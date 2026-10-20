import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';

// Exercise the existing production readers, including the nested timesheet employee read.
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const {readActualUtilization, ActualUtilizationStatus, ActualUtilization} = await import('../src/pages/ActualUtilization.tsx');
const {
  ApiClientError, checkBackend, resetBackendCheck, normalizeUtilizationReport,
  normalizeEmployee, normalizeTimesheetSummary, normalizeSettings,
} = await import('../src/services/apiClient.ts');
const sessionValues = new Map();
globalThis.sessionStorage = {
  getItem: key => sessionValues.get(key) ?? null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: key => sessionValues.delete(key),
};
globalThis.localStorage = {getItem: () => { throw new Error('Production actual utilization must not read local records'); }};
globalThis.window = {location: {pathname: '/utilization/actual'}};

const paths = ['/api/reports/actual-utilization', '/api/timesheets', '/api/employees', '/api/settings'];
const privateMessage = '<script>private-actual-report-diagnostic</script>';
const rawEmployees = [
  {id: 'worker-synthetic-one', employee_id: 'SYN-1', name: 'Synthetic Worker One', department: 'Synthetic Engineering', country: 'Synthetic Country', status: 'Active', primary_country_director_id: 'owner-synthetic', utilization_eligible: true},
  {id: 'worker-synthetic-two', employee_id: 'SYN-2', name: 'Synthetic Worker Two', department: 'Synthetic Design', country: 'Synthetic Country', status: 'Active', primary_country_director_id: 'owner-synthetic', utilization_eligible: true},
];
const settings = [
  {key: 'utilizationThresholdHigh', value: 110},
  {key: 'utilizationThresholdLow', value: 75},
  {key: 'benchThreshold', value: 15},
  {key: 'expectedWeeklyHours', value: 37.5},
];
let emptyReport = false;
let emptyTimesheets = false;
const rawReport = () => ({
  mode: 'actual', asOfDate: '2026-10-20', sourceDate: '2026-10-20', forecastMonths: null, expectedWeeklyHours: 37.5,
  thresholds: {high: 110, low: 75, bench: 15},
  summary: {rows: emptyReport ? 0 : 2, averagePlanned: emptyReport ? 0 : 96.5, averageActual: emptyReport ? 0 : 63.5, overloaded: emptyReport ? 0 : 1, underutilized: emptyReport ? 0 : 1, bench: 0},
  rows: emptyReport ? [] : rawEmployees.map((employee, index) => ({...employee,
    planned_utilization: index ? 71.25 : 121.75, actual_utilization: index ? 46.75 : 80.25, active_project_count: index ? 1 : 3,
  })),
});
const rawTimesheets = () => emptyTimesheets ? [] : [
  {id: 'sheet-synthetic-one', employee_id: 'worker-synthetic-one', week_ending: '2026-10-16T00:00:00Z', total_hours: '37.565', billable_hours: '30.125', status: 'Approved', submitted_at: '2026-10-16T17:00:00Z', approved_at: '2026-10-19T09:00:00Z', approved_by: 'owner-synthetic', entries: [
    {id: 'entry-synthetic-one', project_id: 'project-synthetic', project_name: 'Synthetic Project', work_type: 'Client', category: 'Delivery', work_date: '2026-10-16T00:00:00Z', hours: '30.125', remark: 'Synthetic delivery evidence', billable: true},
  ]},
  {id: 'sheet-synthetic-two', employee_id: 'worker-synthetic-two', week_ending: '2026-10-09', total_hours: 25, billable_hours: 15.5, status: 'Submitted', submitted_at: '2026-10-09T17:00:00Z', entries: []},
  {id: 'sheet-synthetic-three', employee_id: 'worker-synthetic-one', week_ending: '2026-09-25', total_hours: 40, billable_hours: 28.75, status: 'Rejected', submitted_at: '2026-09-25T17:00:00Z', rejected_at: '2026-09-28T09:00:00Z', rejected_by: 'owner-synthetic', rejection_reason: 'Synthetic correction required', entries: []},
  {id: 'sheet-synthetic-four', employee_id: 'worker-synthetic-two', week_ending: '2026-09-18', total_hours: 10, billable_hours: 7.25, status: 'Draft', entries: []},
];
const employeeMap = () => new Map(rawEmployees.map(raw => [String(raw.id), normalizeEmployee(raw)]));
const calls = [];
let health = 'offline';
let healthNetworkFailure = false;
let failedPath = null;
let failureStatus = null;
let networkFailure = false;
let gatePath = null;
let gate = null;
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init});
  if (url === '/api/health') {
    if (healthNetworkFailure) throw new TypeError(privateMessage);
    return new Response(JSON.stringify({database: health}), {status: 200});
  }
  assert(paths.includes(url), `Unexpected production reader: ${url}`);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include');
  if (url === failedPath) {
    if (networkFailure) throw new TypeError(privateMessage);
    return new Response(JSON.stringify({error: {message: privateMessage, code: 'SYNTHETIC_PRIVATE_FAILURE'}}), {status: failureStatus});
  }
  if (url === gatePath && gate) await gate;
  const payload = url === paths[0] ? rawReport() : url === paths[1] ? rawTimesheets() : url === paths[2] ? rawEmployees : settings;
  return new Response(JSON.stringify(payload), {status: 200});
};
const assertAllReaders = start => {
  assert.deepEqual(calls.slice(start).filter(call => call.url !== '/api/health').map(call => call.url).sort(), [...paths].sort(), 'every load retries all four business requests through the three existing readers');
  assert.equal(calls.slice(start).filter(call => call.url === '/api/health').length, 1, 'each load refreshes the cached availability check');
};
const assertParity = snapshot => {
  assert.deepEqual(snapshot.employees, normalizeUtilizationReport(rawReport()).rows, 'successful report figures, eligibility and row ordering retain existing normalization');
  assert.deepEqual(snapshot.timesheets, rawTimesheets().map(raw => normalizeTimesheetSummary(raw, employeeMap())), 'hours, entries, dates, statuses, names and row ordering retain the existing timesheet reader');
  assert.deepEqual(snapshot.settings, normalizeSettings(settings), 'the existing settings reader retains the denominator and thresholds');
};

