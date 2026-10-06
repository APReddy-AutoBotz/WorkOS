import assert from 'node:assert/strict';
import express from 'express';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from '../server/api/v1/error-contract.mjs';
import {createIdentityReadRouter} from '../server/modules/identity-access/read-router.mjs';
import {parseApiClientError} from '../src/services/apiClient.ts';

let generatedId = 0;
const app = express();
app.use('/api', createRequestContextMiddleware({idFactory: () => `generated-${++generatedId}`}));
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json({limit: '32b'}));

const requireDatabase = (_req, _res, next) => next();
const requireIdentity = (req, res, next) => {
  if (req.get('authorization') === 'Bearer valid-session') {
    req.user = {sub: 'user-test', activeRole: 'Admin'};
    next();
    return;
  }
  res.status(401).json({error: 'Authentication required'});
};
const identityPayload = {id: 'user-test', activeRole: 'Admin', roles: ['Admin']};
const listOrganizationScopes = (req, res) => {
  if (req.query.fail === 'true') {
    res.status(503).json({error: 'Database details must not be exposed', code: 'ORG_SCOPE_UNAVAILABLE'});
    return;
  }
  res.json([{organizationId: 'org-test', legalEntityId: 'legal-test'}]);
};
const refreshSession = (_req, res) => res.json(identityPayload);
const identityDependencies = {requireDatabase, requireIdentity, listOrganizationScopes, refreshSession};

app.use('/api/auth', createIdentityReadRouter(identityDependencies));
app.use('/api/v1/auth', createIdentityReadRouter(identityDependencies));
app.post('/api/v1/commands', (_req, res) => res.status(422).json({error: 'Invalid command', code: 'COMMAND_INVALID'}));
app.get('/api/v1/throws', (_req, _res, next) => next(Object.assign(new Error('private database detail'), {code: 'DATABASE_FAILURE'})));
app.get('/api/legacy-error', (_req, res) => res.status(500).json({error: 'Legacy response remains unchanged'}));
app.use('/api/v1', versionedApiErrorHandler);
app.use('/api', (_req, res) => res.status(404).json({error: 'Not found'}));

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
try {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const legacyUnauthorized = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(legacyUnauthorized.status, 401);
  assert.deepEqual(await legacyUnauthorized.json(), {error: 'Authentication required'},
    'legacy API error bodies stay compatible');
  assert.equal(legacyUnauthorized.headers.get('x-correlation-id'), 'generated-1');
  assert.equal(legacyUnauthorized.headers.get('x-operation-id'), null);

  const versionedUnauthorized = await fetch(`${baseUrl}/api/v1/auth/me`);
  assert.equal(versionedUnauthorized.status, 401);
  const unauthorizedBody = await versionedUnauthorized.json();
  assert.deepEqual(unauthorizedBody.error, {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication required',
    correlationId: 'generated-2',
  });

  const versionedMe = await fetch(`${baseUrl}/api/v1/auth/me`, {headers: {Authorization: 'Bearer valid-session'}});
  assert.equal(versionedMe.status, 200);
  assert.deepEqual(await versionedMe.json(), identityPayload, 'versioned success preserves the existing identity payload');

  const scopeList = await fetch(`${baseUrl}/api/v1/auth/organization-scopes`, {
    headers: {Authorization: 'Bearer valid-session', 'X-Correlation-ID': 'trace-client-007'},
  });
  assert.equal(scopeList.status, 200);
  assert.deepEqual(await scopeList.json(), [{organizationId: 'org-test', legalEntityId: 'legal-test'}]);
  assert.equal(scopeList.headers.get('x-correlation-id'), 'trace-client-007', 'valid caller correlation IDs are retained');

  const unavailableScopes = await fetch(`${baseUrl}/api/v1/auth/organization-scopes?fail=true`, {
    headers: {Authorization: 'Bearer valid-session'},
  });
  assert.equal(unavailableScopes.status, 503);
  const unavailableBody = await unavailableScopes.json();
  assert.equal(unavailableBody.error.code, 'ORG_SCOPE_UNAVAILABLE');
  assert.equal(unavailableBody.error.message, 'The request could not be completed.');
  assert.equal(unavailableBody.error.correlationId, unavailableScopes.headers.get('x-correlation-id'));
  assert.equal(JSON.stringify(unavailableBody).includes('Database details'), false, 'server details are not exposed by v1 errors');

  const commandResponse = await fetch(`${baseUrl}/api/v1/commands`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Correlation-ID': 'invalid trace id'},
    body: '{}',
  });
  assert.equal(commandResponse.status, 422);
  const commandBody = await commandResponse.json();
  assert.equal(commandBody.error.code, 'COMMAND_INVALID');
  assert.equal(commandBody.error.correlationId, commandResponse.headers.get('x-correlation-id'));
  assert.equal(commandBody.error.operationId, commandResponse.headers.get('x-operation-id'));
  assert.notEqual(commandBody.error.correlationId, 'invalid trace id', 'invalid trace IDs are replaced');

  const malformedJson = await fetch(`${baseUrl}/api/v1/commands`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: '{',
  });
  assert.equal(malformedJson.status, 400);
  const malformedBody = await malformedJson.json();
  assert.equal(malformedBody.error.code, 'INVALID_REQUEST_BODY');
  assert.equal(malformedBody.error.message, 'Request body must be valid JSON.');
  assert.equal(malformedBody.error.correlationId, malformedJson.headers.get('x-correlation-id'));
  assert.equal(malformedBody.error.operationId, malformedJson.headers.get('x-operation-id'));

  const oversizedJson = await fetch(`${baseUrl}/api/v1/commands`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({value: 'x'.repeat(64)}),
  });
  assert.equal(oversizedJson.status, 413);
  const oversizedBody = await oversizedJson.json();
  assert.equal(oversizedBody.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(oversizedBody.error.message, 'Request body exceeds the allowed size.');
  assert.equal(oversizedBody.error.correlationId, oversizedJson.headers.get('x-correlation-id'));
  assert.equal(oversizedBody.error.operationId, oversizedJson.headers.get('x-operation-id'));

  const thrown = await fetch(`${baseUrl}/api/v1/throws`);
  assert.equal(thrown.status, 500);
  const thrownBody = await thrown.json();
  assert.equal(thrownBody.error.code, 'DATABASE_FAILURE');
  assert.equal(thrownBody.error.message, 'The request could not be completed.');
  assert.equal(JSON.stringify(thrownBody).includes('private database detail'), false);

  const legacyError = await fetch(`${baseUrl}/api/legacy-error`);
  assert.deepEqual(await legacyError.json(), {error: 'Legacy response remains unchanged'});

  const clientError = parseApiClientError(409, {error: {code: 'CONFLICT', message: 'Conflict', operationId: 'op-server'}},
    new Headers({'X-Correlation-ID': 'trace-server'}));
  assert.equal(clientError.message, 'Conflict');
  assert.equal(clientError.code, 'CONFLICT');
  assert.equal(clientError.correlationId, 'trace-server');
  assert.equal(clientError.operationId, 'op-server');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Versioned API contract smoke tests passed.');
