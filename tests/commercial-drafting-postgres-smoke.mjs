import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {localDatabaseUrl} from './support/import-audit-journey.mjs';
import {
  commercialFixture as f, commercialPermissions, commercialServerDir,
  withCommercialDatabase, withPreCommercialMigrations, migrateCommercialDatabase,
  seedCommercialReferences, seedCommercialLegacyWork, seedCommercialIdentities, withCommercialApi,
} from './support/commercial-drafting-test.mjs';

// Database isolation is deliberately required. Do not convert missing PostgreSQL
// configuration or connection failures into a successful skip.
for (const url of [
  'https://localhost/test', 'postgres://example.test/test',
  'postgres://localhost/test?host=example.test', 'postgres://localhost/test?hostaddr=192.0.2.1',
  'postgres://localhost/test?dbname=shared', 'postgres://localhost/test?service=live',
  'postgres://localhost/test#override',
]) assert.throws(() => localDatabaseUrl(url), 'the local-only fixture must reject URL overrides and remote services');
assert.throws(() => localDatabaseUrl(undefined));
for (const host of ['localhost', '127.0.0.1', 'postgres', '[::1]']) {
  assert.equal(localDatabaseUrl(`postgres://${host}/test`).pathname, '/test');
}

const quietLogger = {log() {}};
const versionId = '040_wos04_commercial_drafting_foundation';
const year = new Date().getUTCFullYear() + 1;
const dates = Object.freeze({
  startsOn: `${year}-01-01`, endsOn: `${year + 3}-12-31`,
  engagementStart: `${year}-03-08`, engagementEnd: `${year}-11-07`, dueOn: `${year}-07-01`,
  revision: `${year + 1}-01-01`, later: `${year + 2}-01-01`,
});
const contractInput = (number = 'SYNTHETIC-CONTRACT-001', model = 'time_and_materials') => ({
  number, clientId: f.clientId, name: `Synthetic ${model} contract`, model,
  startsOn: dates.startsOn, endsOn: dates.endsOn, effectiveFrom: dates.startsOn,
  currency: 'USD', value: '12345678901234.1234', billingTerms: 'SYNTHETIC-CONFIDENTIAL-TERMS-7F3C; no billing authority.',
  documents: [{name: 'Synthetic metadata only', url: 'https://example.test/synthetic-contract.pdf'}],
  reason: 'SYNTHETIC-CONFIDENTIAL-REASON-29A4',
});
const revisionInput = (contract, overrides = {}) => {
  const {id, version, ...terms} = contract.versions[0];
  assert.ok(id);
  return {...terms, expectedVersion: contract.latestVersion, effectiveFrom: dates.revision,
    value: '98765432109876.4321', reason: 'Synthetic future contract revision', ...overrides};
};
const engagementInput = (contract, overrides = {}) => ({
  code: 'SYNTHETIC-ENGAGEMENT-001', name: 'Synthetic commercial engagement', model: contract.versions[0].model,
  ownerId: f.ownerId, startsOn: dates.engagementStart, endsOn: dates.engagementEnd,
  currency: 'USD', budget: '1500.1250', clientId: f.clientId, contractId: contract.id,
  contractVersionId: contract.versions[0].id, attributionId: null, reason: 'Synthetic engagement draft', ...overrides,
});
const internalInput = (model = 'internal', overrides = {}) => ({
  code: `SYNTHETIC-${model.toUpperCase()}`, name: `Synthetic ${model} engagement`, model,
  ownerId: f.ownerId, startsOn: dates.engagementStart, endsOn: dates.engagementEnd,
  currency: 'USD', budget: '10.0001', clientId: null, contractId: null, contractVersionId: null,
  attributionId: f.businessUnitId, reason: 'Synthetic non-billable engagement', ...overrides,
});
const poInput = (contract, overrides = {}) => ({
  contractId: contract.id, contractVersionId: contract.versions[0].id, number: 'SYNTHETIC-PO-001',
  value: '5000.1234', currency: 'USD', startsOn: dates.engagementStart, endsOn: dates.engagementEnd,
  warningThresholdPercent: '80.25', reason: 'Synthetic purchase order draft', ...overrides,
});
const milestoneInput = (engagement, overrides = {}) => ({
  engagementId: engagement.id, code: 'SYNTHETIC-MILESTONE-001', name: 'Synthetic milestone draft',
  dueOn: dates.dueOn, amount: engagement.billable ? '1000.0001' : '0.0000', currency: 'USD',
  reason: 'Synthetic milestone draft only', ...overrides,
});

const assertError = (result, status, code) => {
  assert.equal(result.status, status, `expected ${status}/${code}, received ${result.status}/${result.body?.error?.code}`);
  assert.equal(result.body?.error?.code, code);
  assert.ok(result.body.error.message);
  assert.equal(result.body.error.correlationId, result.response.headers.get('x-correlation-id'));
  assert.ok(result.body.error.correlationId, 'v1 errors must contain server request context');
  if (result.response.headers.get('x-operation-id')) {
    assert.equal(result.body.error.operationId, result.response.headers.get('x-operation-id'));
  }
  assert.equal(Object.hasOwn(result.body, 'id'), false, 'a rejected command must not look like a successful draft');
  assert.doesNotMatch(JSON.stringify(result.body), /postgres(?:ql)?:\/\/|constraint .* violates|insert into|select .* from/i,
    'error DTOs must not disclose SQL or connection details');
};
const created = async (request, path, body) => {
  const result = await request(path, {method: 'POST', body});
  assert.equal(result.status, 201, `${path} must persist through the real API: ${JSON.stringify(result.body)}`);
  assert.ok(result.body.id);
  return result.body;
};
const permissionDefaults = async pool => {
  assert.deepEqual((await pool.query(`select permission_key from permission_definitions
    where permission_key=any($1::text[]) order by permission_key`, [commercialPermissions])).rows.map(row => row.permission_key),
  [...commercialPermissions].sort(), 'fresh and upgrade installs must define both commercial permissions');
  assert.equal((await pool.query(`select count(*)::int count from role_permissions
    where permission_key=any($1::text[]) and enabled=true`, [commercialPermissions])).rows[0].count, 0,
  'new commercial definitions must not grant access to any role by default');
  assert.equal((await pool.query(`select count(*)::int count from user_permission_grants
    where permission_key=any($1::text[])`, [commercialPermissions])).rows[0].count, 0,
  'new commercial definitions must not create any user grant');
};
const legacySnapshot = async pool => {
  const snapshot = {};
  for (const table of ['clients', 'employees', 'projects', 'project_allocations', 'timesheets', 'timesheet_entries']) {
    snapshot[table] = (await pool.query(`select to_jsonb(source) snapshot from ${table} source order by id`)).rows.map(row => row.snapshot);
  }
  return snapshot;
};
const sqlRejects = (pool, text, values, code, label) => assert.rejects(pool.query(text, values), error => {
  assert.equal(error.code, code, label);
  return true;
}, label);
const cloneRow = async (pool, table, row, overrides = {}) => {
  const copy = {...row, ...overrides};
  const keys = Object.keys(copy);
  const values = keys.map(key => ['documents', 'installments', 'retainer_periods', 'service_dimensions', 'service_period_charges', 'source_snapshot'].includes(key) ? JSON.stringify(copy[key]) : copy[key]);
  return pool.query(`insert into ${table} (${keys.map(key => `"${key}"`).join(',')}) values (${keys.map((_, index) => `$${index + 1}`).join(',')})`, values);
};
const assertCloneRejected = async (pool, table, row, overrides, code, label) => {
  await assert.rejects(cloneRow(pool, table, row, overrides), error => { assert.equal(error.code, code, label); return true; }, label);
};

