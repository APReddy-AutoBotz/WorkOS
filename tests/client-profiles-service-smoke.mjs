import assert from 'node:assert/strict';

// Exercise the production service and real scoped transport, never local/demo records.
process.env.APP_MODE = process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const storage = new Map(), localAccesses = [], events = [];
globalThis.sessionStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)};
const forbidden = (...args) => {localAccesses.push(args);throw new Error('Client profiles must not use browser-local records.');};
globalThis.localStorage = {getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden};
globalThis.window = {localStorage, location: {pathname: '/client-profiles', href: '/client-profiles'}, dispatchEvent: event => {events.push(event.type);return true;}};
const {clientProfilesService: service, captureClientProfilesContext: capture, isClientProfilesContextCurrent: current,
  assertClientProfilesContext: assertContext, normalizeClientProfilesWorkspace: normalizeWorkspace,
  normalizeClientProfileDetail: normalizeDetail} = await import('../src/services/clientProfiles.ts');
const {api, ApiClientError, getOrganizationScope, getToken, isDemoFallbackAllowed} = await import('../src/services/apiClient.ts');
const {getDefaultPermissionsForRole} = await import('../src/services/permissions.ts');
assert.equal(isDemoFallbackAllowed(), false);
const scope = {organizationId: 'synthetic-org-a', legalEntityId: 'synthetic-legal-a'};
const otherScope = {organizationId: 'synthetic-org-b', legalEntityId: 'synthetic-legal-b'};
const token = 'example-client-profiles-session-a';
const user = {id: 'synthetic-client-profile-operator', employeeId: 'SYN-CLIENT-PROFILES', name: 'Synthetic client profile operator', role: 'ProjectManager', permissionRole: 'ProjectManager',
  permissions: ['commercial.clients.view', 'commercial.clients.manage']};
const asOf = '2026-10-20', historicalAsOf = '2026-03-01';
const clientId = 'client/a ?', unitId = 'unit/a ?';
const contact = {name: 'Synthetic billing contact <script>inert</script>', email: 'billing@example.test'};
const profile1 = {id: 'client-profile-a-1', version: 1, effectiveFrom: '2026-01-01', legalName: 'Synthetic Legal Client', displayName: 'Synthetic Commercial Client',
  parentClientId: 'synthetic-parent-account', defaultCurrency: 'GBP', billingContacts: [contact]};
const profile2 = {...profile1, id: 'client-profile-a-2', version: 2, effectiveFrom: '2027-01-01', legalName: 'Synthetic Future Legal Client', parentClientId: null, defaultCurrency: 'USD'};
const unitProfile1 = {id: 'unit-profile-a-1', version: 1, effectiveFrom: '2026-04-01', legalName: 'Synthetic Billing Entity', displayName: null, defaultCurrency: null, billingContacts: []};
const unitProfile2 = {...unitProfile1, id: 'unit-profile-a-2', version: 2, effectiveFrom: '2027-04-01', displayName: 'Synthetic Future Billing Entity', defaultCurrency: 'EUR', billingContacts: [contact]};
const unit = {id: unitId, clientId, code: 'SYN-BILLING-A', kind: 'billing_entity', latestVersion: 2, currentProfile: unitProfile1, versions: [unitProfile2, unitProfile1]};
const summary = {id: clientId, operationalName: 'Synthetic operational label', industry: 'Synthetic services', status: 'Active', accountOwnerId: 'synthetic-owner', code: 'SYN-CLIENT-A',
  latestVersion: 2, currentProfile: profile1, latestProfile: profile2};
