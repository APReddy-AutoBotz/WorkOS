import assert from 'node:assert/strict';
import {createIdentityAccessMiddleware, readCookie} from '../server/modules/identity-access/middleware.mjs';

const createRequest = ({authorization, cookie} = {}) => ({
  headers: {
    ...(authorization ? {authorization} : {}),
    ...(cookie ? {cookie} : {}),
  },
});

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const execute = async (middleware, request) => {
  const response = createResponse();
  let nextCalled = false;
  await middleware(request, response, () => { nextCalled = true; });
  return {request, response, nextCalled};
};

let currentRole = true;
let identityStorageAvailable = true;
const database = {query: async (_sql, parameters) => {
  assert.deepEqual(parameters, ['user-test', 'Admin']);
  if (!identityStorageAvailable) throw new Error('synthetic storage failure');
  return {rowCount: currentRole ? 1 : 0};
}};
const resolveOrganizationScope = async (_database, request) => {
  if (request.failScope) {
    const error = new Error('scope denied');
    error.statusCode = 403;
    error.code = 'ORG_SCOPE_DENIED';
    throw error;
  }
  if (request.missingScopeTable) {
    const error = new Error('relation does not exist');
    error.code = '42P01';
    throw error;
  }
  return {organizationId: 'org-test', legalEntityId: 'legal-test'};
};
const verifyToken = token => token === 'valid-session'
  ? {sub: 'user-test', username: 'synthetic', activeRole: 'Admin'}
  : null;

assert.equal(readCookie(createRequest({cookie: 'other=value; workos_session=valid-session'}), 'workos_session'),
  'valid-session', 'shared identity utility must read the Entra callback session cookie');
assert.equal(readCookie(createRequest({cookie: 'workos_session_suffix=wrong'}), 'workos_session'), undefined,
  'cookie names must match exactly');

const normal = createIdentityAccessMiddleware({verifyToken, database, resolveOrganizationScope});

const missing = await execute(normal.requireIdentity, createRequest());
assert.equal(missing.nextCalled, false, 'missing identity must stop before the handler');
assert.equal(missing.response.statusCode, 401);
assert.deepEqual(missing.response.body, {error: 'Authentication required'});

const identityOnly = await execute(normal.requireIdentity, createRequest({authorization: 'Bearer valid-session'}));
assert.equal(identityOnly.nextCalled, true, 'identity-only routes may run without a selected data scope');
assert.equal(identityOnly.request.user.sub, 'user-test');
assert.equal(identityOnly.request.organizationScope, undefined,
  'scope discovery must not implicitly resolve an organization scope');

const scoped = await execute(normal.requireAuth, createRequest({cookie: 'other=x; workos_session=valid-session'}));
assert.equal(scoped.nextCalled, true);
assert.deepEqual(scoped.request.organizationScope, {organizationId: 'org-test', legalEntityId: 'legal-test'});
assert.equal(scoped.request.user.organizationId, 'org-test');
assert.equal(scoped.request.user.legalEntityId, 'legal-test');

const deniedRequest = createRequest({authorization: 'Bearer valid-session'});
deniedRequest.failScope = true;
const denied = await execute(normal.requireAuth, deniedRequest);
assert.equal(denied.nextCalled, false, 'denied scope must fail closed');
assert.equal(denied.response.statusCode, 403);
assert.deepEqual(denied.response.body, {
  error: 'Authoritative organization scope is unavailable',
  code: 'ORG_SCOPE_DENIED',
});

const closedByDefault = createIdentityAccessMiddleware({
  verifyToken,
  database,
  resolveOrganizationScope,
  allowTestFallback: () => false,
});
const missingTableRequest = createRequest({authorization: 'Bearer valid-session'});
missingTableRequest.missingScopeTable = true;
const missingTable = await execute(closedByDefault.requireAuth, missingTableRequest);
assert.equal(missingTable.nextCalled, false);
assert.equal(missingTable.response.statusCode, 503, 'missing scope storage must fail closed by default');

const explicitTestFallback = createIdentityAccessMiddleware({
  verifyToken,
  database,
  resolveOrganizationScope,
  allowTestFallback: () => true,
});
const fallbackRequest = createRequest({authorization: 'Bearer valid-session'});
fallbackRequest.missingScopeTable = true;
const fallback = await execute(explicitTestFallback.requireAuth, fallbackRequest);
assert.equal(fallback.nextCalled, true, 'only an explicitly injected test fallback may use the default scope');
assert.deepEqual(fallback.request.organizationScope, {organizationId: 'org-default', legalEntityId: 'legal-default'});

for (const middleware of [normal.requireIdentity, normal.requireAuth, explicitTestFallback.requireAuth]) {
  currentRole = false;
  const removed = await execute(middleware, createRequest({authorization: 'Bearer valid-session'}));
  assert.equal(removed.nextCalled, false);
  assert.equal(removed.response.statusCode, 403);
  assert.equal(removed.response.body.code, 'SESSION_ROLE_REVOKED');
  currentRole = true;
  identityStorageAvailable = false;
  const unavailable = await execute(middleware, createRequest({cookie: 'workos_session=valid-session'}));
  assert.equal(unavailable.nextCalled, false);
  assert.equal(unavailable.response.statusCode, 503);
  assert.equal(unavailable.response.body.code, 'IDENTITY_AUTHORITY_UNAVAILABLE');
  identityStorageAvailable = true;
}

console.log('Identity access middleware and current-role revocation smoke tests passed.');
