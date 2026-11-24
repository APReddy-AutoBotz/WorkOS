import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';

// Exercise the production service contracts, including nested and duplicate reads.
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const {readForecastUtilization, ForecastUtilizationStatus, ForecastUtilization} = await import('../src/pages/ForecastUtilization.tsx');
const {
  ApiClientError, checkBackend, resetBackendCheck, normalizeEmployee, normalizeProject,
  normalizeAllocation, normalizeTimesheetSummary, normalizeSettings, normalizeUtilizationReport,
} = await import('../src/services/apiClient.ts');
const {getAllocationLoad, getLatestApprovedActualUtilization, getActiveAllocationsForEmployee} = await import('../src/services/calculations.ts');
const sessionValues = new Map();
globalThis.sessionStorage = {
  getItem: key => sessionValues.get(key) ?? null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: key => sessionValues.delete(key),
};
globalThis.localStorage = {getItem: () => { throw new Error('Production forecast utilization must not read local records'); }};
globalThis.window = {location: {pathname: '/utilization/forecast'}};

const privateMessage = '<script>private-forecast-report-diagnostic</script>';
const employeesPath = '/api/employees';
const projectsPath = '/api/projects';
const allocationsPath = '/api/allocations';
const timesheetsPath = '/api/timesheets';
const settingsPath = '/api/settings';
const reportPath = months => `/api/reports/forecast-utilization?months=${months}`;
const baseEmployees = [
  {id: 'worker-synthetic-one', employee_id: 'SYN-1', name: 'Synthetic Worker One', email: 'worker-one@example.invalid', designation: 'Consultant', department: 'Synthetic Engineering', country: 'Synthetic Country', status: 'Active', primary_country_director_id: 'owner-synthetic', utilization_eligible: true, mapped_country_director_ids: ['owner-synthetic'], standard_weekly_hours: '37.5'},
  {id: 'worker-synthetic-two', employee_id: 'SYN-2', name: 'Synthetic Worker Two', email: 'worker-two@example.invalid', designation: 'Consultant', department: 'Synthetic Design', country: 'Synthetic Country', status: 'Active', primary_country_director_id: 'owner-synthetic', utilization_eligible: true, joining_date: '2026-01-01T00:00:00Z'},
];
const baseProjects = [
  {id: 'project-synthetic-one', project_code: 'SYN-P1', name: 'Synthetic Active Project', client: 'Synthetic Client', manager_id: 'manager-synthetic', manager_name: 'Synthetic Manager', start_date: '2020-01-01T00:00:00Z', end_date: '2035-12-31T00:00:00Z', status: 'Active', billable: true},
  {id: 'project-synthetic-two', project_code: 'SYN-P2', name: 'Synthetic Proposed Project', client: 'Synthetic Client', manager_id: 'manager-synthetic', manager_name: 'Synthetic Manager', start_date: '2020-01-01', end_date: '2035-12-31', status: 'Proposed', billable: false},
];
const baseAllocations = [
  {id: 'allocation-synthetic-one', employee_id: 'worker-synthetic-one', project_id: 'project-synthetic-one', percentage: '87.565', start_date: '2020-01-01T00:00:00Z', end_date: '2035-12-31T00:00:00Z', status: 'Active', billable: true, role_on_project: 'Synthetic Delivery'},
  {id: 'allocation-synthetic-two', employee_id: 'worker-synthetic-two', project_id: 'project-synthetic-two', percentage: 61.255, start_date: '2020-01-01', end_date: '2035-12-31', status: 'Active', billable: false},
];
const rawTimesheets = [
  {id: 'sheet-synthetic-one', employee_id: 'worker-synthetic-one', week_ending: '2026-10-16T00:00:00Z', total_hours: '37.565', billable_hours: '30.125', status: 'Approved', entries: []},
  {id: 'sheet-synthetic-two', employee_id: 'worker-synthetic-two', week_ending: '2026-10-09', total_hours: 25, billable_hours: 15.5, status: 'Submitted', entries: []},
];
const rawSettings = [
  {key: 'utilizationThresholdHigh', value: 110}, {key: 'utilizationThresholdLow', value: 75},
  {key: 'benchThreshold', value: 15}, {key: 'expectedWeeklyHours', value: 37.5},
];
let empty = {employees: false, projects: false, allocations: false, report: false};
let omitReportEmployee = false;
let periodOverride = {};
const rawEmployees = () => empty.employees ? [] : baseEmployees;
const rawProjects = () => empty.projects ? [] : baseProjects;
const rawAllocations = () => empty.allocations ? [] : baseAllocations;
const rawReport = months => ({
  mode: 'forecast', asOfDate: ({1:'2026-11-20',2:'2026-12-20',3:'2027-01-20'})[months], sourceDate: '2026-10-20', forecastMonths: months, expectedWeeklyHours: 37.5, ...periodOverride,
  thresholds: {high: 110, low: 75, bench: 15},
  summary: {rows: empty.report ? 0 : omitReportEmployee ? 1 : 2, averagePlanned: 44.44, averageActual: 0, overloaded: 0, underutilized: 1, bench: 1},
  rows: empty.report ? [] : baseEmployees.slice(0, omitReportEmployee ? 1 : 2).map((employee, index) => ({...employee,
    planned_utilization: index ? 88.885 : 0, actual_utilization: index ? 46.755 : 80.255, active_project_count: index ? 1 : 3,
  })),
});
const expectedRequests = months => [
  {path: employeesPath, occurrence: 1},
  {path: allocationsPath, occurrence: 1},
  {path: projectsPath, occurrence: 1},
  {path: timesheetsPath, occurrence: 1},
  {path: settingsPath, occurrence: 1},
  {path: projectsPath, occurrence: 2},
  {path: allocationsPath, occurrence: 2},
  {path: projectsPath, occurrence: 3},
  {path: settingsPath, occurrence: 2},
  {path: reportPath(months), occurrence: 1},
];
const calls = [];
let occurrences = new Map();
let health = 'offline';
let healthNetworkFailure = false;
let healthStatus = 200;
let failureTarget = null;
let failureStatus = null;
let networkFailure = false;
let gateTarget = null;
let gate = null;
const sameTarget = (left, right) => left?.path === right?.path && left?.occurrence === right?.occurrence;
globalThis.fetch = async (url, init = {}) => {
  if (url === '/api/health') {
    calls.push({url, init});
    occurrences = new Map();
    if (healthNetworkFailure) throw new TypeError(privateMessage);
    return new Response(JSON.stringify({database: health}), {status: healthStatus});
  }
  const occurrence = (occurrences.get(url) || 0) + 1;
  occurrences.set(url, occurrence);
  const target = {path: url, occurrence};
  calls.push({url, init, occurrence});
  const parsed = new URL(url, 'https://synthetic.example.invalid');
  const months = Number(parsed.searchParams.get('months'));
  assert(expectedRequests(months).some(request => sameTarget(request, target)), `Unexpected production reader: ${url} #${occurrence}`);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include');
  if (parsed.pathname === '/api/reports/forecast-utilization') {
    assert([1, 2, 3].includes(months));
    assert.deepEqual([...parsed.searchParams.keys()], ['months'], 'preserve the existing selected-horizon query without date/as-of parameters');
  }
  if (sameTarget(target, failureTarget)) {
    if (networkFailure) throw new TypeError(privateMessage);
    return new Response(JSON.stringify({error: {message: privateMessage, code: 'SYNTHETIC_PRIVATE_FAILURE'}}), {status: failureStatus});
  }
  if (sameTarget(target, gateTarget) && gate) await gate;
  const payload = url === employeesPath ? rawEmployees() : url === projectsPath ? rawProjects()
    : url === allocationsPath ? rawAllocations() : url === timesheetsPath ? rawTimesheets
      : url === settingsPath ? rawSettings : rawReport(months);
  return new Response(JSON.stringify(payload), {status: 200});
};
const assertAllReaders = (start, months = 3) => {
  const actual = calls.slice(start).filter(call => call.url !== '/api/health').map(call => `${call.url}#${call.occurrence}`).sort();
  assert.deepEqual(actual, expectedRequests(months).map(call => `${call.path}#${call.occurrence}`).sort(), 'each coordinated load reruns all ten business calls through the five unchanged readers');
  assert.equal(new Set(calls.slice(start).filter(call => call.url !== '/api/health').map(call => call.url)).size, 6, 'six distinct business endpoints retain their duplicate and nested calls');
  assert.equal(calls.slice(start).filter(call => call.url === '/api/health').length, 1, 'each load resets and shares one cached health check');
};
const assertParity = (snapshot, months = 3) => {
  const projects = rawProjects().map(normalizeProject);
  const allocations = rawAllocations().map(raw => normalizeAllocation(raw, new Map(projects.map(project => [project.id, project]))));
  const settings = normalizeSettings(rawSettings);
  const timesheets = rawTimesheets.map(raw => normalizeTimesheetSummary(raw, new Map()));
  const today = new Date().toISOString().split('T')[0];
  const employees = rawEmployees().map(normalizeEmployee).map(employee => ({...employee,
    plannedUtilization: getAllocationLoad(employee.id, allocations, projects, today, today),
    actualUtilization: getLatestApprovedActualUtilization(employee.id, timesheets, settings),
    activeProjectCount: getActiveAllocationsForEmployee(employee.id, allocations, projects, today, today).length,
  }));
  assert.deepEqual(snapshot.employees, employees, 'employee enrichment retains the existing normalizers, nested evidence and calculations');
  assert.deepEqual(snapshot.projects, projects, 'project normalizer, dates and ordering are unchanged');
  assert.deepEqual(snapshot.allocations, allocations, 'allocation normalizer, project labels, decimals and dates are unchanged');
  assert.deepEqual(snapshot.settings, settings, 'settings retain existing thresholds and defaults');
  assert.equal(snapshot.sourceDate,rawReport(months).sourceDate);
  assert.equal(snapshot.horizonDate,rawReport(months).asOfDate);
  assert.deepEqual(snapshot.forecastReportEmployees, normalizeUtilizationReport(rawReport(months)).rows, 'authoritative report values and row ordering retain existing normalization');
};

