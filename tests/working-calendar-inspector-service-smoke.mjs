import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
process.env.APP_MODE = process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const values = new Map();
globalThis.sessionStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
const forbidden = () => {throw new Error('Production calendar inspector cannot use local records');};
globalThis.localStorage = {getItem: forbidden, setItem: forbidden, removeItem: forbidden};
globalThis.window = {localStorage, location: {pathname: '/admin/working-calendars', href: '/admin/working-calendars'}, dispatchEvent: forbidden};
const {workingCalendarInspectorService: service, captureCalendarReadContext, isCalendarReadContextCurrent, CALENDAR_ROW_CAP} = await import('../src/services/workingCalendarInspector.ts');
const {resetBackendCheck, ApiClientError, isDemoFallbackAllowed} = await import('../src/services/apiClient.ts');
assert.equal(isDemoFallbackAllowed(), false);
assert.equal(CALENDAR_ROW_CAP, 200);
const scope = {organizationId: 'org-a', legalEntityId: 'legal-a'};
const user = {id: 'synthetic-calendar-admin', employeeId: 'SYN-CAL', role: 'HR', permissionRole: 'HR', permissions: ['settings.manage']};
const token = 'synthetic-calendar-session-a';
const today = new Date().toISOString().slice(0, 10);
const calendar = {id: 'calendar-a', organization_id: 'org-a', legal_entity_id: 'legal-a', applicability_type: 'legal_entity', country_code: null,
  country_authority_legal_entity_id: null, worker_group_id: null, code: 'WEEK_A', name: 'Synthetic calendar', timezone: 'Asia/Kolkata', working_days: [1,2,3,4,5], hours_per_day: '7.50', effective_from: '2020-01-01', effective_to: null, active: true};
