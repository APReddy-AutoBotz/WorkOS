import assert from 'node:assert/strict';

// Configure production before importing the real service. No browser-local or demo fallback is allowed.
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
  throw new Error('Production terminology must not use browser-local records.');
}]));
globalThis.localStorage = forbiddenLocalStorage;
const events = [];
let onScopeChanged;
globalThis.window = {
  localStorage: forbiddenLocalStorage,
  location: {pathname: '/terminology', href: '/terminology'},
  dispatchEvent: event => {
    events.push(event.type);
    if (event.type === 'workos:organization-scope-changed') onScopeChanged?.();
    return true;
  },
};

const {adminService} = await import('../src/services/api.ts');
const {api, ApiClientError, getOrganizationScope, getToken, isDemoFallbackAllowed, resetBackendCheck} = await import('../src/services/apiClient.ts');
const {captureOrganizationProfileContext, isOrganizationProfileContextCurrent} = await import('../src/services/organizationProfileScope.ts');
const {TERMINOLOGY_KEYS, normalizeTerminologyConfiguration, rememberTerminologySave, takeTerminologyFeedback} = await import('../src/services/terminologyConfiguration.ts');
const {applyPersistedTerminology, getConfiguredTerminologyValue, getTerminologyValue} = await import('../src/config/productConfig.ts');
assert.equal(isDemoFallbackAllowed(), false);
const keys = ['employee', 'manager', 'teamLead', 'businessUnit', 'region', 'regionalOwner', 'engagement', 'project', 'worklog'];
assert.deepEqual(TERMINOLOGY_KEYS, keys, 'the approved nine canonical keys are immutable and exhaustive');
assert(Object.isFrozen(TERMINOLOGY_KEYS));
assert.throws(() => TERMINOLOGY_KEYS.push('unapproved'), TypeError);

