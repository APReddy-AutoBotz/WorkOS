import assert from 'node:assert/strict';
import express from 'express';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from '../server/api/v1/error-contract.mjs';
import {createIntegrationHistoryRouter} from '../server/modules/integrations/integration-history-router.mjs';

const app = express();
app.use('/api', createRequestContextMiddleware({idFactory: () => 'integration-history-correlation'}));
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json());

const rowsByScope = new Map([
  ['org-a:legal-a', [
    {
      id: 'integration-event-ref-a',
      organization_id: 'org-a',
      legal_entity_id: 'legal-a',
      event_type: 'EntraLoginSucceeded',
      entity_id: 'opaque-ref-a',
      status: 'Success',
      request_payload: {
        provider_subject: 'provider-subject-a',
        provider_upn: 'provider-a@example.test',
        details: {action_url: 'https://example.test/action/a'},
      },
      response_payload: {nested: {upn: 'provider-a@example.test', safe_status: 'Linked'}},
    },
    {
      id: 'integration-event-rejected-a',
      organization_id: 'org-a',
      legal_entity_id: 'legal-a',
      event_type: 'EntraLoginRejected',
      entity_id: 'provider-subject-a',
      status: 'Failed',
      request_payload: {reason: 'invalid token'},
      response_payload: null,
    },
  ]],
  ['org-b:legal-b', [{
    id: 'integration-event-ref-b',
    organization_id: 'org-b',
    legal_entity_id: 'legal-b',
    event_type: 'TeamsActionCreated',
    entity_id: 'opaque-ref-b',
    status: 'Success',
    request_payload: {safe: true},
    response_payload: {safe_status: 'Created'},
  }]],
]);
const poolQueries = [];
const loggedErrors = [];
let failQuery = false;
const pool = {
  async query(sql, params) {
    poolQueries.push({sql, params});
    if (failQuery) throw new Error('synthetic integration-event database detail');
    const rows = rowsByScope.get(`${params[0]}:${params[1]}`);
    if (!rows) throw new Error('unexpected integration-event scope');
    return {rows};
  },
};
const requireDatabase = (_req, _res, next) => next();
const requireIdentity = (_req, _res, next) => next();
const requireAuth = (req, res, next) => {
  const authorizedScopes = req.get('authorization') === 'Bearer integration-reader'
    ? [{organizationId: 'org-a', legalEntityId: 'legal-a'}]
    : req.get('authorization') === 'Bearer integration-multi-reader'
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
  req.user = {sub: 'integration-reader', activeRole: 'Admin'};
  req.organizationScope = scope;
  next();
};
const permissionChecks = [];
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push(permission);
  if (req.get('x-integration-permission') === 'deny') {
    res.status(403).json({error: 'Insufficient permission privileges'});
    return;
  }
  next();
};
const router = createIntegrationHistoryRouter({
  pool,
  requireDatabase,
  requireAuth,
  requireIdentity,
  requirePermission,
  logError: error => loggedErrors.push(error.message),
});
app.use('/api', router);
app.use('/api/v1', router);
app.use('/api/v1', versionedApiErrorHandler);

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const scopeAHeaders = {
  Authorization: 'Bearer integration-reader',
  'X-Organization-ID': 'org-a',
  'X-Legal-Entity-ID': 'legal-a',
};

