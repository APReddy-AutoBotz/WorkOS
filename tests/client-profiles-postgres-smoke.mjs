import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runMigrations} from '../server/migrate.mjs';
import {createContract, createEngagement} from '../server/modules/commercial-drafting/service.mjs';
import {localDatabaseUrl} from './support/import-audit-journey.mjs';
import {seedCommercialReferences, seedCommercialLegacyWork, seedCommercialIdentities} from './support/commercial-drafting-test.mjs';
import {
  clientProfileFixture as f, clientProfilePermissions, clientProfileMigration, clientProfileScope as scope,
  protectedClientMarker as marker, clientProfileTables, preservedClientTables, withClientProfileDatabase,
  withPreClientProfileMigrations, migrateClientProfiles, clientProfileToday, clientProfileDate as day,
  clientProfileInput as input, clientUnitInput as unitInput, clientUnitRevision as unitRevision,
  clientProfileSnapshot as snapshot, clientProfileCounts as counts, assertClientProfileError as error,
  createClientProfile as profile, createClientUnit as unit, seedClientProfileClient as seedClient,
  grantClientProfileTestPermissions as grant, withClientProfileApi,
} from './support/client-profiles-test.mjs';

// Required real PostgreSQL and HTTP acceptance, never a successful environment
// skip, nonlocal database, permissive mock, or replacement in-memory writer.
assert.throws(() => localDatabaseUrl(undefined));
for (const url of ['postgres://example.test/test', 'postgres://localhost/test?host=example.test',
  'postgres://localhost/test?hostaddr=192.0.2.1', 'postgres://localhost/test?dbname=shared',
  'postgres://localhost/test?service=live', 'postgres://localhost/test#override']) assert.throws(() => localDatabaseUrl(url));
