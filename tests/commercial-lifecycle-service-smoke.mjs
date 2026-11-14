import assert from 'node:assert/strict';

// Production transport and DTO boundary, with browser-local fallback forbidden.
process.env.APP_MODE = process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const storage = new Map(), localAccesses = [], events = [];
globalThis.sessionStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)};
const forbidden = (...args) => {localAccesses.push(args);throw new Error('Lifecycle must not use local records.');};
globalThis.localStorage = {getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden};
globalThis.window = {localStorage, location: {pathname: '/commercial-drafting', href: '/commercial-drafting'}, dispatchEvent: event => {events.push(event.type);return true;}};
const {commercialLifecycleService: service, captureCommercialLifecycleContext: capture, isCommercialLifecycleContextCurrent: current,
  normalizeLifecycleEvent, normalizeGovernedProject, normalizeCommercialLifecycleWorkspace: normalizeWorkspace,
  normalizeCommercialLifecycleHistory: normalizeHistory, normalizeCommercialLifecycleReadiness: normalizeReadiness} = await import('../src/services/commercialLifecycle.ts');
const {api, ApiClientError, getOrganizationScope, getToken, isDemoFallbackAllowed} = await import('../src/services/apiClient.ts');
const {getDefaultPermissionsForRole} = await import('../src/services/permissions.ts');
assert.equal(isDemoFallbackAllowed(), false);
const scope = {organizationId: 'synthetic-org-a', legalEntityId: 'synthetic-legal-a'};
const otherScope = {organizationId: 'synthetic-org-b', legalEntityId: 'synthetic-legal-b'};
const token = 'example-lifecycle-session-a';
const user = {id: 'synthetic-lifecycle-operator', employeeId: 'SYN-LIFECYCLE', name: 'Synthetic lifecycle operator', role: 'ProjectManager', permissionRole: 'ProjectManager',
  permissions: ['commercial.contracts.view', 'commercial.lifecycle.manage']};
const event = {id: 'lifecycle-a', sequence: 1, state: 'Active', effectiveOn: '2026-10-20', contractVersionId: 'terms-a',
  reason: 'Synthetic protected reason <script>inert</script>', approvalReference: 'SYN-APPROVAL', actorId: 'synthetic-actor', activeRole: 'ProjectManager', correlationId: 'synthetic-correlation', operationId: 'synthetic-operation'};
const contract = {id: 'contract-a', number: 'SYN-LIFECYCLE-A', clientId: 'client-a', contractVersionId: 'terms-a', name: 'Synthetic contract', startsOn: '2020-01-01', endsOn: '2099-12-31', lifecycle: event};
const engagement = {id: 'engagement-a', code: 'SYN-ENG-A', name: 'Synthetic engagement', contractVersionId: 'terms-a', startsOn: '2020-01-01', endsOn: '2099-12-31', billable: true, model: 'fixed_fee', clientId: 'client-a', managerId: 'owner-a', currency: 'GBP', lifecycle: event};
const project = {id: 'project/a ?', bindingId: 'binding-a', engagementId: 'engagement-a', code: 'SYN-PROJECT-A', name: 'Synthetic governed project', managerId: 'owner-a', startsOn: '2020-01-01', endsOn: '2099-12-31',
  model: 'fixed_fee', currency: 'GBP', budgetAllocation: '99999999999999.9999', billable: true, contractVersionId: 'terms-a', attributionId: null, origin: 'manual', lifecycle: event};
const closure = {available: false, unavailableEvidence: ['approved-unbilled register', 'commercial balances and PO consumption', 'milestone acceptance and settlement'], message: 'Missing evidence is unknown, never assumed zero.'};
const workspace = {asOf: '2026-10-20', contracts: [contract], engagements: [engagement], projects: [project],
  choices: {legacyProjects: [{id: 'legacy-a', code: 'SYN-LEGACY', name: 'Synthetic Proposed project', clientId: 'client-a', managerId: 'owner-a', startsOn: '2020-01-01', endsOn: '2099-12-31', billable: true, neutralMapped: true}], owners: [{id: 'owner-a', name: 'Synthetic owner'}]},
  limits: {pageSize: 200, truncated: Object.fromEntries(['contracts','engagements','projects','legacyProjects','owners'].map(key => [key, false]))}, closure};
