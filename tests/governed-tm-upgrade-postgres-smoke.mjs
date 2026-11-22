import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../server/migrate.mjs';
import { commercialServerDir } from './support/commercial-drafting-test.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialFixture as f,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import {
  seedWorkApproval,
  adoptStagedPolicy,
  submitStagedWork,
  readApprovalOwner,
  WORK_APPROVAL_BASE as work,
} from './support/work-approval-test.mjs';
import { actualCatalog } from './support/actual-work-test.mjs';
import {
  grantAmendmentPermissions,
  createAmendmentHierarchy,
} from './support/commercial-amendments-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const base = '/api/v1/governed-tm-valuations',
  candidates = '/api/v1/rate-candidates',
  approvals = '/api/v1/commercial-candidate-approvals',
  adoptions = '/api/v1/approved-rate-sources',
  ok = (v, n = 200) => {
    assert.equal(v.status, n, JSON.stringify(v.body));
    return v.body;
  };
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  const dir = await mkdtemp(join(tmpdir(), 'workos-tm-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_.*\.sql$/.test(n) && n < '065e_wos06_governed_tm_valuation.sql')
        await copyFile(join(commercialServerDir, 'migrations', n), join(dir, 'migrations', n));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    const fx = await seedWorkApproval(pool),
      ids = fx.identities;
    await grantAmendmentPermissions(pool);
    for (const k of [
      'commercial.rate_candidates.view',
      'commercial.rate_candidates.manage',
      'commercial.cost_candidates.view',
      'commercial.cost_candidates.manage',
      'commercial.rate_approvals.decide',
      'commercial.cost_approvals.decide',
    ])
      await pool.query(
        "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
        [k],
      );
    await withCommercialApi(
      { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
      async ({ request }) => {
        const end = shift(fx.today, 30),
          roots = await createAmendmentHierarchy(request, 'SYN-TM-VAL', {
            contract: {
              model: 'time_and_materials',
              startsOn: fx.today,
              endsOn: end,
              effectiveFrom: fx.today,
              currency: 'USD',
            },
            engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
            project: { startsOn: fx.today, endsOn: end },
          });
        ok(
          await request('/api/v1/work-categories/catalogs', {
            method: 'POST',
            body: {
              expectedLatestId: null,
              effectiveFrom: fx.today,
              definition: actualCatalog,
              reason: 'Synthetic category',
            },
          }),
          201,
        );
        await adoptStagedPolicy(request, ids, fx.today);
        ok(
          await request('/api/allocations', {
            method: 'POST',
            body: {
              employee_id: f.ownerId,
              project_id: roots.project.id,
              percentage: 20,
              start_date: fx.today,
              end_date: fx.today,
              billable: true,
              status: 'Active',
            },
          }),
        );
        const keys = [
            'approval.action_required',
            'approval.rejected_or_correction_required',
            'approval.completed',
          ],
          makeRate = async (kind, amount, priority = 1, adoptNow = true) => {
            const bindingType = kind === 'billing' ? 'contract' : 'worker',
              bindingId = kind === 'billing' ? roots.contract.id : f.ownerId,
              candidate = ok(
                await request(candidates + '/candidates', {
                  method: 'POST',
                  body: {
                    requestId: randomUUID(),
                    streamId: randomUUID(),
                    expectedLatestId: null,
                    kind,
                    bindingType,
                    bindingId,
                    effectiveFrom: fx.today,
                    effectiveTo: end,
                    currency: 'USD',
                    unit: 'HOUR',
                    amount,
                    priority,
                    reason: 'Synthetic governed source',
                  },
                }),
                201,
              ).candidate,
              owner = ok(
                await request(candidates + '/owners', {
                  method: 'POST',
                  body: {
                    requestId: randomUUID(),
                    candidateId: candidate.id,
                    expectedOwnerEventId: null,
                    ownerUserId: ids.manager.id,
                    ownerRole: 'Admin',
                    reason: 'Synthetic rate owner',
                  },
                }),
                201,
              ),
              definition = {
                entityType: 'CommercialCandidate',
                kind,
                candidateId: candidate.id,
                stages: [{ userId: ids.second.id, role: 'Admin' }],
                locale: 'en-US',
                templates: keys.map((key) => ({
                  key,
                  subject: 'Review {{stageNumber}}',
                  body: 'Source {{sourceRef}}',
                })),
                completionInApp: false,
              },
              policy = ok(
                await request(approvals + '/policies', {
                  method: 'POST',
                  body: {
                    expectedOwnerKey: owner.ownerKey,
                    requestId: randomUUID(),
                    expectedLatestId: null,
                    effectiveFrom: fx.today,
                    definition,
                    reason: 'Synthetic rate policy',
                  },
                }),
                201,
              ).policy,
              approval = ok(
                await request(approvals + '/requests', {
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
              actor = ok(await request(approvals + '/instances/' + approval.id, { identity: ids.second }));
            ok(
              await request(approvals + '/instances/' + approval.id + '/decisions', {
                method: 'POST',
                identity: ids.second,
                body: {
                  expectedOwnerKey: actor.ownerKey,
                  requestId: randomUUID(),
                  expectedCandidateId: candidate.id,
                  expectedOwnerEventId: owner.owner.id,
                  expectedPolicyId: policy.id,
                  expectedSequence: 0,
                  decision: 'Approved',
                  reason: 'Synthetic source review',
                },
              }),
              201,
            );
            const inspected = ok(await request(adoptions + '/candidates/' + candidate.id)),
              r = inspected.reviews[0];
            const adoptionCommand = {
              expectedOwnerKey: inspected.ownerKey,
              requestId: randomUUID(),
              candidateId: candidate.id,
              expectedOwnerEventId: r.ownerEventId,
              approvalId: r.approvalId,
              expectedPolicyId: r.policyId,
              expectedFinalTransitionId: r.finalTransitionId,
              reason: 'Synthetic source adoption',
            };
            return adoptNow
              ? ok(await request(adoptions + '/adoptions', { method: 'POST', body: adoptionCommand }), 201)
                  .adoption
              : adoptionCommand;
          };
        const billing = await makeRate('billing', '100.1234'),
          cost = await makeRate('cost', '40.0020'),
          submitted = await submitStagedWork(request, ids.reader, fx.today, {
            entries: [
              {
                project_id: roots.project.id,
                work_type: 'Project Work',
                category_code: 'BILL',
                work_date: fx.today,
                hours: '1.25',
                billable: true,
                remark: 'Synthetic upgrade approved work',
              },
            ],
          });
        const decide = async (identity) => {
          const v = ok(await request(work + '/instances/' + submitted.instance.id)).instance;
          return ok(
            await request(work + '/instances/' + submitted.instance.id + '/decisions', {
              method: 'POST',
              identity,
              body: {
                expectedOwnerKey: await readApprovalOwner(request, identity),
                expectedSourceToken: v.sourceToken,
                expectedSequence: v.state.sequence,
                requestId: randomUUID(),
                decision: 'Approved',
                reason: 'Synthetic approved work stage',
              },
            }),
            201,
          ).receipt;
        };
        assert.equal((await decide(ids.manager)).outcome.status, 'Pending');
        assert.equal((await decide(ids.second)).outcome.status, 'Approved');
        const tables = [
            'commercial_rate_candidates',
            'commercial_candidate_owners',
            'commercial_candidate_approval_policies',
            'commercial_candidate_approval_instances',
            'commercial_candidate_approval_transitions',
            'commercial_candidate_approval_events',
            'commercial_candidate_approval_recipients',
            'commercial_candidate_approval_deliveries',
            'commercial_rate_adoptions',
            'work_submission_evidence',
            'work_submission_decisions',
            'timesheets',
            'timesheet_entries',
            'approval_records',
            'permission_definitions',
            'role_permissions',
            'user_permission_grants',
            'audit_logs',
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
          before.commercial_rate_adoptions.length === 2 &&
            before.work_submission_decisions.length > 0 &&
            before.timesheet_entries.length > 0,
        );
        assert.deepEqual((await migrateCommercialDatabase(pool)).applied, [
          '065e_wos06_governed_tm_valuation',
          '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts', '082l_wos06_retainer_invoice_approval', '082m_wos06_retainer_invoice_csv', '082n_wos06_retainer_billing_confirmation', '082o_wos06_retainer_reversal_review', '082p_wos06_retainer_credit', '082q_wos08_archive_constraint_resolution', '082r_wos06_managed_service_dimensions', '082s_wos06_service_unit_evidence', '082t_wos06_service_unit_reviews', '082u_wos06_service_unit_contract_prices', '082v_wos06_accepted_unit_valuation', '082w_wos06_service_unit_eligibility', '082x_wos06_service_unit_invoice_drafts', '082y_wos06_service_unit_invoice_approval', '082z_wos06_service_unit_invoice_export','083_wos06_service_unit_corrections','084_wos06_service_period_charge_terms','085_wos06_service_period_reviews','086_wos06_service_period_valuation','087_wos06_service_period_eligibility','088_wos06_service_period_invoice_drafts','089_wos06_service_period_invoice_approval','090_wos06_service_period_invoice_export',
        ]);
        const after = await snapshot(),
          newKeys = [
          'commercial.milestone_billing.view',
          'commercial.milestone_billing.manage',
          'commercial.milestone_billing.decide', 'periods.financial_reopen','commercial.reversal_eligibility.create','commercial.purchase_orders.release','commercial.fixed_fee_eligibility.issue','commercial.service_units.policy','commercial.service_units.value','commercial.service_units.issue','commercial.service_periods.issue','commercial.service_periods.value','commercial.service_periods.decide','commercial.service_units.decide','commercial.service_units.capture','commercial.retainer_statements.prepare','commercial.retainer_statements.decide','commercial.retainer_eligibility.issue',
            'commercial.tm_valuation.view',
            'commercial.tm_valuation.create',
            'commercial.tm_billing.view',
            'commercial.tm_billing.manage',
            'commercial.tm_billing.decide',
            'commercial.invoice_drafts.view',
            'commercial.invoice_drafts.prepare',
            'commercial.invoice_drafts.own',
            'commercial.invoice_drafts.cancel','commercial.invoice_approval.manage','commercial.invoice_approval.decide','commercial.invoice_export.view', 'commercial.invoice_export.create', 'commercial.invoice_export.configure', 'commercial.invoice_export.recover_notices', 'integrations.invoice_alert_routes.manage', 'commercial.invoice_batch.confirm',
          ];
        assert.deepEqual(
          after.permission_definitions
            .filter((x) => newKeys.includes(x.v.permission_key))
            .map((x) => x.v.permission_key)
            .sort(),
          [...newKeys].sort(),
        );
        assert.deepEqual(
          after.permission_definitions.filter((x) => !newKeys.includes(x.v.permission_key)),
          before.permission_definitions,
        );
        assert.deepEqual({ ...after, permission_definitions: before.permission_definitions }, before);
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
        assert.equal(
          (await pool.query('select count(*)::int n from commercial_tm_policy_versions')).rows[0].n,
          0,
        );
        assert.equal((await pool.query('select count(*)::int n from commercial_tm_valuations')).rows[0].n, 0);
        assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
        assert.deepEqual(await snapshot(), after);
        assert(billing.id && cost.id);
        console.log(
          'Populated 079 upgrade/replay preserves adopted sources, approved work, audit and grants; T&M tables stay empty.',
        );
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