// Upgrade evidence is independent of the fresh install/API database. The actual
// runner applies an exact baseline plus 006..039 copied into a temporary root,
// then migration040 upgrades synthetic existing delivery/work records in place.
await withCommercialDatabase(async ({pool}) => {
  await withPreCommercialMigrations(async rootDir => {
    const beforeMigration = await runMigrations({pool, rootDir, logger: quietLogger});
    assert.equal(beforeMigration.status.isCurrent, true);
    assert.equal(beforeMigration.status.currentVersion, '039_wos03_import_operation_contract');
    assert.equal((await pool.query(`select to_regclass('commercial_contracts') name`)).rows[0].name, null);
    await seedCommercialReferences(pool);
    await seedCommercialLegacyWork(pool);
    const before = await legacySnapshot(pool);
    for(const row of before.timesheet_entries){row.evidence_url=null;row.work_reference=null;row.source_identity=null;row.category_code=null;row.category_reference=null;} // additive 047/048 column; all pre-existing fields still compare exactly
    const upgraded = await migrateCommercialDatabase(pool);
    assert.deepEqual(upgraded.applied, [versionId,'041_wos04_governed_lifecycle','042_wos04_scoped_client_profiles','043_wos04_governed_amendments', '044_wos04_work_submission_evidence','045_wos04_work_capture_policy','046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts', '082l_wos06_retainer_invoice_approval', '082m_wos06_retainer_invoice_csv', '082n_wos06_retainer_billing_confirmation', '082o_wos06_retainer_reversal_review', '082p_wos06_retainer_credit', '082q_wos08_archive_constraint_resolution', '082r_wos06_managed_service_dimensions', '082s_wos06_service_unit_evidence', '082t_wos06_service_unit_reviews', '082u_wos06_service_unit_contract_prices', '082v_wos06_accepted_unit_valuation', '082w_wos06_service_unit_eligibility', '082x_wos06_service_unit_invoice_drafts', '082y_wos06_service_unit_invoice_approval', '082z_wos06_service_unit_invoice_export','083_wos06_service_unit_corrections','084_wos06_service_period_charge_terms','085_wos06_service_period_reviews','086_wos06_service_period_valuation','087_wos06_service_period_eligibility','088_wos06_service_period_invoice_drafts','089_wos06_service_period_invoice_approval','090_wos06_service_period_invoice_export','091_wos06_service_period_credit_corrections','092_wos06_service_unit_effort_evidence','093_wos06_service_unit_effort_cost','094_wos06_managed_service_period_margin','095_wos06_fixed_fee_installment_identities','096_wos06_fixed_fee_invoice_approval','097_wos06_fixed_fee_invoice_export','098_wos06_fixed_fee_credit_corrections','099_wos06_fixed_fee_work_costs','100_wos06_fixed_fee_completion_forecasts','101_wos06_fixed_fee_elapsed_values','102_wos06_fixed_fee_margin_access','103_wos06_fixed_fee_progress_values','104_wos06_fixed_fee_transition_approval','105_wos06_fixed_fee_valuation_periods','106_wos06_fixed_fee_period_statements','107_wos06_fixed_fee_risk_notice_policies'], 'upgrade must apply all ordered append-only commercial migrations');
    assert.equal(upgraded.status.isCurrent, true);
    assert.deepEqual(await legacySnapshot(pool), before,
      'upgrade must preserve every project/client/employee/allocation/timesheet/work field, identity, date and commercial assumption');
    await permissionDefaults(pool);
    const mapping = (await pool.query(`select m.*,e.model,e.origin engagement_origin,e.contract_id,e.contract_version_id,
      e.client_id,e.currency,e.budget,e.billable,e.owner_id,e.created_by,e.starts_on::text,e.ends_on::text
      from project_engagement_mappings m join commercial_engagements e on e.id=m.engagement_id where m.project_id=$1`, [f.projectId])).rows[0];
    assert.equal(mapping.project_id, f.projectId);
    assert.equal(mapping.engagement_id, `legacy-engagement-${f.projectId}`);
    assert.equal(mapping.organization_id, f.organizationId);
    assert.equal(mapping.legal_entity_id, f.legalEntityId);
    assert.equal(mapping.origin, 'legacy-neutral');
    assert.equal(mapping.engagement_origin, 'legacy-neutral');
    assert.equal(mapping.model, 'legacy_unclassified');
    assert.equal(mapping.billable, false, 'migration must not infer billing authority from a previously billable project');
    for (const key of ['contract_id', 'contract_version_id', 'client_id', 'currency', 'budget', 'owner_id', 'created_by']) {
      assert.equal(mapping[key], null, `legacy-neutral mapping must not invent ${key}`);
    }
    assert.equal(mapping.starts_on, '2020-03-08');
    assert.equal(mapping.ends_on, '2021-11-07');
    assert.deepEqual(mapping.source_snapshot, before.projects[0], 'mapping must preserve the full original project snapshot');
    const migrationEvents = (await pool.query(`select * from commercial_draft_events where source='Migration'`)).rows;
    assert.equal(migrationEvents.length, 1, 'each neutral mapping must retain exactly one immutable conversion event');
    const migrationEvent = migrationEvents[0];
    assert.equal(migrationEvent.actor_id, null, 'migration must not invent a user identity');
    assert.equal(migrationEvent.system_identity, 'migration:040_wos04_commercial_drafting_foundation');
    assert.equal(migrationEvent.active_role, 'system');
    assert.equal(migrationEvent.organization_id, f.organizationId);
    assert.equal(migrationEvent.legal_entity_id, f.legalEntityId);
    assert.equal(migrationEvent.entity_type, 'Engagement');
    assert.equal(migrationEvent.entity_id, mapping.engagement_id);
    assert.equal(migrationEvent.action, 'Create Neutral Mapping');
    assert.equal(migrationEvent.before_value, null);
    assert.equal(migrationEvent.correlation_id, 'migration:040');
    assert.equal(migrationEvent.operation_id, `migration:040:${f.projectId}`);
    assert.deepEqual(migrationEvent.after_value.mapping.source_snapshot, before.projects[0]);
    assert.equal(migrationEvent.after_value.mapping.project_id, f.projectId);
    assert.equal(migrationEvent.after_value.engagement.id, mapping.engagement_id);
    assert.equal(migrationEvent.after_value.engagement.model, 'legacy_unclassified');
    assert.equal(migrationEvent.after_value.engagement.billable, false);
    assert.equal((await pool.query(`select count(*)::int count from users`)).rows[0].count, 0, 'neutral mapping audit must not seed a fictitious system account');
    const beforeReplay = (await pool.query(`select to_jsonb(m) snapshot from project_engagement_mappings m`)).rows;
    const replay = await migrateCommercialDatabase(pool);
    assert.deepEqual(replay.applied, [], 'replaying the migration runner must be a no-op');
    assert.deepEqual((await pool.query(`select to_jsonb(m) snapshot from project_engagement_mappings m`)).rows, beforeReplay);
    assert.deepEqual((await pool.query(`select * from commercial_draft_events where source='Migration'`)).rows, migrationEvents,
      'replay must not duplicate or rewrite the system conversion event');
    assert.deepEqual(await legacySnapshot(pool), before, 'replay must not change legacy IDs, work or snapshots');
    for (const table of ['commercial_engagements', 'project_engagement_mappings']) {
      await sqlRejects(pool, `update ${table} set organization_id=organization_id`, [], '55000', `${table} must reject even no-op rewrites`);
      await sqlRejects(pool, `delete from ${table}`, [], '55000', `${table} must reject deletion`);
    }
    await sqlRejects(pool, `update commercial_draft_events set reason=reason where id=$1`, [migrationEvent.id], '55000', 'conversion audit evidence must be immutable');
    assert.equal((await pool.query(`select count(*)::int count from project_engagement_mappings`)).rows[0].count, 1);
  });
});

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  const installed = await migrateCommercialDatabase(pool);
  assert.equal(installed.status.isCurrent, true);
  assert.ok(installed.applied.includes(versionId), 'fresh runner must include migration040');
  assert.equal((await pool.query(`select count(*)::int count from project_engagement_mappings`)).rows[0].count, 0);
  await permissionDefaults(pool);
  await seedCommercialReferences(pool);
  const identities = await seedCommercialIdentities(pool);
  await seedCommercialLegacyWork(pool); // Post-migration legacy work must stay explicitly unmapped.
  const originalLegacy = await legacySnapshot(pool);
  let contract;
  let engagement;
  let purchaseOrder;
  let milestone;
  let immutableFirstTerms;
  let canonicalDates;
  await withCommercialApi({databaseUrl, identities, timeZone: 'America/Los_Angeles'}, async ({request}) => {
    const identity = await request('/api/auth/me');
    assert.equal(identity.status, 200, 'synthetic signed sessions must still use the real identity middleware');
    assert.equal(identity.body.id, identities.manager.id);
    assert.equal(identity.body.activeRole, 'Admin');
    for (const permission of commercialPermissions) assert.ok(identity.body.permissions.includes(permission));
    assertError(await request('/workspace', {authenticated: false}), 401, 'AUTHENTICATION_REQUIRED');
    assertError(await request('/workspace', {identity: identities.denied}), 403, 'COMMERCIAL_PERMISSION_DENIED');
    assertError(await request('/workspace', {identity: identities.reader, role: 'Admin'}), 403, 'SESSION_ROLE_REVOKED');
    assertError(await request('/workspace', {scope: {organizationId: f.organizationId, legalEntityId: f.otherLegalEntityId}}), 403, 'ORG_SCOPE_DENIED');
    assertError(await request('/workspace', {scope: {organizationId: f.otherOrganizationId, legalEntityId: f.foreignLegalEntityId}}), 403, 'ORG_SCOPE_DENIED');
    for (const query of ['?asOf=not-a-date', '?asOf=2025-02-29', '?asOf=2028-02-30', '?organizationId=org-default', '?asOf=2026-01-01&status=Active']) {
      assertError(await request(`/workspace${query}`), 400, 'COMMERCIAL_INVALID_REQUEST');
    }
    const empty = await request(`/workspace?asOf=${dates.startsOn}`, {identity: identities.reader});
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.contracts, []);
    assert.deepEqual(empty.body.engagements, []);
    assert.deepEqual(empty.body.purchaseOrders, []);
    assert.deepEqual(empty.body.milestones, []);
    assert.deepEqual(empty.body.legacyMappings, {totalProjects: 1, mappedProjects: 0}, 'post-migration projects must not acquire inferred commercial meaning');
    assert.equal(empty.body.limits.pageSize, 200);
    for (const truncated of Object.values(empty.body.limits.truncated)) assert.equal(truncated, false);
    assert.deepEqual(empty.body.choices.clients.map(row => row.id), [f.clientId]);
    assert.deepEqual(empty.body.choices.owners.map(row => row.id), [f.ownerId]);
    assert.deepEqual(empty.body.choices.attributions.map(row => row.id).sort(), [f.businessUnitId, f.costCentreId, f.sharedBusinessUnitId].sort());
    assertError(await request('/contracts', {method: 'POST', body: contractInput(), identity: identities.reader}), 403, 'COMMERCIAL_PERMISSION_DENIED');
    for (const [key, value] of Object.entries({organizationId: f.otherOrganizationId, legalEntityId: f.otherLegalEntityId,
      createdBy: identities.denied.id, actorId: identities.denied.id, activeRole: 'Admin', status: 'Active', billable: true,
      billingEligible: true, latestVersion: 99})) {
      assertError(await request('/contracts', {method: 'POST', body: {...contractInput(), [key]: value}}), 400, 'COMMERCIAL_INVALID_REQUEST');
    }
    for (const value of [123.45, '-1', '1e3', '01.2', '0.00001', '100000000000000', 'NaN', 'Infinity']) {
      assertError(await request('/contracts', {method: 'POST', body: {...contractInput(), value}}), 400, 'COMMERCIAL_INVALID_REQUEST');
    }
    const syntheticUserinfoUrl = new URL('https://example.test/file');
    syntheticUserinfoUrl.username = 'example-user';
    syntheticUserinfoUrl.password = 'example-password';
    for (const url of ['http://example.test/file', 'javascript:alert(1)', 'file:///tmp/file', syntheticUserinfoUrl.toString()]) {
      assertError(await request('/contracts', {method: 'POST', body: {...contractInput(), documents: [{name: 'Synthetic unsafe metadata', url}]}}), 400, 'COMMERCIAL_INVALID_REQUEST');
    }
    for (const clientId of [f.otherClientId, f.foreignClientId, 'client-synthetic-missing']) {
      assertError(await request('/contracts', {method: 'POST', body: {...contractInput(), clientId}}), 404, 'COMMERCIAL_REFERENCE_NOT_FOUND');
    }
    contract = await created(request, '/contracts', contractInput());
    assert.equal(contract.status, 'Draft');
    assert.equal(contract.latestVersion, 1);
    assert.equal(contract.versions.length, 1);
    immutableFirstTerms = structuredClone(contract.versions[0]);
    assertError(await request(`/contracts/${contract.id}`, {identity: identities.denied}), 403, 'COMMERCIAL_PERMISSION_DENIED');
    // Existing user-grant active_role is grantor audit metadata, not a recipient
    // role condition. Test only a synthetic grant, then remove that fixture.
    await pool.query(`update role_permissions set enabled=false where role_name='Employee' and permission_key='commercial.contracts.view'`);
    try {
      assertError(await request(`/contracts/${contract.id}`, {identity: identities.reader}), 403, 'COMMERCIAL_PERMISSION_DENIED');
      await pool.query(`insert into user_permission_grants(user_id,permission_key,granted_by,active_role)
        values ($1,'commercial.contracts.view',$2,'Admin')`, [identities.reader.id, identities.manager.id]);
      const grantedRead = await request(`/contracts/${contract.id}`, {identity: identities.reader});
      assert.equal(grantedRead.status, 200, 'a recipient Employee must honor an explicit view grant whose grantor audit metadata says Admin');
      assert.deepEqual(grantedRead.body, contract);
    } finally {
      await pool.query(`delete from user_permission_grants where user_id=$1 and permission_key='commercial.contracts.view'`, [identities.reader.id]);
      await pool.query(`update role_permissions set enabled=true where role_name='Employee' and permission_key='commercial.contracts.view'`);
    }
    assert.equal(immutableFirstTerms.value, '12345678901234.1234', 'numeric18,4 amounts must retain all significant decimal digits');
    assert.equal(immutableFirstTerms.effectiveFrom, dates.startsOn);
    assert.equal(immutableFirstTerms.startsOn, dates.startsOn);
    assert.equal(immutableFirstTerms.endsOn, dates.endsOn);
    assertError(await request('/contracts', {method: 'POST', body: contractInput()}), 409, 'COMMERCIAL_DUPLICATE');
    assert.equal((await pool.query('select count(*)::int count from commercial_contracts')).rows[0].count, 1);
    const contracts = new Map([['time_and_materials', contract]]);
    for (const model of ['fixed_fee', 'milestone', 'retainer', 'managed_service']) {
      contracts.set(model, await created(request, '/contracts', contractInput(`SYNTHETIC-${model.toUpperCase()}`, model)));
    }
    const engagements = new Map();
    for (const [model, modelContract] of contracts) {
      const draft = await created(request, '/engagements', engagementInput(modelContract, {code: `SYNTHETIC-${model.toUpperCase()}`}));
      assert.equal(draft.model, model);
      assert.equal(draft.origin, 'manual');
      assert.equal(draft.billable, true);
      assert.equal(draft.status, 'Draft');
      assert.equal(draft.contractVersionId, modelContract.versions[0].id);
      assert.equal(draft.budget, '1500.1250');
      engagements.set(model, draft);
    }
    engagement = engagements.get('time_and_materials');
    for (const [model, attributionId] of [['internal', f.businessUnitId], ['pre_sales', f.costCentreId]]) {
      const draft = await created(request, '/engagements', internalInput(model, {attributionId}));
      assert.equal(draft.model, model);
      assert.equal(draft.billable, false);
      assert.equal(draft.contractId, null);
      assert.equal(draft.contractVersionId, null);
      assert.equal(draft.attributionId, attributionId);
      engagements.set(model, draft);
      const zero = await created(request, '/milestones', milestoneInput(draft));
      assert.equal(zero.amount, '0.0000');
      assert.equal(zero.billingEligible, false);
      assertError(await request('/milestones', {method: 'POST', body: milestoneInput(draft, {code: 'SYNTHETIC-NONZERO', amount: '0.0001'})}), 422, 'COMMERCIAL_INTERNAL_POLICY');
    }
    await created(request, '/engagements', internalInput('internal', {code: 'SYNTHETIC-SHARED-BU', attributionId: f.sharedBusinessUnitId}));
    assert.equal(engagements.size, 7, 'all seven required engagement models must persist via the actual API');
    for (const [path, input] of [['/engagements', engagementInput(contract)], ['/purchase-orders', poInput(contract)],
      ['/milestones', milestoneInput(engagement)]]) {
      for (const [key, value] of Object.entries({organizationId: f.otherOrganizationId, legalEntityId: f.otherLegalEntityId,
        createdBy: identities.denied.id, actorId: identities.denied.id, status: 'Approved', billingEligible: true})) {
        assertError(await request(path, {method: 'POST', body: {...input, [key]: value}}), 400, 'COMMERCIAL_INVALID_REQUEST');
      }
      assertError(await request(path, {method: 'POST', body: input, identity: identities.reader}), 403, 'COMMERCIAL_PERMISSION_DENIED');
    }
    for (const attributionId of [f.inactiveAttributionId, f.expiredAttributionId, f.futureAttributionId,
      f.otherAttributionId, f.foreignAttributionId, f.invalidTypeAttributionId, 'catalog-synthetic-missing']) {
      assertError(await request('/engagements', {method: 'POST', body: internalInput('internal', {code: 'SYNTHETIC-INVALID-BU', attributionId})}), 404, 'COMMERCIAL_REFERENCE_NOT_FOUND');
    }
    for (const body of [internalInput('internal', {attributionId: null}), internalInput('pre_sales', {contractId: contract.id}),
      internalInput('internal', {contractVersionId: contract.versions[0].id})]) {
      assertError(await request('/engagements', {method: 'POST', body}), 422, 'COMMERCIAL_INTERNAL_POLICY');
    }
    for (const ownerId of [f.otherOwnerId, f.foreignOwnerId, 'owner-synthetic-missing']) {
      assertError(await request('/engagements', {method: 'POST', body: engagementInput(contract, {ownerId})}), 404, 'COMMERCIAL_REFERENCE_NOT_FOUND');
    }
    for (const [column, value] of [['status', 'Exited'], ['joining_date', dates.revision], ['exit_date', dates.startsOn]]) {
      await pool.query(`update employees set ${column}=$1 where id=$2`, [value, f.ownerId]);
      try {
        assertError(await request('/engagements', {method: 'POST', body: engagementInput(contract)}), 404, 'COMMERCIAL_REFERENCE_NOT_FOUND');
      } finally {
        await pool.query(`update employees set ${column}=$1 where id=$2`, [column === 'status' ? 'Active' : null, f.ownerId]);
      }
    }
    for (const body of [engagementInput(contract, {currency: 'EUR'}), engagementInput(contract, {model: 'fixed_fee'}),
      engagementInput(contract, {startsOn: `${year - 1}-12-31`}), engagementInput(contract, {endsOn: `${year + 4}-01-01`})]) {
      assertError(await request('/engagements', {method: 'POST', body}), 422, 'COMMERCIAL_TERMS_MISMATCH');
    }
    assertError(await request('/engagements', {method: 'POST', body: engagementInput(contract,
      {contractVersionId: contracts.get('fixed_fee').versions[0].id})}), 404, 'COMMERCIAL_REFERENCE_NOT_FOUND');
    assertError(await request('/engagements', {method: 'POST', body: engagementInput(contract, {contractId: null})}), 422, 'COMMERCIAL_CONTRACT_REQUIRED');
    assertError(await request('/engagements', {method: 'POST', body: engagementInput(contract, {billable: false})}), 400, 'COMMERCIAL_INVALID_REQUEST');
    assertError(await request('/engagements', {method: 'POST', body: engagementInput(contract, {code: engagement.code})}), 409, 'COMMERCIAL_DUPLICATE');
    purchaseOrder = await created(request, '/purchase-orders', poInput(contract));
    assert.equal(purchaseOrder.status, 'Draft');
    assert.equal(purchaseOrder.value, '5000.1234');
    assert.equal(purchaseOrder.warningThresholdPercent, '80.25');
    assert.equal(purchaseOrder.startsOn, dates.engagementStart);
    assert.equal(purchaseOrder.endsOn, dates.engagementEnd);
    assertError(await request('/purchase-orders', {method: 'POST', body: poInput(contract)}), 409, 'COMMERCIAL_DUPLICATE');
    assertError(await request('/purchase-orders', {method: 'POST', body: poInput(contract, {currency: 'EUR'})}), 422, 'COMMERCIAL_TERMS_MISMATCH');
    for (const warningThresholdPercent of ['100.01', '-1', '1.001', 80]) {
      assertError(await request('/purchase-orders', {method: 'POST', body: poInput(contract, {warningThresholdPercent})}), 400, 'COMMERCIAL_INVALID_REQUEST');
    }
    milestone = await created(request, '/milestones', milestoneInput(engagement));
    assert.equal(milestone.status, 'Draft');
    assert.equal(milestone.billingEligible, false, 'draft milestones never constitute acceptance or billing authority');
    assert.equal(milestone.amount, '1000.0001');
    assert.equal(milestone.dueOn, dates.dueOn);
    assertError(await request('/milestones', {method: 'POST', body: milestoneInput(engagement)}), 409, 'COMMERCIAL_DUPLICATE');
    assertError(await request('/milestones', {method: 'POST', body: milestoneInput(engagement, {currency: 'EUR'})}), 422, 'COMMERCIAL_TERMS_MISMATCH');
    assertError(await request('/milestones', {method: 'POST', body: milestoneInput(engagement, {dueOn: dates.startsOn})}), 422, 'COMMERCIAL_TERMS_MISMATCH');
    assertError(await request('/milestones', {method: 'POST', body: milestoneInput(engagement, {status: 'Accepted'})}), 400, 'COMMERCIAL_INVALID_REQUEST');
    assertError(await request('/milestones', {method: 'POST', body: milestoneInput(engagement, {engagementId: `legacy-engagement-${f.projectId}`})}), 404, 'COMMERCIAL_REFERENCE_NOT_FOUND');

    // The database creates foreign-scope drafts solely as negative-test fixtures.
    // They are never communicated or exposed via the authorized local scope.
    const foreignRoots = [];
    for (const [organizationId, legalEntityId, clientId] of [[f.otherOrganizationId, f.foreignLegalEntityId, f.foreignClientId],
      [f.organizationId, f.otherLegalEntityId, f.otherClientId]]) {
      const foreignContract = `contract-${randomUUID()}`;
      const foreignTerms = `contract-version-${randomUUID()}`;
      const foreignEngagement = `engagement-${randomUUID()}`;
      const fixtureConnection = await pool.connect();
      try {
        await fixtureConnection.query('begin');
        await fixtureConnection.query(`insert into commercial_contracts(id,organization_id,legal_entity_id,client_id,number,created_by)
          values ($1,$2,$3,$4,'SYNTHETIC-FOREIGN-CONTRACT',$5)`, [foreignContract, organizationId, legalEntityId, clientId, identities.manager.id]);
        await fixtureConnection.query(`insert into commercial_contract_versions(id,organization_id,legal_entity_id,contract_id,version,
          effective_from,name,model,starts_on,ends_on,currency,value,billing_terms,reason,created_by)
          values ($1,$2,$3,$4,1,$5,'Synthetic foreign terms','time_and_materials',$5,$6,'USD',1,'Synthetic only','Synthetic fixture',$7)`,
        [foreignTerms, organizationId, legalEntityId, foreignContract, dates.startsOn, dates.endsOn, identities.manager.id]);
        await fixtureConnection.query(`insert into commercial_engagements(id,organization_id,legal_entity_id,code,name,model,
          owner_id,client_id,contract_id,contract_version_id,starts_on,ends_on,currency,budget,billable,reason,created_by)
          values ($1,$2,$3,'SYNTHETIC-FOREIGN-ENGAGEMENT','Synthetic foreign engagement','time_and_materials',
          $4,$5,$6,$7,$8,$9,'USD',1,true,'Synthetic fixture',$10)`,
        [foreignEngagement, organizationId, legalEntityId, organizationId === f.organizationId ? f.otherOwnerId : f.foreignOwnerId,
          clientId, foreignContract, foreignTerms, dates.engagementStart, dates.engagementEnd, identities.manager.id]);
        await fixtureConnection.query('commit');
      } catch (error) { await fixtureConnection.query('rollback'); throw error; } finally { fixtureConnection.release(); }
      foreignRoots.push(foreignContract);
      assertError(await request(`/contracts/${foreignContract}`), 404, 'COMMERCIAL_NOT_FOUND');
      assertError(await request(`/contracts/${foreignContract}/versions`, {method: 'POST', body: revisionInput(contract)}), 404, 'COMMERCIAL_NOT_FOUND');
      for (const [path, body] of [
        ['/engagements', engagementInput(contract, {contractId: foreignContract, contractVersionId: foreignTerms})],
        ['/purchase-orders', poInput(contract, {contractId: foreignContract, contractVersionId: foreignTerms})],
        ['/milestones', milestoneInput(engagement, {engagementId: foreignEngagement})],
      ]) assertError(await request(path, {method: 'POST', body}), 404, 'COMMERCIAL_REFERENCE_NOT_FOUND');
    }

    const beforeConcurrent = (await request(`/contracts/${contract.id}`, {identity: identities.reader})).body;
    assert.deepEqual(beforeConcurrent, contract);
    const concurrent = await Promise.all([
      request(`/contracts/${contract.id}/versions`, {method: 'POST', body: revisionInput(contract, {name: 'Synthetic revision contender A', endsOn: `${year + 1}-06-30`})}),
      request(`/contracts/${contract.id}/versions`, {method: 'POST', body: revisionInput(contract, {name: 'Synthetic revision contender B', endsOn: `${year + 1}-06-30`})}),
    ]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409], 'concurrent expectedVersion tokens must have exactly one winner');
    assertError(concurrent.find(result => result.status === 409), 409, 'COMMERCIAL_VERSION_CONFLICT');
    contract = concurrent.find(result => result.status === 201).body;
    assert.equal(contract.latestVersion, 2);
    assert.deepEqual(contract.versions.map(terms => terms.version), [2, 1]);
    assert.deepEqual(contract.versions[1], immutableFirstTerms, 'revision must not mutate any original term');
    assert.equal(contract.versions[0].effectiveFrom, dates.revision);
    assert.equal(contract.versions[0].value, '98765432109876.4321');
    assertError(await request(`/contracts/${contract.id}/versions`, {method: 'POST', body: revisionInput(beforeConcurrent)}), 409, 'COMMERCIAL_VERSION_CONFLICT');
    for (const effectiveFrom of [dates.startsOn, dates.revision]) {
      assertError(await request(`/contracts/${contract.id}/versions`, {method: 'POST', body: revisionInput(contract, {effectiveFrom})}), 409, 'COMMERCIAL_EFFECTIVE_DATE_CONFLICT');
    }
    for (const overrides of [{model: 'fixed_fee'}, {currency: 'EUR'}]) {
      assertError(await request(`/contracts/${contract.id}/versions`, {method: 'POST', body: revisionInput(contract, {effectiveFrom: dates.later, endsOn: dates.endsOn, ...overrides})}), 409, 'COMMERCIAL_IDENTITY_CONFLICT');
    }
    const utcToday = new Date().toISOString().slice(0, 10);
    const currentDateContract = await created(request, '/contracts', {...contractInput('SYNTHETIC-CURRENT-DATE'),
      name: 'Synthetic current UTC date authority contract', startsOn: `${year - 2}-01-01`, effectiveFrom: `${year - 2}-01-01`});
    assertError(await request(`/contracts/${currentDateContract.id}/versions`, {method: 'POST',
      body: revisionInput(currentDateContract, {effectiveFrom: utcToday})}), 409, 'COMMERCIAL_EFFECTIVE_DATE_CONFLICT');
    const oldContract = {...contract, versions: [immutableFirstTerms]};
    assertError(await request('/engagements', {method: 'POST', body: engagementInput(oldContract, {
      code: 'SYNTHETIC-STALE-TERMS', startsOn: dates.revision, endsOn: `${year + 1}-02-01`,
    })}), 409, 'COMMERCIAL_TERMS_SUPERSEDED');
    assertError(await request('/purchase-orders', {method: 'POST', body: poInput(oldContract, {
      number: 'SYNTHETIC-STALE-PO', startsOn: dates.revision, endsOn: `${year + 1}-02-01`,
    })}), 409, 'COMMERCIAL_TERMS_SUPERSEDED');
    await created(request, '/engagements', engagementInput(contract, {
      code: 'SYNTHETIC-FUTURE-TERMS', startsOn: dates.revision, endsOn: `${year + 1}-02-01`,
    }));
    const asOfOriginal = await request(`/workspace?asOf=${dates.engagementStart}`, {identity: identities.reader});
    assert.equal(asOfOriginal.status, 200);
    const originalRoot = asOfOriginal.body.contracts.find(row => row.id === contract.id);
    assert.equal(originalRoot.currentTerms.id, immutableFirstTerms.id);
    assert.equal(originalRoot.terms.id, contract.versions[0].id);
    const asOfFuture = await request(`/workspace?asOf=${dates.revision}`);
    assert.equal(asOfFuture.body.contracts.find(row => row.id === contract.id).currentTerms.id, contract.versions[0].id);
    const asOfInitialBoundary = await request(`/workspace?asOf=${dates.startsOn}`);
    assert.equal(asOfInitialBoundary.body.contracts.find(row => row.id === contract.id).currentTerms.id, immutableFirstTerms.id);
    const asOfNewEnd = await request(`/workspace?asOf=${year + 1}-06-30`);
    assert.equal(asOfNewEnd.body.contracts.find(row => row.id === contract.id).currentTerms.id, contract.versions[0].id,
      'a contract is in range on the inclusive final date of its applicable terms');
    const asOfExpiredNewTerms = await request(`/workspace?asOf=${year + 1}-07-01`);
    assert.equal(asOfExpiredNewTerms.body.contracts.find(row => row.id === contract.id).currentTerms, null,
      'a newer shortened term must expire without reviving older superseded terms that end later');
    const asOfAllExpired = await request(`/workspace?asOf=${year + 4}-01-01`);
    assert.equal(asOfAllExpired.body.contracts.find(row => row.id === contract.id).currentTerms, null);
    const asOfBefore = await request(`/workspace?asOf=${year - 1}-12-31`);
    assert.equal(asOfBefore.body.contracts.find(row => row.id === contract.id).currentTerms, null);
    assert.equal(asOfOriginal.body.engagements.find(row => row.id === engagement.id).contractVersionId, immutableFirstTerms.id,
      'later terms must not rewrite existing engagement version pins');
    assert.equal(asOfOriginal.body.purchaseOrders.find(row => row.id === purchaseOrder.id).contractVersionId, immutableFirstTerms.id,
      'later terms must not rewrite existing PO version pins');
    assert.equal(asOfOriginal.body.contracts.some(row => foreignRoots.includes(row.id)), false, 'workspace must not disclose foreign-scope roots');
    canonicalDates = {contract: (await request(`/contracts/${contract.id}`)).body, workspace: asOfOriginal.body};

    // Force a required audit insert to fail inside the actual command transaction.
    // An apparently successful draft with missing audit evidence must be impossible.
    const auditBefore = (await pool.query(`select count(*)::int count from audit_logs where module='Commercial Drafting'`)).rows[0].count;
    const protectedBefore = (await pool.query(`select count(*)::int count from commercial_draft_events`)).rows[0].count;
    const rootsBefore = (await pool.query(`select count(*)::int count from commercial_contracts`)).rows[0].count;
    const termsBefore = (await pool.query(`select count(*)::int count from commercial_contract_versions`)).rows[0].count;
    await pool.query(`create function commercial_test_reject_audit() returns trigger language plpgsql as $$
      begin if new.module='Commercial Drafting' then raise exception 'Synthetic audit failure' using errcode='P0001'; end if; return new; end $$`);
    await pool.query(`create trigger commercial_test_reject_audit before insert on audit_logs
      for each row execute function commercial_test_reject_audit()`);
    try {
      assertError(await request('/contracts', {method: 'POST', body: contractInput('SYNTHETIC-AUDIT-ROLLBACK')}), 503, 'COMMERCIAL_UNAVAILABLE');
      assert.equal((await pool.query(`select count(*)::int count from commercial_contracts`)).rows[0].count, rootsBefore);
      assert.equal((await pool.query(`select count(*)::int count from audit_logs where module='Commercial Drafting'`)).rows[0].count, auditBefore);
      assert.equal((await pool.query(`select count(*)::int count from commercial_draft_events`)).rows[0].count, protectedBefore,
        'failed general audit persistence must also roll back protected material evidence');
      assert.equal((await pool.query(`select count(*)::int count from commercial_contract_versions`)).rows[0].count, termsBefore);
    } finally {
      await pool.query('drop trigger commercial_test_reject_audit on audit_logs');
      await pool.query('drop function commercial_test_reject_audit()');
    }
  });

  // Real second API process in a UTC+14 zone must return byte-equivalent date
  // strings and decimal DTOs to the UTC-7 process, including DST-boundary dates.
  await withCommercialApi({databaseUrl, identities, timeZone: 'Pacific/Kiritimati'}, async ({request}) => {
    assert.deepEqual((await request(`/contracts/${contract.id}`)).body, canonicalDates.contract);
    assert.deepEqual((await request(`/workspace?asOf=${dates.engagementStart}`)).body, canonicalDates.workspace);
  });
  const connection = await pool.connect();
  try {
    let first;
    for (const timeZone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      await connection.query('select set_config(\'TimeZone\',$1,false)', [timeZone]);
      const value = (await connection.query(`select effective_from::text,starts_on::text,ends_on::text,value::text
        from commercial_contract_versions where id=$1`, [immutableFirstTerms.id])).rows[0];
      if (first) assert.deepEqual(value, first, 'database date-as-text projections must be invariant under PostgreSQL session timezone');
      else first = value;
      assert.equal(value.effective_from, dates.startsOn);
      assert.equal(value.value, '12345678901234.1234');
    }
  } finally { connection.release(); }

  const [root, terms, engagementRow, po, milestoneRow] = await Promise.all([
    pool.query('select * from commercial_contracts where id=$1', [contract.id]),
    pool.query('select * from commercial_contract_versions where id=$1', [immutableFirstTerms.id]),
    pool.query('select * from commercial_engagements where id=$1', [engagement.id]),
    pool.query('select * from commercial_purchase_orders where id=$1', [purchaseOrder.id]),
    pool.query('select * from commercial_milestones where id=$1', [milestone.id]),
  ]).then(results => results.map(result => result.rows[0]));
  for (const [table, row] of [['commercial_contract_versions', terms], ['commercial_engagements', engagementRow],
    ['commercial_purchase_orders', po], ['commercial_milestones', milestoneRow]]) {
    await sqlRejects(pool, `update ${table} set reason=reason where id=$1`, [row.id], '55000', `${table} must be immutable`);
    await sqlRejects(pool, `delete from ${table} where id=$1`, [row.id], '55000', `${table} must not be deleted`);
  }
  await sqlRejects(pool, `update commercial_contracts set number='SYNTHETIC-REWRITE' where id=$1`, [root.id], '55000', 'contract identity must remain stable');
  await sqlRejects(pool, 'update commercial_contracts set latest_version=latest_version+2 where id=$1', [root.id], '55000', 'root version token must not skip versions');
  await sqlRejects(pool, 'update commercial_contracts set latest_version=latest_version+1 where id=$1', [root.id], '23503', 'deferred root pointer FK must reject a missing next term version at commit');
  await sqlRejects(pool, 'delete from commercial_contracts where id=$1', [root.id], '55000', 'contract roots must not be deleted');
  await assertCloneRejected(pool, 'commercial_contracts', root, {id: `contract-${randomUUID()}`}, '23505', 'contract number uniqueness must be scoped');
  await assertCloneRejected(pool, 'commercial_contracts', root, {id: `contract-${randomUUID()}`, number: 'SYNTHETIC-FOREIGN-CLIENT', client_id: f.foreignClientId}, '23503', 'root client FK must reject cross-organization references');
  await assertCloneRejected(pool, 'commercial_contracts', root, {id: `contract-${randomUUID()}`, number: 'SYNTHETIC-OTHER-CLIENT', client_id: f.otherClientId}, '23503', 'root client FK must reject cross-legal references');
  await assertCloneRejected(pool, 'commercial_contract_versions', terms, {id: `contract-version-${randomUUID()}`, version: 5, effective_from: dates.later, currency: 'usd'}, '23514', 'terms must enforce ISO currency shape');
  await assertCloneRejected(pool, 'commercial_contract_versions', terms, {id: `contract-version-${randomUUID()}`, version: 5, effective_from: dates.later, value: '-0.0001'}, '23514', 'terms must reject negative amounts');
  await assertCloneRejected(pool, 'commercial_contract_versions', terms, {id: `contract-version-${randomUUID()}`, version: 5, effective_from: dates.later, value: '100000000000000'}, '22003', 'terms must enforce numeric18,4 precision');
  await assertCloneRejected(pool, 'commercial_contract_versions', terms, {id: `contract-version-${randomUUID()}`, version: 5, effective_from: dates.later, model: 'internal'}, '23514', 'contract terms must reject internal-only models');
  await assertCloneRejected(pool, 'commercial_engagements', engagementRow, {id: `engagement-${randomUUID()}`, code: 'SYNTHETIC-CROSS-LEGAL-OWNER', owner_id: f.otherOwnerId}, '23503', 'engagement owner FK must reject cross-legal references');
  await assertCloneRejected(pool, 'commercial_engagements', engagementRow, {id: `engagement-${randomUUID()}`, code: 'SYNTHETIC-CROSS-ORG-OWNER', owner_id: f.foreignOwnerId}, '23503', 'engagement owner FK must reject cross-organization references');
  await assertCloneRejected(pool, 'commercial_engagements', engagementRow, {id: `engagement-${randomUUID()}`, code: 'SYNTHETIC-INTERNAL-BILLABLE', model: 'internal', contract_id: null, contract_version_id: null, attribution_id: f.businessUnitId}, '23514', 'database must enforce nonbillability for internal models');
  await assertCloneRejected(pool, 'commercial_engagements', engagementRow, {id: `engagement-${randomUUID()}`, code: 'SYNTHETIC-STATUS-ESCALATION', status: 'Active'}, '23514', 'engagement lifecycle remains draft-only');
  await assertCloneRejected(pool, 'commercial_purchase_orders', po, {id: `po-${randomUUID()}`, number: 'SYNTHETIC-PO-THRESHOLD', warning_threshold_percent: '100.01'}, '23514', 'PO threshold must stay within bounds');
  await assertCloneRejected(pool, 'commercial_purchase_orders', po, {id: `po-${randomUUID()}`, number: 'SYNTHETIC-PO-STATUS', status: 'Approved'}, '23514', 'POs remain draft-only');
  await assertCloneRejected(pool, 'commercial_milestones', milestoneRow, {id: `milestone-${randomUUID()}`, code: 'SYNTHETIC-ACCEPTED', status: 'Accepted'}, '23514', 'milestone acceptance is unavailable');
  await assertCloneRejected(pool, 'commercial_milestones', milestoneRow, {id: `milestone-${randomUUID()}`, code: 'SYNTHETIC-CROSS-SCOPE', legal_entity_id: f.otherLegalEntityId}, '23503', 'milestones must pin same-scope engagements');
  const scopedIdentityClient = await pool.connect();
  try {
    // The same business identifiers are valid in another legal entity, with
    // matching references. Roll back this fixture so API/audit totals stay exact.
    await scopedIdentityClient.query('begin');
    const otherContract = `contract-${randomUUID()}`;
    const otherTerms = `contract-version-${randomUUID()}`;
    const otherEngagement = `engagement-${randomUUID()}`;
    await cloneRow(scopedIdentityClient, 'commercial_contracts', root, {id: otherContract, legal_entity_id: f.otherLegalEntityId,
      client_id: f.otherClientId, latest_version: 1});
    await cloneRow(scopedIdentityClient, 'commercial_contract_versions', terms, {id: otherTerms, legal_entity_id: f.otherLegalEntityId,
      contract_id: otherContract, version: 1});
    await cloneRow(scopedIdentityClient, 'commercial_engagements', engagementRow, {id: otherEngagement, legal_entity_id: f.otherLegalEntityId,
      client_id: f.otherClientId, owner_id: f.otherOwnerId, contract_id: otherContract, contract_version_id: otherTerms});
    await cloneRow(scopedIdentityClient, 'commercial_purchase_orders', po, {id: `po-${randomUUID()}`, legal_entity_id: f.otherLegalEntityId,
      contract_id: otherContract, contract_version_id: otherTerms});
    await cloneRow(scopedIdentityClient, 'commercial_milestones', milestoneRow, {id: `milestone-${randomUUID()}`, legal_entity_id: f.otherLegalEntityId,
      engagement_id: otherEngagement});
    await scopedIdentityClient.query('set constraints all immediate');
  } finally {
    try { await scopedIdentityClient.query('rollback'); } finally { scopedIdentityClient.release(); }
  }

  const audits = (await pool.query(`select * from audit_logs where module='Commercial Drafting' order by created_at,id`)).rows;
  const successfulDrafts = (await pool.query(`select ((select count(*) from commercial_contracts where organization_id=$1 and legal_entity_id=$2)
    +(select count(*) from commercial_engagements where origin='manual' and organization_id=$1 and legal_entity_id=$2)
    +(select count(*) from commercial_purchase_orders where organization_id=$1 and legal_entity_id=$2)
    +(select count(*) from commercial_milestones where organization_id=$1 and legal_entity_id=$2)+1)::int count`, [f.organizationId, f.legalEntityId])).rows[0].count;
  assert.equal(audits.length, successfulDrafts, 'each successful create and the single winning append must have exactly one audit record; rejected commands have none');
  for (const audit of audits) {
    assert.equal(audit.user_id, identities.manager.id);
    assert.equal(audit.user_name, identities.manager.username);
    assert.equal(audit.active_role, 'Admin');
    assert.equal(audit.user_role, 'Admin');
    assert.equal(audit.organization_id, f.organizationId);
    assert.equal(audit.legal_entity_id, f.legalEntityId);
    assert.equal(audit.source, 'Web');
    assert.ok(audit.entity_id && audit.entity_type && audit.reason && audit.created_at);
    assert.ok(audit.correlation_id && audit.operation_id, 'actual API mutations must retain request and operation identities');
    assert.deepEqual(Object.keys(audit.new_value).sort(), ['commercialEventId', 'snapshot'], 'general audit must contain only an opaque protected-evidence pointer');
    assert.equal(audit.new_value.snapshot, 'after');
  }
  assert.doesNotMatch(JSON.stringify(audits), /SYNTHETIC-CONFIDENTIAL-(?:TERMS-7F3C|REASON-29A4)|12345678901234\.1234|98765432109876\.4321|example\.test\/synthetic-contract\.pdf/,
    'general audit readers must not receive confidential values, documents or user-entered reasons');
  const events = (await pool.query(`select * from commercial_draft_events order by created_at,id`)).rows;
  assert.equal(events.length, successfulDrafts, 'each successful draft transaction must retain one protected full-material event');
  for (const event of events) {
    assert.equal(event.actor_id, identities.manager.id);
    assert.equal(event.active_role, 'Admin');
    assert.equal(event.organization_id, f.organizationId);
    assert.equal(event.legal_entity_id, f.legalEntityId);
    assert.equal(event.source, 'Web');
    assert.ok(event.reason && event.correlation_id && event.operation_id && event.entity_id && event.entity_type && event.created_at);
    const pointer = audits.find(row => row.new_value.commercialEventId === event.id);
    assert.ok(pointer, 'protected event and general audit must link atomically');
    assert.equal(pointer.entity_id, event.entity_id);
    assert.equal(pointer.correlation_id, event.correlation_id);
    assert.equal(pointer.operation_id, event.operation_id);
    assert.equal(pointer.action, event.action);
  }
  const createdContractEvent = events.find(row => row.entity_id === contract.id && row.action === 'Create Draft');
  assert.equal(createdContractEvent.before_value, null);
  assert.equal(createdContractEvent.reason, 'SYNTHETIC-CONFIDENTIAL-REASON-29A4');
  assert.equal(createdContractEvent.after_value.versions[0].value, immutableFirstTerms.value);
  assert.equal(createdContractEvent.after_value.versions[0].billingTerms, immutableFirstTerms.billingTerms);
  assert.deepEqual(createdContractEvent.after_value.versions[0].documents, immutableFirstTerms.documents);
  const appendEvent = events.filter(row => row.action === 'Append Version');
  assert.equal(appendEvent.length, 1);
  assert.equal(appendEvent[0].before_value.latestVersion, 1);
  assert.equal(appendEvent[0].after_value.latestVersion, 2);
  assert.deepEqual(appendEvent[0].before_value.versions, [immutableFirstTerms]);
  assert.deepEqual(appendEvent[0].after_value.versions, contract.versions);
  await sqlRejects(pool, `update commercial_draft_events set reason=reason where id=$1`, [createdContractEvent.id], '55000', 'protected material evidence must be immutable');
  await sqlRejects(pool, `delete from commercial_draft_events where id=$1`, [createdContractEvent.id], '55000', 'protected material evidence must not be deleted');
  assert.deepEqual(await legacySnapshot(pool), originalLegacy, 'API drafting/revisions must not mutate original project/work history');
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied, [], 'fresh database replay must remain idempotent after commercial writes');
  assert.equal((await pool.query(`select count(*)::int count from user_permission_grants where permission_key=any($1::text[])`, [commercialPermissions])).rows[0].count, 0,
    'synthetic grant-metadata test must remove its isolated fixture and never leave a live grant');
  // Deliberately exceed a new list's bound using isolated SQL fixtures after
  // reconciling all successful command/audit counts above.
  await pool.query(`insert into commercial_engagements(id,organization_id,legal_entity_id,code,name,model,
    owner_id,attribution_id,starts_on,ends_on,currency,budget,billable,reason,created_by)
    select 'engagement-cap-'||n,$1,$2,'SYNTHETIC-CAP-'||n,'Synthetic cap fixture','internal',
      $3,$4,$5::date,$6::date,'USD',0,false,'Synthetic capped-list fixture',$7::uuid
    from generate_series(1,201) n`,
  [f.organizationId, f.legalEntityId, f.ownerId, f.businessUnitId, dates.engagementStart, dates.engagementEnd, identities.manager.id]);
  await withCommercialApi({databaseUrl, identities}, async ({request}) => {
    const capped = await request(`/workspace?asOf=${dates.engagementStart}`);
    assert.equal(capped.status, 200);
    assert.equal(capped.body.engagements.length, 200);
    assert.equal(capped.body.limits.pageSize, 200);
    assert.equal(capped.body.limits.truncated.engagements, true, 'a bounded result must explicitly disclose additional records');
    assert.equal(capped.body.limits.truncated.contracts, false);

    const retainer = contractInput('SYN-PERIOD-TERMS','retainer');
    const period = {startsOn:dates.engagementStart,endsOn:dates.engagementEnd,includedHours:'80.0001',baseFee:'3000.1234'};
    for (const invalid of [
      {...retainer,model:'fixed_fee',retainerPeriods:[period]},
      {...retainer,retainerPeriods:[period,{...period,startsOn:period.endsOn}]},
      {...retainer,retainerPeriods:[{...period,startsOn:'2000-01-01'}]},
      {...retainer,retainerPeriods:[{...period,endsOn:dates.startsOn}]},
      {...retainer,retainerPeriods:[{...period,includedHours:'0'}]},
    ]) assertError(await request('/contracts',{method:'POST',body:invalid}),422,'COMMERCIAL_RETAINER_PERIODS_INVALID');
    for (const bad of [{...retainer,retainerCapacityPolicy:'all_expire'},
      {...retainer,model:'fixed_fee',retainerCapacityPolicy:'all_rollover'}])
      assertError(await request('/contracts',{method:'POST',body:bad}),422,'COMMERCIAL_RETAINER_POLICY_INVALID');
    assertError(await request('/contracts',{method:'POST',body:{...retainer,retainerPeriods:[period],retainerOveragePolicy:'no_charge'}}),422,'COMMERCIAL_RETAINER_OVERAGE_INVALID');
    assertError(await request('/contracts',{method:'POST',body:{...retainer,retainerPeriods:[period],retainerRounding:{mode:'HALF_UP',precision:0}}}),422,'COMMERCIAL_RETAINER_ROUNDING_INVALID');
    const saved = await request('/contracts',{method:'POST',body:{...retainer,retainerPeriods:[period],retainerCapacityPolicy:'billable_rollover',retainerOveragePolicy:'no_charge',retainerRounding:{mode:'DOWN',precision:4}}});
    assert.equal(saved.status,201,JSON.stringify(saved.body));
    assert.deepEqual(saved.body.versions[0].retainerPeriods,[period]);
    const path = '/contracts/'+saved.body.id;
    const inherited = await request(path+'/versions',{method:'POST',body:revisionInput(saved.body,{retainerPeriods:undefined})});
    assert.equal(inherited.status,201,JSON.stringify(inherited.body));
    assert.deepEqual(inherited.body.versions.map(v=>v.retainerRounding),Array(2).fill({mode:'DOWN',precision:4}));
    assert.deepEqual(inherited.body.versions.map(v=>v.retainerOveragePolicy),['no_charge','no_charge']);
    assert.deepEqual(inherited.body.versions.map(v=>v.retainerCapacityPolicy),['billable_rollover','billable_rollover']);
    assert.deepEqual(inherited.body.versions.map(v=>v.retainerPeriods),[[period],[period]]);
    const cleared = await request(path+'/versions',{method:'POST',body:revisionInput(inherited.body,{retainerPeriods:[],retainerCapacityPolicy:null,retainerOveragePolicy:null,retainerRounding:null,effectiveFrom:dates.later})});
    assert.equal(cleared.status,201,JSON.stringify(cleared.body));
    assert.deepEqual(cleared.body.versions.map(v=>v.retainerCapacityPolicy),[undefined,'billable_rollover','billable_rollover']);
    assert.deepEqual(cleared.body.versions.map(v=>v.retainerPeriods ?? []),[[],[period],[period]]);
    assert.equal((await request(path,{identity:identities.denied})).status,403);

    const terms = {...contractInput('SYN-FIXED-SCHEDULE', 'fixed_fee'), value:'70.0001'};
    const installments = [{dueOn:dates.startsOn,amount:'40.0001'}, {dueOn:dates.endsOn,amount:'30'}];
    for (const candidate of [
      {...terms, model:'time_and_materials', installments},
      {...terms, value:'70.0002', installments},
      {...terms, installments:[...installments].reverse()},
      {...terms, installments:[{dueOn:'2000-01-01',amount:'70.0001'}]},
      {...terms, installments:[...installments,{dueOn:dates.endsOn,amount:'0'}]},
    ]) assertError(await request('/contracts',{method:'POST',body:candidate}),422,'COMMERCIAL_INSTALLMENTS_INVALID');
    const accepted = await request('/contracts',{method:'POST',body:{...terms,installments}});
    assert.equal(accepted.status,201,JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body.versions[0].installments,installments);
    const revised = await request('/contracts/'+accepted.body.id+'/versions',{method:'POST',body:{
      ...revisionInput(accepted.body,{value:terms.value}), installments:undefined,
    }});
    assert.equal(revised.status,201,JSON.stringify(revised.body));
    assert.deepEqual(revised.body.versions.map(v=>v.installments),[installments,installments]);
    assert.equal((await request('/contracts/'+accepted.body.id,{identity:identities.denied})).status,403);
  });
});

console.log('Commercial drafting PostgreSQL smoke passed: fresh/upgrade/replay, seven models, API workflow, immutable pinned terms, concurrent versioning, decimal/date integrity, scope/permission rejection and transactional audit.');