const workspace = {asOf, clients: [summary], limit: 200, truncated: false};
const detail = {...summary, asOf, versions: [profile2, profile1], billingUnits: [unit], limit: 200, truncated: false};
const legacy = {id: 'synthetic-legacy-client', operationalName: 'Synthetic incomplete legacy client', industry: null, status: 'Inactive', accountOwnerId: null, code: null, latestVersion: 0, currentProfile: null, latestProfile: null};
const legacyDetail = {...legacy, asOf, versions: [], billingUnits: [], limit: 200, truncated: false};
const historicalDetail = {...detail, asOf: historicalAsOf, billingUnits: [{...unit, currentProfile: null}]};
const profileFields = ({id: _id, version: _version, ...fields}) => fields;
const profileInput = {...profileFields(profile1), effectiveFrom: '2028-01-01', expectedVersion: 2, code: summary.code, reason: 'Synthetic append-only client correction'};
const profile3 = {...profileFields(profileInput), id: 'client-profile-a-3', version: 3};
for (const field of ['expectedVersion', 'code', 'reason']) delete profile3[field];
const appended = {...detail, latestVersion: 3, latestProfile: profile3, versions: [profile3, profile2, profile1]};
const firstInput = {...profileFields(profile1), expectedVersion: 0, code: 'SYN-LEGACY-CLIENT', reason: 'Synthetic explicit legacy profile completion'};
const firstProfile = {...profile1, parentClientId: firstInput.parentClientId};
const firstDetail = {...legacyDetail, code: firstInput.code, latestVersion: 1, currentProfile: firstProfile, latestProfile: firstProfile, versions: [firstProfile]};
const newUnitInput = {...profileFields(unitProfile1), code: 'SYN-BUSINESS-A', kind: 'business_unit', reason: 'Synthetic distinct customer business unit'};
const newUnitProfile = {...unitProfile1, id: 'unit-profile-new-1'};
const newUnit = {id: 'synthetic-new-business-unit', clientId, code: newUnitInput.code, kind: newUnitInput.kind, latestVersion: 1, currentProfile: newUnitProfile, versions: [newUnitProfile]};
const withNewUnit = {...detail, billingUnits: [unit, newUnit]};
const unitVersionInput = {...profileFields(unitProfile2), effectiveFrom: '2028-04-01', expectedVersion: 2, reason: 'Synthetic effective-dated billing correction'};
const unitProfile3 = {...profileFields(unitProfile2), id: 'unit-profile-a-3', version: 3, effectiveFrom: unitVersionInput.effectiveFrom};
const revisedUnit = {...unit, latestVersion: 3, versions: [unitProfile3, unitProfile2, unitProfile1]};
const withUnitVersion = {...detail, billingUnits: [revisedUnit]};
const extra = {organizationId: 'forged-org', legalEntityId: 'forged-legal', clientId: 'forged-client', unitId: 'forged-unit', actorId: 'forged-actor', activeRole: 'Admin',
  status: 'Active', operationalName: 'forged-operational-label', accountOwnerId: 'forged-owner', industry: 'forged-industry', createdBy: 'forged-creator', latestVersion: 99,
  taxIdentifier: 'forged-tax-field', paymentIdentifier: 'forged-payment-field', unexpected: true};
const withForgedContacts = input => ({...input, ...extra, billingContacts: input.billingContacts.map(value => ({...value, actorId: 'forged-contact-actor', privateMetadata: 'must not transmit'}))});
const prefix = '/api/v1/client-profiles';
const path = `${prefix}/clients/client%2Fa%20%3F`;
const operations = [
  {name: 'workspace', method: 'GET', path: `${prefix}/workspace`, result: workspace, run: context => service.getWorkspace(context)},
  {name: 'historical workspace', method: 'GET', path: `${prefix}/workspace?asOf=${historicalAsOf}`, result: {...workspace, asOf: historicalAsOf}, run: context => service.getWorkspace(context, historicalAsOf)},
  {name: 'client detail', method: 'GET', path, result: detail, run: context => service.getClient(clientId, context)},
  {name: 'historical client detail', method: 'GET', path: `${path}?asOf=${historicalAsOf}`, result: historicalDetail, run: context => service.getClient(clientId, context, historicalAsOf)},
  {name: 'append client profile', method: 'POST', path: `${path}/profiles`, body: profileInput, result: appended, run: context => service.appendClientProfile(clientId, withForgedContacts(profileInput), context)},
  {name: 'complete first client profile', method: 'POST', path: `${prefix}/clients/${legacy.id}/profiles`, body: firstInput, result: firstDetail, run: context => service.appendClientProfile(legacy.id, withForgedContacts(firstInput), context)},
  {name: 'create billing unit', method: 'POST', path: `${path}/billing-units`, body: newUnitInput, result: withNewUnit, run: context => service.createBillingUnit(clientId, {...withForgedContacts(newUnitInput), expectedVersion: 100, parentClientId: 'forged-parent'}, context)},
  {name: 'append billing unit version', method: 'POST', path: `${path}/billing-units/unit%2Fa%20%3F/versions`, body: unitVersionInput, result: withUnitVersion,
    run: context => service.appendBillingUnitVersion(clientId, unitId, {...withForgedContacts(unitVersionInput), code: 'FORGED-CODE', kind: 'business_unit', parentClientId: 'forged-parent'}, context)},
];
const calls = [];
let payload, status, networkError, malformedJson, gate;
const errorPayload = {error: {code: 'SYNTHETIC_CLIENT_PROFILE_FAILURE', message: 'Synthetic protected client profile rejection', correlationId: 'synthetic-correlation', operationId: 'synthetic-operation'}};
const setUser = value => storage.set('workos_session', JSON.stringify(value));
const setScope = value => storage.set('workos_organization_scope', JSON.stringify(value));
const snapshot = () => ({values: [...storage], href: window.location.href, events: [...events]});
const reset = () => {storage.clear();setUser(structuredClone(user));setScope(scope);storage.set('workos_api_token', token);calls.length = events.length = 0;
  window.location.href = window.location.pathname;payload = undefined;status = 200;networkError = null;malformedJson = false;gate = null;};