const sessionKey = 'workos_session';
const scopeKey = 'workos_organization_scope';
const tokenKey = 'workos_api_token';
const endpoint = '/api/organization-setup/terminology';
const originalScope = {organizationId: 'org-synthetic-terms-one', legalEntityId: 'legal-synthetic-terms-one'};
const nextScope = {organizationId: 'org-synthetic-terms-two', legalEntityId: 'legal-synthetic-terms-two'};
const originalToken = 'synthetic-terminology-session-one';
const originalUser = {
  id: 'worker-synthetic-terms-one', employeeId: 'SYN-TERMS-ONE', role: 'HR', permissionRole: 'HR',
  permissions: ['settings.manage', 'employees.view'], name: 'Synthetic Terminology Operator',
};
const terms = Object.fromEntries(keys.map(key => [key, {singular: `synthetic ${key}`, plural: `synthetic ${key} plural`, helpText: `Synthetic ${key} help.`}]));
const rawConfiguration = {terms, effective_from: '2026-10-01', effective_to: '2026-10-31', ignored_server_field: 'not-writable'};
const expectedConfiguration = {terms, effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31'};
const editable = {
  terms: Object.fromEntries(keys.map(key => [key, {...terms[key], canonicalKey: 'attempted-key-override', unexpected: 'strip-me'}]).concat([
    ['unapproved', {singular: 'not sent', plural: 'not sent', helpText: 'not sent'}],
  ])),
  effectiveFrom: '2026-10-01', effectiveTo: '2027-12-31', organizationId: nextScope.organizationId,
  legalEntityId: nextScope.legalEntityId, actorId: 'attempted-actor', role: 'Admin', permissions: ['permissions.manage'],
  version: 'caller-invented-version', unexpected: 'strip-me',
};
const expectedBody = {terms, effectiveFrom: editable.effectiveFrom};
const failurePayload = {error: {
  code: 'SYNTHETIC_TERMINOLOGY_FAILURE', message: 'Synthetic backend rejection',
  correlationId: 'synthetic-terms-correlation', operationId: 'synthetic-terms-operation',
}};
const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: {'Content-Type': 'application/json', ETag: '"synthetic-unused-version"'},
});
const calls = [];
let healthState, healthError, healthStatus, healthGate, businessStatus, businessError, businessGate, payloadOverride;
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init: {...init, ...(init.headers ? {headers: {...init.headers}} : {})}});
  if (url === '/api/health') {
    assert.equal(init.credentials, 'include');
    assert.equal(init.method, undefined);
    const result = response({database: healthState}, healthStatus);
    const error = healthError;
    if (healthGate) await healthGate.promise;
    if (error) throw error;
    return result;
  }
  assert.equal(url, endpoint, 'terminology service uses only its approved endpoint');
  const status = businessStatus;
  const error = businessError;
  const payload = status === 200 ? payloadOverride === undefined ? rawConfiguration : payloadOverride : failurePayload;
  if (businessGate) await businessGate.promise;
  if (error) throw error;
  return response(payload, status);
};
const setUser = user => values.set(sessionKey, JSON.stringify(user));
const setScope = scope => values.set(scopeKey, JSON.stringify(scope));
const snapshot = () => ({session: [...values], href: window.location.href});
const reset = () => {
  takeTerminologyFeedback(null);
  values.clear();
  setUser(structuredClone(originalUser));
  setScope(originalScope);
  values.set(tokenKey, originalToken);
  calls.length = 0; events.length = 0; onScopeChanged = undefined;
  window.location.href = '/terminology';
  healthState = 'connected'; healthStatus = 200; healthError = null; healthGate = null;
  businessStatus = 200; businessError = null; businessGate = null; payloadOverride = undefined;
  resetBackendCheck();
  applyPersistedTerminology({employee: {singular: 'runtime sentinel', plural: 'runtime sentinels', helpText: 'Unchanged until runtime reload.'}});
};
const deferred = () => {
  let resolve;
  const promise = new Promise(release => { resolve = release; });
  return {promise, resolve};
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const denied = error => error instanceof ApiClientError && error.status === 403;
const invalid = error => error instanceof ApiClientError && error.status === 502;
const operations = [
  {name: 'terminology GET', method: 'GET', health: true, run: context => adminService.getTerminologyConfiguration(context)},
  {name: 'terminology POST', method: 'POST', health: false, run: context => adminService.saveTerminologyConfiguration(editable, context)},
];
const expectedHeaders = (scope = originalScope, token = originalToken) => ({
  'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
  'X-Organization-Id': scope.organizationId, 'X-Legal-Entity-Id': scope.legalEntityId,
});
const assertRequest = (call, operation, scope = originalScope, token = originalToken) => {
  assert.equal(call.url, endpoint);
  assert.deepEqual(call.init, {
    method: operation.method, credentials: 'include', headers: expectedHeaders(scope, token),
    ...(operation.method === 'POST' ? {body: JSON.stringify(expectedBody)} : {}),
  }, `${operation.name} pins scope/auth and uses only the approved body; no invented version or ETag headers`);
};
const assertDispatch = operation => {
  assert.deepEqual(calls.map(call => call.url), [...(operation.health ? ['/api/health'] : []), endpoint]);
  assertRequest(calls.at(-1), operation);
};

// Exercise the production service itself, not a test-local serializer or normalizer.
for (const operation of operations) {
  reset();
  const before = snapshot();
  const callerDraft = structuredClone(editable);
  assert.deepEqual(await operation.run(), expectedConfiguration);
  assertDispatch(operation);
  assert.deepEqual(editable, callerDraft, 'serialization does not mutate the caller draft');
  assert.deepEqual(snapshot(), before, 'success cannot rewrite the authenticated session or selected scope');
  assert.equal(getTerminologyValue('employee').singular, 'runtime sentinel', 'editing/service feedback does not apply returned labels globally');
  assert.deepEqual(events, operation.method === 'POST' ? ['workos:organization-scope-changed'] : [], 'save emits exactly one existing runtime refresh event');
  if (operation.method === 'POST') {
    const body = JSON.parse(calls.at(-1).init.body);
    assert.deepEqual(Object.keys(body).sort(), ['effectiveFrom', 'terms']);
    assert.deepEqual(Object.keys(body.terms), keys);
    for (const key of keys) assert.deepEqual(Object.keys(body.terms[key]), ['singular', 'plural', 'helpText']);
  }
}

// Empty and partial legacy dictionaries use centralized configured defaults, never stale live labels.
for (const legacy of [{terms: {}}, {terms: {}, effective_from: '2026-10-01'}, {terms: {employee: '  person  '}, effective_from: '2026-10-01'}]) {
  reset();
  payloadOverride = legacy;
  const result = await adminService.getTerminologyConfiguration();
  assert.deepEqual(Object.keys(result.terms), keys);
  for (const key of keys) {
    assert.deepEqual(result.terms[key], key === 'employee' && legacy.terms.employee
      ? {singular: 'person', plural: 'persons', helpText: ''} : getConfiguredTerminologyValue(key));
    assert.notEqual(result.terms[key].singular, 'runtime sentinel');
  }
  assert.equal(result.effectiveFrom, legacy.effective_from ?? new Date().toISOString().slice(0, 10));
  assertDispatch(operations[0]);
}
reset();
payloadOverride = {terms: {employee: {singular: ' person ', plural: ' people ', helpText: ' Approved help. '}}, effective_from: '2026-10-01T00:00:00.000Z', effective_to: '2026-10-31T00:00:00.000Z'};
assert.deepEqual((await adminService.getTerminologyConfiguration()).terms.employee, {singular: 'person', plural: 'people', helpText: 'Approved help.'});
assert.deepEqual(normalizeTerminologyConfiguration({...rawConfiguration, effective_from: '2026-10-01T00:00:00.000Z', effective_to: '2026-10-31T00:00:00.000Z'}), expectedConfiguration);

const malformedReads = [
  {}, {terms: null}, {terms: []}, {terms: 'not-a-dictionary'},
  {terms: {unapproved: 'not-allowed'}, effective_from: '2026-10-01'},
  ...[null, [], 7, '', ' ', {singular: 'person', plural: 'people'}, {singular: 'person', plural: ' ', helpText: ''},
    {singular: 'person', plural: 'people', helpText: 7}, {singular: 'x'.repeat(101), plural: 'people', helpText: ''},
    {singular: 'person', plural: 'x'.repeat(101), helpText: ''}, {singular: 'person', plural: 'people', helpText: 'x'.repeat(501)}]
    .map(employee => ({terms: {employee}, effective_from: '2026-10-01'})),
  {terms: {employee: 'person'}},
];
const invalidDates = ['', '2026-02-29', '2026-02-30', '2026-13-01', '2026-10-1', 'not-a-date',
  '2026-10-01T18:30:00.000Z', '2026-10-01T00:00:00.001Z', '2026-10-01T00:00:00+00:00', 20261001, null];
for (const operation of operations) {
  for (const raw of [...malformedReads, ...invalidDates.map(effective_from => ({...rawConfiguration, effective_from})),
    ...invalidDates.filter(Boolean).map(effective_to => ({...rawConfiguration, effective_to}))]) {
    reset();
    payloadOverride = raw;
    const before = snapshot();
    await assert.rejects(operation.run(), invalid, `${operation.name} refuses malformed values or non-calendar date transport`);
    assertDispatch(operation);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(events, [], 'invalid response cannot publish refresh or success');
    assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), undefined);
    assert.equal(getTerminologyValue('employee').singular, 'runtime sentinel');
  }
  for (const raw of [null, [], 'invalid']) {
    reset(); payloadOverride = raw;
    await assert.rejects(operation.run(), `${operation.name} rejects malformed response envelopes`);
    assert.deepEqual(events, []);
  }
}

