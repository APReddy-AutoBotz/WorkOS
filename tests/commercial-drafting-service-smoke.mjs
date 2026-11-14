import assert from 'node:assert/strict';

// Exercise the real service and shared transport with production fallback disabled.
process.env.APP_MODE = process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const storage = new Map();
const localAccesses = [];
globalThis.sessionStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)};
const forbidden = (...args) => {localAccesses.push(args);throw new Error('Commercial drafting must not use browser-local records.');};
globalThis.localStorage = {getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden};
const events = [];
globalThis.window = {localStorage, location: {pathname: '/commercial-drafting', href: '/commercial-drafting'}, dispatchEvent: event => {events.push(event.type);return true;}};
const {commercialDraftingService: service, captureCommercialDraftingContext: capture, isCommercialDraftingContextCurrent: current,
  normalizeCommercialWorkspace, normalizeCommercialContract, COMMERCIAL_CONTRACT_MODELS, ENGAGEMENT_MODELS} = await import('../src/services/commercialDrafting.ts');
const {api, ApiClientError, getOrganizationScope, getToken, isDemoFallbackAllowed} = await import('../src/services/apiClient.ts');
const {getDefaultPermissionsForRole} = await import('../src/services/permissions.ts');
assert.equal(isDemoFallbackAllowed(), false);
assert.deepEqual(COMMERCIAL_CONTRACT_MODELS, ['time_and_materials','fixed_fee','milestone','retainer','managed_service']);
assert.deepEqual(ENGAGEMENT_MODELS, [...COMMERCIAL_CONTRACT_MODELS, 'internal', 'pre_sales']);
const scope = {organizationId: 'synthetic-org-a', legalEntityId: 'synthetic-legal-a'};
const otherScope = {organizationId: 'synthetic-org-b', legalEntityId: 'synthetic-legal-b'};
const token = 'example-commercial-session-a';
const user = {id: 'synthetic-commercial-operator', employeeId: 'SYN-COMMERCIAL', name: 'Synthetic Commercial Operator', role: 'ProjectManager', permissionRole: 'ProjectManager',
  permissions: ['commercial.contracts.view', 'commercial.contracts.manage']};
const terms = {id: 'term-a-1', version: 1, name: 'Synthetic terms <script>inert</script>', model: 'fixed_fee', startsOn: '2026-01-01', endsOn: '2030-12-31',
  effectiveFrom: '2026-01-01', currency: 'GBP', value: '99999999999999.9999', billingTerms: 'Synthetic quarterly terms', documents: [{name: 'Synthetic SOW', url: 'https://example.test/synthetic-sow.pdf'}]};
const detail = {id: 'contract-a', number: 'SYN-CONTRACT-A', clientId: 'client-a', latestVersion: 1, versions: [terms]};
const summary = {id: detail.id, number: detail.number, clientId: detail.clientId, latestVersion: 1, terms, currentTerms: terms};
const engagement = {id: 'engagement-a', code: 'SYN-ENG-A', name: 'Synthetic delivery', model: 'fixed_fee', ownerId: 'owner-a', startsOn: '2026-01-01', endsOn: '2029-12-31', currency: 'GBP', budget: '25000.0001',
  contractId: 'contract-a', contractVersionId: 'term-a-1', clientId: 'client-a', attributionId: null, status: 'Draft', billable: true, origin: 'manual'};
const po = {id: 'po-a', contractId: 'contract-a', contractVersionId: 'term-a-1', number: 'SYN-PO-A', value: '12345.6700', currency: 'GBP', startsOn: '2026-01-01', endsOn: '2029-12-31', warningThresholdPercent: '75.25', status: 'Draft'};
const milestone = {id: 'milestone-a', engagementId: 'engagement-a', code: 'SYN-MILESTONE-A', name: 'Synthetic draft delivery', dueOn: '2027-06-01', amount: '200.0001', currency: 'GBP', status: 'Draft', billingEligible: false};
const workspace = {asOf: '2026-10-20', contracts: [summary], engagements: [engagement], purchaseOrders: [po], milestones: [milestone],
  choices: {clients: [{id: 'client-a', name: 'Synthetic Client'}], owners: [{id: 'owner-a', name: 'Synthetic Owner'}], attributions: [{id: 'attribution-a', name: 'Synthetic Practice', code: 'SYN-PRACTICE', catalogType: 'business_unit'}]},
  limits: {pageSize: 200, truncated: Object.fromEntries(['contracts','engagements','purchaseOrders','milestones','clients','owners','attributions'].map(key => [key, false]))}, legacyMappings: {totalProjects: 7, mappedProjects: 7}};
