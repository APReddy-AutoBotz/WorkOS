// Synthetic fixtures only. Compose the retained local-only PostgreSQL/API
// harness rather than relaxing its URL allowlist, isolation or teardown rules.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runMigrations} from '../../server/migrate.mjs';
import {
  commercialFixture, commercialServerDir, withCommercialDatabase, withPreCommercialMigrations,
  migrateCommercialDatabase, seedCommercialReferences, seedCommercialLegacyWork,
  seedCommercialIdentities, withCommercialApi,
} from './commercial-drafting-test.mjs';

export const clientProfileFixture = commercialFixture;
export const clientProfilePermissions = Object.freeze(['commercial.clients.view', 'commercial.clients.manage']);
export const clientProfilePrefix = '/api/v1/client-profiles';
export const clientProfileMigration = '042_wos04_scoped_client_profiles';
export const clientProfileScope = Object.freeze({organizationId: commercialFixture.organizationId, legalEntityId: commercialFixture.legalEntityId});
export const protectedClientMarker = 'SYNTHETIC-PRIVATE-CLIENT-9C72';
export const clientProfileTables = Object.freeze(['client_profile_accounts', 'client_profile_versions', 'client_billing_units', 'client_billing_unit_versions', 'client_profile_events']);
export const preservedClientTables = Object.freeze(['clients', 'employees', 'projects', 'project_allocations', 'timesheets', 'timesheet_entries', 'approval_records',
  'commercial_contracts', 'commercial_contract_versions', 'commercial_engagements', 'commercial_purchase_orders', 'commercial_milestones',
  'commercial_draft_events', 'project_engagement_mappings', 'commercial_project_bindings', 'commercial_lifecycle_events']);
export {withCommercialDatabase as withClientProfileDatabase, migrateCommercialDatabase as migrateClientProfiles};

