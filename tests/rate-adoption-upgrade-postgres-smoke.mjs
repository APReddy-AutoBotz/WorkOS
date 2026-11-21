import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../server/migrate.mjs';
import {
  commercialFixture as f,
  commercialServerDir,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import { seedCapacity } from './support/worker-capacity-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const ok = (r, n = 200) => {
  assert.equal(r.status, n, JSON.stringify(r.body));
  return r.body;
};
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  const dir = await mkdtemp(join(tmpdir(), 'workos-adoption-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_.*\.sql$/.test(n) && n < '065d_wos06_approved_rate_adoptions.sql')
        await copyFile(join(commercialServerDir, 'migrations', n), join(dir, 'migrations', n));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    const fx = await seedCapacity(pool),
      admin = fx.identities.manager,
      reviewer = fx.identities.denied;
    for (const k of ['commercial.rate_candidates.view', 'commercial.rate_candidates.manage'])
      await pool.query(
        "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
        [k],
      );
    for (const k of [
      'commercial.contracts.view',
      'commercial.rate_candidates.view',
      'commercial.rate_approvals.decide',
      'notifications.view',
      'approvals.view',
      'employees.view',
    ])
      await pool.query(
        "insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
        [k],
      );
    await withCommercialApi({ databaseUrl, identities: fx.identities }, async ({ request }) => {
      const contract = ok(
          await request('/contracts', {
            method: 'POST',
            body: {
              number: 'SYN-ADOPTION-UPGRADE',
              clientId: f.clientId,
              name: 'Synthetic contract',
              model: 'time_and_materials',
              startsOn: fx.today,
              endsOn: shift(fx.today, 20),
              effectiveFrom: fx.today,
              currency: 'USD',
              value: '100.0000',
              billingTerms: 'Synthetic terms',
              documents: [],
              reason: 'Synthetic fixture',
            },
          }),
          201,
        ),
        candidate = ok(
          await request('/api/v1/rate-candidates/candidates', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              streamId: randomUUID(),
              expectedLatestId: null,
              kind: 'billing',
              bindingType: 'contract',
              bindingId: contract.id,
              effectiveFrom: fx.today,
              effectiveTo: shift(fx.today, 20),
              currency: 'USD',
              unit: 'HOUR',
              amount: '27.1234',
              priority: 9,
              reason: 'Synthetic candidate',
            },
          }),
          201,
        ).candidate,
        owner = ok(
          await request('/api/v1/rate-candidates/owners', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              candidateId: candidate.id,
              expectedOwnerEventId: null,
              ownerUserId: admin.id,
              ownerRole: 'Admin',
              reason: 'Synthetic owner',
            },
          }),
          201,
        ),
        definition = {
          entityType: 'CommercialCandidate',
          kind: 'billing',
          candidateId: candidate.id,
          stages: [{ userId: reviewer.id, role: 'TeamLead' }],
          locale: 'en-US',
          templates: [
            'approval.action_required',
            'approval.rejected_or_correction_required',
            'approval.completed',
          ].map((key) => ({ key, subject: 'Review {{stageNumber}}', body: 'Source {{sourceRef}}' })),
          completionInApp: false,
        },
        policy = ok(
          await request('/api/v1/commercial-candidate-approvals/policies', {
            method: 'POST',
            body: {
              expectedOwnerKey: owner.ownerKey,
              requestId: randomUUID(),
              expectedLatestId: null,
              effectiveFrom: fx.today,
              definition,
              reason: 'Synthetic policy',
            },
          }),
          201,
        ).policy,
        approval = ok(
          await request('/api/v1/commercial-candidate-approvals/requests', {
            method: 'POST',
            body: {
              expectedOwnerKey: owner.ownerKey,
              requestId: randomUUID(),
              candidateId: candidate.id,
              expectedOwnerEventId: owner.owner.id,
              expectedPolicyId: policy.id,
              reason: 'Synthetic review',
            },
          }),
          201,
        ).approval,
        view = ok(
          await request('/api/v1/commercial-candidate-approvals/instances/' + approval.id, {
            identity: reviewer,
          }),
        );
      ok(
        await request('/api/v1/commercial-candidate-approvals/instances/' + approval.id + '/decisions', {
          method: 'POST',
          identity: reviewer,
          body: {
            expectedOwnerKey: view.ownerKey,
            requestId: randomUUID(),
            expectedCandidateId: candidate.id,
            expectedOwnerEventId: owner.owner.id,
            expectedPolicyId: policy.id,
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic approval',
          },
        }),
        201,
      );
      const tables = [
          'commercial_rate_candidates',
          'commercial_candidate_owners',
          'commercial_candidate_approval_policies',
          'commercial_candidate_approval_instances',
          'commercial_candidate_approval_transitions',
          'commercial_candidate_approval_events',
          'commercial_candidate_approval_recipients',
          'commercial_candidate_approval_deliveries',
          'approval_records',
          'permission_definitions',
          'role_permissions',
          'user_permission_grants',
          'audit_logs',
          'employees',
          'timesheets',
          'timesheet_entries',
        ],
        snapshot = async () =>
          Object.fromEntries(
            await Promise.all(
              tables.map(async (t) => [
                t,
                (await pool.query('select to_jsonb(t)v from ' + t + ' t order by to_jsonb(t)::text')).rows,
              ]),
            ),
          ),
        before = await snapshot();
      assert(
        before.commercial_candidate_approval_transitions.length > 0 &&
          before.commercial_candidate_approval_events.length > 0,
      );
      assert.deepEqual((await migrateCommercialDatabase(pool)).applied, [
        '065d_wos06_approved_rate_adoptions',
        '065e_wos06_governed_tm_valuation',
        '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms',
      ]);
      const upgraded = await snapshot(),
        newKeys = [
          'commercial.milestone_billing.view',
          'commercial.milestone_billing.manage',
          'commercial.milestone_billing.decide', 'periods.financial_reopen','commercial.reversal_eligibility.create','commercial.purchase_orders.release','commercial.fixed_fee_eligibility.issue',
          'commercial.tm_valuation.view',
          'commercial.tm_valuation.create',
          'commercial.tm_billing.view',
          'commercial.tm_billing.manage',
          'commercial.tm_billing.decide',
          'commercial.invoice_drafts.view',
          'commercial.invoice_drafts.prepare',
          'commercial.invoice_drafts.own',
          'commercial.invoice_drafts.cancel','commercial.invoice_approval.manage','commercial.invoice_approval.decide','commercial.invoice_export.view', 'commercial.invoice_export.create', 'commercial.invoice_export.configure', 'commercial.invoice_export.recover_notices', 'integrations.invoice_alert_routes.manage', 'commercial.invoice_batch.confirm',
        ],
        added = upgraded.permission_definitions.filter((x) => newKeys.includes(x.v.permission_key));
      assert.deepEqual(added.map((x) => x.v.permission_key).sort(), [...newKeys].sort());
      assert.deepEqual(
        upgraded.permission_definitions.filter((x) => !newKeys.includes(x.v.permission_key)),
        before.permission_definitions,
      );
      assert.deepEqual({ ...upgraded, permission_definitions: before.permission_definitions }, before);
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from role_permissions where permission_key=any($1::text[])',
            [newKeys],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from user_permission_grants where permission_key=any($1::text[])',
            [newKeys],
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await pool.query('select count(*)::int n from commercial_rate_adoptions')).rows[0].n, 0);
      assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
      assert.deepEqual(await snapshot(), upgraded);
      const inspect = ok(await request('/api/v1/approved-rate-sources/candidates/' + candidate.id)),
        oldReview = inspect.reviews.find((x) => x.approvalId === approval.id);
      assert(
        oldReview && !oldReview.current,
        'Unadopted pre-upgrade approval lacks authority-change history',
      );
      const stale = await request('/api/v1/approved-rate-sources/adoptions', {
        method: 'POST',
        body: {
          expectedOwnerKey: inspect.ownerKey,
          requestId: randomUUID(),
          candidateId: candidate.id,
          expectedOwnerEventId: oldReview.ownerEventId,
          approvalId: oldReview.approvalId,
          expectedPolicyId: oldReview.policyId,
          expectedFinalTransitionId: oldReview.finalTransitionId,
          reason: 'Synthetic stale adoption',
        },
      });
      assert.equal(stale.status, 409);
      assert.equal((await pool.query('select count(*)::int n from commercial_rate_adoptions')).rows[0].n, 0);
      const freshPolicy = ok(
          await request('/api/v1/commercial-candidate-approvals/policies', {
            method: 'POST',
            body: {
              expectedOwnerKey: owner.ownerKey,
              requestId: randomUUID(),
              expectedLatestId: policy.id,
              effectiveFrom: fx.today,
              definition,
              reason: 'Synthetic fresh review policy',
            },
          }),
          201,
        ).policy,
        freshReview = ok(
          await request('/api/v1/commercial-candidate-approvals/requests', {
            method: 'POST',
            body: {
              expectedOwnerKey: owner.ownerKey,
              requestId: randomUUID(),
              candidateId: candidate.id,
              expectedOwnerEventId: owner.owner.id,
              expectedPolicyId: freshPolicy.id,
              reason: 'Synthetic fresh review',
            },
          }),
          201,
        ).approval,
        freshView = ok(
          await request('/api/v1/commercial-candidate-approvals/instances/' + freshReview.id, {
            identity: reviewer,
          }),
        );
      ok(
        await request('/api/v1/commercial-candidate-approvals/instances/' + freshReview.id + '/decisions', {
          method: 'POST',
          identity: reviewer,
          body: {
            expectedOwnerKey: freshView.ownerKey,
            requestId: randomUUID(),
            expectedCandidateId: candidate.id,
            expectedOwnerEventId: owner.owner.id,
            expectedPolicyId: freshPolicy.id,
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic fresh approval',
          },
        }),
        201,
      );
      const ready = ok(await request('/api/v1/approved-rate-sources/candidates/' + candidate.id)),
        r = ready.reviews.find((x) => x.approvalId === freshReview.id);
      assert(r?.current);
      const adopted = ok(
        await request('/api/v1/approved-rate-sources/adoptions', {
          method: 'POST',
          body: {
            expectedOwnerKey: ready.ownerKey,
            requestId: randomUUID(),
            candidateId: candidate.id,
            expectedOwnerEventId: r.ownerEventId,
            approvalId: r.approvalId,
            expectedPolicyId: r.policyId,
            expectedFinalTransitionId: r.finalTransitionId,
            reason: 'Synthetic adoption after fresh review',
          },
        }),
        201,
      );
      assert.equal(adopted.adoption.approvalId, freshReview.id);
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
            [approval.id],
          )
        ).rows[0].n,
        1,
        'Original approved history remains immutable',
      );
      console.log(
        'Populated upgrade/replay preserves history and grants; unadopted history requires fresh review before adoption.',
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
