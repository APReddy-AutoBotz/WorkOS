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
          '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts', '082l_wos06_retainer_invoice_approval', '082m_wos06_retainer_invoice_csv', '082n_wos06_retainer_billing_confirmation', '082o_wos06_retainer_reversal_review', '082p_wos06_retainer_credit', '082q_wos08_archive_constraint_resolution', '082r_wos06_managed_service_dimensions', '082s_wos06_service_unit_evidence', '082t_wos06_service_unit_reviews', '082u_wos06_service_unit_contract_prices', '082v_wos06_accepted_unit_valuation', '082w_wos06_service_unit_eligibility', '082x_wos06_service_unit_invoice_drafts', '082y_wos06_service_unit_invoice_approval', '082z_wos06_service_unit_invoice_export','083_wos06_service_unit_corrections','084_wos06_service_period_charge_terms','085_wos06_service_period_reviews','086_wos06_service_period_valuation','087_wos06_service_period_eligibility','088_wos06_service_period_invoice_drafts','089_wos06_service_period_invoice_approval','090_wos06_service_period_invoice_export','091_wos06_service_period_credit_corrections','092_wos06_service_unit_effort_evidence','093_wos06_service_unit_effort_cost','094_wos06_managed_service_period_margin','095_wos06_fixed_fee_installment_identities','096_wos06_fixed_fee_invoice_approval','097_wos06_fixed_fee_invoice_export','098_wos06_fixed_fee_credit_corrections','099_wos06_fixed_fee_work_costs','100_wos06_fixed_fee_completion_forecasts','101_wos06_fixed_fee_elapsed_values','102_wos06_fixed_fee_margin_access','103_wos06_fixed_fee_progress_values','104_wos06_fixed_fee_transition_approval','105_wos06_fixed_fee_valuation_periods','106_wos06_fixed_fee_period_statements','107_wos06_fixed_fee_risk_notice_policies','108_wos06_fixed_fee_risk_delivery','109_wos06_risk_delivery_attempt_history','110_wos06_po_commitment_balance_evidence','111_wos06_po_risk_engagement_assignments',
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