const deferred = () => {let resolve;const promise = new Promise(release => {resolve = release;});return {promise, resolve};};
const denied = error => error instanceof ApiClientError && error.status === 403;
const invalid = error => error instanceof ApiClientError && error.status === 502;
const invalidInput = error => error instanceof ApiClientError && error.status >= 400 && error.status < 500;
const invoke = async (operation, context) => operation.run(context);
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init: {...init, headers: {...init.headers}}});
  assert(url.startsWith(prefix), 'direct protected client-profile endpoint only, never health, demo or legacy fallback');
  const captured = {payload, status, networkError, malformedJson};
  if (gate) await gate.promise;
  if (captured.networkError) throw captured.networkError;
  return new Response(captured.malformedJson ? '{invalid synthetic json' : JSON.stringify(captured.status === 200 ? captured.payload : errorPayload), {status: captured.status, headers: {'Content-Type': 'application/json'}});
};
const assertRequest = (operation, expectedScope = scope, expectedToken = token) => {
  assert.equal(calls.length, 1, `${operation.name}: exactly one business request`);
  const {body, ...init} = calls[0].init;
  assert.deepEqual({url: calls[0].url, init}, {url: operation.path, init: {method: operation.method, credentials: 'include', headers: {'Content-Type': 'application/json',
    ...(expectedToken ? {Authorization: `Bearer ${expectedToken}`} : {}), 'X-Organization-Id': expectedScope.organizationId, 'X-Legal-Entity-Id': expectedScope.legalEntityId}}}, `${operation.name}: captured scope/token and encoded resource path`);
  if (operation.body) assert.deepEqual(JSON.parse(body), operation.body, `${operation.name}: strict command and nested contact allowlists`);
  else assert.equal(body, undefined, `${operation.name}: no GET body`);
};

for (const operation of operations) {
  reset();payload = {...operation.result, ignoredServerField: 'must be stripped'};const before = snapshot();const original = structuredClone(operation.body);
  assert.deepEqual(await invoke(operation, capture()), operation.result, `${operation.name}: exact nullable DTO mapping`);assertRequest(operation);
  assert.deepEqual(operation.body, original, 'service never mutates the command input');assert.deepEqual(snapshot(), before, 'reads and saves never rewrite session, scope or navigation');
  for (const failureStatus of [400,401,403,404,409,422,500,502,503,504]) {
    reset();status = failureStatus;const beforeFailure = snapshot();
    await assert.rejects(invoke(operation, capture()), error => {assert(error instanceof ApiClientError);assert.equal(error.status, failureStatus);assert.equal(error.code, errorPayload.error.code);
      assert.equal(error.message, errorPayload.error.message);assert.equal(error.correlationId, errorPayload.error.correlationId);assert.equal(error.operationId, errorPayload.error.operationId);return true;});
    assertRequest(operation);assert.deepEqual(snapshot(), beforeFailure, 'including current-session 401: no clearing session, scope or token, and no redirect');
  }
  for (const bad of [null, [], {}, {unexpected: true}]) {reset();payload = bad;await assert.rejects(invoke(operation, capture()), invalid);assertRequest(operation);}
  reset();malformedJson = true;await assert.rejects(invoke(operation, capture()), invalid);assertRequest(operation);
  reset();networkError = new TypeError('Synthetic unavailable client-profile API');const failure = networkError;
  await assert.rejects(invoke(operation, capture()), error => error === failure);assertRequest(operation);
  networkError = null;payload = operation.result;assert.deepEqual(await invoke(operation, capture()), operation.result, 'an explicit retry recovers without demo fallback');
  assert.equal(calls.length, 2, 'no automatic request retry or hidden fallback');
  for (const invalidate of [() => setScope(null), () => setScope({}), () => setScope({organizationId: scope.organizationId}), () => setScope({organizationId: 42, legalEntityId: scope.legalEntityId}),
    () => setScope({organizationId: ' ', legalEntityId: scope.legalEntityId}), () => setScope({organizationId: scope.organizationId, legalEntityId: []}), () => setScope({organizationId: scope.organizationId, legalEntityId: ''}),
    () => storage.set('workos_organization_scope', '{invalid'), () => setUser(null), () => storage.delete('workos_session'), () => storage.set('workos_session', '{invalid'),
    () => setUser({...user, permissions: []}), () => setUser({...user, permissions: ['commercial.clients.manage']}),
    () => setUser({...user, permissions: ['clients.view','clients.manage','commercial.contracts.view','commercial.contracts.manage','commercial.lifecycle.manage']})]) {
    reset();invalidate();assert.equal(capture(), null);await assert.rejects(invoke(operation, null), denied);assert.equal(calls.length, 0, 'missing scope, identity or explicit profile view denies before dispatch');
  }
  reset();await assert.rejects(invoke(operation, null), denied);assert.equal(calls.length, 0);
  reset();await assert.rejects(invoke(operation, capture(() => false)), denied);assert.equal(calls.length, 0, 'expired UI generation cannot dispatch');
  for (const permissions of [['commercial.clients.view'], ['commercial.clients.view','clients.manage','commercial.contracts.manage','commercial.lifecycle.manage']]) {
    reset();setUser({...user, permissions});payload = operation.result;const reader = capture();assert(reader);assert.equal(reader.canManage, false);
    if (operation.method === 'POST') {await assert.rejects(invoke(operation, reader), denied);assert.equal(calls.length, 0, 'operational, contract and lifecycle management never imply client-profile management');}
    else {assert.deepEqual(await invoke(operation, reader), operation.result);assertRequest(operation);}
  }
}