const history = {entityType: 'Project', entityId: project.id, events: [event], limit: 200};
const readiness = {entityType: 'Project', entityId: project.id, available: false, checkedOn: '2026-10-20', evidence: {openAssignments: 2, draftSubmittedWorkLines: 3, pendingTimesheetApprovals: 1, unacceptedMilestones: 4, draftPurchaseOrders: 5, ownerActive: true}, unavailableEvidence: closure.unavailableEvidence, message: closure.message};
const transition = {expectedSequence: 0, state: 'Active', contractVersionId: 'terms-a', reason: event.reason, approvalReference: event.approvalReference};
const projectInput = {engagementId: project.engagementId, projectId: null, code: project.code, name: project.name, managerId: project.managerId, startsOn: project.startsOn, endsOn: project.endsOn, billable: true, budgetAllocation: project.budgetAllocation, reason: 'Synthetic project creation'};
const extra = {organizationId: 'forged-org', legalEntityId: 'forged-legal', actorId: 'forged-actor', role: 'Admin', effectiveOn: '2000-01-01', status: 'Completed', lifecycle: {}, contractId: 'forged-contract', currency: 'USD', unexpected: true};
const prefix = '/api/v1/commercial-drafting/lifecycle';
const operations = [
  {name: 'workspace', method: 'GET', path: `${prefix}/workspace`, result: workspace, run: context => service.getWorkspace(context)},
  {name: 'history', method: 'GET', path: `${prefix}/Project/project%2Fa%20%3F/history`, result: history, run: context => service.getHistory('Project', project.id, context)},
  {name: 'readiness', method: 'GET', path: `${prefix}/Project/project%2Fa%20%3F/readiness`, result: readiness, run: context => service.getReadiness('Project', project.id, context)},
  {name: 'transition', method: 'POST', path: `${prefix}/Project/project%2Fa%20%3F/transitions`, body: transition, result: event, run: context => service.transition('Project', project.id, {...transition, ...extra}, context)},
  {name: 'create project', method: 'POST', path: `${prefix}/projects`, body: projectInput, result: project, run: context => service.createProject({...projectInput, ...extra}, context)},
  {name: 'explicit promotion', method: 'POST', path: `${prefix}/projects`, body: {...projectInput, projectId: project.id}, result: {...project, origin: 'explicit-legacy-promotion'}, run: context => service.createProject({...projectInput, projectId: project.id, ...extra}, context)},
];
const calls = [];
let payload, status, networkError, malformedJson, gate;
const errorPayload = {error: {code: 'SYNTHETIC_LIFECYCLE_FAILURE', message: 'Synthetic protected failure', correlationId: 'synthetic-correlation', operationId: 'synthetic-operation'}};
const setUser = value => storage.set('workos_session', JSON.stringify(value));
const setScope = value => storage.set('workos_organization_scope', JSON.stringify(value));
const snapshot = () => ({values: [...storage], href: window.location.href, events: [...events]});
const reset = () => {storage.clear();setUser(structuredClone(user));setScope(scope);storage.set('workos_api_token', token);calls.length = events.length = 0;
  window.location.href = window.location.pathname;payload = undefined;status = 200;networkError = null;malformedJson = false;gate = null;};
const deferred = () => {let resolve;const promise = new Promise(release => {resolve = release;});return {promise, resolve};};
const denied = error => error instanceof ApiClientError && error.status === 403;
const invalid = error => error instanceof ApiClientError && error.status === 502;
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init: {...init, headers: {...init.headers}}});
  assert(url.startsWith(prefix), 'direct lifecycle endpoint only, never health/demo/legacy fallback');
  const captured = {payload, status, networkError, malformedJson};
  if (gate) await gate.promise;
  if (captured.networkError) throw captured.networkError;
  return new Response(captured.malformedJson ? '{invalid synthetic json' : JSON.stringify(captured.status === 200 ? captured.payload : errorPayload), {status: captured.status, headers: {'Content-Type': 'application/json'}});
};
const assertRequest = (operation, expectedScope = scope, expectedToken = token) => {
  assert.deepEqual(calls, [{url: operation.path, init: {method: operation.method, credentials: 'include', headers: {'Content-Type': 'application/json',
    ...(expectedToken ? {Authorization: `Bearer ${expectedToken}`} : {}), 'X-Organization-Id': expectedScope.organizationId, 'X-Legal-Entity-Id': expectedScope.legalEntityId},
    ...(operation.body ? {body: JSON.stringify(operation.body)} : {})}}], `${operation.name}: one exact pinned request and command allowlist`);
};

