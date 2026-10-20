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
export const seedClientProfileClient = async (pool, {id = `synthetic-client-${randomUUID()}`, name = 'Synthetic additional operational client',
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
    const upgraded = await migrateCommercialDatabase(pool);assert.deepEqual(upgraded.applied, [clientProfileMigration]);
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