// Production health failure never creates a fake editable configuration or touches local records.
for (const failure of ['offline', 'network', 'http']) {
  reset();
  if (failure === 'offline') healthState = 'offline';
  if (failure === 'network') healthError = new TypeError('Synthetic health failure');
  if (failure === 'http') { healthStatus = 503; healthState = 'offline'; }
  await assert.rejects(adminService.getTerminologyConfiguration(), /Backend API is required/);
  assert.deepEqual(calls.map(call => call.url), ['/api/health']);
}
for (const operation of operations) {
  for (const status of [400, 401, 403, 404, 409, 422, 500, 502, 503, 504]) {
    reset(); businessStatus = status;
    const before = snapshot();
    await assert.rejects(operation.run(), error => {
      assert(error instanceof ApiClientError);
      assert.equal(error.status, status);
      for (const key of ['code', 'message', 'correlationId', 'operationId']) assert.equal(error[key], failurePayload.error[key]);
      return true;
    });
    assertDispatch(operation);
    assert.deepEqual(snapshot(), before, 'scoped 401/errors do not invoke the legacy global logout');
    assert.deepEqual(events, []);
    assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), undefined);
  }
  reset(); businessError = new TypeError('Synthetic terminology network failure');
  const expectedError = businessError;
  await assert.rejects(operation.run(), error => error === expectedError);
  assertDispatch(operation);
  businessError = null;
  assert.deepEqual(await operation.run(), expectedConfiguration, 'a subsequent server request can recover');
}