for (const operation of operations) {
  reset();payload = {...operation.result, ignoredServerField: 'must be stripped'};const before = snapshot();
  assert.deepEqual(await operation.run(capture()), operation.result, `${operation.name}: exact DTO and decimal preservation`);assertRequest(operation);assert.deepEqual(snapshot(), before);
  for (const failureStatus of [400,401,403,404,409,422,500,502,503,504]) {
    reset();status = failureStatus;const beforeFailure = snapshot();
    await assert.rejects(operation.run(capture()), error => {assert(error instanceof ApiClientError);assert.equal(error.status, failureStatus);assert.equal(error.code, errorPayload.error.code);
      assert.equal(error.message, errorPayload.error.message);assert.equal(error.correlationId, errorPayload.error.correlationId);assert.equal(error.operationId, errorPayload.error.operationId);return true;});
    assertRequest(operation);assert.deepEqual(snapshot(), beforeFailure, 'including current-session 401: never clear session, scope, token, or navigate');
  }
  for (const bad of [null, [], {}, {unexpected: true}]) {reset();payload = bad;await assert.rejects(operation.run(capture()), invalid);assertRequest(operation);}
  reset();malformedJson = true;await assert.rejects(operation.run(capture()), invalid);assertRequest(operation);
  reset();networkError = new TypeError('Synthetic unavailable');const failure = networkError;await assert.rejects(operation.run(capture()), error => error === failure);assertRequest(operation);
  networkError = null;payload = operation.result;assert.deepEqual(await operation.run(capture()), operation.result, 'explicit retry can recover, never automatic fallback');
  for (const invalidate of [() => setScope(null), () => setScope({}), () => setScope({organizationId: scope.organizationId}), () => setScope({organizationId: 7, legalEntityId: scope.legalEntityId}),
    () => setScope({organizationId: ' ', legalEntityId: scope.legalEntityId}), () => setScope({organizationId: scope.organizationId, legalEntityId: []}), () => storage.set('workos_organization_scope', '{invalid'),
    () => setUser(null), () => storage.delete('workos_session'), () => storage.set('workos_session', '{invalid'), () => setUser({...user, permissions: []}), () => setUser({...user, permissions: ['commercial.lifecycle.manage']})]) {
    reset();invalidate();assert.equal(capture(), null);await assert.rejects(operation.run(null), denied);assert.equal(calls.length, 0, 'missing scope/identity/view permission fails before dispatch');
  }
  reset();await assert.rejects(operation.run(null), denied);assert.equal(calls.length, 0);
  reset();await assert.rejects(operation.run(capture(() => false)), denied);assert.equal(calls.length, 0, 'expired UI generation cannot dispatch');
  for (const permissions of [['commercial.contracts.view'], ['commercial.contracts.view','commercial.contracts.manage']]) {
    reset();setUser({...user, permissions});payload = operation.result;const reader = capture();assert(reader);assert.equal(reader.canManage, false);
    if (operation.method === 'POST') {await assert.rejects(operation.run(reader), denied);assert.equal(calls.length, 0, 'drafting management does not grant lifecycle authority');}
    else {assert.deepEqual(await operation.run(reader), operation.result);assertRequest(operation);}
  }
}
const changes = [
  ['actor', () => setUser({...user, id: 'synthetic-other'})], ['employee', () => setUser({...user, employeeId: 'SYN-OTHER'})], ['active role', () => setUser({...user, role: 'Admin'})],
  ['permission role', () => setUser({...user, permissionRole: 'HR'})], ['permissions', () => setUser({...user, permissions: [...user.permissions,'projects.view']})],
  ['management revoked', () => setUser({...user, permissions: ['commercial.contracts.view']})], ['view revoked', () => setUser({...user, permissions: ['commercial.lifecycle.manage']})],
  ['token', () => storage.set('workos_api_token', 'example-lifecycle-session-b')], ['missing token', () => storage.delete('workos_api_token')],
  ['organization', () => setScope({...scope, organizationId: otherScope.organizationId})], ['legal entity', () => setScope({...scope, legalEntityId: otherScope.legalEntityId})],
  ['missing identity', () => setUser(null)], ['missing scope', () => setScope(null)],
];
for (const operation of operations) for (const [reason, change] of changes) {
  reset();const owner = capture();change();assert.equal(current(owner), false, `${reason} invalidates lease`);await assert.rejects(operation.run(owner), denied);assert.equal(calls.length, 0);
  for (const resultStatus of [200,401,409]) {
    reset();payload = operation.result;status = resultStatus;gate = deferred();let owned = true;const context = capture(() => owned);
    const completion = assert.rejects(operation.run(context), resultStatus === 200 ? denied : error => error instanceof ApiClientError && error.status === resultStatus);
    assertRequest(operation);change();owned = false;const replacement = snapshot();gate.resolve();await completion;assertRequest(operation);
    assert.deepEqual(snapshot(), replacement, `${operation.name}: late ${resultStatus} cannot publish or alter replacement ${reason}`);
  }
}
for (const operation of operations) {reset();payload = operation.result;gate = deferred();let owned = true;const completion = assert.rejects(operation.run(capture(() => owned)), denied);owned = false;gate.resolve();await completion;assertRequest(operation);}
reset();const equivalent = capture();setUser({...user, name: 'Synthetic changed display', permissions: [...user.permissions].reverse()});setScope({...scope, organizationName: 'Synthetic display'});assert.equal(current(equivalent), true);
reset();storage.delete('workos_api_token');payload = workspace;assert.deepEqual(await service.getWorkspace(capture()), workspace);assertRequest(operations[0], scope, null);
for (const role of ['Admin','HR','CountryDirector','ProjectManager','TeamLead','Employee']) {
  assert(!getDefaultPermissionsForRole(role).includes('commercial.lifecycle.manage'));reset();setUser({id: 'synthetic-default', employeeId: 'SYN-DEFAULT', role});assert.equal(capture(), null);
}

