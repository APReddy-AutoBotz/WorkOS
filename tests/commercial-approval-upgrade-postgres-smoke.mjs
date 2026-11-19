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
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  const dir = await mkdtemp(join(tmpdir(), 'commercial-approval-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(n) && n < '065c_wos06_commercial_candidate_approvals.sql')
        await copyFile(join(commercialServerDir, 'migrations', n), join(dir, 'migrations', n));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    const fx = await seedCapacity(pool);
    for (const k of ['commercial.rate_candidates.view', 'commercial.rate_candidates.manage'])
      await pool.query(
        "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
        [k],
      );
    await withCommercialApi({ databaseUrl, identities: fx.identities }, async ({ request }) => {
      const contract = await request('/contracts', {
        method: 'POST',
        body: {
          number: 'SYN-APPROVAL-UPGRADE',
          clientId: f.clientId,
          name: 'Synthetic contract',
          model: 'time_and_materials',
          startsOn: fx.today,
          endsOn: shift(fx.today, 90),
          effectiveFrom: fx.today,
          currency: 'USD',
          value: '100.0000',
          billingTerms: 'Synthetic terms',
          documents: [],
          reason: 'Synthetic fixture',
        },
      });
      assert.equal(contract.status, 201, JSON.stringify(contract.body));
      const candidate = await request('/api/v1/rate-candidates/candidates', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          streamId: randomUUID(),
          expectedLatestId: null,
          kind: 'billing',
          bindingType: 'contract',
          bindingId: contract.body.id,
          effectiveFrom: fx.today,
          effectiveTo: fx.today,
          currency: 'USD',
          unit: 'HOUR',
          amount: '11.0002',
          priority: 1,
          reason: 'Synthetic candidate',
        },
      });
      assert.equal(candidate.status, 201, JSON.stringify(candidate.body));
      const owner = await request('/api/v1/rate-candidates/owners', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          candidateId: candidate.body.candidate.id,
          expectedOwnerEventId: null,
          ownerUserId: fx.identities.manager.id,
          ownerRole: 'Admin',
          reason: 'Synthetic owner',
        },
      });
      assert.equal(owner.status, 201, JSON.stringify(owner.body));
      const tables = [
          'commercial_rate_candidates',
          'commercial_candidate_owners',
          'users',
          'user_roles',
          'role_permissions',
          'user_permission_grants',
          'audit_logs',
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
        before = await snapshot(),
        keys = ['commercial.rate_approvals.decide', 'commercial.cost_approvals.decide'];
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from permission_definitions where permission_key=any($1::text[])',
            [keys],
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual((await migrateCommercialDatabase(pool)).applied, [
        '065c_wos06_commercial_candidate_approvals',
        '065d_wos06_approved_rate_adoptions',
        '065e_wos06_governed_tm_valuation',
        '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy',
      ]);
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from permission_definitions where permission_key=any($1::text[])',
            [keys],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from role_permissions where permission_key=any($1::text[])',
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
      assert.equal(
        (await pool.query('select count(*)::int n from commercial_candidate_approval_instances')).rows[0].n,
        0,
      );
      assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
      assert.deepEqual(await snapshot(), before);
      console.log(
        '077 populated upgrade and replay preserve owners, candidates, work, audit and grants; approval definitions have no grants.',
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