const contextChanges = [
  ['actor ID', () => setUser({...originalUser, id: 'worker-synthetic-terms-other'})],
  ['employee ID', () => setUser({...originalUser, employeeId: 'SYN-TERMS-OTHER'})],
  ['active role', () => setUser({...originalUser, role: 'Admin'})],
  ['permission role', () => setUser({...originalUser, permissionRole: undefined})],
  ['effective permissions', () => setUser({...originalUser, permissions: [...originalUser.permissions, 'projects.view']})],
  ['management permission removal', () => setUser({...originalUser, permissions: ['employees.view']})],
  ['bearer token', () => values.set(tokenKey, 'synthetic-terminology-session-other')],
  ['bearer token removal', () => values.delete(tokenKey)],
  ['organization', () => setScope({...originalScope, organizationId: nextScope.organizationId})],
  ['legal entity', () => setScope({...originalScope, legalEntityId: nextScope.legalEntityId})],
];
for (const operation of operations) {
  for (const [reason, invalidate] of [
    ['missing scope', () => values.delete(scopeKey)],
    ['missing organization', () => setScope({legalEntityId: originalScope.legalEntityId})],
    ['missing legal entity', () => setScope({organizationId: originalScope.organizationId})],
    ['malformed scope', () => values.set(scopeKey, '{invalid')],
    ['missing actor', () => setUser(null)],
    ['missing management permission', () => setUser({...originalUser, permissions: []})],
  ]) {
    reset(); invalidate();
    assert.equal(captureOrganizationProfileContext(), null, reason);
    await assert.rejects(operation.run(), denied, `${operation.name} ${reason}`);
    assert.deepEqual(calls, [], 'capture fails before health or mutation');
  }
  reset();
  await assert.rejects(operation.run(null), denied);
  await assert.rejects(operation.run(captureOrganizationProfileContext(() => false)), denied);
  assert.deepEqual(calls, []);
  for (const [reason, change] of contextChanges) {
    reset();
    const context = captureOrganizationProfileContext();
    change();
    assert.equal(isOrganizationProfileContextCurrent(context), false, reason);
    await assert.rejects(operation.run(context), denied, `${operation.name} stale ${reason}`);
    assert.deepEqual(calls, []);
  }
}