// Requested identity, expected sequence and immutable pin must match the response.
for (const operation of operations.filter(item => ['history','readiness'].includes(item.name))) for (const delta of [{entityType: 'Contract'}, {entityId: 'foreign-record'}]) {
  reset();payload = {...operation.result, ...delta};await assert.rejects(operation.run(capture()), invalid);assertRequest(operation);
}
for (const delta of [{sequence: 3}, {state: 'On Hold', sequence: 2}, {contractVersionId: 'foreign-pin'}]) {
  reset();payload = {...event, ...delta};await assert.rejects(operations[3].run(capture()), invalid);assertRequest(operations[3]);
}
for (const [operation, delta] of [[operations[4], {engagementId: 'foreign-parent'}], [operations[5], {id: 'foreign-project'}], [operations[4], {lifecycle: {...event, sequence: 3}}]]) {
  reset();payload = {...operation.result, ...delta};await assert.rejects(operation.run(capture()), invalid);assertRequest(operation);
}
const clone = value => structuredClone(value);
for (const [key, values] of Object.entries({id: ['',null,1], sequence: [0,201,1.5,'1'], state: ['Draft','Completed','On Hold'], effectiveOn: ['2026-02-30','2026-10-20T00:00:00Z'], contractVersionId: [undefined,42], reason: ['',null], approvalReference: [undefined,42], actorId: ['',null], activeRole: ['',null], correlationId: ['',null], operationId: ['',null]}))
  for (const value of values) assert.throws(() => normalizeLifecycleEvent({...event, [key]: value}), invalid, `malformed lifecycle ${key}`);
for (const delta of [{budgetAllocation: 1}, {budgetAllocation: '1e3'}, {budgetAllocation: '0.00001'}, {budgetAllocation: '100000000000000.0000'}, {billable: 'true'}, {currency: 'gbp'}, {origin: 'legacy-neutral'}, {model: 'legacy_unclassified'}, {contractVersionId: 'different-pin'}, {startsOn: '2026-02-30'}, {endsOn: '1900-01-01'}, {model: 'internal', billable: true}])
  assert.throws(() => normalizeGovernedProject({...project, ...delta}), invalid);