const quiet = {log() {}};
const defaults = async pool => {
  assert.deepEqual((await pool.query('select permission_key from permission_definitions where permission_key=any($1::text[]) order by permission_key', [clientProfilePermissions])).rows.map(row => row.permission_key), [...clientProfilePermissions].sort());
  assert.equal((await pool.query('select count(*)::int count from role_permissions where permission_key=any($1::text[]) and enabled', [clientProfilePermissions])).rows[0].count, 0);
  assert.equal((await pool.query('select count(*)::int count from user_permission_grants where permission_key=any($1::text[])', [clientProfilePermissions])).rows[0].count, 0);
};
const jsonValues = new Set(['billing_contacts', 'before_value', 'after_value', 'source_snapshot']);
const clone = (pool, table, row, overrides = {}) => {
  const copy = {...row, ...overrides}, keys = Object.keys(copy);
  return pool.query(`insert into ${table}(${keys.map(key => `"${key}"`).join(',')}) values(${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map(key => jsonValues.has(key) && copy[key] !== null ? JSON.stringify(copy[key]) : copy[key]));
};
const rejects = (promise, code) => assert.rejects(promise, failure => {assert.equal(failure.code, code);return true;});
const post = async (request, path, body, options = {}) => {
  const result = await request(path, {method: 'POST', body, ...options});assert.equal(result.status, 201, `${path}: ${JSON.stringify(result.body)}`);return result.body;
};
const stableFailure = async (pool, request, path, options, status, code) => {
  const beforeCounts = await counts(pool), before = await snapshot(pool, [...clientProfileTables, 'clients', 'projects', 'project_allocations']);
  error(await request(path, options), status, code);
  assert.deepEqual(await counts(pool), beforeCounts, `${path}: rejection commits no partial entity, event, audit, import or idempotency`);
  assert.deepEqual(await snapshot(pool, [...clientProfileTables, 'clients', 'projects', 'project_allocations']), before, `${path}: rejection changes no durable records`);
};
const seedGovernedHistory = async (pool, identities, today) => {
  const client = await pool.connect();const year = Number(today.slice(0, 4));
  const req = {user: {sub: identities.manager.id, activeRole: 'Admin'}, organizationScope: scope,
    correlationId: 'synthetic-preserved-041', operationId: 'synthetic-preserved-041'};
  const common = {startsOn: `${year - 1}-01-01`, endsOn: `${year + 2}-12-31`};
  try {
    await client.query('begin');
    const contract = await createContract(client, req, {...common, number: 'SYN-PRESERVED-041', clientId: f.clientId,
      name: 'Synthetic immutable agreement', model: 'fixed_fee', effectiveFrom: common.startsOn,
      currency: 'USD', value: '25000.0001', billingTerms: 'Synthetic immutable private terms', documents: [], reason: 'Synthetic preserved contract'}, async () => {});
    const pin = contract.versions[0].id;
    const engagement = await createEngagement(client, req, {...common, code: 'SYN-PRESERVED-ENGAGEMENT', name: 'Synthetic immutable delivery', model: 'fixed_fee',
      ownerId: f.ownerId, currency: 'USD', budget: '10000.0001', clientId: f.clientId, contractId: contract.id, contractVersionId: pin,
      attributionId: null, reason: 'Synthetic preserved engagement'}, async () => {});
    // Seed the intentionally retained 041 schema with real, schema-compatible
    // SQL rather than running today's 043-aware lifecycle binary on old tables.
    // All 041 scoped-root, chronology, immutable-pin and project-projection
    // triggers remain enabled. The upgrade and preservation snapshot stay below.
    const activate = async (type, id, source) => {
      await client.query(`insert into commercial_lifecycle_events
        (id,organization_id,legal_entity_id,entity_type,entity_id,sequence,state,contract_id,contract_version_id,
         before_value,after_value,reason,approval_reference,actor_id,active_role,correlation_id,operation_id)
        values($1,$2,$3,$4,$5,1,'Active',$6,$7,null,$8::jsonb,'Synthetic preserved activation',null,$9,'Admin',$10,$11)`,
      [`lifecycle-${randomUUID()}`,scope.organizationId,scope.legalEntityId,type,id,contract.id,pin,
        JSON.stringify({lifecycle:{entityId:id,state:'Active',sequence:1,effectiveOn:today,contractVersionId:pin},snapshot:source}),
        identities.manager.id,req.correlationId,req.operationId]);
    };
    await activate('Contract', contract.id, contract);
    await activate('Engagement', engagement.id, engagement);
    const project = (await client.query(`insert into projects
      (id,organization_id,legal_entity_id,project_code,name,client_id,client,manager_id,manager_name,project_type,billable,start_date,end_date,status)
      select $1,$2,$3,'SYN-PRESERVED-PROJECT','Synthetic governed project',c.id,c.name,e.id,e.name,'fixed_fee',true,$6,$7,'Proposed'
      from clients c join employees e on e.id=$5 and e.organization_id=$2 and e.legal_entity_id=$3
      where c.id=$4 and c.organization_id=$2 and c.legal_entity_id=$3
      returning *,start_date::text,end_date::text`,
    [`p-${randomUUID()}`,scope.organizationId,scope.legalEntityId,f.clientId,f.ownerId,common.startsOn,common.endsOn])).rows[0];
    assert.ok(project, '041 fixture requires the real scoped client and manager');
    const binding = (await client.query(`insert into commercial_project_bindings
      (organization_id,legal_entity_id,project_id,engagement_id,contract_id,contract_version_id,code,name,manager_id,
       starts_on,ends_on,model,currency,budget_allocation,billable,attribution_id,origin,source_snapshot,reason,created_by)
      values($1,$2,$3,$4,$5,$6,'SYN-PRESERVED-PROJECT','Synthetic governed project',$7,$8,$9,'fixed_fee','USD',
        '100.0001',true,null,'manual',$10::jsonb,'Synthetic preserved project',$11)
      returning *,starts_on::text,ends_on::text,budget_allocation::text`,
    [scope.organizationId,scope.legalEntityId,project.id,engagement.id,contract.id,pin,f.ownerId,common.startsOn,common.endsOn,
      JSON.stringify(project),identities.manager.id])).rows[0];
    await activate('Project', project.id, binding);
    assert.equal((await client.query('select status from projects where id=$1',[project.id])).rows[0].status, 'Active',
      '041 lifecycle trigger, not a fixture UPDATE, projects the governed operational state');
    await client.query('commit');return {contract, engagement, project, pin};
  } catch (failure) {await client.query('rollback');throw failure;} finally {client.release();}
};

// Exercise enrollment through the real permission product APIs, rather than
// relying on fixture SQL to make the new opt-in capabilities reachable.
await withClientProfileDatabase(async ({pool, databaseUrl}) => {
  await migrateClientProfiles(pool);await seedCommercialReferences(pool);
  const identities=await seedCommercialIdentities(pool), today=await clientProfileToday(pool);
  await defaults(pool);
  await withClientProfileApi({databaseUrl,identities},async({request})=>{
    const config=await request('/api/permissions/config');assert.equal(config.status,200);
    for(const key of clientProfilePermissions){
      const definition=config.body.permissions.find(item=>item.key===key);
      assert.ok(definition,`permission configuration exposes ${key}`);assert.equal(definition.protected,false);
      assert.equal((await request('/api/permissions/roles/Employee',{method:'PATCH',identity:identities.reader,body:{permissionKey:key,enabled:true}})).status,403);
      assert.equal((await request('/api/permissions/user-grants',{method:'POST',identity:identities.reader,body:{userId:identities.reader.id,permissionKey:key}})).status,403);
    }
    await defaults(pool);
    for(const identity of Object.values(identities)) error(await request('/workspace',{identity}),403);
    const roleGrant=async(key,enabled)=>assert.equal((await request('/api/permissions/roles/Employee',{method:'PATCH',body:{permissionKey:key,enabled}})).status,200);
    await roleGrant('commercial.clients.view',true);
    assert.equal((await request('/workspace',{identity:identities.reader})).status,200);
    error(await request(`/clients/${f.clientId}/profiles`,{method:'POST',identity:identities.reader,body:input(today)}),403);
    await roleGrant('commercial.clients.manage',true);
    await profile(request,f.clientId,input(today),{identity:identities.reader});
    await roleGrant('commercial.clients.manage',false);
    error(await request(`/clients/${f.clientId}/profiles`,{method:'POST',identity:identities.reader,body:input(day(today,1),{expectedVersion:1})}),403);
    await roleGrant('commercial.clients.view',false);
    error(await request('/workspace',{identity:identities.reader}),403);
    const grants=[];
    for(const key of clientProfilePermissions){
      const granted=await request('/api/permissions/user-grants',{method:'POST',body:{userId:identities.reader.id,permissionKey:key}});
      assert.equal(granted.status,200);grants.push(granted.body);
    }
    await profile(request,f.clientId,input(day(today,1),{expectedVersion:1}),{identity:identities.reader});
    for(const granted of grants) assert.equal((await request(`/api/permissions/user-grants/${granted.id}`,{method:'DELETE'})).status,200);
    error(await request('/workspace',{identity:identities.reader}),403);
    await defaults(pool);
    const changes=(await pool.query('select * from permission_change_history where permission_key=any($1::text[])',[clientProfilePermissions])).rows;
    assert.equal(changes.length,8);assert(changes.every(row=>row.changed_by===identities.manager.id&&row.active_role==='Admin'));
  });
});

// Exact041 upgrade includes real pre-existing work, 040 neutral mappings and
// immutable commercial/lifecycle histories, not just an empty schema fixture.
await withClientProfileDatabase(async ({pool, databaseUrl}) => {
  await withPreClientProfileMigrations(async rootDir => {
    const baseline = await runMigrations({pool, rootDir, logger: quiet});assert.equal(baseline.status.currentVersion, '041_wos04_governed_lifecycle');
    const identities = await seedCommercialIdentities(pool), today = await clientProfileToday(pool);
    const governed = await seedGovernedHistory(pool, identities, today);
    const before = await snapshot(pool, [...preservedClientTables, 'audit_logs']);
    for (const row of before.commercial_contract_versions) row.value.installments = [];
    for(const row of before.timesheet_entries){row.value.evidence_url=null;row.value.work_reference=null;row.value.source_identity=null;row.value.category_code=null;row.value.category_reference=null;} // additive 047/048 column
    assert.equal(before.project_engagement_mappings.length, 1);assert.ok(before.commercial_draft_events.length >= 3);assert.equal(before.commercial_lifecycle_events.length, 3);
    const upgraded = await migrateClientProfiles(pool);assert.deepEqual(upgraded.applied, [clientProfileMigration, '043_wos04_governed_amendments', '044_wos04_work_submission_evidence','045_wos04_work_capture_policy','046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '083_wos06_fixed_fee_batch_approval', '084_wos06_fixed_fee_invoice_export', '085_wos06_fixed_fee_invoice_confirmation', '086_wos06_fixed_fee_po_commitments', '087_wos06_fixed_fee_reversal_credit']);assert.equal(upgraded.status.isCurrent, true);
    assert.deepEqual(await snapshot(pool, [...preservedClientTables, 'audit_logs']), before, '042 never rewrites operational, neutral, commercial, lifecycle or work history');
    await defaults(pool);
    for (const table of clientProfileTables) assert.deepEqual((await snapshot(pool, [table]))[table], []);
    const replay = await migrateClientProfiles(pool);assert.deepEqual(replay.applied, []);
    assert.deepEqual(await snapshot(pool, [...preservedClientTables, 'audit_logs']), before);
    await grant(pool);
    await withClientProfileApi({databaseUrl, identities, timeZone: 'America/Los_Angeles'}, async ({request}) => {
      const initialized = await profile(request, f.clientId, input(today));assert.equal(initialized.latestVersion, 1);
      const revised = await profile(request, f.clientId, input(day(today, 40), {expectedVersion: 1, defaultCurrency: 'EUR'}));
      assert.equal(revised.currentProfile.defaultCurrency, 'GBP');assert.equal(revised.latestProfile.defaultCurrency, 'EUR');
      assert.deepEqual(await snapshot(pool, preservedClientTables), Object.fromEntries(preservedClientTables.map(table => [table, before[table]])),
        'profile defaults are future selection aids, never authority to rewrite contractual pins, terms, project labels, neutral mappings or approved work');
      assert.equal((await pool.query('select contract_version_id from commercial_engagements where id=$1', [governed.engagement.id])).rows[0].contract_version_id, governed.pin);
    });
  }, {beforeCommercial: async rootDir => {
    const baseline = await runMigrations({pool, rootDir, logger: quiet});assert.equal(baseline.status.currentVersion, '039_wos03_import_operation_contract');
    await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  }});
});

await withClientProfileDatabase(async ({pool, databaseUrl}) => {
  const installed = await migrateClientProfiles(pool);assert.ok(installed.applied.includes(clientProfileMigration));assert.equal(installed.status.isCurrent, true);
  await defaults(pool);await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities = await seedCommercialIdentities(pool);const today = await clientProfileToday(pool), future = day(today, 30), later = day(today, 60);
  const inactive = await seedClient(pool, {status: 'Inactive'}), blank = await seedClient(pool), parent = await seedClient(pool);
  const cycleA = await seedClient(pool), cycleB = await seedClient(pool), cycleC = await seedClient(pool);
  const raceA = await seedClient(pool), raceB = await seedClient(pool), capId = await seedClient(pool);
  const oldHistory = await snapshot(pool, preservedClientTables.filter(table => table !== 'clients'));
  // Existing drafting/lifecycle and broad operational/audit rights do not
  // implicitly opt in to the confidential client-profile permission boundary.
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled) select 'TeamLead',key,true from unnest($1::text[]) key
    on conflict(role_name,permission_key) do update set enabled=true`,
    [['commercial.contracts.view', 'commercial.contracts.manage', 'commercial.lifecycle.manage', 'clients.view', 'audit.view', 'commercial.clients.manage']]);
  await withClientProfileApi({databaseUrl, identities, timeZone: 'Pacific/Honolulu'}, async ({request, commercialRequest}) => {
    error(await request('/workspace', {authenticated: false}), 401, 'AUTHENTICATION_REQUIRED');
    for (const identity of Object.values(identities)) error(await request('/workspace', {identity}), 403);
    await grant(pool);
    const workspace = await request('/workspace', {identity: identities.reader});assert.equal(workspace.status, 200);assert.equal(workspace.body.asOf, today);
    assert.equal(workspace.body.limit, 200);assert.equal(workspace.body.truncated, false);
    const original = workspace.body.clients.find(row => row.id === f.clientId);assert.ok(original);
    assert.equal(original.operationalName, 'Synthetic commercial local client');assert.equal(original.industry, 'Unclassified', 'preserve the existing operational schema default; do not invent profile identity');assert.equal(original.status, 'Active');assert.equal(original.accountOwnerId, f.ownerId);
    assert.equal(original.code, null);assert.equal(original.latestVersion, 0);assert.equal(original.currentProfile, null);assert.equal(original.latestProfile, null);
    assert.equal(workspace.body.clients.some(row => [f.otherClientId, f.foreignClientId].includes(row.id)), false);
    for (const path of ['/workspace?organizationId=forged', '/workspace?legalEntityId=forged', '/workspace?limit=999', '/workspace?asOf=2025-02-29', '/workspace?asOf=2026-1-1', '/workspace?asOf=2026-01-01&asOf=2026-01-02', `/clients/${f.clientId}?unknown=forged`]) error(await request(path), 400);
    for (const id of ['synthetic-missing', f.otherClientId, f.foreignClientId]) {
      error(await request(`/clients/${id}`), 404);
      error(await request(`/clients/${id}/profiles`, {method: 'POST', body: input(today)}), 404);
      error(await request(`/clients/${id}/billing-units`, {method: 'POST', body: unitInput(today)}), 404);
    }
    error(await request(`/clients/${inactive}/profiles`, {method: 'POST', body: input(today)}), 404);
    for (const path of [`/clients/${f.clientId}/profiles`, `/clients/${f.clientId}/billing-units`, `/clients/${f.clientId}/billing-units/missing/versions`]) {
      error(await request(path, {method: 'POST', body: path.endsWith('/profiles') ? input(today) : path.endsWith('/versions') ? unitRevision(future) : unitInput(today), identity: identities.reader}), 403);
    }
    error(await request('/workspace', {identity: identities.denied}), 403);
    error(await request(`/clients/${f.clientId}/history`, {identity: identities.denied}), 403);
    error(await request('/clients/synthetic-missing/history'), 404);
    error(await request(`/clients/${f.clientId}/history?forged=true`), 400);
    error(await request('/workspace', {scope: {organizationId: f.organizationId, legalEntityId: f.otherLegalEntityId}}), 403, 'ORG_SCOPE_DENIED');
    await stableFailure(pool, request, `/clients/${blank}/billing-units`, {method: 'POST', body: unitInput(today)}, 409, 'CLIENT_PROFILE_REQUIRED');
    const beforeInvalid = await counts(pool);
    for (const [key, value] of Object.entries({organizationId: 'forged', legalEntityId: 'forged', actorId: identities.denied.id, activeRole: 'Admin', createdBy: 'forged', source: 'Migration', status: 'Active', industry: 'forged', accountOwnerId: f.ownerId, latestVersion: 5, taxId: 'forged'})) {
      error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(today, {[key]: value})}), 400);
    }
    for (const delta of [{expectedVersion: -1}, {expectedVersion: 0.5}, {expectedVersion: 200}, {code: 'lowercase'}, {code: 'X'.repeat(81)}, {code: ''},
      {effectiveFrom: '2025-02-29'}, {effectiveFrom: `${today}T00:00:00Z`}, {defaultCurrency: 'gbp'}, {defaultCurrency: 'US'},
      {billingContacts: [{name: 'Synthetic contact', email: 'not-an-email'}]}, {billingContacts: [{name: 'Synthetic contact', email: 'x@example.test', secret: true}]}, {billingContacts: Array.from({length: 11}, () => ({name: 'Synthetic', email: 'synthetic@example.test'}))}, {reason: ''}]) {
      error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(today, delta)}), 400);
    }
    for (const key of ['legalName', 'displayName', 'parentClientId', 'defaultCurrency', 'billingContacts', 'reason']) {
      const body = input(today);delete body[key];error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body}), 400);
    }
    assert.deepEqual(await counts(pool), beforeInvalid, 'strict-body errors create no shadow accounts, versions, events or audit');
    error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(day(today, -1))}), 409, 'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT');
    for (const parentClientId of ['synthetic-missing', f.otherClientId, f.foreignClientId]) error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(today, {parentClientId})}), 404);
    error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(today, {parentClientId: f.clientId})}), 409, 'CLIENT_PROFILE_PARENT_CYCLE');
    let detail = await profile(request, f.clientId, input(today, {parentClientId: parent}));
    assert.equal(detail.latestVersion, 1);assert.equal(detail.currentProfile.id, detail.latestProfile.id);assert.equal(detail.currentProfile.effectiveFrom, today);
    assert.equal(detail.currentProfile.parentClientId, parent);assert.equal(detail.currentProfile.defaultCurrency, 'GBP');assert.deepEqual(detail.currentProfile.billingContacts, input(today).billingContacts);
    const first = detail.currentProfile;assert.equal(detail.operationalName, original.operationalName);assert.equal(detail.accountOwnerId, original.accountOwnerId);
    for (const delta of [{expectedVersion: 0}, {expectedVersion: 2}]) error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(future, delta)}), 409);
    error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(future, {expectedVersion: 1, code: 'DIFFERENT-CODE'})}), 409);
    for (const effectiveFrom of [day(today, -1), today]) error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(effectiveFrom, {expectedVersion: 1})}), 409, 'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT');
    detail = await profile(request, f.clientId, input(future, {expectedVersion: 1, legalName: `${marker} future legal`, displayName: null, parentClientId: null, defaultCurrency: null, billingContacts: []}));
    assert.deepEqual(detail.currentProfile, first);assert.equal(detail.latestVersion, 2);assert.equal(detail.latestProfile.version, 2);assert.equal(detail.latestProfile.defaultCurrency, null);
    assert.equal(detail.latestProfile.displayName, null);assert.deepEqual(detail.latestProfile.billingContacts, []);
    const atFuture = await request(`/clients/${f.clientId}?asOf=${future}`);assert.equal(atFuture.body.currentProfile.version, 2);assert.equal(atFuture.body.asOf, future);
    assert.equal((await request(`/clients/${f.clientId}?asOf=${day(today, -1)}`)).body.currentProfile, null);
    for (const effectiveFrom of [future, day(today, 1)]) error(await request(`/clients/${f.clientId}/profiles`, {method: 'POST', body: input(effectiveFrom, {expectedVersion: 2})}), 409, 'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT');
    error(await request(`/clients/${blank}/profiles`, {method: 'POST', body: input(today)}), 409, 'CLIENT_PROFILE_DUPLICATE');
    const empty = await profile(request, blank, input(future, {code: 'SYNTHETIC-BLANK', legalName: null, displayName: null, parentClientId: inactive, defaultCurrency: null, billingContacts: []}));
    assert.equal(empty.latestProfile.parentClientId, inactive, 'a parent reference may name any existing scoped client, including an inactive account');
    assert.equal(empty.currentProfile, null);assert.equal(empty.latestProfile.legalName, null);assert.equal(empty.latestProfile.defaultCurrency, null);

    // Full immutable snapshots for independent billing entities and business
    // units. Customer identities must never become buyer legal-entity scopes.
    error(await request(`/clients/${f.clientId}/billing-units`, {method: 'POST', body: unitInput(day(today, -1))}), 409, 'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT');
    for (const key of ['legalName', 'displayName', 'defaultCurrency', 'billingContacts', 'reason']) {const body = unitInput(today);delete body[key];error(await request(`/clients/${f.clientId}/billing-units`, {method: 'POST', body}), 400);}
    detail = await unit(request, f.clientId, unitInput(today));
    const billing = detail.billingUnits.find(row => row.code === 'SYNTHETIC-BILLING');assert.ok(billing);assert.equal(billing.clientId, f.clientId);assert.equal(billing.kind, 'billing_entity');
    const unitFirst = billing.currentProfile;assert.equal(unitFirst.defaultCurrency, 'EUR');
    detail = await unit(request, f.clientId, unitInput(future, {code: 'SYNTHETIC-BUSINESS', kind: 'business_unit', legalName: null, displayName: null, defaultCurrency: null, billingContacts: []}));
    const business = detail.billingUnits.find(row => row.code === 'SYNTHETIC-BUSINESS');assert.equal(business.kind, 'business_unit');assert.equal(business.currentProfile, null);
    error(await request(`/clients/${f.clientId}/billing-units`, {method: 'POST', body: unitInput(today)}), 409);
    for (const delta of [{kind: 'legal_entity'}, {code: 'lowercase'}, {organizationId: 'forged'}, {parentClientId: parent}, {expectedVersion: 0}]) error(await request(`/clients/${f.clientId}/billing-units`, {method: 'POST', body: unitInput(today, delta)}), 400);
    for (const path of [`/clients/${f.clientId}/billing-units/missing/versions`, `/clients/${blank}/billing-units/${billing.id}/versions`, `/clients/${f.otherClientId}/billing-units/${billing.id}/versions`]) error(await request(path, {method: 'POST', body: unitRevision(future)}), 404);
    error(await request(`/clients/${f.clientId}/billing-units/${billing.id}/versions`, {method: 'POST', body: unitRevision(future, {expectedVersion: 0})}), 400);
    for (const delta of [{code: 'CHANGED'}, {kind: 'business_unit'}, {clientId: blank}, {actorId: identities.manager.id}]) error(await request(`/clients/${f.clientId}/billing-units/${billing.id}/versions`, {method: 'POST', body: unitRevision(future, delta)}), 400);
    detail = await post(request, `/clients/${f.clientId}/billing-units/${billing.id}/versions`, unitRevision(future, {legalName: null, displayName: null, defaultCurrency: null, billingContacts: []}));
    let revisedUnit = detail.billingUnits.find(row => row.id === billing.id);assert.deepEqual(revisedUnit.currentProfile, unitFirst);assert.equal(revisedUnit.latestVersion, 2);assert.equal(revisedUnit.versions.find(row => row.version === 2).legalName, null);
    error(await request(`/clients/${f.clientId}/billing-units/${billing.id}/versions`, {method: 'POST', body: unitRevision(later)}), 409);
    error(await request(`/clients/${f.clientId}/billing-units/${billing.id}/versions`, {method: 'POST', body: unitRevision(today, {expectedVersion: 2})}), 409, 'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT');
    revisedUnit = (await request(`/clients/${f.clientId}?asOf=${future}`)).body.billingUnits.find(row => row.id === billing.id);assert.equal(revisedUnit.currentProfile.version, 2);assert.equal(revisedUnit.currentProfile.defaultCurrency, null);

    // Hierarchy checks cover all future boundaries, not only today's graph or
    // the new edge's own date. Later removal is not permission for an earlier cycle.
    await profile(request, cycleA, input(today, {code: 'SYN-CYCLE-A', parentClientId: cycleB}));
    await profile(request, cycleB, input(today, {code: 'SYN-CYCLE-B', parentClientId: cycleC}));
    await stableFailure(pool, request, `/clients/${cycleC}/profiles`, {method: 'POST', body: input(today, {code: 'SYN-CYCLE-C', parentClientId: cycleA})}, 409, 'CLIENT_PROFILE_PARENT_CYCLE');
    await profile(request, cycleA, input(later, {code: 'SYN-CYCLE-A', expectedVersion: 1, parentClientId: null}));
    await stableFailure(pool, request, `/clients/${cycleC}/profiles`, {method: 'POST', body: input(future, {code: 'SYN-CYCLE-C', parentClientId: cycleA})}, 409, 'CLIENT_PROFILE_PARENT_CYCLE');
    await profile(request, cycleC, input(day(today, 61), {code: 'SYN-CYCLE-C', parentClientId: cycleA}));
    const futureA = await seedClient(pool), futureB = await seedClient(pool);
    await profile(request, futureA, input(today, {code: 'SYN-FUTURE-A', parentClientId: null}));
    await profile(request, futureA, input(later, {code: 'SYN-FUTURE-A', expectedVersion: 1, parentClientId: futureB}));
    await stableFailure(pool, request, `/clients/${futureB}/profiles`, {method: 'POST', body: input(future, {code: 'SYN-FUTURE-B', parentClientId: futureA})}, 409, 'CLIENT_PROFILE_PARENT_CYCLE');
    const raceBefore = await counts(pool);
    const raced = await Promise.all([[raceA, raceB, 'SYN-RACE-A'], [raceB, raceA, 'SYN-RACE-B']].map(([id, parentClientId, code]) => request(`/clients/${id}/profiles`, {method: 'POST', body: input(today, {code, parentClientId})})));
    assert.deepEqual(raced.map(row => row.status).sort(), [201, 409], 'scope lock serializes opposing-parent races so exactly one edge wins');
    const raceAfter = await counts(pool);for (const table of ['client_profile_accounts', 'client_profile_versions', 'client_profile_events', 'audit_logs']) assert.equal(raceAfter[table], raceBefore[table] + 1);
    const appendRace = await Promise.all([1, 2].map(() => request(`/clients/${blank}/profiles`, {method: 'POST', body: input(later, {code: 'SYNTHETIC-BLANK', expectedVersion: 1})})));
    assert.deepEqual(appendRace.map(row => row.status).sort(), [201, 409]);

    // An explicitly authorized second scope demonstrates row filtering rather
    // than merely rejection of forged active-scope headers. Codes are scoped.
    for (const alternate of [{organizationId: f.organizationId, legalEntityId: f.otherLegalEntityId}, {organizationId: f.otherOrganizationId, legalEntityId: f.foreignLegalEntityId}]) {
      await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true)', [identities.manager.id, alternate.organizationId, alternate.legalEntityId]);
      const target = alternate.organizationId === f.organizationId ? f.otherClientId : f.foreignClientId;
      const remote = await profile(request, target, input(today), {scope: alternate});assert.equal(remote.code, 'SYNTHETIC-CLIENT');
      const scoped = await request('/workspace', {scope: alternate});assert.deepEqual(scoped.body.clients.map(row => row.id), [target]);
      for (const path of [`/clients/${f.clientId}`, `/clients/${f.clientId}/profiles`, `/clients/${f.clientId}/billing-units/${billing.id}/versions`]) {
        error(await request(path, {scope: alternate, ...(path.endsWith('/profiles') || path.endsWith('/versions') ? {method: 'POST', body: path.endsWith('/profiles') ? input(today) : unitRevision(future)} : {})}), 404);
      }
      error(await request(`/clients/${target}/profiles`, {scope: alternate, method: 'POST', body: input(future, {expectedVersion: 1, parentClientId: f.clientId})}), 404);
    }
    assert.equal((await request('/workspace')).body.clients.some(row => [f.otherClientId, f.foreignClientId].includes(row.id)), false);

    // No material profile value escapes through broad legacy clients or shared
    // audit. The protected append ledger retains complete material evidence.
    const broadClients = await request('/api/clients', {identity: identities.denied});assert.equal(broadClients.status, 200);
    assert.equal(JSON.stringify(broadClients.body).includes(marker), false);assert.equal(JSON.stringify(broadClients.body).includes('synthetic-billing@example.test'), false);
    const protectedHistory = await request(`/clients/${f.clientId}/history`, {identity: identities.reader});assert.equal(protectedHistory.status, 200);
    assert.equal(protectedHistory.body.clientId, f.clientId);assert.equal(protectedHistory.body.limit, 200);assert.equal(protectedHistory.body.truncated, false);
    assert.ok(protectedHistory.body.events.some(event => JSON.stringify(event.after).includes(marker)));
    assert.ok(protectedHistory.body.events.some(event => event.before?.profile.version === 1 && event.after.profile.version === 2));
    for (const event of protectedHistory.body.events) {assert.equal(event.actorId, identities.manager.id);assert.equal(event.activeRole, 'Admin');assert.ok(event.correlationId);assert.ok(event.operationId);}
    const generalAudit = await request('/api/audit-logs', {identity: identities.denied});assert.equal(generalAudit.status, 200);
    assert.equal(JSON.stringify(generalAudit.body).includes(marker), false);assert.equal(JSON.stringify(generalAudit.body).includes('synthetic-unit@example.test'), false);
    const events = (await pool.query('select * from client_profile_events order by created_at,id')).rows;assert.ok(events.length > 5);
    assert.equal(events.some(event => JSON.stringify(event.after_value).includes(marker)), true);
    for (const event of events) {
      assert.equal(event.actor_id, identities.manager.id);assert.equal(event.active_role, 'Admin');assert.equal(event.source, 'Web');
      assert.ok(event.correlation_id);assert.ok(event.operation_id);assert.ok(event.reason.includes(marker));assert.ok(event.after_value);
      const audits = (await pool.query('select * from audit_logs where new_value::text like $1', [`%${event.id}%`])).rows;
      assert.equal(audits.length, 1, 'exactly one opaque shared audit links each protected event');
      assert.equal(audits[0].correlation_id, event.correlation_id);assert.equal(audits[0].operation_id, event.operation_id);
      assert.equal(JSON.stringify(audits[0]).includes(marker), false);assert.equal(JSON.stringify(audits[0]).includes('synthetic-billing@example.test'), false);
      assert.ok(Object.keys(audits[0].new_value).length <= 2, 'shared audit carries only an opaque event pointer and optional snapshot side');
    }
    // Fail the actual audit insert in PostgreSQL, after service work, to prove
    // creation, profile and unit revisions all roll back in the same transaction.
    const module = (await pool.query('select module from audit_logs where new_value::text like $1 limit 1', [`%${events[0].id}%`])).rows[0].module;
    await pool.query(`create function synthetic_reject_client_audit() returns trigger language plpgsql as $$ begin
      if new.module=${"'" + module.replaceAll("'", "''") + "'"} then raise exception 'Synthetic profile audit failure';end if;return new;end $$`);
    await pool.query('create trigger synthetic_client_audit_failure before insert on audit_logs for each row execute function synthetic_reject_client_audit()');
    try {
      const untouched = await seedClient(pool);
      await stableFailure(pool, request, `/clients/${untouched}/profiles`, {method: 'POST', body: input(today, {code: 'SYN-AUDIT-FAIL'})}, 503);
      await stableFailure(pool, request, `/clients/${f.clientId}/profiles`, {method: 'POST', body: input(later, {expectedVersion: 2})}, 503);
      await stableFailure(pool, request, `/clients/${f.clientId}/billing-units`, {method: 'POST', body: unitInput(today, {code: 'SYN-AUDIT-FAIL-UNIT'})}, 503);
      await stableFailure(pool, request, `/clients/${f.clientId}/billing-units/${billing.id}/versions`, {method: 'POST', body: unitRevision(later, {expectedVersion: 2})}, 503);
    } finally {await pool.query('drop trigger synthetic_client_audit_failure on audit_logs');await pool.query('drop function synthetic_reject_client_audit()');}

    // Existing operational CRUD/import semantics are preserved. Omitted new
    // columns in client-master/1 cannot erase commercial profile history.
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) select 'Admin',key,true from unnest($1::text[]) key
      on conflict(role_name,permission_key) do update set enabled=true`, [['clients.view', 'clients.manage', 'imports.manage', 'projects.manage', 'projects.status_update', 'commercial.lifecycle.manage']]);
    const privateBefore = await snapshot(pool, clientProfileTables);
    const operational = (await pool.query('select * from clients where id=$1', [f.clientId])).rows[0];
    const changed = await request('/api/clients', {method: 'POST', body: {id: f.clientId, name: 'Synthetic renamed operational client', industry: 'Synthetic changed operational industry', account_owner_id: f.ownerId, country_director_ids: [], status: 'Active'}});
    assert.equal(changed.status, 200);assert.deepEqual(await snapshot(pool, clientProfileTables), privateBefore);
    for (const alias of ['/api', '/api/v1']) for (const dryRun of [true, false]) {
      const idempotency = `synthetic-client-compatibility-${randomUUID()}`;
      const body = {schemaVersion: 'client-master/1', dryRun, fileName: 'synthetic-omitted-profile-fields.csv', totalRows: 1, clientErrors: [],
        rows: [{id: f.clientId, name: 'Synthetic renamed operational client', industry: 'Synthetic changed operational industry', status: 'Active', accountOwnerId: f.ownerId}]};
      const result = await request(`${alias}/imports/clients/apply`, {method: 'POST', headers: {'Idempotency-Key': idempotency}, body});
      assert.equal(result.status, 200, JSON.stringify(result.body));assert.deepEqual(await snapshot(pool, clientProfileTables), privateBefore);
      const beforeRetry = await counts(pool);const replay = await request(`${alias}/imports/clients/apply`, {method: 'POST', headers: {'Idempotency-Key': idempotency}, body});
      assert.equal(replay.status, 200);
      if (alias === '/api/v1') assert.deepEqual(await counts(pool), beforeRetry, 'identical versioned import retry never duplicates provenance/audit');
      assert.deepEqual(await snapshot(pool, clientProfileTables), privateBefore, 'legacy retries retain their existing behavior but cannot rewrite profile evidence');
    }
    assert.equal((await request(`/clients/${f.clientId}`)).body.operationalName, 'Synthetic renamed operational client');
    assert.equal((await request(`/clients/${f.clientId}`)).body.currentProfile.legalName, first.legalName);
    // Restore ordinary metadata before constructing independent immutable 041
    // history so earlier fixture changes cannot cause unrelated guard failures.
    await pool.query('update clients set name=$1,industry=$2 where id=$3', [operational.name, operational.industry, f.clientId]);
    const governed = await seedGovernedHistory(pool, identities, today);
    for (const delta of [{name: 'Synthetic forbidden operational cascade'}, {status: 'Inactive'}]) {
      await stableFailure(pool, request, '/api/clients', {method: 'POST', body: {id: f.clientId, name: operational.name, industry: operational.industry || 'Unclassified', account_owner_id: f.ownerId, country_director_ids: [], status: 'Active', ...delta}}, 409, 'GOVERNED_PROJECT_MUTATION_REQUIRED');
    }
    for (const alias of ['/api', '/api/v1']) for (const dryRun of [true, false]) for (const invalidReference of [false, true]) {
      await stableFailure(pool, request, `${alias}/imports/clients/apply`, {method: 'POST', headers: {'Idempotency-Key': `synthetic-governed-profile-${randomUUID()}`}, body: {schemaVersion: 'client-master/1', dryRun,
        fileName: 'synthetic-governed-cascade.csv', totalRows: 2, clientErrors: [], rows: [{name: `Synthetic preceding rollback ${randomUUID()}`, status: 'Active'},
          {id: f.clientId, name: 'Synthetic forbidden cascade', status: 'Inactive', accountOwnerId: invalidReference ? 'synthetic-missing-owner' : f.ownerId}]}}, 409, 'GOVERNED_PROJECT_MUTATION_REQUIRED');
    }
    const immutableGoverned = await snapshot(pool, preservedClientTables.filter(table => table !== 'clients'));
    await profile(request, f.clientId, input(later, {expectedVersion: 2, defaultCurrency: 'JPY'}));
    await unit(request, f.clientId, unitInput(today, {code: 'SYN-WITH-GOVERNED-PROJECT'}));
    assert.deepEqual(await snapshot(pool, preservedClientTables.filter(table => table !== 'clients')), immutableGoverned,
      'profile commands coexist with governed projects but never become a legacy cascade bypass or overwrite a pin');
    assert.equal((await pool.query('select contract_version_id from commercial_project_bindings where project_id=$1', [governed.project.id])).rows[0].contract_version_id, governed.pin);

    // Bounded full histories and workspace are explicit rather than silently
    // truncating. Expected-version200 cannot append a 201st profile snapshot.
    await profile(request, capId, input(today, {code: 'SYN-CAP', legalName: null, displayName: null, defaultCurrency: null, billingContacts: []}));
    for (let expectedVersion = 1; expectedVersion < 200; expectedVersion++) await profile(request, capId, input(day(today, expectedVersion), {code: 'SYN-CAP', expectedVersion, legalName: null, displayName: null, defaultCurrency: null, billingContacts: []}));
    const capped = await request(`/clients/${capId}`);assert.equal(capped.body.latestVersion, 200);assert.equal(capped.body.versions.length, 200);
    assert.deepEqual(capped.body.versions.map(row => row.version).sort((a, b) => a - b), Array.from({length: 200}, (_, index) => index + 1));
    await stableFailure(pool, request, `/clients/${capId}/profiles`, {method: 'POST', body: input(day(today, 201), {code: 'SYN-CAP', expectedVersion: 200})}, 400);
    for (let expectedVersion = 2; expectedVersion < 200; expectedVersion++) await post(request, `/clients/${f.clientId}/billing-units/${billing.id}/versions`,
      unitRevision(day(today, 29 + expectedVersion), {expectedVersion, legalName: null, displayName: null, defaultCurrency: null, billingContacts: []}));
    const cappedUnit = (await request(`/clients/${f.clientId}`)).body.billingUnits.find(row => row.id === billing.id);assert.equal(cappedUnit.latestVersion, 200);assert.equal(cappedUnit.versions.length, 200);
    await stableFailure(pool, request, `/clients/${f.clientId}/billing-units/${billing.id}/versions`, {method: 'POST', body: unitRevision(day(today, 230), {expectedVersion: 200})}, 400);
    const cappedHistory = await request(`/clients/${f.clientId}/history`);assert.equal(cappedHistory.body.events.length, 200);assert.equal(cappedHistory.body.limit, 200);assert.equal(cappedHistory.body.truncated, true);

    await pool.query(`insert into clients(id,name,status,organization_id,legal_entity_id) select 'synthetic-capped-client-'||n,'Synthetic bounded operational client '||n,'Active',$1,$2 from generate_series(1,201) n`, [scope.organizationId, scope.legalEntityId]);
    const cappedWorkspace = await request('/workspace');assert.equal(cappedWorkspace.body.limit, 200);assert.equal(cappedWorkspace.body.clients.length, 200);assert.equal(cappedWorkspace.body.truncated, true);
    // Earlier historical allocations/work and neutral mappings stay unchanged;
    // only deliberately added new governed records may exist alongside them.
    for (const table of ['project_allocations', 'timesheets', 'timesheet_entries', 'project_engagement_mappings']) assert.deepEqual((await snapshot(pool, [table]))[table], oldHistory[table]);
    void commercialRequest;
  });

  // Independent database-boundary guards protect against future/bulk writers.
  // UPDATE includes no-op changes, and DELETE is never a retirement mechanism.
  for (const table of clientProfileTables) {
    await rejects(pool.query(`update ${table} set organization_id=organization_id`), '55000');
    await rejects(pool.query(`delete from ${table}`), '55000');
  }
  const row = (await pool.query('select *,effective_from::text from client_profile_versions where client_id=$1 order by version desc limit 1', [f.clientId])).rows[0];
  assert.ok(row);const next = {id: `client-profile-${randomUUID()}`, version: row.version + 1, effective_from: day(today, 90)};
  for (const [delta, code] of [[{version: row.version + 2}, 'WCP01'], [{effective_from: today}, 'WCP02'], [{effective_from: day(today, -1)}, 'WCP02'],
    [{parent_client_id: f.clientId}, 'WCP03'], [{parent_client_id: f.otherClientId}, '23503'], [{client_id: 'synthetic-missing', version: 1}, '23503'],
    [{organization_id: f.otherOrganizationId, legal_entity_id: f.foreignLegalEntityId, version: 1}, '23503'], [{default_currency: 'gbp'}, '23514']]) {
    await rejects(clone(pool, 'client_profile_versions', row, {...next, ...delta}), code);
  }
  // A writer retaining an old repeatable-read/serializable snapshot cannot
  // rely on a later advisory lock to see another transaction's parent edge.
  // Reject that isolation before append rather than admitting write skew.
  for (const isolation of ['repeatable read', 'serializable']) {
    const client = await pool.connect(), beforeIsolation = await snapshot(pool, clientProfileTables);
    try {
      await client.query(`begin isolation level ${isolation}`);
      await client.query('select count(*) from client_profile_versions');
      await rejects(clone(client, 'client_profile_versions', row, next), 'WCP04');
    } finally {await client.query('rollback');client.release();}
    assert.deepEqual(await snapshot(pool, clientProfileTables), beforeIsolation);
  }
  const billing = (await pool.query('select * from client_billing_units where client_id=$1 order by id limit 1', [f.clientId])).rows[0];
  await rejects(clone(pool, 'client_billing_units', billing, {id: `client-unit-${randomUUID()}`, code: `SYN-DB-${randomUUID().toUpperCase()}`, client_id: f.otherClientId}), '23503');
  const unitRow = (await pool.query('select *,effective_from::text from client_billing_unit_versions order by version desc limit 1')).rows[0];
  const unitNext = {id: `client-unit-version-${randomUUID()}`, version: unitRow.version + 1, effective_from: day(today, 120)};
  await rejects(clone(pool, 'client_billing_unit_versions', unitRow, {...unitNext, version: unitRow.version + 2}), 'WCP01');
  await rejects(clone(pool, 'client_billing_unit_versions', unitRow, {...unitNext, version: 1, organization_id: f.otherOrganizationId, legal_entity_id: f.foreignLegalEntityId}), '23503');
  const event = (await pool.query('select * from client_profile_events order by id limit 1')).rows[0];assert.ok(event.actor_id);
  await rejects(clone(pool, 'client_profile_events', event, {id: `client-event-${randomUUID()}`, actor_id: randomUUID()}), '23503');
  const beforeReplay = await snapshot(pool, [...preservedClientTables, ...clientProfileTables, 'audit_logs']);
  const replay = await migrateClientProfiles(pool);assert.deepEqual(replay.applied, []);assert.deepEqual(await snapshot(pool, [...preservedClientTables, ...clientProfileTables, 'audit_logs']), beforeReplay);
});
// Explicit seed remains a real command against its own randomized database.
// It never loads live credentials or permits production-mode seeding.
await withClientProfileDatabase(async ({pool, databaseUrl}) => {
  await migrateClientProfiles(pool);await defaults(pool);
  const runSeed = args => promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/seed-demo.mjs', ...args], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 60000, maxBuffer: 1024 * 1024,
    env: {PATH: process.env.PATH, NODE_ENV: 'test', APP_MODE: 'test', TZ: 'UTC', DATABASE_URL: databaseUrl, PGSSLMODE: 'disable',
      DEMO_SEED_PASSWORD: randomBytes(32).toString('base64url'), AUTO_SEED_DEMO: 'false', RESET_DEMO_DATA: 'false'},
  });
  await runSeed([]);await assert.rejects(runSeed(['--reset']),/submitted or approved work history/);await defaults(pool);
  for (const table of clientProfileTables) assert.deepEqual((await snapshot(pool, [table]))[table], [], 'ordinary seed/reset must not guess commercial profile values');
  const seeded = (await pool.query("select id from clients where status='Active' and organization_id=$1 and legal_entity_id=$2 order by id limit 1", [scope.organizationId, scope.legalEntityId])).rows[0];assert.ok(seeded);
  const identities = await seedCommercialIdentities(pool);await grant(pool);
  await withClientProfileApi({databaseUrl, identities}, async ({request}) => {await profile(request, seeded.id, input(await clientProfileToday(pool), {code: 'SYN-SEEDED-PROFILE'}));});
  const privateBefore = await snapshot(pool, clientProfileTables);await runSeed([]);
  assert.deepEqual(await snapshot(pool, clientProfileTables), privateBefore, 'ordinary reseeding never overwrites protected client profiles or contacts');
  const protectedReset = await snapshot(pool, [...preservedClientTables, ...clientProfileTables, 'audit_logs']);
  const protectedCounts = await counts(pool);
  await assert.rejects(runSeed(['--reset']), failure => {assert.equal(failure.code, 1);assert.match(failure.stderr, /foreign key|23503|submitted or approved work history/i);return true;},
    'reset cannot remove a client owning immutable commercial profile evidence');
  assert.deepEqual(await snapshot(pool, [...preservedClientTables, ...clientProfileTables, 'audit_logs']), protectedReset,
    'failed reset transaction restores every preceding client, employee, project, assignment, work and audit change');
  assert.deepEqual(await counts(pool), protectedCounts);

});
console.log('Client profiles real PostgreSQL fresh/041 upgrade/replay, immutable legacy and commercial history, opt-in permissions, protected projections/audit, scoped references, timeline/concurrent hierarchy safety, version limits, atomic audit failures and legacy CRUD/import governed rollback passed.');