// The implicit ownership capture precedes health; the same capture is rechecked after the await.
for (const [reason, change] of contextChanges) {
  reset(); healthGate = deferred();
  const rejected = assert.rejects(adminService.getTerminologyConfiguration(), denied, `GET changes ${reason} during health`);
  assert.deepEqual(calls.map(call => call.url), ['/api/health']);
  change(); healthGate.resolve();
  await rejected;
  assert.deepEqual(calls.map(call => call.url), ['/api/health']);
}
reset();
let generationCurrent = true;
const healthOwner = captureOrganizationProfileContext(() => generationCurrent);
healthGate = deferred();
const healthRejected = assert.rejects(adminService.getTerminologyConfiguration(healthOwner), denied);
generationCurrent = false; healthGate.resolve();
await healthRejected;
assert.deepEqual(calls.map(call => call.url), ['/api/health']);

reset();
const equivalent = captureOrganizationProfileContext();
setUser({...originalUser, name: 'Changed display metadata', permissions: [...originalUser.permissions].reverse()});
assert.equal(isOrganizationProfileContextCurrent(equivalent), true, 'permission order and display metadata are not a different identity');
assert.deepEqual(await adminService.getTerminologyConfiguration(equivalent), expectedConfiguration);

// The dedicated low-level POST pins its explicit scope, does not emit an automatic event, and suppresses global 401.
for (const status of [200, 401]) {
  reset(); setScope(nextScope); businessStatus = status;
  const pending = api.postTerminologyWithScope(expectedBody, originalScope);
  if (status === 200) assert.deepEqual(await pending, rawConfiguration);
  else await assert.rejects(pending, error => error instanceof ApiClientError && error.status === 401);
  assertRequest(calls[0], operations[1]);
  assert.deepEqual(events, []);
  assert.equal(getToken(), originalToken);
  assert.deepEqual(getOrganizationScope(), nextScope);
  assert.equal(window.location.href, '/terminology');
}

// Ownership feedback must exist before synchronous event listeners trigger the runtime remount.
reset();
let eventFeedback;
onScopeChanged = () => { eventFeedback = takeTerminologyFeedback(captureOrganizationProfileContext(), false); };
await adminService.saveTerminologyConfiguration(editable);
assert.match(eventFeedback, /^Terminology saved\./, 'successful current save feedback is available to the synchronous refresh listener');
assert.deepEqual(events, ['workos:organization-scope-changed']);
assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), eventFeedback);
assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), undefined, 'feedback is one-use');

// A future save reports scheduling, not immediate activation, through the real service result.
reset();
payloadOverride = {...rawConfiguration, effective_from: '2999-01-01'};
let scheduledEventFeedback;
onScopeChanged = () => { scheduledEventFeedback = takeTerminologyFeedback(captureOrganizationProfileContext(), false); };
const scheduled = await adminService.saveTerminologyConfiguration({...editable, effectiveFrom: '2999-01-01'});
assert.equal(scheduled.effectiveFrom, '2999-01-01');
assert.equal(JSON.parse(calls.at(-1).init.body).effectiveFrom, '2999-01-01');
assert.match(scheduledEventFeedback, /^Terminology scheduled for 2999-01-01\./);
assert.match(scheduledEventFeedback, /Currently effective labels remain in use/);
assert.equal(getTerminologyValue('employee').singular, 'runtime sentinel');
assert.deepEqual(events, ['workos:organization-scope-changed']);

