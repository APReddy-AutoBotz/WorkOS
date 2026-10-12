import assert from 'node:assert/strict';
import express from 'express';
import {createOrganizationAuditRouter} from '../server/modules/audit/organization-audit-router.mjs';
import {versionedApiErrorHandler} from '../server/api/v1/error-contract.mjs';

const poolQueries = [];
const grants = new Set(['organization-reader:org-a']);
const auditRows = [{
  id: 'organization-row-a',
  user_id: 'actor-a',
  user_name: 'Synthetic actor',
  user_role: 'Admin',
  active_role: 'Admin',
  source: 'Synthetic test',
  module: 'Organization Audit Test',
  action: 'Update Organization Profile',
  details: 'Organization-level event',
  entity_type: 'Organization',
  entity_id: 'organization-a',
  source_identifier: 'external-subject-a',
  old_value: {provider_subject: 'external-subject-a', nested: {id: 'external-subject-a'}},
  new_value: {status: 'Updated'},
  organization_id: 'org-a',
  legal_entity_id: null,
  created_at: '2026-10-12T12:00:00.000Z',
}];

const pool = {
  async query(sql, params = []) {
    poolQueries.push({sql, params});
    if (sql.includes('select al.* from audit_logs al')) {
      return {rowCount: 1, rows: auditRows.filter(row => row.organization_id === params[0] && row.legal_entity_id === null)};
    }
    if (sql.includes('from users u') && sql.includes('join user_roles ur')) {
      const active = !['disabled-reader', 'unassigned-reader'].includes(params[0]);
      return {rowCount: active ? 1 : 0, rows: active ? [{ok: 1}] : []};
    }
    if (sql.includes('from organization_audit_grants g') && sql.includes('where g.user_id::text=$1')) {
      const allowed = grants.has(`${params[0]}:${params[1]}`);
      return {rowCount: allowed ? 1 : 0, rows: allowed ? [{ok: 1}] : []};
    }
    if (sql.includes('select o.id organization_id')) {
      return {rowCount: 1, rows: [{
        organization_id: 'org-a', organization_code: 'ORG-A', organization_name: 'Synthetic Org A', status: 'Active',
      }]};
    }
    return {rowCount: 0, rows: []};
  },
  async connect() {
    throw new Error('Grant management is covered by the disposable PostgreSQL migration-runner test.');
  },
};

const requireDatabase = (_req, _res, next) => next();
const requireIdentity = (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({error: 'Authentication required'});
  req.user = {sub: token, activeRole: 'Employee'};
  next();
};
const requireAuth = (req, res, next) => {
  requireIdentity(req, res, () => {
    const organizationId = req.headers['x-organization-id'];
    const legalEntityId = req.headers['x-legal-entity-id'];
    if (!organizationId || !legalEntityId) return res.status(403).json({error: 'Organization scope is not authorized'});
    req.organizationScope = {organizationId, legalEntityId};
    next();
  });
};
const permissionChecks = [];
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push(permission);
  if (req.headers['x-deny-permission'] === 'true'
      || (permission === 'audit.organization.view' && ![...grants].some(key => key.startsWith(`${req.user.sub}:`)))) {
    return res.status(403).json({error: 'Insufficient permission privileges'});
  }
  next();
};
const getEffectivePermissionsForUser = async () => ['permissions.manage'];
const audit = async () => {};

const app = express();
app.use(express.json());
const router = createOrganizationAuditRouter({
  pool,
  requireDatabase,
  requireAuth,
  requireIdentity,
  requirePermission,
  getEffectivePermissionsForUser,
  audit,
  logError: error => { throw error; },
});
app.use('/api', router);
app.use('/api/v1', router);
app.use('/api/v1', versionedApiErrorHandler);

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const identityHeaders = {Authorization: 'Bearer organization-reader'};
  const legacyScopes = await fetch(`${baseUrl}/api/organization-audit-scopes`, {headers: identityHeaders});
  const versionedScopes = await fetch(`${baseUrl}/api/v1/organization-audit-scopes`, {headers: identityHeaders});
  assert.equal(legacyScopes.status, 200);
  assert.equal(versionedScopes.status, 200);
  assert.deepEqual(await versionedScopes.json(), await legacyScopes.json(),
    'legacy and versioned organization scope readers must share the same response');

  const legacyRead = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-a`, {headers: identityHeaders});
  const versionedRead = await fetch(`${baseUrl}/api/v1/organization-audit-logs?organizationId=org-a`, {headers: identityHeaders});
  assert.equal(legacyRead.status, 200);
  assert.equal(versionedRead.status, 200);
  const legacyRows = await legacyRead.json();
  assert.deepEqual(await versionedRead.json(), legacyRows,
    'legacy and versioned organization audit readers must preserve the same payload');
  assert.deepEqual(legacyRows.map(row => row.id), ['organization-row-a'], JSON.stringify(legacyRows));
  assert.equal(legacyRows[0].legal_entity_id, null);
  assert.equal(legacyRows[0].source_identifier, null,
    'organization audit responses must apply shared identity redaction');
  assert.deepEqual(legacyRows[0].old_value, {nested: {}},
    'organization audit responses must recursively redact external identity fields');

  const missingOrganization = await fetch(`${baseUrl}/api/organization-audit-logs`, {headers: identityHeaders});
  assert.equal(missingOrganization.status, 400, 'the reader must require an explicit organization selection');
  const wrongOrganization = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-b`, {headers: identityHeaders});
  assert.equal(wrongOrganization.status, 404, 'an ungranted organization must be indistinguishable from a missing designation');

  const noGrantHeaders = {Authorization: 'Bearer no-grant-reader'};
  const noGrantScopes = await fetch(`${baseUrl}/api/organization-audit-scopes`, {headers: noGrantHeaders});
  const noGrantRead = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-a`, {headers: noGrantHeaders});
  assert.deepEqual([noGrantScopes.status, noGrantRead.status], [403, 403],
    'no organization designation must fail closed before reading organization history');
  const deniedPermission = await fetch(`${baseUrl}/api/v1/organization-audit-logs?organizationId=org-a`, {
    headers: {...identityHeaders, 'x-deny-permission': 'true'},
  });
  assert.equal(deniedPermission.status, 403);
  const disabledAuditor = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-a`, {
    headers: {Authorization: 'Bearer disabled-reader'},
  });
  assert.equal(disabledAuditor.status, 403, 'an inactive account must be denied');
  const staleRole = await fetch(`${baseUrl}/api/v1/organization-audit-logs?organizationId=org-a`, {
    headers: {Authorization: 'Bearer unassigned-reader'},
  });
  assert.equal(staleRole.status, 403, 'a session whose active role is no longer assigned must be denied');

  const finalRead = poolQueries.find(query => query.sql.includes('select al.* from audit_logs al'));
  assert(finalRead.sql.includes('al.organization_id=$1 and al.legal_entity_id is null'));
  assert(finalRead.sql.includes('g.organization_id=al.organization_id'));
  assert.match(finalRead.sql, /order by al\.created_at desc limit 500/);
  assert.deepEqual(finalRead.params, ['org-a', 'organization-reader', 'Employee']);
  assert.deepEqual(permissionChecks, Array(9).fill('audit.organization.view'),
    'all aliases must use the protected organization-audit permission');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Organization audit router smoke tests passed.');