for (const model of ['internal','pre_sales']) {
  const internalEvent = {...event, contractVersionId: null};const internal = {...project, model, billable: false, contractVersionId: null, attributionId: 'synthetic-bu', budgetAllocation: '0.0000', lifecycle: internalEvent};
  assert.deepEqual(normalizeGovernedProject(internal), internal);for (const delta of [{attributionId: null},{budgetAllocation: '0.0001'},{billable: true},{contractVersionId: 'terms-a'}]) assert.throws(() => normalizeGovernedProject({...internal, ...delta}), invalid);
  for (const clientId of [null,'client-a']) {
    const internalEngagement = {...engagement, model, billable: false, contractVersionId: null, clientId, lifecycle: internalEvent};
    const value = {...workspace, engagements: [internalEngagement]};assert.deepEqual(normalizeWorkspace(value).engagements, [internalEngagement], 'internal/pre-sales retains its valid optional scoped client');
    for (const delta of [{billable: true},{contractVersionId: 'terms-a'}]) assert.throws(() => normalizeWorkspace({...value, engagements: [{...internalEngagement,...delta}]}), invalid);
  }
}
for (const delta of [{limit: 201}, {events: [event,event]}, {events: [{...event, sequence: 3}]}, {events: [{...event, sequence: 2, state: 'On Hold'}, {...event, contractVersionId: 'changed-pin'}]}, {events: [{...event, sequence: 2, state: 'On Hold'}, {...event, effectiveOn: '2027-01-01'}]}, {entityType: 'Unknown'}])
  assert.throws(() => normalizeHistory({...history, ...delta}), invalid);
assert.deepEqual(normalizeHistory({...history, events: []}), {...history, events: []});
for (const delta of [{available: true}, {checkedOn: '2026-02-30'}, {evidence: {...readiness.evidence, openAssignments: -1}}, {evidence: {...readiness.evidence, draftSubmittedWorkLines: '0'}}, {evidence: {...readiness.evidence, pendingTimesheetApprovals: 0.5}}, {evidence: {...readiness.evidence, ownerActive: 'unknown'}}, {unavailableEvidence: [null]}])
  assert.throws(() => normalizeReadiness({...readiness, ...delta}), invalid);
assert.equal(normalizeReadiness({...readiness, evidence: {...readiness.evidence, ownerActive: null}}).evidence.ownerActive, null, 'unknown owner evidence is not converted to false or zero');
for (const delta of [{asOf: '2026-02-30'}, {closure: {...closure, available: true}}, {limits: {...workspace.limits, pageSize: 201}}, {contracts: [contract,contract]}, {projects: Array(201).fill(project)}, {engagements: [{...engagement, lifecycle: {...event, effectiveOn: '2027-01-01'}}]}, {projects: [{...project, lifecycle: null}]}, {choices: {...workspace.choices, owners: [{id: '', name: 'Synthetic'}]}}])
  assert.throws(() => normalizeWorkspace({...workspace, ...delta}), invalid);
for (const key of ['contracts','engagements','projects','legacyProjects','owners']) {const value = clone(workspace);delete value.limits.truncated[key];assert.throws(() => normalizeWorkspace(value), invalid);}
const empty = {...workspace, contracts: [], engagements: [], projects: [], choices: {legacyProjects: [], owners: []}};assert.deepEqual(normalizeWorkspace(empty), empty);
reset();payload = workspace;setScope(otherScope);storage.set('workos_api_token', 'example-lifecycle-session-b');
assert.deepEqual(await api.requestWithContext('GET', operations[0].path, undefined, {scope: {...scope}, token}), workspace);assertRequest(operations[0]);assert.deepEqual(getOrganizationScope(), otherScope);assert.equal(getToken(), 'example-lifecycle-session-b');
assert.deepEqual(localAccesses, [], 'no success, failure, stale read or write path touches browser-local fallback');
console.log('Commercial lifecycle production service passed: exact fields/decimals and allowlists, all reads/transitions/project creation/promotion, independent opt-in lifecycle authority, scope/token/identity/permission/generation races, stale success and 401 session isolation, malformed DTOs and no local fallback.');