export const withPreClientProfileMigrations = (test, {beforeCommercial} = {}) => withPreCommercialMigrations(async rootDir => {
  if (beforeCommercial) await beforeCommercial(rootDir);
  for (const name of ['040_wos04_commercial_drafting_foundation', '041_wos04_governed_lifecycle']) {
    await copyFile(join(commercialServerDir, 'migrations', `${name}.sql`), join(rootDir, 'migrations', `${name}.sql`));
  }
  return test(rootDir);
});
export const clientProfileToday = async pool => (await pool.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
export const clientProfileDate = (today, days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const clientProfileInput = (today, overrides = {}) => ({expectedVersion: 0, code: 'SYNTHETIC-CLIENT', effectiveFrom: today,
  legalName: `${protectedClientMarker} legal name`, displayName: `${protectedClientMarker} display name`, parentClientId: null,
  defaultCurrency: 'GBP', billingContacts: [{name: `${protectedClientMarker} billing contact`, email: 'synthetic-billing@example.test'}],
  reason: `${protectedClientMarker} profile reason`, ...overrides});
export const clientUnitInput = (today, overrides = {}) => ({code: 'SYNTHETIC-BILLING', kind: 'billing_entity', effectiveFrom: today,
  legalName: `${protectedClientMarker} unit legal name`, displayName: `${protectedClientMarker} unit display name`,
  defaultCurrency: 'EUR', billingContacts: [{name: `${protectedClientMarker} unit contact`, email: 'synthetic-unit@example.test'}],
  reason: `${protectedClientMarker} unit reason`, ...overrides});
export const clientUnitRevision = (today, overrides = {}) => {
  const {code: _code, kind: _kind, ...profile} = clientUnitInput(today);
  return {...profile, expectedVersion: 1, ...overrides};
};
export const clientProfileSnapshot = async (pool, tables, where = '', values = []) => {
  const snapshot = {};
  for (const table of tables) snapshot[table] = (await pool.query(`select to_jsonb(t) value from ${table} t ${where} order by to_jsonb(t)::text`, values)).rows;
  return snapshot;
};
export const clientProfileCounts = async pool => {
  const output = {};
  for (const table of [...clientProfileTables, 'clients', 'projects', 'audit_logs', 'import_export_logs', 'import_export_idempotency']) {
    output[table] = (await pool.query(`select count(*)::int count from ${table}`)).rows[0].count;
  }
  return output;
};
export const assertClientProfileError = (result, status, code) => {
  assert.equal(result.status, status, `expected ${status}${code ? `/${code}` : ''}, received ${result.status}/${result.body?.error?.code}`);
  assert.ok(result.body?.error?.code);if (code) assert.equal(result.body.error.code, code);
  assert.ok(result.body.error.message);
  if (new URL(result.response.url).pathname.startsWith('/api/v1/')) {
    assert.equal(result.body.error.correlationId, result.response.headers.get('x-correlation-id'));
    assert.ok(result.body.error.correlationId, 'v1 errors contain server context');
    if (result.response.headers.get('x-operation-id')) assert.equal(result.body.error.operationId, result.response.headers.get('x-operation-id'));
  }
  assert.equal(Object.hasOwn(result.body, 'id'), false);
  assert.doesNotMatch(JSON.stringify(result.body), /postgres(?:ql)?:\/\/|constraint .* violates|insert into|select .* from/i);
};
export const createClientProfile = async (request, id, input, options = {}) => {
  const result = await request(`/clients/${id}/profiles`, {method: 'POST', body: input, ...options});
  assert.equal(result.status, 201, `real profile command: ${JSON.stringify(result.body)}`);assert.equal(result.body.id, id);return result.body;
};
export const createClientUnit = async (request, id, input, options = {}) => {
  const result = await request(`/clients/${id}/billing-units`, {method: 'POST', body: input, ...options});
  assert.equal(result.status, 201, `real billing-unit command: ${JSON.stringify(result.body)}`);assert.equal(result.body.id, id);return result.body;
};
export const seedClientProfileClient = async (pool, {id = `synthetic-client-${randomUUID()}`, name = `Synthetic additional operational client ${id}`,
  scope = clientProfileScope, ownerId = commercialFixture.ownerId, status = 'Active', industry = 'Synthetic operational industry'} = {}) => {
  await pool.query(`insert into clients(id,name,industry,account_owner_id,status,organization_id,legal_entity_id) values($1,$2,$3,$4,$5,$6,$7)`,
    [id, name, industry, ownerId, status, scope.organizationId, scope.legalEntityId]);return id;
};
export const grantClientProfileTestPermissions = async (pool, {readerManage = false} = {}) => {
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
    values ('Admin','commercial.clients.view',true),('Admin','commercial.clients.manage',true),('Employee','commercial.clients.view',true)
    on conflict(role_name,permission_key) do update set enabled=excluded.enabled`);
  if (readerManage) await pool.query(`insert into role_permissions(role_name,permission_key,enabled) values('Employee','commercial.clients.manage',true)
    on conflict(role_name,permission_key) do update set enabled=excluded.enabled`);
};
export const withClientProfileApi = ({databaseUrl, identities, timeZone = 'UTC'}, test) => withCommercialApi({databaseUrl, identities, timeZone}, api => {
  const request = (path, options) => api.request(path.startsWith('/api/') ? path : `${clientProfilePrefix}${path}`, options);
  return test({...api, request, commercialRequest: api.request});
});
export const withClientProfilesJourney = async test => withCommercialDatabase(async ({pool, databaseUrl}) => {
  await withPreClientProfileMigrations(async rootDir => {
    const result = await runMigrations({pool, rootDir, logger: {log() {}}});assert.equal(result.status.currentVersion, '041_wos04_governed_lifecycle');
    const before = await clientProfileSnapshot(pool, preservedClientTables);
    for (const row of before.commercial_contract_versions) Object.assign(row.value, {installments: [], retainer_periods: [], service_dimensions: [], retainer_capacity_policy: null, retainer_overage_policy: null, retainer_rounding: null});
    for(const row of before.timesheet_entries){row.value.evidence_url=null;row.value.work_reference=null;row.value.source_identity=null;row.value.category_code=null;row.value.category_reference=null;} // additive 047/048 column
    const upgraded = await migrateCommercialDatabase(pool);assert.deepEqual(upgraded.applied, [clientProfileMigration, '043_wos04_governed_amendments', '044_wos04_work_submission_evidence','045_wos04_work_capture_policy','046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts', '082l_wos06_retainer_invoice_approval', '082m_wos06_retainer_invoice_csv', '082n_wos06_retainer_billing_confirmation', '082o_wos06_retainer_reversal_review', '082p_wos06_retainer_credit', '082q_wos08_archive_constraint_resolution', '082r_wos06_managed_service_dimensions', '082s_wos06_service_unit_evidence', '082t_wos06_service_unit_reviews', '082u_wos06_service_unit_contract_prices', '082v_wos06_accepted_unit_valuation']);
    assert.deepEqual(await clientProfileSnapshot(pool, preservedClientTables), before);
  }, {beforeCommercial: async rootDir => {
    const baseline = await runMigrations({pool, rootDir, logger: {log() {}}});assert.equal(baseline.status.currentVersion, '039_wos03_import_operation_contract');
    await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  }});
  const identities = await seedCommercialIdentities(pool);await grantClientProfileTestPermissions(pool);
  const today = await clientProfileToday(pool);
  await withClientProfileApi({databaseUrl, identities}, api => test({...api, pool, identities, today, scope: clientProfileScope,
    ownerId: commercialFixture.ownerId, clientId: commercialFixture.clientId}));
});