const extra = {organizationId: 'forged-org', legalEntityId: 'forged-legal', actorId: 'forged-actor', role: 'Admin', status: 'Active', billable: true, billingEligible: true, createdBy: 'forged-creator', unexpected: 'not-allowed'};
const termsInput = Object.fromEntries(Object.entries(terms).filter(([key]) => !['id','version'].includes(key)));
const contractInput = {...termsInput, number: detail.number, clientId: detail.clientId, reason: 'Synthetic create reason'};
const revisionInput = {...termsInput, effectiveFrom: '2027-01-01', expectedVersion: 1, reason: 'Synthetic future revision'};
const engagementInput = Object.fromEntries(Object.entries({...engagement, reason: 'Synthetic engagement reason'}).filter(([key]) => !['id','status','billable','origin'].includes(key)));
const poInput = Object.fromEntries(Object.entries({...po, reason: 'Synthetic purchase-order reason'}).filter(([key]) => !['id','status'].includes(key)));
const milestoneInput = Object.fromEntries(Object.entries({...milestone, reason: 'Synthetic milestone reason'}).filter(([key]) => !['id','status','billingEligible'].includes(key)));
const prefix = '/api/v1/commercial-drafting';
const operations = [
  {name: 'workspace', method: 'GET', path: `${prefix}/workspace`, result: workspace, run: context => service.getWorkspace(context)},
  {name: 'contract detail', method: 'GET', path: `${prefix}/contracts/contract%2Fa%20%3F`, result: {...detail, id: 'contract/a ?'}, run: context => service.getContract('contract/a ?', context)},
  {name: 'create contract', method: 'POST', path: `${prefix}/contracts`, body: contractInput, result: detail, run: context => service.createContract({...contractInput, ...extra, documents: termsInput.documents.map(item => ({...item, actorId: 'forged-doc-actor'}))}, context)},
  {name: 'append version', method: 'POST', path: `${prefix}/contracts/contract%2Fa%20%3F/versions`, body: revisionInput, result: {...detail, id: 'contract/a ?', latestVersion: 2, versions: [{...terms, id: 'term-a-2', version: 2, effectiveFrom: revisionInput.effectiveFrom}, terms]}, run: context => service.appendContractVersion('contract/a ?', {...revisionInput, ...extra}, context)},
  {name: 'create engagement', method: 'POST', path: `${prefix}/engagements`, body: engagementInput, result: engagement, run: context => service.createEngagement({...engagementInput, ...extra}, context)},
  {name: 'create purchase order', method: 'POST', path: `${prefix}/purchase-orders`, body: poInput, result: po, run: context => service.createPurchaseOrder({...poInput, ...extra}, context)},
  {name: 'create milestone', method: 'POST', path: `${prefix}/milestones`, body: milestoneInput, result: milestone, run: context => service.createMilestone({...milestoneInput, ...extra}, context)},
];
const calls = [];
let payload, status, networkError, malformedJson, gate;
const errorPayload = {error: {code: 'SYNTHETIC_COMMERCIAL_FAILURE', message: 'Synthetic commercial rejection', correlationId: 'synthetic-correlation', operationId: 'synthetic-operation'}};
const setUser = value => storage.set('workos_session', JSON.stringify(value));
const setScope = value => storage.set('workos_organization_scope', JSON.stringify(value));
const snapshot = () => ({values: [...storage], href: window.location.href, events: [...events]});
const reset = () => {storage.clear();setUser(structuredClone(user));setScope(scope);storage.set('workos_api_token', token);calls.length = events.length = 0;
  window.location.href = window.location.pathname;payload = undefined;status = 200;networkError = null;malformedJson = false;gate = null;};
const deferred = () => {let resolve;const promise = new Promise(release => {resolve = release;});return {promise, resolve};};
const denied = error => error instanceof ApiClientError && error.status === 403;
const invalid = error => error instanceof ApiClientError && error.status === 502;
globalThis.fetch = async (url, init = {}) => {
  const call = {url, init: {...init, headers: {...init.headers}}};calls.push(call);
  assert(url.startsWith(prefix), 'commercial service uses direct production API only, never health, demo or legacy fallback');
  const capturedPayload = payload;const capturedStatus = status;const capturedError = networkError;const capturedMalformed = malformedJson;
  if (gate) await gate.promise;
  if (capturedError) throw capturedError;
  return new Response(capturedMalformed ? '{invalid synthetic json' : JSON.stringify(capturedStatus === 200 ? capturedPayload : errorPayload), {status: capturedStatus, headers: {'Content-Type': 'application/json'}});
};
const assertRequest = (operation, expectedScope = scope, expectedToken = token) => {
  assert.equal(calls.length, 1, `${operation.name} has exactly one business request`);
  assert.deepEqual(calls[0], {url: operation.path, init: {method: operation.method, credentials: 'include', headers: {'Content-Type': 'application/json',
    ...(expectedToken ? {Authorization: `Bearer ${expectedToken}`} : {}), 'X-Organization-Id': expectedScope.organizationId, 'X-Legal-Entity-Id': expectedScope.legalEntityId},
    ...(operation.body ? {body: JSON.stringify(operation.body)} : {})}}, `${operation.name} pinned HTTP/body allowlist`);
};