const holiday = {id: 'holiday-version-a', holiday_id: 'holiday-a', calendar_id: 'calendar-a', organization_id: 'org-a', holiday_date: '2026-12-25', label: '<Synthetic holiday>', holiday_type: 'Public', effective_from: '2020-01-01', effective_to: null, active: false};
let health = 'connected', healthGate, businessGate, businessStatus, businessPayload;
const calls = [];
const response = (payload, status = 200) => new Response(JSON.stringify(payload), {status, headers: {'Content-Type': 'application/json'}});
const deferred = () => {let resolve;const promise = new Promise(release => {resolve = release;});return {promise, resolve};};
const flush = () => new Promise(resolve => setImmediate(resolve));
const set = (key, value) => values.set(key, JSON.stringify(value));
const reset = () => {
  values.clear();set('workos_session', structuredClone(user));set('workos_organization_scope', scope);values.set('workos_api_token', token);
  window.location.href = window.location.pathname;calls.length = 0;health = 'connected';healthGate = businessGate = null;businessStatus = 200;businessPayload = undefined;resetBackendCheck();
};
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init: {...init, ...(init.headers ? {headers: {...init.headers}} : {})}});
  if (url === '/api/health') {const result = response({database: health});if (healthGate) await healthGate.promise;return result;}
  assert.equal(init.method, 'GET', 'explicit no business mutation request assertion');
  assert(url === `/api/organization-setup/calendars?asOf=${today}` || url === `/api/organization-setup/calendars/calendar-a/holidays?asOf=${today}`,
    'only established calendar and lazy selected-calendar holiday reads are allowed');
  const payload = businessPayload === undefined ? [url.includes('/holidays') ? holiday : calendar] : businessPayload;
  const status = businessStatus;
  if (businessGate) await businessGate.promise;
  return response(payload, status);
};
const denied = error => error instanceof ApiClientError && error.status === 403;
const invalid = error => error instanceof ApiClientError && error.status === 502;
const operations = [
  {name: 'calendar GET', run: context => service.getCalendars(context), row: calendar, path: '/api/organization-setup/calendars'},
  {name: 'holiday GET', run: context => service.getHolidays('calendar-a', context), row: holiday, path: '/api/organization-setup/calendars/calendar-a/holidays'},
];
const changes = [
  () => set('workos_session', {...user, id: 'replacement'}),
  () => set('workos_session', {...user, employeeId: 'replacement'}),
  () => set('workos_session', {...user, role: 'Admin'}),
  () => set('workos_session', {...user, permissionRole: 'Admin'}),
  () => set('workos_session', {...user, permissions: []}),
  () => set('workos_organization_scope', {...scope, organizationId: 'org-b'}),
  () => set('workos_organization_scope', {...scope, legalEntityId: 'legal-b'}),
  () => values.set('workos_api_token', 'synthetic-calendar-session-b'),
  () => values.delete('workos_session'),
  () => values.delete('workos_organization_scope'),
];
for (const operation of operations) {
  reset();
  const context = captureCalendarReadContext();
  assert.equal(context.asOf, today);
  const result = await operation.run(context);
  assert.equal(result.length, 1);assert.equal(result[0].effectiveFrom, '2020-01-01');assert.equal(result[0].effectiveTo, null);
  assert.deepEqual(calls.map(call => call.url), ['/api/health', `${operation.path}?asOf=${today}`]);
  assert.deepEqual(calls.at(-1).init, {method: 'GET', credentials: 'include', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Organization-Id': 'org-a', 'X-Legal-Entity-Id': 'legal-a'}});
  assert.equal(result[0].active, operation.name === 'calendar GET');
  for (const payload of [[], Array.from({length: 200}, (_, i) => ({...operation.row, id: `synthetic-row-${i}`}))]) {
    reset();businessPayload = payload;assert.equal((await operation.run(captureCalendarReadContext())).length, payload.length);
  }
  const malformed = [null, {}, [null], [[]], [operation.row, operation.row], Array.from({length: 201}, (_, i) => ({...operation.row, id: `extra-${i}`})),
    ...[{id: ''}, {organization_id: 'org-b'}, {effective_from: '2026-02-30'}, {effective_from: '2999-01-01'},
      {effective_to: '2000-01-01'}, {effective_from: '2020-01-01T00:00:00.000Z'}, {active: 'true'}].map(change => [{...operation.row, ...change}])];
  for (const payload of malformed) {reset();businessPayload = payload;await assert.rejects(operation.run(captureCalendarReadContext()), invalid);}
  for (const status of [400,401,403,404,500,503]) {
    reset();businessStatus = status;businessPayload = {error: 'synthetic-private-token'};
    await assert.rejects(operation.run(captureCalendarReadContext()), error => error instanceof ApiClientError && error.status === status);
    assert.equal(values.get('workos_api_token'), token, 'scoped 401 cannot erase a replacement session or force navigation');
    assert.equal(window.location.href, window.location.pathname);
  }
  reset();health = 'offline';await assert.rejects(operation.run(captureCalendarReadContext()));
  health = 'connected';await assert.rejects(operation.run(captureCalendarReadContext()));assert.equal(calls.length, 1, 'offline status is cached');
  resetBackendCheck();await operation.run(captureCalendarReadContext());assert.equal(calls.length, 3, 'explicit retry can recover backend availability');
  for (const change of changes) {
    reset();const context = captureCalendarReadContext();change();
    await assert.rejects(operation.run(context), denied);assert.equal(calls.length, 0, 'changed context fails before health or business request');
    reset();healthGate = deferred();const pending = operation.run(captureCalendarReadContext());await flush();change();healthGate.resolve();
    await assert.rejects(pending, denied);assert.equal(calls.length, 1, 'changed context while health waits suppresses business dispatch');
    reset();businessGate = deferred();const dispatched = operation.run(captureCalendarReadContext());await flush();assert.equal(calls.length, 2);
    change();const replacement = [...values];businessGate.resolve();await assert.rejects(dispatched, denied);assert.deepEqual([...values], replacement);
  }
  for (const phase of ['before', 'health', 'dispatched']) {
    reset();let owned = true;const context = captureCalendarReadContext(() => owned);
    if (phase === 'before') {owned = false;await assert.rejects(operation.run(context), denied);assert.equal(calls.length, 0);}
    else {
      const gate = deferred();if (phase === 'health') healthGate = gate;else businessGate = gate;
      const pending = operation.run(context);await flush();owned = false;gate.resolve();await assert.rejects(pending, denied);
      assert.equal(calls.length, phase === 'health' ? 1 : 2, 'retry/selection/unmount lease blocks obsolete reads');
    }
  }
}
for (const change of [{legal_entity_id: 'legal-b'}, {applicability_type: 'unknown'}, {country_code: 'IN'}, {timezone: 'not-a-zone'},
  {working_days: []}, {working_days: [1,1]}, {working_days: [7]}, {working_days: ['1']}, {hours_per_day: 'NaN'}, {hours_per_day: 0}, {hours_per_day: 25}]) {
  reset();businessPayload = [{...calendar,...change}];await assert.rejects(service.getCalendars(captureCalendarReadContext()), invalid);
}
for (const change of [{calendar_id: 'calendar-b'}, {holiday_date: '2026-02-30'}, {holiday_type: 'Unknown'}, {holiday_type: ['Public']}, {holiday_type: ['Company']}, {label: ''}]) {
  reset();businessPayload = [{...holiday,...change}];await assert.rejects(service.getHolidays('calendar-a',captureCalendarReadContext()), invalid);
}
reset();businessPayload = [
  {...calendar,id: 'country',legal_entity_id: null,applicability_type: 'country',country_code: 'IN',country_authority_legal_entity_id: 'legal-other-country-authority'},
  {...calendar,id: 'worker',legal_entity_id: null,applicability_type: 'worker_group',worker_group_id: 'saved-version-row-17',active: false},
];
const applicability = await service.getCalendars(captureCalendarReadContext());
assert.equal(applicability[0].countryAuthorityLegalEntityId, 'legal-other-country-authority', 'country calendar can be shared by same-country legal entities');
assert.equal(applicability[1].workerGroupId, 'saved-version-row-17', 'saved row ID is not replaced by inferred lineage/name');
for (const malformedScope of [null, {}, {organizationId: 'org-a'}, {organizationId: 42,legalEntityId:'legal-a'}, {organizationId:'org-a',legalEntityId:[]}, {organizationId:' ',legalEntityId:'legal-a'}]) {
  reset();set('workos_organization_scope', malformedScope);assert.equal(captureCalendarReadContext(), null);await assert.rejects(service.getCalendars(null), denied);assert.equal(calls.length, 0);
}
reset();const ctx = captureCalendarReadContext();assert(isCalendarReadContextCurrent(ctx));values.set('workos_api_token','replacement');assert.equal(isCalendarReadContextCurrent(ctx),false);
const page = readFileSync(new URL('../src/pages/WorkingCalendarInspector.tsx',import.meta.url),'utf8');
for (const marker of ['200-calendar response limit','200-holiday response limit','Worker-group version-row ID','No calendars returned','No holidays returned','resetBackendCheck','workos:organization-scope-switch-requested']) assert(page.includes(marker));
for (const file of ['../src/App.tsx','../src/components/Layout/Sidebar.tsx','../src/pages/AdminSettings.tsx']) assert(readFileSync(new URL(file,import.meta.url),'utf8').includes('/admin/working-calendars'));
assert(!/\.post\(|\.put\(|\.patch\(|\.delete\(/.test(readFileSync(new URL('../src/services/workingCalendarInspector.ts',import.meta.url),'utf8')), 'service has no business mutation method');
console.log('Production calendar inspector GET contracts, applicability, validation, cap, retry, context/selection ownership and explicit zero business mutations passed.');
