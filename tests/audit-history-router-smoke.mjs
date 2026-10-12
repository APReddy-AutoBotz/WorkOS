import assert from 'node:assert/strict';
import express from 'express';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from '../server/api/v1/error-contract.mjs';
import {createAuditHistoryRouter} from '../server/modules/audit/audit-history-router.mjs';

const app = express();
app.use('/api', createRequestContextMiddleware({idFactory: () => 'audit-history-correlation'}));
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json());

const rows = [{
  id: 'synthetic-audit-row',
  organization_id: 'org-a',
  legal_entity_id: 'legal-a',
  entity_id: 'legacy-link-subject-a',
  source_identifier: 'legacy-user@example.test',
  old_value: {id: 'legacy-link-subject-a', nested: {provider_subject: 'subject-a'}},
  new_value: {nested: {id: 'legacy-user@example.test'}, provider_upn: 'user@example.test', status: 'Linked'},
}];
const deploymentRows = [
  {
    id: 'deployment-global-row',
    organization_id: null,
    legal_entity_id: null,
    entity_id: 'legacy-global-subject',
    source_identifier: 'global-user@example.test',
    old_value: {provider_subject: 'global-subject', nested: {id: 'global-user@example.test'}},
    new_value: {provider_upn: 'global-user@example.test', status: 'Updated'},
  },
  {id: 'deployment-half-null-row', organization_id: null, legal_entity_id: 'legal-a', entity_id: 'half-null'},
  {id: 'deployment-scoped-row', organization_id: 'org-a', legal_entity_id: 'legal-a', entity_id: 'scoped'},
];
const poolQueries = [];
let failQuery = false;
const pool = {
  async query(sql, params) {
    poolQueries.push({sql, params});
    if (failQuery) throw new Error('synthetic database detail');
    if (sql.includes('al.organization_id is null and al.legal_entity_id is null')) {
      const globalRows = deploymentRows.filter(row => row.organization_id === null && row.legal_entity_id === null);
      return {rows: globalRows, rowCount: globalRows.length};
    }
    if (sql.includes('where user_id=$1 and permission_key=$2')) {
      const rowsForUser = params[0] === 'audit-designated-auditor' && params[1] === 'audit.deployment.view'
        ? [{permission_key: 'audit.deployment.view'}]
        : [];
      return {rows: rowsForUser, rowCount: rowsForUser.length};
    }
    if (sql.includes('where u.id::text=$1 and u.status=\'Active\' and r.name=$2')) {
      const assignedActiveRoles = new Set([
        'audit-reader:Admin',
        'audit-designated-auditor:Employee',
      ]);
      const rowsForUser = assignedActiveRoles.has(`${params[0]}:${params[1]}`) ? [{exists: 1}] : [];
      return {rows: rowsForUser, rowCount: rowsForUser.length};
    }
    return {rows};
  },
};
const requireDatabase = (_req, _res, next) => next();
const requireAuth = (req, res, next) => {
  const authorizedScopes = req.get('authorization') === 'Bearer audit-reader'
    ? [{organizationId: 'org-a', legalEntityId: 'legal-a'}]
    : req.get('authorization') === 'Bearer audit-multi-reader'
      ? [
          {organizationId: 'org-a', legalEntityId: 'legal-a'},
          {organizationId: 'org-b', legalEntityId: 'legal-b'},
        ]
      : null;
  if (!authorizedScopes) {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  const requestedOrganizationId = req.get('x-organization-id');
  const requestedLegalEntityId = req.get('x-legal-entity-id');
  const scope = requestedOrganizationId || requestedLegalEntityId
    ? authorizedScopes.find(item => item.organizationId === requestedOrganizationId
      && item.legalEntityId === requestedLegalEntityId)
    : authorizedScopes.length === 1 ? authorizedScopes[0] : null;
  if (!scope) {
    res.status(403).json({error: 'Organization scope is not authorized', code: 'ORG_SCOPE_DENIED'});
    return;
  }
  req.user = {sub: 'audit-reader', activeRole: 'Admin'};
  req.organizationScope = scope;
  next();
};
const requireIdentity = (req, res, next) => {
  const identity = {
    'Bearer audit-reader': {sub: 'audit-reader', activeRole: 'Admin'},
    'Bearer audit-designated-reader': {sub: 'audit-designated-auditor', activeRole: 'Employee'},
    'Bearer audit-employee-reader': {sub: 'audit-employee', activeRole: 'Employee'},
    'Bearer audit-disabled-reader': {sub: 'audit-disabled-auditor', activeRole: 'Employee'},
    'Bearer audit-unassigned-role-reader': {sub: 'audit-designated-auditor', activeRole: 'Admin'},
  }[req.get('authorization')];
  if (!identity) {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  req.user = identity;
  next();
};
const permissionChecks = [];
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push(permission);
  if (req.get('x-audit-permission') === 'deny') {
    res.status(403).json({error: 'Insufficient permission privileges'});
    return;
  }
  next();
};
const router = createAuditHistoryRouter({
  pool,
  requireDatabase,
  requireAuth,
  requireIdentity,
  requirePermission,
  logError: () => {},
});
app.use('/api', router);
app.use('/api/v1', router);
app.use('/api/v1', versionedApiErrorHandler);

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const headers = {
  Authorization: 'Bearer audit-reader',
  'X-Organization-ID': 'org-a',
  'X-Legal-Entity-ID': 'legal-a',
};

try {
  const legacyResponse = await fetch(`${baseUrl}/api/audit-logs`, {headers});
  const versionedResponse = await fetch(`${baseUrl}/api/v1/audit-logs`, {headers});
  assert.equal(legacyResponse.status, 200);
  assert.equal(versionedResponse.status, 200);
  const legacyRows = await legacyResponse.json();
  const versionedRows = await versionedResponse.json();
  assert.deepEqual(versionedRows, legacyRows, 'the versioned compatibility route must use the same scoped audit handler and response shape');
  assert(legacyRows[0].entity_id === null && legacyRows[0].source_identifier === null,
    'legacy external identifiers in generic audit references must be redacted');
  assert.deepEqual(legacyRows[0].old_value, {nested: {}},
    'the router must use recursive redaction across nested identity values');
  assert.deepEqual(legacyRows[0].new_value, {nested: {}, status: 'Linked'});

  const singleScopeNoSelector = await fetch(`${baseUrl}/api/v1/audit-logs`, {
    headers: {Authorization: headers.Authorization},
  });
  assert.equal(singleScopeNoSelector.status, 200,
    'an actor with exactly one authorized scope may use the server-resolved scope without headers');
  assert.deepEqual(await singleScopeNoSelector.json(), legacyRows);
  assert.deepEqual(poolQueries.map(query => query.params), [
    ['org-a', 'legal-a'],
    ['org-a', 'legal-a'],
    ['org-a', 'legal-a'],
  ], 'ordinary routes must query only the server-resolved organization/legal-entity pair');

  const deploymentHeaders = {Authorization: 'Bearer audit-designated-reader'};
  const deploymentLegacy = await fetch(`${baseUrl}/api/deployment-audit-logs`, {headers: deploymentHeaders});
  const deploymentV1 = await fetch(`${baseUrl}/api/v1/deployment-audit-logs`, {headers: deploymentHeaders});
  assert.equal(deploymentLegacy.status, 200);
  assert.equal(deploymentV1.status, 200);
  const deploymentLegacyRows = await deploymentLegacy.json();
  const deploymentV1Rows = await deploymentV1.json();
  assert.deepEqual(deploymentV1Rows, deploymentLegacyRows,
    'both deployment audit aliases must share one reader and response shape');
  assert.deepEqual(deploymentLegacyRows.map(row => row.id), ['deployment-global-row'],
    'the deployment reader must include only records whose organization and legal-entity scopes are both null');
  assert.equal(deploymentLegacyRows[0].entity_id, null);
  assert.equal(deploymentLegacyRows[0].source_identifier, null);
  assert.deepEqual(deploymentLegacyRows[0].old_value, {nested: {}},
    'deployment audit records must use the same recursive identifier redaction as scoped history');
  assert.deepEqual(deploymentLegacyRows[0].new_value, {status: 'Updated'});
  assert(poolQueries.some(query => query.sql.includes('al.organization_id is null and al.legal_entity_id is null')
    && query.sql.includes('order by al.created_at desc limit 500')
    && query.sql.includes("u.status='Active'")
    && query.sql.includes('r.name=$2')
    && query.sql.includes('upg.permission_key=$3')
    && query.params?.[2] === 'audit.deployment.view'),
  'the final deployment read must revalidate the active assigned role, exact user grant, null scopes, fixed limit, and ordering');

  const queriesBeforeDeniedReads = poolQueries.length;
  const deniedRequests = [
    fetch(`${baseUrl}/api/audit-logs`, {headers: {...headers, 'x-audit-permission': 'deny'}}),
    fetch(`${baseUrl}/api/v1/audit-logs`, {headers: {...headers, 'x-audit-permission': 'deny'}}),
    fetch(`${baseUrl}/api/v1/audit-logs`, {headers: {Authorization: 'Bearer audit-multi-reader'}}),
    fetch(`${baseUrl}/api/v1/audit-logs`, {headers: {...headers, 'X-Organization-ID': 'org-b', 'X-Legal-Entity-ID': 'legal-b'}}),
  ];
  const deniedResponses = await Promise.all(deniedRequests);
  assert.deepEqual(deniedResponses.map(response => response.status), [403, 403, 403, 403],
    'both route versions must reject denied permissions, ambiguous multi-scope selection, and an unauthorized scope pair');
  assert.equal(poolQueries.length, queriesBeforeDeniedReads,
    'denied, ambiguous multi-scope, and unauthorized-scope reads must not query audit data');

  const deniedGlobalReads = await Promise.all([
    fetch(`${baseUrl}/api/deployment-audit-logs`, {headers: {Authorization: 'Bearer audit-reader'}}),
    fetch(`${baseUrl}/api/v1/deployment-audit-logs`, {headers: {...deploymentHeaders, 'x-audit-permission': 'deny'}}),
    fetch(`${baseUrl}/api/v1/deployment-audit-logs`, {headers: {Authorization: 'Bearer audit-employee-reader'}}),
    fetch(`${baseUrl}/api/v1/deployment-audit-logs`, {headers: {Authorization: 'Bearer audit-disabled-reader'}}),
    fetch(`${baseUrl}/api/v1/deployment-audit-logs`, {headers: {Authorization: 'Bearer audit-unassigned-role-reader'}}),
  ]);
  assert.deepEqual(deniedGlobalReads.map(response => response.status), [403, 403, 403, 403, 403],
    'deployment-wide reads must deny users without a grant, denied permissions, inactive accounts, and sessions whose active role is no longer assigned');
  assert.equal(poolQueries.filter(query => query.sql.includes('al.organization_id is null and al.legal_entity_id is null')).length, 2,
    'negative deployment reads must not query global audit rows');

  failQuery = true;
  const [legacyFailure, versionedFailure] = await Promise.all([
    fetch(`${baseUrl}/api/audit-logs`, {headers}),
    fetch(`${baseUrl}/api/v1/audit-logs`, {headers}),
  ]);
  assert.equal(legacyFailure.status, 500);
  assert.deepEqual(await legacyFailure.json(), {error: 'Database operation failed'},
    'the legacy route must preserve its existing database-error body');
  assert.equal(versionedFailure.status, 500);
  const versionedError = await versionedFailure.json();
  assert.equal(versionedError.error.code, 'INTERNAL_ERROR');
  assert.equal(versionedError.error.message, 'The request could not be completed.');
  assert.equal(versionedError.error.correlationId, versionedFailure.headers.get('x-correlation-id'));
  assert.deepEqual(permissionChecks, [
    'audit.view', 'audit.view', 'audit.view',
    'audit.deployment.view', 'audit.deployment.view',
    'audit.view', 'audit.view',
    'audit.deployment.view', 'audit.deployment.view',
    'audit.view', 'audit.view',
  ], 'each alias must use the intended scoped or deployment audit permission');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Audit history router smoke tests passed.');