const changes = [
  ['actor', () => setUser({...user, id: 'synthetic-replacement-actor'})], ['employee identity', () => setUser({...user, employeeId: 'SYN-REPLACEMENT'})],
  ['active role', () => setUser({...user, role: 'Admin'})], ['permission role', () => setUser({...user, permissionRole: 'HR'})],
  ['permission set', () => setUser({...user, permissions: [...user.permissions, 'projects.view']})], ['profile management revoked', () => setUser({...user, permissions: ['commercial.clients.view']})],
  ['profile view revoked', () => setUser({...user, permissions: ['commercial.clients.manage']})], ['token replaced', () => storage.set('workos_api_token', 'example-client-profiles-session-b')],
  ['token removed', () => storage.delete('workos_api_token')], ['organization', () => setScope({...scope, organizationId: otherScope.organizationId})],
  ['legal entity', () => setScope({...scope, legalEntityId: otherScope.legalEntityId})], ['identity removed', () => setUser(null)], ['scope removed', () => setScope(null)],
];
for (const operation of operations) for (const [reason, change] of changes) {
  reset();const context = capture();assert(context);change();assert.equal(current(context), false, `${reason} invalidates the captured context`);
  await assert.rejects(invoke(operation, context), denied);assert.equal(calls.length, 0, `${operation.name}: stale ${reason} cannot dispatch`);
  for (const resultStatus of [200,401,409]) {
    reset();payload = operation.result;status = resultStatus;gate = deferred();const captured = capture();
    const completion = assert.rejects(invoke(operation, captured), resultStatus === 200 ? denied : error => error instanceof ApiClientError && error.status === resultStatus);
    assertRequest(operation);change();const replacement = snapshot();gate.resolve();await completion;assertRequest(operation);
    assert.deepEqual(snapshot(), replacement, `${operation.name}: late ${resultStatus} cannot publish stale data or disturb replacement ${reason}`);
  }
}
for (const operation of operations) {
  reset();payload = operation.result;gate = deferred();let owned = true;const context = capture(() => owned);const completion = assert.rejects(invoke(operation, context), denied);
  assertRequest(operation);owned = false;assert.equal(current(context), false);gate.resolve();await completion;assertRequest(operation);
}
reset();const equivalent = capture();setUser({...user, name: 'Synthetic changed display', permissions: [...user.permissions].reverse()});setScope({...scope, organizationName: 'Synthetic renamed display'});
assert.equal(current(equivalent), true, 'display metadata and permission ordering do not invalidate identity');assert.equal(assertContext(equivalent), equivalent);
reset();storage.delete('workos_api_token');payload = workspace;assert.deepEqual(await service.getWorkspace(capture()), workspace);assertRequest(operations[0], scope, null);
for (const role of ['Admin','HR','CountryDirector','ProjectManager','TeamLead','Employee']) {
  for (const permission of user.permissions) assert(!getDefaultPermissionsForRole(role).includes(permission), `${role} has no default profile grant`);
  reset();setUser({id: 'synthetic-default-role', employeeId: 'SYN-DEFAULT', role});assert.equal(capture(), null, `${role} without an explicit grant cannot read commercial profiles`);
}