for (const operation of operations) {
  reset();payload = {...operation.result, ignoredServerField: 'stripped'};
  const before = snapshot();const inputBefore = structuredClone(operation.body);
  assert.deepEqual(await operation.run(capture()), operation.result, `${operation.name} exact DTO mapping`);
  assertRequest(operation);assert.deepEqual(operation.body, inputBefore);assert.deepEqual(snapshot(), before, 'reads and saves do not rewrite session, scope or navigation');
  for (const failureStatus of [400,401,403,404,409,422,500,502,503,504]) {
    reset();status = failureStatus;const beforeFailure = snapshot();
    await assert.rejects(operation.run(capture()), error => {assert(error instanceof ApiClientError);assert.equal(error.status, failureStatus);
      assert.equal(error.code, errorPayload.error.code);assert.equal(error.message, errorPayload.error.message);assert.equal(error.correlationId, errorPayload.error.correlationId);assert.equal(error.operationId, errorPayload.error.operationId);return true;});
    assertRequest(operation);assert.deepEqual(snapshot(), beforeFailure, 'scoped HTTP errors including 401 do not clear any current session');
  }
  for (const bad of [null, [], {}, {unexpected: true}]) {reset();payload = bad;await assert.rejects(operation.run(capture()), invalid);assertRequest(operation);}
  reset();malformedJson = true;await assert.rejects(operation.run(capture()), invalid);assertRequest(operation);
  reset();networkError = new TypeError('Synthetic network unavailable');const failure = networkError;
  await assert.rejects(operation.run(capture()), error => error === failure);assertRequest(operation);
  networkError = null;payload = operation.result;assert.deepEqual(await operation.run(capture()), operation.result, 'explicit retry recovers without local fallback');
  for (const invalidate of [() => setScope(null), () => setScope({}), () => setScope({organizationId: scope.organizationId}), () => setScope({organizationId: 42, legalEntityId: scope.legalEntityId}),
    () => setScope({organizationId: ' ', legalEntityId: scope.legalEntityId}), () => setScope({organizationId: scope.organizationId, legalEntityId: []}), () => storage.set('workos_organization_scope', '{invalid'),
    () => setUser(null), () => storage.delete('workos_session'), () => storage.set('workos_session', '{invalid'), () => setUser({...user, permissions: []}), () => setUser({...user, permissions: ['commercial.contracts.manage']})]) {
    reset();invalidate();assert.equal(capture(), null);await assert.rejects(operation.run(null), denied);assert.equal(calls.length, 0, 'missing scope/identity/view permission fails before dispatch');
  }
  reset();await assert.rejects(operation.run(null), denied);assert.equal(calls.length, 0);
  reset();const expired = capture(() => false);await assert.rejects(operation.run(expired), denied);assert.equal(calls.length, 0, 'expired UI lease cannot dispatch');
  reset();setUser({...user, permissions: ['commercial.contracts.view']});payload = operation.result;
  const readOnly = capture();assert(readOnly);assert.equal(readOnly.canManage, false);
  if (operation.method === 'POST') {await assert.rejects(operation.run(readOnly), denied);assert.equal(calls.length, 0, 'explicit view permission never authorizes mutation');}
  else {assert.deepEqual(await operation.run(readOnly), operation.result);assertRequest(operation);}
}

