import assert from 'node:assert/strict';

// Import only after fixing production configuration: no test/demo fallback is permitted.
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';

const values = new Map();
const localAccesses = [];
globalThis.sessionStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
};
const forbiddenLocalStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear'].map(method => [method, (...args) => {
  localAccesses.push({method, args});
  throw new Error('Production organization profile must not access browser-local records.');
}]));
globalThis.localStorage = forbiddenLocalStorage;
const events = [];
globalThis.window = {
  localStorage: forbiddenLocalStorage,
  location: {pathname: '/organization-profile', href: '/organization-profile'},
  dispatchEvent: event => { events.push(event.type); return true; },
};

const {adminService} = await import('../src/services/api.ts');
const {api, ApiClientError, getOrganizationScope, getToken, isDemoFallbackAllowed, resetBackendCheck} = await import('../src/services/apiClient.ts');
const {captureOrganizationProfileContext, isOrganizationProfileContextCurrent} = await import('../src/services/organizationProfileScope.ts');
assert.equal(isDemoFallbackAllowed(), false);

const sessionKey = 'workos_session';
const scopeKey = 'workos_organization_scope';
const tokenKey = 'workos_api_token';
const profilePath = '/api/organization-setup/profile';
const readinessPath = '/api/organization-setup/readiness';
const originalScope = {organizationId: 'org-synthetic-one', legalEntityId: 'legal-synthetic-one'};
const nextScope = {organizationId: 'org-synthetic-two', legalEntityId: 'legal-synthetic-two'};
const originalToken = 'synthetic-profile-session-one';
const originalUser = {
  id: 'worker-synthetic-one', employeeId: 'SYN-PROFILE-ONE', role: 'HR', permissionRole: 'HR',
  permissions: ['settings.manage', 'employees.view'], name: 'Synthetic Profile Operator',
};
const rawProfile = {
  organization_id: originalScope.organizationId,
  organization_code: 'SYNTHETIC-ONE',
  organization_name: 'Synthetic Organization',
  legal_name: 'Synthetic Organization Limited',
  product_display_name: 'Synthetic Workspace',
  support_contact: 'support@example.test',
  default_locale: 'en-GB',
  default_time_zone: 'Europe/London',
  base_currency: 'GBP',
  fiscal_year_start: '04-01',
  default_week_start: '0',
  profile_effective_from: '2026-10-01',
  ignored_server_field: 'not-part-of-the-profile-contract',
};
const expectedProfile = {
  organizationId: originalScope.organizationId,
  code: 'SYNTHETIC-ONE',
  name: 'Synthetic Organization',
  legalName: 'Synthetic Organization Limited',
  productDisplayName: 'Synthetic Workspace',
  supportContact: 'support@example.test',
  defaultLocale: 'en-GB',
  defaultTimeZone: 'Europe/London',
  baseCurrency: 'GBP',
  fiscalYearStart: '04-01',
  defaultWeekStart: 0,
  effectiveFrom: '2026-10-01',
};
const readiness = {
  organizationId: originalScope.organizationId,
  legalEntityId: originalScope.legalEntityId,
  checks: {
    organization: true, legal_entity: true, calendars: false, roles: true, identity: true,
    initial_users: true, imports: false, commercial_defaults: false, notifications: false,
    production_readiness: false, worker_type: true, reporting_period: false,
  },
  evidence: {organization: 'Persisted synthetic profile', calendars: 'No active working calendar'},
  ready: false,
  authority: 'persisted-server-state',
};
const editableProfile = {
  ...expectedProfile, name: 'Revised Synthetic Organization', defaultWeekStart: 1,
  code: 'ATTEMPTED-CODE-CHANGE', legalEntityId: 'attempted-legal-override',
  organization_id: 'attempted-organization-override', role: 'Admin',
  permissions: ['permissions.manage'], etag: 'caller-invented-version', unexpected: 'must-be-stripped',
};
const expectedPutBody = {
  organizationId: originalScope.organizationId, name: 'Revised Synthetic Organization',
  legalName: 'Synthetic Organization Limited', productDisplayName: 'Synthetic Workspace',
  supportContact: 'support@example.test', defaultLocale: 'en-GB', defaultTimeZone: 'Europe/London',
  baseCurrency: 'GBP', fiscalYearStart: '04-01', defaultWeekStart: 1, effectiveFrom: '2026-10-01',
};
const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: {'Content-Type': 'application/json', ETag: '"synthetic-unadvertised-version"'},
});
const failurePayload = {error: {
  code: 'SYNTHETIC_PROFILE_FAILURE', message: 'Synthetic backend rejection',
  correlationId: 'synthetic-correlation', operationId: 'synthetic-operation',
}};
const calls = [];
let healthState;
let healthError;
let healthStatus;
let healthGate;
let businessStatus;
let businessError;
let businessGate;
let payloadOverride;
globalThis.fetch = async (url, init = {}) => {
  // Snapshot dispatched values; later session changes must not rewrite an in-flight request.
  calls.push({url, init: {...init, ...(init.headers ? {headers: {...init.headers}} : {})}});
  if (url === '/api/health') {
    assert.equal(init.credentials, 'include');
    assert.equal(init.method, undefined, 'health uses the existing implicit GET');
    const result = healthError ? null : response({database: healthState}, healthStatus);
    const error = healthError;
    if (healthGate) await healthGate.promise;
    if (error) throw error;
    return result;
  }
  assert([profilePath, readinessPath].includes(url), `Unexpected service request: ${url}`);
  const status = businessStatus;
  const error = businessError;
  const payload = status === 200 ? payloadOverride ?? (url === profilePath ? rawProfile : readiness) : failurePayload;
  if (businessGate) await businessGate.promise;
  if (error) throw error;
  return response(payload, status);
};
const setUser = user => values.set(sessionKey, JSON.stringify(user));
const setScope = scope => values.set(scopeKey, JSON.stringify(scope));
const snapshot = () => ({session: [...values], href: window.location.href, events: [...events]});
const reset = () => {
  values.clear();
  setUser(structuredClone(originalUser));
  setScope(originalScope);
  values.set(tokenKey, originalToken);
  calls.length = 0;
  events.length = 0;
  window.location.href = '/organization-profile';
  healthState = 'connected'; healthStatus = 200; healthError = null; healthGate = null;
  businessStatus = 200; businessError = null; businessGate = null; payloadOverride = undefined;
  resetBackendCheck();
};
const deferred = () => {
  let resolve;
  const promise = new Promise(release => { resolve = release; });
  return {promise, resolve};
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const denied = error => error instanceof ApiClientError && error.status === 403;
const operations = [
  {name: 'profile GET', path: profilePath, method: 'GET', health: true, run: context => adminService.getOrganizationProfile(context)},
  {name: 'profile PUT', path: profilePath, method: 'PUT', health: false, run: context => adminService.updateOrganizationProfile(editableProfile, context)},
  {name: 'readiness GET', path: readinessPath, method: 'GET', health: true, run: context => adminService.getOrganizationSetupReadinessForProfile(context)},
];
const expectedHeaders = (scope = originalScope, token = originalToken) => ({
  'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
  'X-Organization-Id': scope.organizationId, 'X-Legal-Entity-Id': scope.legalEntityId,
});
const assertRequest = (call, operation, scope = originalScope, token = originalToken) => {
  assert.equal(call.url, operation.path);
  assert.deepEqual(call.init, {
    method: operation.method, credentials: 'include', headers: expectedHeaders(scope, token),
    ...(operation.method === 'PUT' ? {body: JSON.stringify(expectedPutBody)} : {}),
  }, `${operation.name} uses only the specified HTTP contract, without invented ETag/If-Match/version headers`);
};
const assertDispatch = operation => {
  assert.deepEqual(calls.map(call => call.url), [...(operation.health ? ['/api/health'] : []), operation.path]);
  assertRequest(calls.at(-1), operation);
};

// Every profile field, snake-case normalization, Sunday zero, server code and readiness authority survive.
for (const operation of operations) {
  reset();
  const before = snapshot();
  const callerProfile = structuredClone(editableProfile);
  const result = await operation.run();
  assert.deepEqual(result, operation.path === readinessPath ? readiness : expectedProfile);
  assertDispatch(operation);
  assert.deepEqual(editableProfile, callerProfile, 'serializing a save does not mutate the caller draft');
  assert.deepEqual(snapshot(), before, 'ordinary profile reads/saves never rewrite the authenticated session or selected scope');
}

for (const operation of operations.filter(item => item.path === profilePath)) {
  reset();
  payloadOverride = {...rawProfile, profile_effective_from: '2026-10-01T00:00:00.000Z'};
  assert.deepEqual(await operation.run(), expectedProfile, `${operation.name} converts serialized UTC API dates to the date-input contract`);
  assertDispatch(operation);
  for (const invalidDate of ['2026-10-19T18:30:00.000Z', '2026-10-20T00:00:00.001Z']) {
    reset();
    payloadOverride = {...rawProfile, profile_effective_from: invalidDate};
    const before = snapshot();
    await assert.rejects(operation.run(), error => error instanceof ApiClientError && error.status === 502,
      `${operation.name} rejects shifted/non-midnight date transport instead of silently publishing a different effective day`);
    assertDispatch(operation);
    assert.deepEqual(snapshot(), before, 'invalid date transport cannot mutate session, scope or navigation');
  }
}

// The actual response normalizer, not a test-local surrogate, owns conversions for all profile fields.
reset();
payloadOverride = Object.fromEntries(Object.entries(rawProfile).map(([key], index) => [key, index + 100]));
payloadOverride.profile_effective_from = expectedProfile.effectiveFrom;
const converted = await adminService.getOrganizationProfile();
for (const [clientKey, serverKey] of Object.entries({
  organizationId: 'organization_id', code: 'organization_code', name: 'organization_name', legalName: 'legal_name',
  productDisplayName: 'product_display_name', supportContact: 'support_contact', defaultLocale: 'default_locale',
  defaultTimeZone: 'default_time_zone', baseCurrency: 'base_currency', fiscalYearStart: 'fiscal_year_start', effectiveFrom: 'profile_effective_from',
})) assert.equal(converted[clientKey], String(payloadOverride[serverKey]), `${clientKey} is normalized to a string`);
assert.equal(converted.defaultWeekStart, Number(payloadOverride.default_week_start));
assert.deepEqual(Object.keys(converted).sort(), Object.keys(expectedProfile).sort());

// GET/readiness fail closed on unavailable health, without local records or business dispatch.
for (const operation of operations.filter(item => item.health)) {
  for (const failure of ['offline', 'network', 'http']) {
    reset();
    if (failure === 'offline') healthState = 'offline';
    if (failure === 'network') healthError = new TypeError('Synthetic health network failure');
    if (failure === 'http') { healthStatus = 503; healthState = 'offline'; }
    await assert.rejects(operation.run(), /Backend API is required/, `${operation.name} ${failure} health rejects`);
    assert.deepEqual(calls.map(call => call.url), ['/api/health']);
  }
}

// Production business failures propagate their true HTTP/network outcome, never a local success.
for (const operation of operations) {
  for (const status of [400, 401, 403, 404, 409, 422, 500, 502, 503, 504]) {
    reset();
    businessStatus = status;
    const before = snapshot();
    await assert.rejects(operation.run(), error => {
      assert(error instanceof ApiClientError);
      assert.equal(error.status, status);
      assert.equal(error.code, failurePayload.error.code);
      assert.equal(error.message, failurePayload.error.message);
      assert.equal(error.correlationId, failurePayload.error.correlationId);
      assert.equal(error.operationId, failurePayload.error.operationId);
      return true;
    }, `${operation.name} ${status} is not converted into a fake success`);
    assertDispatch(operation);
    assert.deepEqual(snapshot(), before, 'scoped 401 and other errors do not invoke global logout/navigation');
  }
  reset();
  businessError = new TypeError('Synthetic business network failure');
  const expectedError = businessError;
  await assert.rejects(operation.run(), error => error === expectedError);
  assertDispatch(operation);
  businessError = null;
  assert.deepEqual(await operation.run(), operation.path === readinessPath ? readiness : expectedProfile, 'a subsequent request can recover');
}

// Capture/permission failures must occur before even the backend health await.
for (const operation of operations) {
  for (const [reason, invalidate] of [
    ['missing scope', () => values.delete(scopeKey)],
    ['missing organization', () => setScope({legalEntityId: originalScope.legalEntityId})],
    ['missing legal entity', () => setScope({organizationId: originalScope.organizationId})],
    ['malformed scope', () => values.set(scopeKey, '{invalid')],
    ['missing actor', () => setUser(null)],
    ['no management permission', () => setUser({...originalUser, permissions: []})],
  ]) {
    reset();
    invalidate();
    assert.equal(captureOrganizationProfileContext(), null, reason);
    await assert.rejects(operation.run(), denied, `${operation.name}: ${reason}`);
    assert.deepEqual(calls, [], `${reason} does not contact health or business APIs`);
  }
  reset();
  await assert.rejects(operation.run(null), denied, `${operation.name} refuses an explicitly absent context`);
  assert.deepEqual(calls, []);
  const expired = captureOrganizationProfileContext(() => false);
  await assert.rejects(operation.run(expired), denied, `${operation.name} refuses an expired UI generation`);
  assert.deepEqual(calls, []);
}

const contextChanges = [
  ['actor ID', () => setUser({...originalUser, id: 'worker-synthetic-other'})],
  ['employee ID', () => setUser({...originalUser, employeeId: 'SYN-PROFILE-OTHER'})],
  ['active role', () => setUser({...originalUser, role: 'Admin'})],
  ['permission role', () => setUser({...originalUser, permissionRole: undefined})],
  ['effective permission set', () => setUser({...originalUser, permissions: [...originalUser.permissions, 'projects.view']})],
  ['management permission removal', () => setUser({...originalUser, permissions: ['employees.view']})],
  ['bearer token', () => values.set(tokenKey, 'synthetic-profile-session-other')],
  ['bearer token removal', () => values.delete(tokenKey)],
  ['organization', () => setScope({...originalScope, organizationId: nextScope.organizationId})],
  ['legal entity', () => setScope({...originalScope, legalEntityId: nextScope.legalEntityId})],
];

for (const operation of operations) {
  for (const [reason, change] of contextChanges) {
    reset();
    const context = captureOrganizationProfileContext();
    assert(context);
    change();
    assert.equal(isOrganizationProfileContextCurrent(context), false, `${reason} invalidates the captured context`);
    await assert.rejects(operation.run(context), denied, `${operation.name} rejects a prior ${reason}`);
    assert.deepEqual(calls, [], 'stale explicit contexts never dispatch health or a business request');
  }
}

// Both readers must capture the implicit context before health and reassert it after health.
for (const operation of operations.filter(item => item.health)) {
  for (const [reason, change] of contextChanges) {
    reset();
    healthGate = deferred();
    const pending = operation.run();
    const rejected = assert.rejects(pending, denied, `${operation.name} stops after ${reason} changes during health`);
    assert.deepEqual(calls.map(call => call.url), ['/api/health']);
    change();
    healthGate.resolve();
    await rejected;
    assert.deepEqual(calls.map(call => call.url), ['/api/health'], 'health completion cannot dispatch under the replacement context');
  }
  reset();
  let currentGeneration = true;
  const context = captureOrganizationProfileContext(() => currentGeneration);
  healthGate = deferred();
  const rejected = assert.rejects(operation.run(context), denied, `${operation.name} rechecks UI generation after health`);
  currentGeneration = false;
  healthGate.resolve();
  await rejected;
  assert.deepEqual(calls.map(call => call.url), ['/api/health']);
}

// Equivalent effective permissions are order-independent; unrelated display metadata is not identity.
reset();
const equivalent = captureOrganizationProfileContext();
setUser({...originalUser, name: 'Revised Synthetic Display Name', permissions: [...originalUser.permissions].reverse()});
assert.equal(isOrganizationProfileContextCurrent(equivalent), true);
assert.deepEqual(await adminService.getOrganizationProfile(equivalent), expectedProfile);

reset();
await assert.rejects(adminService.updateOrganizationProfile({...editableProfile, organizationId: nextScope.organizationId}), denied);
assert.deepEqual(calls, [], 'body organization mismatch is rejected before any write, not repaired silently');

// Low-level explicit scope methods retain their override rather than reading replacement global scope.
for (const method of ['GET', 'PUT']) {
  reset();
  setScope(nextScope);
  if (method === 'GET') await api.getWithScope(profilePath, originalScope);
  else await api.putWithScope(profilePath, expectedPutBody, originalScope);
  assert.equal(calls.length, 1);
  assertRequest(calls[0], {name: `explicit-scope ${method}`, path: profilePath, method});
  assert.deepEqual(getOrganizationScope(), nextScope);
}

// Once dispatched, a save is not redirected to another organization. Its completion is session-neutral.
// Readers use the same scoped transport: a stale 401 must not clear a newly established login/scope.
for (const operation of operations) {
  for (const status of [200, 401, 409]) {
    reset();
    businessStatus = status;
    businessGate = deferred();
    let currentGeneration = true;
    const context = captureOrganizationProfileContext(() => currentGeneration);
    const pending = operation.run(context);
    const completion = status === 200 ? pending : assert.rejects(pending, error => error instanceof ApiClientError && error.status === status);
    await flush();
    assertDispatch(operation);
    setUser({...originalUser, id: 'worker-synthetic-next', employeeId: 'SYN-PROFILE-NEXT', role: 'Admin', permissionRole: 'Admin'});
    setScope(nextScope);
    values.set(tokenKey, 'synthetic-profile-session-next');
    currentGeneration = false;
    const replacement = snapshot();
    businessGate.resolve();
    const result = await completion;
    if (status === 200) assert.deepEqual(result, operation.path === readinessPath ? readiness : expectedProfile);
    assertRequest(calls.at(-1), operation);
    assert.deepEqual(snapshot(), replacement, `${operation.name} late ${status} cannot clear or mutate the new authenticated context`);
    assert.equal(getToken(), 'synthetic-profile-session-next');
  }
}

// Guard the shared-client compatibility boundary: legacy methods still implement their global 401 flow.
for (const method of ['GET', 'PUT']) {
  reset();
  businessStatus = 401;
  await assert.rejects(method === 'GET' ? api.get(profilePath) : api.put(profilePath, expectedPutBody), error => error instanceof ApiClientError && error.status === 401);
  assert.equal(getToken(), null);
  assert.equal(getOrganizationScope(), null);
  assert.equal(window.location.href, '/login', `legacy ${method} retains global unauthorized navigation`);
}

assert.deepEqual(localAccesses, [], 'production paths never attempt browser-local fallback, even when storage access would throw');
console.log('Organization profile production service contract passed: complete normalization and exact HTTP/body allowlist; fail-closed health/network/HTTP errors; permission, actor/role/token/scope/generation races; pinned dispatched requests and stale-401 session isolation; legacy 401 compatibility; no fake ETag contract or local fallback.');