for (const change of [
  ...['id','employeeId'].flatMap(key => [undefined,'',' ',42,{}].map(value => () => setUser({...user,[key]:value}))),
  ...[null,{},'commercial.clients.view',[42],['commercial.clients.view',42]].map(permissions => () => setUser({...user,permissions})),
]) {
  reset();change();assert.equal(capture(),null,'malformed identity or explicit permission data fails closed');
  await assert.rejects((async () => service.getWorkspace(capture()))(),denied);assert.equal(calls.length,0);
}
reset();const readLease = capture();setUser({...user,permissions:['commercial.clients.view']});assert.throws(() => assertContext(readLease,true),denied);
reset();setUser({...user,permissions:['commercial.clients.view']});assert.throws(() => assertContext(capture(),true),denied);

// Invalid asOf input must fail locally, not dispatch an unbounded or normalized date.
for (const value of ['', ' ', '2026-02-30', '2026-13-01', '2026-00-01', '2026-1-01', '2026-10-20T00:00:00.000Z', '2026-10-20&asOf=2027-01-01', null, 20261020, {}, []]) {
  for (const run of [context => service.getWorkspace(context, value), context => service.getClient(clientId, context, value)]) {
    reset();await assert.rejects((async () => run(capture()))(), invalidInput, `invalid asOf ${JSON.stringify(value)}`);assert.equal(calls.length, 0, 'bad date fails before GET');
  }
}
for (const value of ['2024-02-29','0001-01-01','9999-12-31']) {
  reset();payload = {...workspace, asOf: value, clients: []};assert.deepEqual(await service.getWorkspace(capture(), value), payload);
  assertRequest({...operations[0], path: `${prefix}/workspace?asOf=${value}`});
}
for (const operation of operations.filter(value => value.name.startsWith('historical'))) {
  reset();payload = {...operation.result, asOf};await assert.rejects(invoke(operation, capture()), invalid);assertRequest(operation);
}
for (const operation of operations.filter(value => value.name !== 'workspace' && value.name !== 'historical workspace')) {
  reset();payload = {...operation.result, id: 'synthetic-foreign-client'};await assert.rejects(invoke(operation, capture()), invalid);assertRequest(operation);
}

const clone = value => structuredClone(value);
const assertMalformedWorkspace = (value, label) => assert.throws(() => normalizeWorkspace(value), invalid, label);
const assertMalformedDetail = (value, label) => assert.throws(() => normalizeDetail(value), invalid, label);
// Response minimization preserves explicitly incomplete legacy data without inference.
assert.deepEqual(normalizeWorkspace({...workspace, clients: [{...summary, privateMetadata: 'stripped', currentProfile: {...profile1, actorId: 'stripped', billingContacts: [{...contact, privateMetadata: 'stripped'}]}}], privateMetadata: 'stripped'}), workspace);
assert.deepEqual(normalizeDetail({...detail, billingUnits: [{...unit, organizationId: 'stripped', versions: unit.versions.map(value => ({...value, auditPayload: 'stripped'}))}], internalAudit: 'stripped'}), detail);
assert.deepEqual(normalizeWorkspace({...workspace, clients: [legacy]}), {...workspace, clients: [legacy]});assert.deepEqual(normalizeDetail(legacyDetail), legacyDetail);
assert.deepEqual(normalizeWorkspace({...workspace, clients: []}), {...workspace, clients: []});
const allNull = {...profile1, legalName: null, displayName: null, parentClientId: null, defaultCurrency: null, billingContacts: []};
const allNullDetail = {...detail, latestVersion: 1, currentProfile: allNull, latestProfile: allNull, versions: [allNull], billingUnits: []};
assert.deepEqual(normalizeDetail(allNullDetail), allNullDetail, 'explicit null profile fields remain null rather than guessed from operational labels');
for (const kind of ['billing_entity','business_unit']) {const value = {...detail, billingUnits: [{...unit, kind}]};assert.deepEqual(normalizeDetail(value), value);}
const atLimitVersions = Array.from({length:200},(_,index) => ({...profile1,id:`synthetic-limit-profile-${index+1}`,version:index+1,effectiveFrom:new Date(Date.UTC(2026,0,index+1)).toISOString().slice(0,10)}));
const atLimitUnitVersions = atLimitVersions.map(({parentClientId:_parent,...value}) => ({...value,id:`synthetic-limit-unit-profile-${value.version}`}));
const atLimitDetail = {...detail,latestVersion:200,currentProfile:atLimitVersions.at(-1),latestProfile:atLimitVersions.at(-1),versions:atLimitVersions,
  billingUnits:[{...unit,latestVersion:200,currentProfile:atLimitUnitVersions.at(-1),versions:atLimitUnitVersions}]};