const changes = [
  ['actor', () => setUser({...user, id: 'synthetic-other-actor'})], ['employee identity', () => setUser({...user, employeeId: 'SYN-OTHER'})],
  ['active role', () => setUser({...user, role: 'Admin'})], ['permission role', () => setUser({...user, permissionRole: 'HR'})],
  ['permissions', () => setUser({...user, permissions: [...user.permissions, 'projects.view']})], ['management revoked', () => setUser({...user, permissions: ['commercial.contracts.view']})],
  ['view revoked', () => setUser({...user, permissions: ['commercial.contracts.manage']})], ['token', () => storage.set('workos_api_token', 'example-commercial-session-b')],
  ['token removed', () => storage.delete('workos_api_token')], ['organization', () => setScope({...scope, organizationId: otherScope.organizationId})],
  ['legal entity', () => setScope({...scope, legalEntityId: otherScope.legalEntityId})], ['missing actor', () => setUser(null)], ['missing scope', () => setScope(null)],
];
for (const operation of operations) for (const [reason, change] of changes) {
  reset();const context = capture();assert(context);change();assert.equal(current(context), false, `${reason} invalidates context`);
  await assert.rejects(operation.run(context), denied);assert.equal(calls.length, 0, `${operation.name}: stale ${reason} fails before request`);
  for (const resultStatus of [200,401,409]) {
    reset();payload = operation.result;status = resultStatus;gate = deferred();let owned = true;const captured = capture(() => owned);
    const pending = operation.run(captured);const completion = assert.rejects(pending, resultStatus === 200 ? denied : error => error instanceof ApiClientError && error.status === resultStatus);
    assertRequest(operation);change();owned = false;const replacement = snapshot();gate.resolve();await completion;
    assertRequest(operation);assert.deepEqual(snapshot(), replacement, `${operation.name} late ${resultStatus} cannot publish stale data, redirect, or clear replacement ${reason}`);
  }
}
for (const operation of operations) {
  reset();payload = operation.result;gate = deferred();let owned = true;const context = capture(() => owned);const completion = assert.rejects(operation.run(context), denied);
  owned = false;gate.resolve();await completion;assertRequest(operation);
}
reset();const equivalent = capture();setUser({...user, name: 'Synthetic display changed', permissions: [...user.permissions].reverse()});
setScope({...scope, organizationName: 'Synthetic renamed display'});assert.equal(current(equivalent), true, 'permission order and display-only metadata do not invalidate identity');
reset();storage.delete('workos_api_token');payload = workspace;assert.deepEqual(await service.getWorkspace(capture()), workspace);assertRequest(operations[0], scope, null);
for (const role of ['Admin','HR','CountryDirector','ProjectManager','TeamLead','Employee']) {
  assert(!getDefaultPermissionsForRole(role).includes('commercial.contracts.view'));assert(!getDefaultPermissionsForRole(role).includes('commercial.contracts.manage'));
  reset();setUser({id: 'synthetic-no-explicit-grant', employeeId: 'SYN-NO-GRANT', role});assert.equal(capture(), null, `${role} defaults never grant commercial access`);
}

// Requested-ID and optimistic-concurrency response checks cannot accept another record.
for (const operation of operations.filter(item => ['contract detail','append version'].includes(item.name))) {
  reset();payload = {...operation.result, id: 'contract-foreign'};await assert.rejects(operation.run(capture()), invalid);assertRequest(operation);
}
reset();payload = {...detail, id: 'contract/a ?'};await assert.rejects(operations.find(item => item.name === 'append version').run(capture()), invalid);

// Full DTOs preserve decimal strings and explicit false/null values, stripping metadata rather than inventing defaults.
reset();assert.deepEqual(normalizeCommercialWorkspace({...workspace, ignored: true}), workspace);assert.deepEqual(normalizeCommercialContract({...detail, status: 'Draft', ignored: true}), detail);
const clone = value => structuredClone(value);
const credentialedDocument = new URL('https://example.test/file');credentialedDocument.username = 'example-user';credentialedDocument.password = 'example-password';
const badWorkspace = [null, [], {}, {...workspace, asOf: '2026-02-30'}, {...workspace, asOf: '2026-10-20T00:00:00.000Z'},
  ...['contracts','engagements','purchaseOrders','milestones'].flatMap(key => [null, {}, [null], [[]]].map(value => ({...workspace, [key]: value}))),
  ...['clients','owners','attributions'].flatMap(key => [null, {}, [{id: '', name: 'Synthetic'}]].map(value => ({...workspace, choices: {...workspace.choices, [key]: value}}))),
  {...workspace, limits: {...workspace.limits, pageSize: 199}}, {...workspace, limits: {...workspace.limits, pageSize: 0}}, {...workspace, limits: {...workspace.limits, pageSize: '200'}},
  {...workspace, limits: {...workspace.limits, truncated: {...workspace.limits.truncated, contracts: 'false'}}},
  {...workspace, legacyMappings: {totalProjects: 0, mappedProjects: 1}}, {...workspace, legacyMappings: {totalProjects: -1, mappedProjects: 0}}, {...workspace, legacyMappings: {totalProjects: 7.5, mappedProjects: 7}}];
