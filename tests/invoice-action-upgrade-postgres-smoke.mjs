import {expectedMilestoneUpgradeSnapshot} from './support/milestone-upgrade-expectations.mjs';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../server/migrate.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialServerDir,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import { seedWorkApproval, readApprovalOwner } from './support/work-approval-test.mjs';
import {
  grantAmendmentPermissions,
  createAmendmentHierarchy,
} from './support/commercial-amendments-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const ok = (v, n = 200) => {
  assert.equal(v.status, n, JSON.stringify(v.body));
  return v.body;
};
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  const dir = await mkdtemp(join(tmpdir(), 'invoice-action-065k-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const name of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(name) && name < '065l_wos06_invoice_action_required.sql')
        await copyFile(join(commercialServerDir, 'migrations', name), join(dir, 'migrations', name));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    const fx = await seedWorkApproval(pool),
      ids = fx.identities;
    await grantAmendmentPermissions(pool);
    for (const k of [
      'commercial.tm_billing.view',
      'commercial.invoice_drafts.view',
      'commercial.invoice_drafts.prepare',
      'commercial.invoice_drafts.own',
      'commercial.invoice_drafts.cancel',
      'commercial.invoice_approval.manage',
      'commercial.contracts.manage',
    ])
      await pool.query(
        "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
        [k],
      );
    await withCommercialApi(
      { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
      async ({ request }) => {
        const end = shift(fx.today, 30),
          roots = await createAmendmentHierarchy(request, 'SYN-ACTION-UPGRADE', {
            contract: {
              model: 'time_and_materials',
              startsOn: fx.today,
              endsOn: end,
              effectiveFrom: fx.today,
              currency: 'USD',
            },
            engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
            project: { startsOn: fx.today, endsOn: end },
          }),
          ownerKey = await readApprovalOwner(request, ids.requester),
          draft = ok(
            await request('/api/v1/invoice-drafts/batches', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: ownerKey,
                requestId: randomUUID(),
                definition: {
                  clientId: roots.contract.clientId,
                  contractId: roots.contract.id,
                  engagementId: roots.engagement.id,
                  currency: 'USD',
                  periodStart: fx.today,
                  periodEnd: fx.today,
                  periodBasis: 'WORK_DATE',
                  ownerUserId: ids.manager.id,
                  ownerRole: 'Admin',
                },
                reason: 'Synthetic upgrade draft',
              },
            }),
            201,
          ).batch;
        const tables = [
            'users',
            'user_roles',
            'user_organization_scopes',
            'role_permissions',
            'user_permission_grants',
            'invoice_draft_batches',
            'invoice_draft_lines',
            'invoice_draft_occupancies',
            'invoice_batch_approval_instances',
            'invoice_batch_approval_transitions',
            'invoice_csv_artifacts',
            'invoice_export_notice_events',
            'audit_logs',
          ],
          snapshot = async () =>
            Object.fromEntries(
              await Promise.all(
                tables.map(async (t) => [
                  t,
                  (await pool.query('select to_jsonb(t) v from ' + t + ' t order by to_jsonb(t)::text')).rows,
                ]),
              ),
            ),
          before = await snapshot();
        assert(before.invoice_draft_batches.some((x) => x.v.id === draft.id));
        assert.equal((await pool.query("select to_regclass('invoice_action_events') t")).rows[0].t, null);
        assert.deepEqual((await migrateCommercialDatabase(pool)).applied, [
          '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap',
        ]);
        assert.deepEqual(await snapshot(), expectedMilestoneUpgradeSnapshot(before));
        for (const t of [
          'invoice_action_templates',
          'invoice_action_events',
          'invoice_action_recipients',
          'invoice_action_deliveries',
          'invoice_action_reads',
        ])
          assert.equal((await pool.query('select count(*)::int n from ' + t)).rows[0].n, 0);
        assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
        assert.deepEqual(await snapshot(), expectedMilestoneUpgradeSnapshot(before));
        console.log(
          'Synthetic populated 065k to 065l upgrade preserves draft, identities, grants, audit and replay.',
        );
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