assert.deepEqual(normalizeDetail(atLimitDetail),atLimitDetail,'the explicit 200-version cap remains usable');
const atLimitWorkspace = {...workspace,clients:Array.from({length:200},(_,index) => ({...legacy,id:`synthetic-limit-client-${index}`})),truncated:true};
assert.deepEqual(normalizeWorkspace(atLimitWorkspace),atLimitWorkspace,'bounded truncated workspaces remain usable');
assert.deepEqual(normalizeDetail({...legacyDetail,truncated:true}),{...legacyDetail,truncated:true},'truncation is preserved, never hidden');
const ascending = {...detail, versions: [...detail.versions].reverse(), billingUnits: [{...unit, versions: [...unit.versions].reverse()}]};assert.deepEqual(normalizeDetail(ascending), ascending, 'chronology checks do not invent an array order');
const futureOnly = {...detail, asOf: '2025-12-31', currentProfile: null, billingUnits: [{...unit, currentProfile: null}]};assert.deepEqual(normalizeDetail(futureOnly), futureOnly, 'future terms are not promoted to current');
for (const effective of [profile1.effectiveFrom, profile2.effectiveFrom]) {
  const selected = effective === profile1.effectiveFrom ? profile1 : profile2;const selectedUnit = effective < unitProfile1.effectiveFrom ? null : unitProfile1;
  const value = {...detail, asOf: effective, currentProfile: selected, billingUnits: [{...unit, currentProfile: selectedUnit}]};assert.deepEqual(normalizeDetail(value), value, 'effective date itself is inclusive');
}
assert.deepEqual(normalizeDetail({...detail, asOf: '2029-01-01', currentProfile: profile2, billingUnits: [{...unit, currentProfile: unitProfile2}]}), {...detail, asOf: '2029-01-01', currentProfile: profile2, billingUnits: [{...unit, currentProfile: unitProfile2}]});

// Strict bounded lists, nullable shapes, IDs, codes and temporal/version integrity.
for (const value of [null, [], {}, {...workspace, asOf: '2026-02-30'}, {...workspace, asOf: '2026-10-20T00:00:00Z'},
  ...[null, {}, [null], [[]], [summary, summary], Array(201).fill(summary)].map(clients => ({...workspace, clients})),
  ...[0,199,201,'200',undefined].map(limit => ({...workspace, limit})), ...[null,0,'false',undefined].map(truncated => ({...workspace, truncated}))]) assertMalformedWorkspace(value, 'malformed workspace envelope');
for (const [key, values] of Object.entries({id: ['', ' ', null, 1], operationalName: ['', null, 1], industry: [undefined, 1, {}], status: ['', null, 1],
  accountOwnerId: [undefined, '', 1, {}], code: [undefined,'', 'lowercase', 'WITH SPACE', '-LEADING', 'A'.repeat(81), 1], latestVersion: [-1,201,1.5,'2',undefined], currentProfile: [undefined, {}, []], latestProfile: [undefined, {}, []]}))
  for (const value of values) assertMalformedWorkspace({...workspace, clients: [{...summary, [key]: value}]}, `malformed summary ${key}`);
for (const delta of [{code: null}, {latestVersion: 0}, {latestProfile: null}, {latestProfile: profile1}, {currentProfile: {...profile1, version: 3}},
  {currentProfile: {...profile1, effectiveFrom: '2028-01-01'}}, {currentProfile: profile2}, {currentProfile: {...profile2, effectiveFrom: profile1.effectiveFrom}}])
  assertMalformedWorkspace({...workspace, clients: [{...summary, ...delta}]}, 'summary current/latest profile must match version/asOf');
