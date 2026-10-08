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
const poolQueries = [];
let failQuery = false;
const pool = {
  async query(sql, params) {
    poolQueries.push({sql, params});
    if (failQuery) throw new Error('synthetic database detail');
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
  ], 'both routes must query only the server-resolved organization/legal-entity pair');

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
  assert.deepEqual(permissionChecks, Array(7).fill('audit.view'),
    'both aliases use the same audit.view permission guard');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Audit history router smoke tests passed.');
