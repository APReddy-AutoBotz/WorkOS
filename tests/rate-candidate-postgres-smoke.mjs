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
const base = '/api/v1/rate-candidates';
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
await withCommercialDatabase(async ({ pool }) => {
  const dir = await mkdtemp(join(tmpdir(), 'rate-candidate-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(n) && n < '065a_wos06_rate_cost_candidates.sql')
        await copyFile(join(commercialServerDir, 'migrations', n), join(dir, 'migrations', n));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    await seedCapacity(pool);
    const tables = [
      'users',
      'user_roles',
      'role_permissions',
      'user_permission_grants',
      'commercial_contracts',
      'commercial_engagements',
      'employees',
      'timesheets',
      'timesheet_entries',
      'audit_logs',
    ];
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (t) => [
            t,
            (await pool.query('select to_jsonb(t)v from ' + t + ' t order by to_jsonb(t)::text')).rows,
          ]),
        ),
      );
    const before = await snapshot();
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, ['065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts', '082l_wos06_retainer_invoice_approval', '082m_wos06_retainer_invoice_csv', '082n_wos06_retainer_billing_confirmation', '082o_wos06_retainer_reversal_review', '082p_wos06_retainer_credit', '082q_wos08_archive_constraint_resolution', '082r_wos06_managed_service_dimensions', '082s_wos06_service_unit_evidence', '082t_wos06_service_unit_reviews', '082u_wos06_service_unit_contract_prices', '082v_wos06_accepted_unit_valuation']);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await pool.query('select count(*)::int n from commercial_rate_candidates')).rows[0].n, 0);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
    assert.deepEqual(await snapshot(), before);
    console.log('Rate candidate populated 065 upgrade and replay preserve existing data and grants.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const keys = [
    'commercial.rate_candidates.view',
    'commercial.rate_candidates.manage',
    'commercial.cost_candidates.view',
    'commercial.cost_candidates.manage',
  ];
  assert.equal(
    (
      await pool.query(
        'select count(*)::int n from role_permissions where permission_key=any($1::text[]) and enabled',
        [keys],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int n from user_permission_grants where permission_key=any($1::text[])',
        [keys],
      )
    ).rows[0].n,
    0,
  );
  const fx = await seedCapacity(pool);
  // Historical user codes must never substitute for a current workforce binding.
  const directoryContext = {
    organizationId: f.organizationId,
    legalEntityId: f.legalEntityId,
    actorId: fx.identities.reader.id,
    activeRole: 'Employee',
  };
  const bindingVisible = async () =>
    (await pool.query('select rate_candidate_worker_visible($1::jsonb,$2) as allowed',
      [JSON.stringify(directoryContext), f.ownerId])).rows[0].allowed;
  assert.equal(await bindingVisible(), true);
  await pool.query('update users set employee_record_id=null where id=$1', [directoryContext.actorId]);
  assert.equal(await bindingVisible(), false);
  await pool.query('update users set employee_record_id=$1 where id=$2', [f.ownerId, directoryContext.actorId]);
  for (const k of keys)
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await pool.query(
    "insert into role_permissions(role_name,permission_key,enabled)values('Admin','permissions.manage',true)on conflict(role_name,permission_key)do update set enabled=true",
  );
  await withCommercialApi(
    { databaseUrl, identities: fx.identities, onServerError: (s) => process.stderr.write(s) },
    async ({ request }) => {
      const configuration = ok(await request('/api/permissions/config'));
      for (const key of keys)
        assert(
          configuration.permissions.some((x) => x.key === key),
          'permission configuration recognizes ' + key,
        );
      const today = fx.today,
        last = shift(today, 90),
        next = shift(today, 1);
      const contract = ok(
        await request('/contracts', {
          method: 'POST',
          body: {
            number: 'SYN-RATE-CONTRACT',
            clientId: f.clientId,
            name: 'Synthetic contract',
            model: 'time_and_materials',
            startsOn: today,
            endsOn: last,
            effectiveFrom: today,
            currency: 'USD',
            value: '1000.0000',
            billingTerms: 'Synthetic terms',
            documents: [],
            reason: 'Synthetic fixture contract',
          },
        }),
        201,
      );
      const e = ok(
        await request('/engagements', {
          method: 'POST',
          body: {
            code: 'SYN-RATE-ENG',
            name: 'Synthetic engagement',
            model: 'time_and_materials',
            ownerId: f.ownerId,
            startsOn: today,
            endsOn: last,
            currency: 'USD',
            budget: '1000.0000',
            clientId: f.clientId,
            contractId: contract.id,
            contractVersionId: contract.versions[0].id,
            attributionId: null,
            reason: 'Synthetic fixture engagement',
          },
        }),
        201,
      );
      const saved = async (d) =>
        ok(await request(base + '/candidates', { method: 'POST', body: d }), 201).candidate;
      const make = (kind, bindingType, bindingId, amount, priority) => ({
        requestId: randomUUID(),
        streamId: randomUUID(),
        expectedLatestId: null,
        kind,
        bindingType,
        bindingId,
        effectiveFrom: today,
        effectiveTo: today,
        currency: 'USD',
        unit: 'HOUR',
        amount,
        priority,
        reason: 'Synthetic candidate only',
      });
      const billing = make('billing', 'contract', contract.id, '100.0001', 10),
        higher = make('billing', 'engagement', e.id, '200.0002', 20),
        cost = make('cost', 'worker', f.ownerId, '80.0003', 10);
      const b = await saved(billing),
        h = await saved(higher),
        c = await saved(cost);
      const query = (k, id, day = today, cur = 'USD') =>
        `${base}/preview?kind=${k}&sourceId=${encodeURIComponent(id)}&asOf=${day}&currency=${cur}&unit=HOUR`;
      const billingResponse = await request(query('billing', e.id)),
        costResponse = await request(query('cost', f.ownerId));
      assert.equal(billingResponse.response.headers.get('cache-control'), 'no-store');
      assert.equal(costResponse.response.headers.get('cache-control'), 'no-store');
      const bp = ok(billingResponse),
        cp = ok(costResponse);
      assert.equal(bp.previewOnly, true);
      assert.equal(bp.result, 'candidate');
      assert.equal(bp.candidate.id, h.id);
      assert.equal(bp.candidate.amount, '200.0002');
      assert.equal(cp.candidate.id, c.id);
      assert.equal(cp.candidate.amount, '80.0003');
      assert.equal(ok(await request(query('billing', e.id, today, 'EUR'))).result, 'missing');
      assert.equal((await request(query('cost', f.ownerId), { identity: fx.identities.reader })).status, 403);
      await pool.query(
        "insert into user_permission_grants(user_id,permission_key,granted_by)values($1,'commercial.cost_candidates.view',$2)",
        [fx.identities.reader.id, fx.identities.manager.id],
      );
      assert.equal(
        ok(await request(query('cost', f.ownerId), { identity: fx.identities.reader })).candidate.amount,
        '80.0003',
      );
      assert.equal((await request(query('billing', e.id), { identity: fx.identities.reader })).status, 403);
      assert.equal(
        (await request(base + '/candidates', { method: 'POST', body: cost, identity: fx.identities.reader }))
          .status,
        403,
      );
      await pool.query(
        "delete from user_permission_grants where user_id=$1 and permission_key='commercial.cost_candidates.view'",
        [fx.identities.reader.id],
      );
      const replay = ok(await request(base + '/candidates', { method: 'POST', body: billing }));
      assert.equal(replay.replayed, true);
      assert.equal(replay.candidate.id, b.id);
      assert.equal(
        (await request(base + '/candidates', { method: 'POST', body: { ...billing, amount: '101.0000' } }))
          .status,
        409,
      );
      const tied = make('billing', 'contract', contract.id, '300.0000', 20);
      await saved(tied);
      assert.equal(ok(await request(query('billing', e.id))).result, 'conflict');
      const v2 = {
        ...higher,
        requestId: randomUUID(),
        expectedLatestId: h.id,
        effectiveFrom: next,
        effectiveTo: last,
        amount: '210.0000',
      };
      const [x, y] = await Promise.all([
        request(base + '/candidates', { method: 'POST', body: v2 }),
        request(base + '/candidates', { method: 'POST', body: v2 }),
      ]);
      assert.deepEqual([x.status, y.status].sort(), [200, 201]);
      assert.equal(x.body.candidate.id, y.body.candidate.id);
      assert.equal(ok(await request(query('billing', e.id, next))).candidate.amount, '210.0000');
      const historical = (
        await pool.query('select amount::text amount from commercial_rate_candidates where id=$1', [h.id])
      ).rows[0];
      assert.equal(historical.amount, '200.0002');
      assert.equal(
        (await request(base + '/receipts/' + billing.requestId, { identity: fx.identities.reader })).status,
        404,
      );
      const audit = (
        await pool.query("select * from audit_logs where module='Rate Candidate' order by created_at")
      ).rows;
      assert.equal(audit.length, 5);
      assert(!JSON.stringify(audit).includes('200.0002'));
      assert(!JSON.stringify(audit).includes('Synthetic candidate only'));
      await assert.rejects(
        pool.query(
          "insert into commercial_rate_candidates(id,organization_id,legal_entity_id,stream_id,sequence,kind,binding_type,binding_id,effective_from,effective_to,currency,unit,amount,priority,command,request_id,actor_id,active_role,reason,operation_id) values($1,$2,$3,$4,1,'billing','contract',$5,$6,$6,'USD','HOUR',1,1,'{}',$7,$8,'Admin','Bypass attempt','test')",
          [
            randomUUID(),
            f.organizationId,
            f.legalEntityId,
            randomUUID(),
            contract.id,
            today,
            randomUUID(),
            fx.identities.manager.id,
          ],
        ),
        { code: 'RCC01' },
      );
      await pool.query(
        "update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.cost_candidates.view'",
      );
      assert.equal((await request(base + '/receipts/' + cost.requestId)).status, 403);
      await pool.query(
        "update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.cost_candidates.view'",
      );
      assert.equal(ok(await request(base + '/receipts/' + cost.requestId)).candidate.id, c.id);
      const lockClient = await pool.connect();
      try {
        await lockClient.query('begin');
        await lockClient.query(
          "update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.cost_candidates.view'",
        );
        const pending = request(query('cost', f.ownerId));
        let waiting = false;
        for (let i = 0; i < 60; i++) {
          const state = await pool.query(
            "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%permission_key from role_permissions%' limit 1",
          );
          if (state.rowCount) {
            waiting = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(waiting, true, 'the read waits on the current permission row');
        await lockClient.query('commit');
        const refused = await pending;
        assert([403, 409].includes(refused.status), JSON.stringify(refused.body));
        assert(!JSON.stringify(refused.body).includes('80.0003'));
      } finally {
        await lockClient.query('rollback').catch(() => {});
        lockClient.release();
        await pool.query(
          "update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.cost_candidates.view'",
        );
      }
      const exact = { ...make('cost', 'worker', f.ownerId, '12345678901234.1234', 42), currency: 'EUR' };
      const exactRow = await saved(exact);
      assert.equal(exactRow.amount, '12345678901234.1234');
      assert.equal(ok(await request(query('cost', f.ownerId, today, 'EUR'))).candidate.amount, exact.amount);
      assert.equal((await request(query('cost', f.otherOwnerId))).status, 404);
      await assert.rejects(
        pool.query('update commercial_rate_candidates set priority=99 where id=$1', [b.id]),
        { code: '55000' },
      );
      await assert.rejects(pool.query('delete from commercial_rate_candidates where id=$1', [b.id]), {
        code: '55000',
      });
      const ledgerBefore = (await pool.query('select count(*)::int n from commercial_rate_candidates'))
        .rows[0].n;
      await pool.query(
        "create function synthetic_rate_audit_failure()returns trigger language plpgsql as $$begin if new.module='Rate Candidate'then raise exception 'Synthetic audit refusal';end if;return new;end$$;create trigger synthetic_rate_audit_failure before insert on audit_logs for each row execute function synthetic_rate_audit_failure()",
      );
      const failed = make('billing', 'contract', contract.id, '1.0000', 1);
      assert.equal((await request(base + '/candidates', { method: 'POST', body: failed })).status, 503);
      assert.equal(
        (await pool.query('select count(*)::int n from commercial_rate_candidates')).rows[0].n,
        ledgerBefore,
      );
      assert.equal((await request(base + '/receipts/' + failed.requestId)).status, 404);
      await pool.query(
        'drop trigger synthetic_rate_audit_failure on audit_logs;drop function synthetic_rate_audit_failure()',
      );
      assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
      console.log(
        'Rate candidate PostgreSQL/API receipt:',
        JSON.stringify({
          nativeDecimal: true,
          explicitPriority: true,
          missingAndConflict: true,
          costIsolation: true,
          exactReplayAndConcurrency: true,
          redactedAudit: true,
          sqlBypassRefused: true,
          noAutomaticActivation: true,
        }),
      );
    },
  );
});