assertMalformedDetail({...legacyDetail,billingUnits:[{...newUnit,clientId:legacy.id}]},'an unprofiled legacy client cannot own commercial billing units');
for (const delta of [{code: 'SYN-CLIENT'}, {currentProfile: profile1}, {latestProfile: profile1}]) assertMalformedWorkspace({...workspace, clients: [{...legacy, ...delta}]}, 'version-zero record cannot invent a commercial profile');
for (const [key, values] of Object.entries({id: ['', ' ', null, 1], version: [0,201,1.5,'1'], effectiveFrom: [null,'2026-02-30','2026-01-01T00:00:00Z'],
  legalName: [undefined,'', ' ',42,'a'.repeat(201)], displayName: [undefined,'',42,'a'.repeat(201)], parentClientId: [undefined,'',42,clientId], defaultCurrency: [undefined,'gbp','GB',100],
  billingContacts: [undefined,null,{},[null],[[]],Array(11).fill(contact),[{...contact,name:''}],[{...contact,name:'x'.repeat(201)}],[{...contact,email:'invalid'}],[{...contact,email:'x'.repeat(250)+'@example.test'}],[{name:contact.name}]]})) {
  for (const value of values) {const bad = {...profile1, [key]: value};assertMalformedDetail({...allNullDetail, currentProfile: bad, latestProfile: bad, versions: [bad]}, `malformed client profile ${key}`);}
}
for (const delta of [{asOf:'2026-02-30'}, {versions:null}, {versions:{}}, {versions:[null]}, {versions:[profile1]}, {versions:[profile2,profile2]}, {versions:[profile2,{...profile1,id:profile2.id}]},
  {versions:[{...profile2,version:3},profile1],latestVersion:3}, {versions:[{...profile2,effectiveFrom:profile1.effectiveFrom},profile1]},
  {versions:[{...profile2,effectiveFrom:'2025-01-01'},profile1]}, {versions:Array(201).fill(profile1)}, {latestProfile:{...profile2,legalName:'not the historical snapshot'}},
  {currentProfile:{...profile1,displayName:'not the historical snapshot'}}, {currentProfile:null}, {currentProfile:profile2}, {billingUnits:null}, {billingUnits:{}},
  {billingUnits:[unit,unit]}, {billingUnits:[unit,{...unit,id:'synthetic-other-unit'}]}, {billingUnits:Array(201).fill(unit)}, {limit:199}, {truncated:undefined}]) assertMalformedDetail({...detail,...delta}, 'malformed detail or version linkage');
for (const delta of [{id:''}, {clientId:'foreign-client'}, {code:'lowercase'}, {code:'A'.repeat(81)}, {kind:'legal_entity'}, {latestVersion:0}, {latestVersion:3}, {latestVersion:'2'},
  {versions:[]}, {versions:[unitProfile2,unitProfile2]}, {versions:[unitProfile2,{...unitProfile1,id:unitProfile2.id}]}, {versions:[{...unitProfile2,effectiveFrom:unitProfile1.effectiveFrom},unitProfile1]},
  {versions:[{...unitProfile2,effectiveFrom:'2025-01-01'},unitProfile1]}, {versions:Array(201).fill(unitProfile1)}, {currentProfile:null}, {currentProfile:unitProfile2},
  {currentProfile:{...unitProfile1,displayName:'forged-current-unit'}}, {currentProfile:undefined}]) assertMalformedDetail({...detail,billingUnits:[{...unit,...delta}]}, 'malformed billing unit or ownership/current linkage');
for (const [key, values] of Object.entries({id: ['',null,1], version: [0,201,'1'], effectiveFrom: ['2026-02-30'], legalName:[undefined,'',42], displayName:[undefined,'',42],
  defaultCurrency:[undefined,'usd',42], billingContacts:[null,{},Array(11).fill(contact),[{...contact,email:'invalid'}]]})) for (const value of values) {
    const bad = {...unitProfile1,[key]:value};const badUnit = {...unit,latestVersion:1,currentProfile:bad,versions:[bad]};assertMalformedDetail({...detail,billingUnits:[badUnit]}, `malformed billing profile ${key}`);
  }