resetBackendCheck();
await assert.rejects(checkBackend(), /Backend API is required/);
health = 'connected';
let start = calls.length;
assertParity(await readForecastUtilization(3));


assertAllReaders(start);
assert.equal(calls.filter(call => call.url === '/api/health').length, 2, 'coordinated retry recovers a previously cached failed availability check');
for (const months of [1, 2, 3]) {
  start = calls.length;
  assertParity(await readForecastUtilization(months), months);
  assertAllReaders(start, months);
}

// Fail every individual request, including the second/third calls to shared paths.
for (const invalid of [{sourceDate:'2026-02-30'},{asOfDate:'2027-01-21'},{forecastMonths:1},{mode:'planned'}]) {
  periodOverride=invalid;
  await assert.rejects(readForecastUtilization(3), TypeError);
}
periodOverride={};

for (const target of expectedRequests(3)) {
  failureTarget = target;
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]) {
    failureStatus = status;
    start = calls.length;
    await assert.rejects(readForecastUtilization(3), error => error instanceof ApiClientError && error.status === status, `${target.path} #${target.occurrence} ${status} rejects the entire snapshot`);
    assertAllReaders(start);
  }
  networkFailure = true;
  start = calls.length;
  await assert.rejects(readForecastUtilization(3), TypeError, `${target.path} #${target.occurrence} network failure rejects the entire snapshot`);
  assertAllReaders(start);
  networkFailure = false;
  failureTarget = null;
  start = calls.length;
  assertParity(await readForecastUtilization(3));
  assertAllReaders(start);
}
failureStatus = null;