resetBackendCheck();
await assert.rejects(checkBackend(), /Backend API is required/);
health = 'connected';
let start = calls.length;
assertParity(await readActualUtilization());
assertAllReaders(start);
assert.equal(calls.filter(call => call.url === '/api/health').length, 2, 'retry recovers a previously cached failed health check');

for (const path of paths) {
  failedPath = path;
  for (const status of [401, 403, 404, 500, 502, 503, 504]) {
    failureStatus = status;
    start = calls.length;
    await assert.rejects(readActualUtilization(), error => error instanceof ApiClientError && error.status === status, `${path} ${status} rejects the entire snapshot`);
    assertAllReaders(start);
  }
  networkFailure = true;
  start = calls.length;
  await assert.rejects(readActualUtilization(), TypeError, `${path} network failure rejects the entire snapshot`);
  assertAllReaders(start);
  networkFailure = false;
  failedPath = null;
  start = calls.length;
  assertParity(await readActualUtilization());
  assertAllReaders(start);
}
failureStatus = null;

// A success from any subset of the four endpoints cannot resolve a combined snapshot.
for (const path of paths) {
  let release;
  gatePath = path;
  gate = new Promise(resolve => { release = resolve; });
  let completed = false;
  start = calls.length;
  const pendingSnapshot = readActualUtilization().then(snapshot => { completed = true; return snapshot; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, `${path} completion is required before publishing the snapshot`);
  assertAllReaders(start);
  release();
  assertParity(await pendingSnapshot);
  gate = null;
  gatePath = null;
}

healthNetworkFailure = true;
start = calls.length;
await assert.rejects(readActualUtilization(), /Backend API is required/);
assert.deepEqual(calls.slice(start).map(call => call.url), ['/api/health'], 'failed health cannot fall back to local records or issue business requests');
healthNetworkFailure = false;
start = calls.length;
assertParity(await readActualUtilization());
assertAllReaders(start);

emptyReport = true;
start = calls.length;
const logsWithoutReportEmployees = await readActualUtilization();
assert.deepEqual(logsWithoutReportEmployees.employees, []);
assert.equal(logsWithoutReportEmployees.timesheets.length, 4, 'a successful empty report must preserve independently returned timesheet logs');
assertParity(logsWithoutReportEmployees);
assertAllReaders(start);
emptyTimesheets = true;
start = calls.length;
const genuineEmpty = await readActualUtilization();
assert.deepEqual(genuineEmpty.employees, []);
assert.deepEqual(genuineEmpty.timesheets, [], 'genuine successful composite empty remains empty');
assertParity(genuineEmpty);
assertAllReaders(start);
emptyReport = false;
const employeesWithoutTimesheets = await readActualUtilization();
assert.equal(employeesWithoutTimesheets.employees.length, 2);
assert.deepEqual(employeesWithoutTimesheets.timesheets, [], 'successful missing logs retain the report employees');
assertParity(employeesWithoutTimesheets);
emptyTimesheets = false;
assertParity(await readActualUtilization());
assert(calls.every(call => call.init.method === undefined || call.init.method === 'GET'), 'report reads perform no writes, export history or audit');

const messages = {
  loading: 'Loading actual utilization…',
  access: 'Access to actual utilization could not be confirmed.',
  unavailable: 'Actual utilization is unavailable.',
  error: 'Actual utilization could not be loaded.',
};
const unsupportedClaims = [privateMessage, 'No actual utilization data was returned.', 'No weekly utilization logs available', 'No approved variance data yet', 'No service delivery logs recorded', 'No service delivery logs match the selected filters.', 'Approval Health', 'Most submitted effort has been vetted', '0%'];
for (const status of ['loading', 'access', 'unavailable', 'error', 'ready']) {
  const html = renderToStaticMarkup(createElement(ActualUtilizationStatus, {status, retry: () => {}}));
  for (const claim of unsupportedClaims) assert(!html.includes(claim));
  if (status === 'ready') assert.equal(html, '');
  else {
    assert(html.includes(messages[status]));
    assert(html.includes(status === 'loading' ? 'role="status"' : 'role="alert"'));
    if (status !== 'loading') {
      assert(html.includes('Retry actual utilization'));
      assert(html.includes(status === 'access' ? 'Check your sign-in and report access, then retry.' : 'Check your connection and retry. If the problem continues, contact your administrator.'));
      assert(html.includes('type="button"'));
      assert(html.includes('focus-visible:'));
    }
  }
}
const beforeInitialRender = calls.length;
const initialMarkup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ActualUtilization)));
assert(initialMarkup.includes('Loading actual utilization…'));
assert(initialMarkup.includes('aria-label="Refresh actual utilization"'));
assert.match(initialMarkup, /<button[^>]*disabled=""[^>]*>[\s\S]*?Global Report<\/button>/);
for (const claim of [...unsupportedClaims, 'Avg. Actual Util.', 'Actual vs Planned Reconciliation', 'Service Delivery Logs', 'Audit Trail']) assert(!initialMarkup.includes(claim));
assert.equal(calls.length, beforeInitialRender, 'initial render does not launch reads or export/audit side effects');

console.log('Actual utilization production-reader failures for all four dependencies, cached-health recovery, atomic completion, composite and mixed empty, successful normalization parity, GET-only calls and safe announced status checks passed.');