try {
  const [legacyAResponse, versionedAResponse] = await Promise.all([
    fetch(`${baseUrl}/api/integrations/events`, {headers: scopeAHeaders}),
    fetch(`${baseUrl}/api/v1/integrations/events`, {headers: scopeAHeaders}),
  ]);
  assert.equal(legacyAResponse.status, 200);
  assert.equal(versionedAResponse.status, 200);
  const legacyRowsA = await legacyAResponse.json();
  const versionedRowsA = await versionedAResponse.json();
  assert.deepEqual(versionedRowsA, legacyRowsA,
    'the versioned event reader must preserve the legacy DTO and shared handler result');
  assert.equal(legacyRowsA.find(row => row.id === 'integration-event-ref-a').entity_id, 'opaque-ref-a',
    'opaque identity-link references remain usable in the selected scope');
  assert.equal(legacyRowsA.find(row => row.id === 'integration-event-rejected-a').entity_id, null,
    'rejected Entra events continue to hide provider subjects');
  assert(!JSON.stringify(legacyRowsA).includes('provider-subject-a'));
  assert(!JSON.stringify(legacyRowsA).includes('provider-a@example.test'));
  assert(!JSON.stringify(legacyRowsA).includes('https://example.test/action/a'));

  const multiScopeBResponse = await fetch(`${baseUrl}/api/v1/integrations/events`, {
    headers: {
      Authorization: 'Bearer integration-multi-reader',
      'X-Organization-ID': 'org-b',
      'X-Legal-Entity-ID': 'legal-b',
    },
  });
  assert.equal(multiScopeBResponse.status, 200);
  assert.deepEqual(await multiScopeBResponse.json(), rowsByScope.get('org-b:legal-b'),
    'a multi-scope reader must see only the explicitly selected scope B rows');

  const singleScopeNoSelector = await fetch(`${baseUrl}/api/v1/integrations/events`, {
    headers: {Authorization: scopeAHeaders.Authorization},
  });
  assert.equal(singleScopeNoSelector.status, 200,
    'the server may select the sole authorized organization/legal-entity pair when selectors are omitted');
  assert.deepEqual(await singleScopeNoSelector.json(), legacyRowsA);

  assert(poolQueries.every(({sql}) => sql.replace(/\s+/g, ' ').trim()
    === 'select * from integration_event_logs where organization_id=$1 and legal_entity_id=$2 order by created_at desc limit 300'),
  'both aliases must preserve the exact selected-scope query, ordering, and 300-row limit');
  assert.deepEqual(poolQueries.slice(0, 4).map(query => query.params), [
    ['org-a', 'legal-a'],
    ['org-a', 'legal-a'],
    ['org-b', 'legal-b'],
    ['org-a', 'legal-a'],
  ]);

  const queriesBeforeDeniedReads = poolQueries.length;
  const deniedResponses = await Promise.all([
    fetch(`${baseUrl}/api/integrations/events`, {headers: {...scopeAHeaders, 'x-integration-permission': 'deny'}}),
    fetch(`${baseUrl}/api/v1/integrations/events`, {headers: {...scopeAHeaders, 'x-integration-permission': 'deny'}}),
    fetch(`${baseUrl}/api/v1/integrations/events`, {headers: {Authorization: 'Bearer integration-multi-reader'}}),
    fetch(`${baseUrl}/api/v1/integrations/events`, {
      headers: {...scopeAHeaders, 'X-Organization-ID': 'org-x', 'X-Legal-Entity-ID': 'legal-x'},
    }),
    fetch(`${baseUrl}/api/integrations/events`, {headers: {Authorization: 'Bearer unknown-reader'}}),
  ]);
  assert.deepEqual(deniedResponses.map(response => response.status), [403, 403, 403, 403, 401],
    'permission denial, ambiguous multi-scope selection, unauthorized scope, and unauthenticated reads must fail closed');
  assert.equal(poolQueries.length, queriesBeforeDeniedReads,
    'denied, ambiguous, unauthorized, or unauthenticated requests must not query integration history');

  failQuery = true;
  const [legacyFailure, versionedFailure] = await Promise.all([
    fetch(`${baseUrl}/api/integrations/events`, {headers: scopeAHeaders}),
    fetch(`${baseUrl}/api/v1/integrations/events`, {headers: scopeAHeaders}),
  ]);
  assert.equal(legacyFailure.status, 500);
  assert.deepEqual(await legacyFailure.json(), {error: 'Database operation failed'},
    'the legacy route must preserve its database-error body');
  assert.equal(versionedFailure.status, 500);
  const versionedError = await versionedFailure.json();
  assert.equal(versionedError.error.code, 'INTERNAL_ERROR');
  assert.equal(versionedError.error.message, 'The request could not be completed.');
  assert.equal(versionedError.error.correlationId, versionedFailure.headers.get('x-correlation-id'));
  assert.deepEqual(permissionChecks, Array(8).fill('integrations.identity'),
    'both aliases must preserve the existing integrations.identity permission');
  assert.deepEqual(loggedErrors, [
    'synthetic integration-event database detail',
    'synthetic integration-event database detail',
  ], 'the reader must log database failures without exposing details in either response');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Integration history router smoke tests passed.');