for (const target of expectedRequests(3)) {
  let release;
  gateTarget = target;
  gate = new Promise(resolve => { release = resolve; });
  let completed = false;
  start = calls.length;
  const pendingSnapshot = readForecastUtilization(3).then(snapshot => { completed = true; return snapshot; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, `${target.path} #${target.occurrence} must complete before publishing the combined snapshot`);
  assertAllReaders(start);
  release();
  assertParity(await pendingSnapshot);
  gate = null;
  gateTarget = null;
}

for (const status of [401, 403, 404, 500, 502, 503, 504]) {
  healthStatus = status;
  health = 'offline';
  start = calls.length;
  await assert.rejects(readForecastUtilization(3), /Backend API is required/);
  assert.deepEqual(calls.slice(start).map(call => call.url), ['/api/health'], 'unavailable health cannot issue business reads or use local records');
}
healthStatus = 200;
healthNetworkFailure = true;
start = calls.length;
await assert.rejects(readForecastUtilization(3), /Backend API is required/);
assert.deepEqual(calls.slice(start).map(call => call.url), ['/api/health']);
healthNetworkFailure = false;
health = 'connected';
start = calls.length;
assertParity(await readForecastUtilization(3));
assertAllReaders(start);

// Every combination of successful empty/mixed collections remains a complete success.
const collections = ['employees', 'projects', 'allocations', 'report'];
for (let mask = 0; mask < 16; mask += 1) {
  empty = Object.fromEntries(collections.map((collection, index) => [collection, Boolean(mask & (1 << index))]));
  start = calls.length;
  const snapshot = await readForecastUtilization(3);
  assertParity(snapshot);
  assertAllReaders(start);
  for (const collection of collections) {
    const values = collection === 'report' ? snapshot.forecastReportEmployees : snapshot[collection];
    assert.equal(values.length, empty[collection] ? 0 : 2, `${collection} empty does not erase independent returned collections`);
  }
}
empty = {employees: false, projects: false, allocations: false, report: false};
omitReportEmployee = true;
const omittedEmployee = await readForecastUtilization(3);
assertParity(omittedEmployee);
assert.equal(omittedEmployee.employees.length, 2);
assert.equal(omittedEmployee.forecastReportEmployees.length, 1, 'a successful report may omit an employee without being a failure');
assert.equal(omittedEmployee.forecastReportEmployees[0].plannedUtilization, 0, 'an authoritative report zero remains zero');
omitReportEmployee = false;
assertParity(await readForecastUtilization(3));
assert(calls.every(call => call.init.method === undefined || call.init.method === 'GET'), 'read recovery performs no writes, exports, history or audit');

const messages = {
  loading: 'Loading forecast utilization…',
  access: 'Access to forecast utilization could not be confirmed.',
  unavailable: 'Forecast utilization is unavailable.',
  error: 'Forecast utilization could not be loaded.',
};
const unsupportedClaims = [privateMessage, 'No forecast utilization data was returned.', 'No resource forecasts were returned for this horizon.', 'No resource forecasts match the selected filters.', 'No capacity and demand checkpoints were returned for this horizon.', 'No demand', 'No roll-offs inside this horizon', 'No future bench cases in this horizon', 'No immediate hiring trigger', '0%'];
for (const status of ['loading', 'access', 'unavailable', 'error', 'ready']) {
  const html = renderToStaticMarkup(createElement(ForecastUtilizationStatus, {status, retry: () => {}}));
  for (const claim of unsupportedClaims) assert(!html.includes(claim));
  if (status === 'ready') assert.equal(html, '');
  else {
    assert(html.includes(messages[status]));
    assert(html.includes(status === 'loading' ? 'role="status"' : 'role="alert"'));
    if (status !== 'loading') {
      assert(html.includes('Retry forecast utilization'));
      assert(html.includes(status === 'access' ? 'Check your sign-in and report access, then retry.' : 'Check your connection and retry. If the problem continues, contact your administrator.'));
      assert(html.includes('type="button"'));
      assert(html.includes('focus-visible:'));
    }
  }
}
const beforeInitialRender = calls.length;
const initialMarkup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ForecastUtilization)));
assert(initialMarkup.includes('Loading forecast utilization…'));
assert(initialMarkup.includes('aria-label="Refresh forecast utilization"'));
for (const label of ['1 Month', '2 Months', '3 Months']) assert(initialMarkup.includes(`>${label}</button>`));
assert.match(initialMarkup, /aria-pressed="true"[^>]*>3 Months<\/button>/);
assert.match(initialMarkup, /<button[^>]*disabled=""[^>]*>[\s\S]*?Forecast Report<\/button>/);
assert.match(initialMarkup, /<button[^>]*disabled=""[^>]*>[\s\S]*?Forecast<\/button>/);
assert.equal((initialMarkup.match(/disabled=""/g) || []).length, 2, 'both existing export controls fail closed on initial markup');
for (const claim of [...unsupportedClaims, 'Projected Avg. Util.', 'Capacity vs Demand Horizon', 'Horizon Risk Analysis', 'Resource Forecast Ledger']) assert(!initialMarkup.includes(claim));
assert.equal(calls.length, beforeInitialRender, 'initial render does not launch reads or export/audit side effects');

console.log('Forecast utilization production-reader failures for all ten nested/duplicate business calls across six endpoints, all horizons, health recovery, atomic completion, all mixed-empty combinations, zero/omitted report rows, normalizer parity, GET-only calls and safe announced initial/status markup checks passed.');