for (const key of ['contracts','engagements','purchaseOrders','milestones']) badWorkspace.push({...workspace, [key]: Array.from({length: 201}, () => workspace[key][0])});
for (const key of ['clients','owners','attributions']) badWorkspace.push({...workspace, choices: {...workspace.choices, [key]: Array.from({length: 201}, () => workspace.choices[key][0])}});
badWorkspace.push({...workspace, contracts: [{...summary, latestVersion: 2}]}, {...workspace, choices: {...workspace.choices, attributions: [{...workspace.choices.attributions[0], catalogType: 'department'}]}});
for (const value of badWorkspace) assert.throws(() => normalizeCommercialWorkspace(value), invalid);
for (const [key, badValues] of Object.entries({id: [null, '', 1], version: [0, 1.5, '1'], name: ['', null], model: ['internal', 'unknown'], startsOn: ['2026-02-30', '2026-01-01T00:00:00.000Z'], endsOn: ['bad-date'], effectiveFrom: [undefined],
  currency: ['gbp', 'GB', 100], value: [0, 100.2, '-1', '1.00001', '1e3', '100000000000000.00'], billingTerms: [null, 42], documents: [null, {}, [{name: 'Synthetic', url: 'http://example.test/file'}], Array.from({length:11}, () => ({name: 'Synthetic', url: 'https://example.test/file'})), [{name: 'Synthetic', url: 'javascript:alert(1)'}], [{name: 'Synthetic', url: credentialedDocument.href}], [{name: '', url: 'https://example.test/file'}]]})) {
  for (const bad of badValues) {const value = {...detail, versions: [{...terms, [key]: bad}]};assert.throws(() => normalizeCommercialContract(value), invalid, `invalid terms ${key}`);}
}
for (const value of [null, {}, [], {...detail, versions: []}, {...detail, latestVersion: 2}, {...detail, versions: [terms, terms]}, {...detail, latestVersion: '1'}, {...detail, clientId: ''}]) assert.throws(() => normalizeCommercialContract(value), invalid);
for (const [collection, delta] of [
  ['engagements', {status: 'Active'}], ['engagements', {billable: 'true'}], ['engagements', {budget: 0}], ['engagements', {contractId: undefined}], ['engagements', {model: 'unknown'}], ['engagements', {origin: 'legacy'}], ['engagements', {model: 'internal', billable: true}],
  ['purchaseOrders', {status: 'Approved'}], ['purchaseOrders', {warningThresholdPercent: '100.01'}], ['purchaseOrders', {warningThresholdPercent: 90}], ['purchaseOrders', {value: 'NaN'}],
  ['milestones', {status: 'Accepted'}], ['milestones', {billingEligible: true}], ['milestones', {amount: 200}], ['milestones', {dueOn: '2027-02-30'}],
]) {const value = clone(workspace);value[collection][0] = {...value[collection][0], ...delta};assert.throws(() => normalizeCommercialWorkspace(value), invalid, `${collection} malformed response cannot invent approved/billable state`);}
for (const model of ENGAGEMENT_MODELS) {const value = clone(workspace);value.engagements[0].model = model;if (['internal','pre_sales'].includes(model)) Object.assign(value.engagements[0], {billable: false, contractId: null, contractVersionId: null, clientId: null, attributionId: 'attribution-a'});assert.equal(normalizeCommercialWorkspace(value).engagements[0].model, model);}
const empty = {...workspace, contracts: [], engagements: [], purchaseOrders: [], milestones: [], choices: {clients: [], owners: [], attributions: []}, legacyMappings: {totalProjects: 0, mappedProjects: 0}};
assert.deepEqual(normalizeCommercialWorkspace(empty), empty);
const future = {...workspace, contracts: [{...summary, currentTerms: null}]};assert.equal(normalizeCommercialWorkspace(future).contracts[0].currentTerms, null, 'future-only terms do not become current implicitly');

// The shared explicit-context transport remains pinned even if global state is already different.
reset();payload = workspace;setScope(otherScope);storage.set('workos_api_token', 'example-commercial-session-b');
assert.deepEqual(await api.requestWithContext('GET', operations[0].path, undefined, {scope: {...scope}, token}), workspace);assertRequest(operations[0]);
assert.deepEqual(getOrganizationScope(), otherScope);assert.equal(getToken(), 'example-commercial-session-b');
assert.deepEqual(localAccesses, [], 'no successful/error/read/write path accesses browser-local fallback records');
console.log('Commercial drafting production service passed: exact DTO/decimal mapping and strict command allowlists; all seven API operations; fail-closed permission/identity/scope/token/generation races; stale-read/save rejection; current/replacement 401 session isolation; opt-in grants; malformed responses and no local fallback.');