// Every command must return the requested identity and exact new immutable snapshot.
const appendOperation = operations.find(value => value.name === 'append client profile');
for (const value of [detail, {...appended,code:'WRONG-CODE'}, {...appended,latestVersion:2}, {...appended,latestProfile:{...profile3,legalName:'forged-name'},versions:[{...profile3,legalName:'forged-name'},profile2,profile1]},
  {...appended,latestProfile:{...profile3,parentClientId:'forged-parent'},versions:[{...profile3,parentClientId:'forged-parent'},profile2,profile1]},
  {...appended,latestProfile:{...profile3,defaultCurrency:'EUR'},versions:[{...profile3,defaultCurrency:'EUR'},profile2,profile1]},
  {...appended,latestProfile:{...profile3,effectiveFrom:'2029-01-01'},versions:[{...profile3,effectiveFrom:'2029-01-01'},profile2,profile1]}]) {
  reset();payload=value;await assert.rejects(invoke(appendOperation,capture()),invalid);assertRequest(appendOperation);
}
const createUnitOperation = operations.find(value => value.name === 'create billing unit');
for (const value of [detail, {...withNewUnit,billingUnits:[unit,{...newUnit,code:'WRONG-CODE'}]}, {...withNewUnit,billingUnits:[unit,{...newUnit,kind:'billing_entity'}]},
  {...withNewUnit,billingUnits:[unit,{...newUnit,clientId:'foreign-client'}]}, {...withNewUnit,billingUnits:[unit,{...newUnit,currentProfile:{...newUnitProfile,legalName:'forged-name'},versions:[{...newUnitProfile,legalName:'forged-name'}]}]}]) {
  reset();payload=value;await assert.rejects(invoke(createUnitOperation,capture()),invalid);assertRequest(createUnitOperation);
}
const appendUnitOperation = operations.find(value => value.name === 'append billing unit version');
for (const value of [detail, {...withUnitVersion,billingUnits:[{...revisedUnit,id:'foreign-unit'}]}, {...withUnitVersion,billingUnits:[{...revisedUnit,clientId:'foreign-client'}]},
  {...withUnitVersion,billingUnits:[{...revisedUnit,versions:[{...unitProfile3,legalName:'forged-name'},unitProfile2,unitProfile1]}]},
  {...withUnitVersion,billingUnits:[{...revisedUnit,versions:[{...unitProfile3,effectiveFrom:'2029-04-01'},unitProfile2,unitProfile1]}]}]) {
  reset();payload=value;await assert.rejects(invoke(appendUnitOperation,capture()),invalid);assertRequest(appendUnitOperation);
}

// A success envelope with another valid snapshot is still a failed command acknowledgment.
for (const delta of [{displayName:'synthetic-unrequested-display'}, {billingContacts:[]}, {billingContacts:[{...contact,email:'different@example.test'}]}]) {
  const changed = {...profile3,...delta};reset();payload={...appended,latestProfile:changed,versions:[changed,profile2,profile1]};
  await assert.rejects(invoke(appendOperation,capture()),invalid);assertRequest(appendOperation);
}
for (const delta of [{displayName:'synthetic-unrequested-display'}, {defaultCurrency:'USD'}, {billingContacts:[contact]}, {effectiveFrom:'2026-05-01'}]) {
  const changed = {...newUnitProfile,...delta};reset();payload={...withNewUnit,billingUnits:[unit,{...newUnit,currentProfile:changed,versions:[changed]}]};
  await assert.rejects(invoke(createUnitOperation,capture()),invalid);assertRequest(createUnitOperation);
}
for (const delta of [{displayName:'synthetic-unrequested-display'}, {defaultCurrency:'USD'}, {billingContacts:[]}, {billingContacts:[{...contact,email:'different@example.test'}]}]) {
  const changed = {...unitProfile3,...delta};reset();payload={...withUnitVersion,billingUnits:[{...revisedUnit,versions:[changed,unitProfile2,unitProfile1]}]};
  await assert.rejects(invoke(appendUnitOperation,capture()),invalid);assertRequest(appendUnitOperation);
}
const paddedProfileInput = {...profileInput,code:` ${profileInput.code} `,parentClientId:` ${profileInput.parentClientId} `,legalName:` ${profileInput.legalName} `,
  displayName:` ${profileInput.displayName} `,billingContacts:profileInput.billingContacts.map(value => ({name:` ${value.name} `,email:` ${value.email} `}))};
reset();payload=appended;assert.deepEqual(await service.appendClientProfile(clientId,paddedProfileInput,capture()),appended,'server trimming of explicit names/contacts is not confused with inference');
assertRequest({...appendOperation,body:paddedProfileInput});

// The shared explicit-context transport pins original ownership even after global replacement.
reset();payload = workspace;setScope(otherScope);storage.set('workos_api_token','example-client-profiles-session-b');
assert.deepEqual(await api.requestWithContext('GET',operations[0].path,undefined,{scope:{...scope},token}),workspace);assertRequest(operations[0]);
assert.deepEqual(getOrganizationScope(),otherScope);assert.equal(getToken(),'example-client-profiles-session-b');
assert.deepEqual(localAccesses,[],'no success, error, stale read, stale save or session failure path accesses browser-local fallback');
console.log('Client profiles production service passed: exact nullable DTOs and command/contact allowlists; all five APIs plus initial/historical reads; independent opt-in grants; scope/token/identity/permission/generation races; stale success and 401 isolation; bounded contiguous effective histories, current/latest selection, requested client/unit pins, optimistic versions, malformed response rejection and no local fallback.');
