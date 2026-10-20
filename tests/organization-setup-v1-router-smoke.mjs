import assert from 'node:assert/strict';
import express from 'express';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from '../server/api/v1/error-contract.mjs';
import {AUDIT_INSERT_SQL, recordAuditEvent} from '../server/modules/audit/audit-record.mjs';
import {registerOrganizationSetupRoutes} from '../server/organization-setup.mjs';

// Synthetic pool/client doubles cover route parity, authorization ordering, and audit request-context wiring;
// PostgreSQL schema and migration behavior are verified separately by the exact-head CI workflow.
const app = express();
let generatedId = 0;
app.use('/api', createRequestContextMiddleware({idFactory: () => `org-setup-${++generatedId}`}));
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json({limit: '1mb'}));

const context = {
  organization_id: 'org-test',
  organization_code: 'ORG-TEST',
  organization_name: 'Test Organization',
  legal_entity_id: 'legal-test',
  legal_entity_code: 'LEGAL-TEST',
  legal_entity_name: 'Test Legal Entity',
};
const profile = {
  organization_id: 'org-test',
  organization_code: 'ORG-TEST',
  organization_name: 'Updated Test Organization',
  legal_name: 'Updated Test Organization LLC',
  product_display_name: 'Updated WorkOS',
  support_contact: 'support@example.test',
  default_locale: 'en-US',
  default_time_zone: 'UTC',
  base_currency: 'USD',
  fiscal_year_start: '01-01',
  default_week_start: 1,
  profile_effective_from: '2026-01-01',
  profile_effective_to: null,
};
const organization = {id: 'org-test', name: 'Test Organization'};
const latestProfile = {
  id: 'profile-current',
  name: 'Test Organization',
  effective_from: '2025-01-01',
  effective_to: null,
};
const insertedProfile = {...profile, id: 'profile-updated'};
const auditInserts = [];
const clientQueries = [];
let connectCount = 0;
const pool = {
  async query(sql, values = []) {
    if (sql.includes('from user_organization_scopes s')) {
      const [userId, organizationId, legalEntityId] = values;
      if (userId !== 'user-test'
          || (organizationId && organizationId !== 'org-test')
          || (legalEntityId && legalEntityId !== 'legal-test')) return {rows: []};
      return {rows: [{organization_id: 'org-test', legal_entity_id: 'legal-test'}]};
    }
    if (sql.includes('select o.id organization_id,o.code organization_code')) {
      return values[0] === 'org-test' && values[1] === 'legal-test' ? {rows: [context]} : {rows: []};
    }
    throw new Error(`Unexpected organization setup test query: ${sql.slice(0, 120)}`);
  },
  async connect() {
    connectCount += 1;
    return {
      async query(sql, values = []) {
        clientQueries.push({sql, values});
        if (sql === AUDIT_INSERT_SQL) {
          auditInserts.push(values);
          return {rows: []};
        }
        if (/^\s*(begin|commit|rollback)\s*$/i.test(sql)) return {rows: []};
        if (sql.includes('pg_advisory_xact_lock')) return {rows: []};
        if (sql.includes('select * from organizations where id=$1 for update')) {
          return {rows: [organization]};
        }
        if (sql.includes('from organization_profile_versions where organization_id=$1')) {
          return {rows: [latestProfile]};
        }
        if (sql.includes('insert into organization_profile_versions')) {
          return {rows: [insertedProfile]};
        }
        if (sql.includes('update organization_profile_versions set effective_to=')) return {rows: []};
        if (sql.includes('update organizations set name=')) return {rows: []};
        if (sql.includes('select o.id organization_id,o.code organization_code,p.name organization_name')) {
          return {rows: [profile]};
        }
        throw new Error(`Unexpected organization profile test query: ${sql.slice(0, 120)}`);
      },
      release() {},
    };
  },
};
const requireDatabase = (_req, _res, next) => next();
const requireAuth = (req, res, next) => {
  if (req.get('authorization') !== 'Bearer authorized-test') {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  req.user = {sub: 'user-test', activeRole: 'Admin'};
  next();
};
const permissionChecks = [];
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push(permission);
  if (permission === 'settings.manage' && req.get('x-settings-manage') === 'deny') {
    res.status(403).json({error: 'Settings permission required', code: 'SETTINGS_MANAGE_DENIED'});
    return;
  }
  next();
};
registerOrganizationSetupRoutes({
  app,
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  audit: recordAuditEvent,
  mountPaths: ['/api/organization-setup', '/api/v1/organization-setup'],
});
app.use('/api/v1', versionedApiErrorHandler);

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const deniedResponses = await Promise.all([
    fetch(`${baseUrl}/api/organization-setup/context`),
    fetch(`${baseUrl}/api/v1/organization-setup/context`),
  ]);
  assert.deepEqual(deniedResponses.map(response => response.status), [401, 401],
    'both compatibility prefixes enforce the same authentication guard');
  assert.deepEqual(await deniedResponses[0].json(), {error: 'Authentication required'},
    'legacy organization setup keeps its legacy error shape');
  const versionedDenial = await deniedResponses[1].json();
  assert.equal(versionedDenial.error.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(versionedDenial.error.message, 'Authentication required');
  assert.equal(versionedDenial.error.correlationId, deniedResponses[1].headers.get('x-correlation-id'));

  const mutation = {
    name: 'Updated Test Organization',
    legalName: 'Updated Test Organization LLC',
    productDisplayName: 'Updated WorkOS',
    supportContact: 'support@example.test',
    defaultLocale: 'en-US',
    defaultTimeZone: 'UTC',
    baseCurrency: 'USD',
    fiscalYearStart: '01-01',
    defaultWeekStart: 1,
    effectiveFrom: '2026-01-01',
  };
  const mismatchedScopes = [
    ['/api/organization-setup', 'org-other', 'legal-test'],
    ['/api/v1/organization-setup', 'org-other', 'legal-test'],
    ['/api/organization-setup', 'org-test', 'legal-other'],
    ['/api/v1/organization-setup', 'org-test', 'legal-other'],
  ];
  const deniedScopeResponses = await Promise.all(mismatchedScopes.map(([prefix, organizationId, legalEntityId]) =>
    fetch(`${baseUrl}${prefix}/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer authorized-test',
        'X-Organization-ID': organizationId,
        'X-Legal-Entity-ID': legalEntityId,
      },
      body: JSON.stringify(mutation),
    })
  ));
  assert.deepEqual(deniedScopeResponses.map(response => response.status), [403, 403, 403, 403],
    'both compatibility prefixes reject mismatched organization and legal-entity scopes');
  assert.deepEqual(await deniedScopeResponses[0].json(), {
    error: 'Organization scope is not authorized',
    code: 'ORG_SCOPE_DENIED',
  }, 'legacy organization-scope denial preserves its legacy body');
  const versionedScopeDenial = await deniedScopeResponses[1].json();
  assert.equal(versionedScopeDenial.error.code, 'ORG_SCOPE_DENIED');
  assert.equal(versionedScopeDenial.error.message, 'Organization scope is not authorized');
  assert.equal(versionedScopeDenial.error.correlationId, deniedScopeResponses[1].headers.get('x-correlation-id'));
  assert.equal(versionedScopeDenial.error.operationId, deniedScopeResponses[1].headers.get('x-operation-id'));
  assert.equal(connectCount, 0, 'mismatched scope requests do not open mutation transactions');
  assert.equal(auditInserts.length, 0, 'mismatched scope requests do not write audit events');
  assert.equal(permissionChecks.length, 0, 'scope rejection occurs before the settings permission guard');

  const deniedPermissionResponses = await Promise.all([
    fetch(`${baseUrl}/api/organization-setup/profile`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer authorized-test', 'x-settings-manage': 'deny'},
      body: JSON.stringify(mutation),
    }),
    fetch(`${baseUrl}/api/v1/organization-setup/profile`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer authorized-test', 'x-settings-manage': 'deny'},
      body: JSON.stringify(mutation),
    }),
  ]);
  assert.deepEqual(deniedPermissionResponses.map(response => response.status), [403, 403],
    'both compatibility prefixes enforce the same permission guard before mutation');
  assert.deepEqual(await deniedPermissionResponses[0].json(), {
    error: 'Settings permission required',
    code: 'SETTINGS_MANAGE_DENIED',
  }, 'legacy permission denial preserves the legacy body');
  const versionedPermissionDenial = await deniedPermissionResponses[1].json();
  assert.deepEqual(versionedPermissionDenial.error, {
    code: 'SETTINGS_MANAGE_DENIED',
    message: 'Settings permission required',
    correlationId: deniedPermissionResponses[1].headers.get('x-correlation-id'),
    operationId: deniedPermissionResponses[1].headers.get('x-operation-id'),
  }, 'versioned permission denial uses the stable API error contract');
  assert.equal(connectCount, 0, 'denied permission checks do not open a mutation transaction');
  assert.equal(auditInserts.length, 0, 'denied permission checks do not write audit events');

  const headers = {
    Authorization: 'Bearer authorized-test',
    'X-Organization-ID': 'org-test',
    'X-Legal-Entity-ID': 'legal-test',
  };
  const legacy = await fetch(`${baseUrl}/api/organization-setup/context`, {headers});
  const versioned = await fetch(`${baseUrl}/api/v1/organization-setup/context`, {headers});
  assert.equal(legacy.status, 200);
  assert.equal(versioned.status, 200);
  assert.deepEqual(await legacy.json(), context, 'legacy context response remains unchanged');
  assert.deepEqual(await versioned.json(), context, 'v1 compatibility alias uses the same guarded route contract');

  const mutationHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer authorized-test',
    'X-Operation-ID': 'caller-supplied-operation-must-be-ignored',
  };
  const acceptedMutations = [];
  for (const prefix of ['/api/organization-setup', '/api/v1/organization-setup']) {
    acceptedMutations.push(await fetch(`${baseUrl}${prefix}/profile`, {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify(mutation),
    }));
  }
  assert.deepEqual(acceptedMutations.map(response => response.status), [200, 200],
    'both compatibility prefixes execute the same authorized mutation');
  const acceptedBodies = await Promise.all(acceptedMutations.map(response => response.json()));
  assert.deepEqual(acceptedBodies[0], profile, 'legacy mutation response matches the shared handler result');
  assert.deepEqual(acceptedBodies[1], profile, 'versioned mutation response matches the shared handler result');
  assert.equal(connectCount, 2, 'each accepted request opens exactly one mutation transaction');
  assert.equal(auditInserts.length, 2, 'each accepted request writes exactly one shared audit event');
  assert.deepEqual(permissionChecks, ['settings.manage', 'settings.manage', 'settings.manage', 'settings.manage'],
    'legacy and versioned mutation routes use the same settings permission');

  for (const [index, response] of acceptedMutations.entries()) {
    const audit = auditInserts[index];
    const correlationId = response.headers.get('x-correlation-id');
    const operationId = response.headers.get('x-operation-id');
    assert.match(correlationId || '', /^org-setup-\d+$/, 'the server generates the correlation ID when none is supplied');
    assert.match(operationId || '', /^org-setup-\d+$/, 'the server generates an operation ID for the mutation');
    assert.notEqual(correlationId, operationId, 'correlation and operation IDs identify separate request dimensions');
    assert.equal(audit[0], 'user-test', 'audit identifies the authenticated actor');
    assert.equal(audit[2], 'Admin', 'audit records the active role');
    assert.equal(audit[5], 'Organization Setup');
    assert.equal(audit[6], 'Update Organization Profile');
    assert.equal(audit[7], 'Organization');
    assert.equal(audit[8], 'org-test');
    assert.equal(JSON.parse(audit[9]).name, 'Test Organization', 'audit retains the before value');
    assert.equal(JSON.parse(audit[10]).name, 'Updated Test Organization', 'audit retains the after value');
    assert.equal(audit[15], correlationId,
      'the shared audit writer persists the response correlation ID');
    assert.equal(audit[16], operationId,
      'the shared audit writer persists the server-generated operation ID');
    assert.notEqual(operationId, 'caller-supplied-operation-must-be-ignored',
      'a caller cannot choose the operation ID written to audit');
  }
  assert.equal(clientQueries.filter(query => query.sql === AUDIT_INSERT_SQL).length, 2,
    'the accepted aliases each invoke the same append-only audit insert contract');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Organization setup v1 compatibility smoke tests passed.');
