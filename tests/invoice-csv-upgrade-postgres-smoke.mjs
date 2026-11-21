import {expectedMilestoneUpgradeSnapshot} from './support/milestone-upgrade-expectations.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../server/migrate.mjs';
import {
  commercialServerDir,
  withCommercialDatabase,
  migrateCommercialDatabase,
} from './support/commercial-drafting-test.mjs';
import { seedWorkApproval } from './support/work-approval-test.mjs';

await withCommercialDatabase(async ({ pool }) => {
  const dir = await mkdtemp(join(tmpdir(), 'invoice-csv-083-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(n) && n < '065i_wos06_approved_invoice_csv.sql')
        await copyFile(join(commercialServerDir, 'migrations', n), join(dir, 'migrations', n));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    await seedWorkApproval(pool);
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
      'audit_logs',
    ];
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (t) => [
            t,
            (await pool.query('select to_jsonb(t) v from ' + t + ' t order by to_jsonb(t)::text')).rows,
          ]),
        ),
      );
    const before = await snapshot(),
      keys = [
        'commercial.invoice_export.view',
        'commercial.invoice_export.create',
        'commercial.invoice_export.configure',
        'commercial.invoice_export.recover_notices',
        'integrations.invoice_alert_routes.manage', 'commercial.invoice_batch.confirm',
      ];
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
      '065i_wos06_approved_invoice_csv',
      '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts',
    ]);
    assert.deepEqual(await snapshot(), expectedMilestoneUpgradeSnapshot(before));
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from permission_definitions where permission_key=any($1::text[])',
          [keys],
        )
      ).rows[0].n,
      keys.length,
    );
    for (const t of ['invoice_csv_artifacts', 'invoice_csv_failures', 'invoice_csv_request_keys'])
      assert.equal((await pool.query('select count(*)::int n from ' + t)).rows[0].n, 0);
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
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
    assert.deepEqual(await snapshot(), expectedMilestoneUpgradeSnapshot(before));
    console.log('Invoice CSV 083 upgrade and replay preserve prior records and grants.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
