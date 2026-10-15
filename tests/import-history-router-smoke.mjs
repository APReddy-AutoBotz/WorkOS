import assert from 'node:assert/strict';
import express from 'express';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from '../server/api/v1/error-contract.mjs';
import {createImportHistoryRouter} from '../server/modules/imports/import-history-router.mjs';

const app = express();
app.use('/api', createRequestContextMiddleware({idFactory: () => 'import-history-correlation'}));
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json());

const rows = [{
  id: 'import-history-a',
  organization_id: 'org-a',
  legal_entity_id: 'legal-a',
  operation: 'Import',
  file_name: 'synthetic-a.csv',
  status: 'Partial',
  total_rows: 3,
  valid_rows: 2,
  error_rows: 1,
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
const requireDatabase = (req, res, next) => req.get('x-no-database') === 'true'
  ? res.status(503).json({error: 'DATABASE_URL is not configured'}) : next();
const requireAuth = (req, res, next) => {
  const authorizedScopes = req.get('authorization') === 'Bearer import-reader'
    ? [{organizationId: 'org-a', legalEntityId: 'legal-a'}]
    : req.get('authorization') === 'Bearer import-multi-reader'
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
  req.user = {sub: 'import-reader', username: 'server-user', activeRole: 'Admin'};
  req.organizationScope = scope;
  next();
};
const permissionChecks = [];
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push(permission);
  if (req.get('x-import-permission') === 'deny') {
    res.status(403).json({error: 'Insufficient permission privileges'});
    return;
  }
  next();
};
const router = createImportHistoryRouter({
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
  Authorization: 'Bearer import-reader',
  'X-Organization-ID': 'org-a',
  'X-Legal-Entity-ID': 'legal-a',
};

try {
  const legacyResponse = await fetch(`${baseUrl}/api/import-export-logs`, {headers});
  const versionedResponse = await fetch(`${baseUrl}/api/v1/import-export-logs`, {headers});
  assert.equal(legacyResponse.status, 200);
  assert.equal(versionedResponse.status, 200);
  const legacyRows = await legacyResponse.json();
  const versionedRows = await versionedResponse.json();
  assert.deepEqual(versionedRows, legacyRows,
    'the versioned import-history route must preserve the legacy payload and shared handler result');
  assert(poolQueries.every(query => /order by created_at desc limit 100/.test(query.sql)),
    'the legacy history ordering and result limit must remain unchanged');

  const singleScopeNoSelector = await fetch(`${baseUrl}/api/v1/import-export-logs`, {
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
    fetch(`${baseUrl}/api/import-export-logs`, {headers: {...headers, 'x-import-permission': 'deny'}}),
    fetch(`${baseUrl}/api/v1/import-export-logs`, {headers: {...headers, 'x-import-permission': 'deny'}}),
    fetch(`${baseUrl}/api/v1/import-export-logs`, {headers: {Authorization: 'Bearer import-multi-reader'}}),
    fetch(`${baseUrl}/api/v1/import-export-logs`, {headers: {...headers, 'X-Organization-ID': 'org-b', 'X-Legal-Entity-ID': 'legal-b'}}),
  ];
  const deniedResponses = await Promise.all(deniedRequests);
  assert.deepEqual(deniedResponses.map(response => response.status), [403, 403, 403, 403],
    'both route versions must reject denied permissions, ambiguous multi-scope selection, and an unauthorized scope pair');
  assert.equal(poolQueries.length, queriesBeforeDeniedReads,
    'denied, ambiguous multi-scope, and unauthorized-scope reads must not query import history');

  failQuery = true;
  const [legacyFailure, versionedFailure] = await Promise.all([
    fetch(`${baseUrl}/api/import-export-logs`, {headers}),
    fetch(`${baseUrl}/api/v1/import-export-logs`, {headers}),
  ]);
  assert.equal(legacyFailure.status, 500);
  assert.deepEqual(await legacyFailure.json(), {error: 'Database operation failed'},
    'the legacy route must preserve its existing database-error body');
  assert.equal(versionedFailure.status, 500);
  const versionedError = await versionedFailure.json();
  assert.equal(versionedError.error.code, 'INTERNAL_ERROR');
  assert.equal(versionedError.error.message, 'The request could not be completed.');
  assert.equal(versionedError.error.correlationId, versionedFailure.headers.get('x-correlation-id'));
  assert.deepEqual(permissionChecks, Array(7).fill('employees.manage'),
    'both aliases must preserve the existing employees.manage read permission');
  failQuery = false;
  const payload = {
    operation: 'Import', channel: 'Free-form legacy channel', fileName: 'synthetic.csv', status: 'Partial',
    totalRows: 2, validRows: 1, errorRows: 1,
    errors: [{rowNumber: 2, field: 'code', message: 'Invalid code', sourceIdentifier: 'ROW-2'}],
    user_name: 'forged-user', organizationId: 'forged-org', legalEntityId: 'forged-entity',
  };
  const post = (prefix, body = payload, extraHeaders = {}) => fetch(`${baseUrl}${prefix}/import-export-logs`, {
    method: 'POST', headers: {...headers, 'Content-Type': 'application/json', ...extraHeaders},
    body: JSON.stringify(body),
  });
  const writePermissionStart = permissionChecks.length;
  for (const prefix of ['/api', '/api/v1']) {
    const response = await post(prefix);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), rows, 'writes preserve the legacy array response');
    const query = poolQueries.at(-1);
    assert.match(query.sql, /insert into import_export_logs/);
    assert.deepEqual(query.params, ['Import', 'Free-form legacy channel', 'synthetic.csv', 'Partial',
      2, 1, 1, JSON.stringify(payload.errors), 'server-user', 'org-a', 'legal-a'],
    'only validated diagnostics and server-owned actor/scope enter parameterized SQL');
    const omittedErrors = {...payload};
    delete omittedErrors.errors;
    assert.equal((await post(prefix, omittedErrors)).status, 200);
    assert.equal(poolQueries.at(-1).params[7], null);
    assert.equal((await post(prefix, {...payload, errors: []})).status, 200);
    assert.equal(poolQueries.at(-1).params[7], '[]');
    for (const invalid of [
      {...payload, operation: 'Delete'}, {...payload, status: 'Unknown'},
      {...payload, totalRows: -1}, {...payload, validRows: 1.5}, {...payload, errorRows: '1'},
      {...payload, fileName: ''}, {...payload, channel: ''},
      {...payload, errors: [{rowNumber: 0, message: 'bad'}]},
      {...payload, errors: [{rowNumber: 1, message: 'bad', sourceIdentifier: '  '}]},
      {...payload, errors: [{rowNumber: 1, message: 'bad', sourceIdentifier: 'x'.repeat(201)}]},
    ]) {
      const before = poolQueries.length;
      const invalidResponse = await post(prefix, invalid);
      assert.equal(invalidResponse.status, 400);
      const body = await invalidResponse.json();
      if (prefix === '/api/v1') {
        assert.equal(body.error.code, 'BAD_REQUEST');
        assert.equal(body.error.correlationId, invalidResponse.headers.get('x-correlation-id'));
        assert.equal(typeof body.error.operationId, 'string');
      } else assert.equal(typeof body.error.fieldErrors, 'object');
      assert.equal(poolQueries.length, before, 'invalid data must never reach the database');
    }
    for (const [extraHeaders, status] of [
      [{Authorization: ''}, 401], [{'x-import-permission': 'deny'}, 403],
      [{'X-Organization-ID': 'org-b', 'X-Legal-Entity-ID': 'legal-b'}, 403],
      [{Authorization: 'Bearer import-multi-reader', 'X-Organization-ID': '', 'X-Legal-Entity-ID': ''}, 403],
      [{'x-no-database': 'true'}, 503],
    ]) {
      const before = poolQueries.length;
      const denied = await post(prefix, payload, extraHeaders);
      assert.equal(denied.status, status);
      assert.equal(poolQueries.length, before, 'unauthorized or unavailable writes must never query');
    }
    failQuery = true;
    const failed = await post(prefix);
    assert.equal(failed.status, 500);
    const failure = await failed.json();
    if (prefix === '/api/v1') {
      assert.equal(failure.error.code, 'INTERNAL_ERROR');
      assert.equal(failure.error.message, 'The request could not be completed.');
    } else assert.deepEqual(failure, {error: 'Database operation failed'});
    assert(!JSON.stringify(failure).includes('synthetic database detail'));
    failQuery = false;
  }
  assert(permissionChecks.slice(writePermissionStart).every(permission => permission === 'imports.manage'),
    'write aliases must use imports.manage, never the history-read permission');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Import history router smoke tests passed.');