// Feedback is transient, owned and safe across the existing runtime child remount, not a persisted draft.
reset();
let originalGeneration = true;
const feedbackOwner = captureOrganizationProfileContext(() => originalGeneration);
rememberTerminologySave(feedbackOwner, {...expectedConfiguration, effectiveFrom: '2999-01-01'});
originalGeneration = false;
assert.equal(takeTerminologyFeedback(feedbackOwner, false), undefined, 'an invalid generation cannot consume visible feedback');
const remountedOwner = captureOrganizationProfileContext();
assert.match(takeTerminologyFeedback(remountedOwner, false), /^Terminology scheduled for 2999-01-01\./, 'same-context remount can show the saved scheduled result');
assert.match(takeTerminologyFeedback(remountedOwner), /Currently effective labels remain in use/);
assert.equal(takeTerminologyFeedback(remountedOwner), undefined);
for (const [reason, change] of contextChanges) {
  reset();
  const owner = captureOrganizationProfileContext();
  rememberTerminologySave(owner, expectedConfiguration);
  change();
  assert.equal(takeTerminologyFeedback(owner, false), undefined, `${reason} invalidates old feedback context`);
  assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), undefined, `${reason} cannot receive another identity/scope's feedback`);
  reset();
  const staleOwner = captureOrganizationProfileContext();
  change();
  rememberTerminologySave(staleOwner, expectedConfiguration);
  assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), undefined, `${reason} cannot record late feedback`);
}
reset();
rememberTerminologySave(captureOrganizationProfileContext(() => false), expectedConfiguration);
assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), undefined, 'an expired UI generation cannot record save feedback');

// A dispatched request stays pinned. Its late 401 must not clear a replacement session;
// a late success must not refresh/remount that new owner's editor or publish save feedback.
for (const operation of operations) {
  for (const [reason, change] of [...contextChanges, ['UI generation/unmount', () => { generationCurrent = false; }]]) {
    for (const status of [200, 401, 409]) {
      reset(); businessStatus = status; businessGate = deferred(); generationCurrent = true;
      const context = captureOrganizationProfileContext(() => generationCurrent);
      const pending = operation.run(context);
      const completion = status === 200 ? pending : assert.rejects(pending, error => error instanceof ApiClientError && error.status === status);
      await flush();
      assertDispatch(operation);
      change();
      const replacement = snapshot();
      businessGate.resolve();
      const result = await completion;
      if (status === 200) assert.deepEqual(result, expectedConfiguration);
      assertRequest(calls.at(-1), operation);
      assert.deepEqual(snapshot(), replacement, `${operation.name} late ${status} after ${reason} is session-neutral`);
      assert.equal(takeTerminologyFeedback(captureOrganizationProfileContext()), undefined, `late ${status} after ${reason} cannot publish save feedback`);
      assert.deepEqual(events, [], `late ${status} after ${reason} cannot refresh/remount the replacement runtime`);
    }
  }
}

// A stale original save also cannot overwrite or consume newer feedback from a replacement owner.
reset();
businessGate = deferred();
const originalSaveGate = businessGate;
const staleSave = adminService.saveTerminologyConfiguration(editable);
await flush();
setUser({...originalUser, id: 'worker-synthetic-terms-new-owner'});
setScope(nextScope);
values.set(tokenKey, 'synthetic-terminology-session-new-owner');
businessGate = null;
await adminService.saveTerminologyConfiguration(editable);
const newOwner = captureOrganizationProfileContext();
const newFeedback = takeTerminologyFeedback(newOwner, false);
assert.match(newFeedback, /^Terminology saved\./);
assert.deepEqual(events, ['workos:organization-scope-changed']);
originalSaveGate.resolve();
await staleSave;
assert.deepEqual(events, ['workos:organization-scope-changed'], 'old completion cannot trigger a second replacement-owner remount');
assert.equal(takeTerminologyFeedback(newOwner), newFeedback, 'old completion leaves newer owned feedback available exactly once');
assert.equal(takeTerminologyFeedback(newOwner), undefined);

// Existing non-owned API methods retain their global unauthorized contract.
reset(); businessStatus = 401;
await assert.rejects(api.post(endpoint, expectedBody), error => error instanceof ApiClientError && error.status === 401);
assert.equal(getToken(), null);
assert.equal(getOrganizationScope(), null);
assert.equal(window.location.href, '/login');
assert.deepEqual(localAccesses, [], 'production terminology never attempts browser-local fallback');
console.log('Terminology configuration production service checks passed: exact scoped/authenticated GET and allowlisted nine-key POST; strict response/date normalization; configured legacy defaults; fail-closed errors; pre/post-health and dispatched ownership races; stale-401 isolation; one-use owned feedback before a single refresh event.');
