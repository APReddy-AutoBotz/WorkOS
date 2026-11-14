import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';

// Exercise the actual production readers with browser-local fallback forbidden.
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const {readPlannedUtilization, PlannedUtilizationStatus, PlannedUtilization} = await import('../src/pages/PlannedUtilization.tsx');
const {ApiClientError, checkBackend, resetBackendCheck, normalizeUtilizationReport, normalizeCountryDirector, normalizeSettings} = await import('../src/services/apiClient.ts');
const sessionValues = new Map();
globalThis.sessionStorage = {
  getItem: key => sessionValues.get(key) ?? null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: key => sessionValues.delete(key),
};
globalThis.localStorage = {getItem: () => { throw new Error('Production planned utilization must not read local records'); }};
globalThis.window = {location: {pathname: '/utilization/planned'}};

const paths = ['/api/reports/planned-utilization', '/api/country-directors', '/api/settings'];
const privateMessage = '<script>private-planned-report-diagnostic</script>';
const directors = [{id: 'owner-synthetic', name: 'Synthetic Owner', region: 'Synthetic Region'}];
const settings = [
  {key: 'utilizationThresholdHigh', value: 110},
  {key: 'utilizationThresholdLow', value: 75},
  {key: 'benchThreshold', value: 15},
  {key: 'expectedWeeklyHours', value: 37.5},
];
let empty = false;
const rawReport = () => ({
  mode: 'planned', asOfDate: '2026-10-20', sourceDate: '2026-10-20', forecastMonths: null, expectedWeeklyHours: 37.5,
  thresholds: {high: 110, low: 75, bench: 15},
  summary: {rows: empty ? 0 : 2, averagePlanned: empty ? 0 : 96.5, averageActual: empty ? 0 : 63.5, overloaded: empty ? 0 : 1, underutilized: empty ? 0 : 1, bench: 0},
  rows: empty ? [] : [
    {id: 'worker-synthetic-one', employee_id: 'SYN-1', name: 'Synthetic Worker One', department: 'Synthetic Engineering', country: 'Synthetic Country', status: 'Active', primary_country_director_id: 'owner-synthetic', mapped_country_director_ids: ['owner-synthetic'], planned_utilization: 121.75, actual_utilization: 80.25, active_project_count: 3, utilization_eligible: true},
    {id: 'worker-synthetic-two', employee_id: 'SYN-2', name: 'Synthetic Worker Two', department: 'Synthetic Design', country: 'Synthetic Country', status: 'Active', primary_country_director_id: 'owner-synthetic', planned_utilization: 71.25, actual_utilization: 46.75, active_project_count: 1, utilization_eligible: true},
  ],
});
const calls = [];
let health = 'offline';
let failedPath = null;
let failureStatus = null;
let networkFailure = false;
let settingsGate = null;
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init});
  if (url === '/api/health') return new Response(JSON.stringify({database: health}), {status: 200});
  assert(paths.includes(url), `Unexpected production reader: ${url}`);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include');
  if (url === failedPath) {
    if (networkFailure) throw new TypeError(privateMessage);
    return new Response(JSON.stringify({error: {message: privateMessage, code: 'SYNTHETIC_PRIVATE_FAILURE'}}), {status: failureStatus});
  }
  if (url === '/api/settings' && settingsGate) await settingsGate;
  const payload = url === paths[0] ? rawReport() : url === paths[1] ? directors : settings;
  return new Response(JSON.stringify(payload), {status: 200});
};
const assertAllReaders = start => {
  assert.deepEqual(calls.slice(start).filter(call => call.url !== '/api/health').map(call => call.url).sort(), [...paths].sort(), 'every load must retry all three existing readers');
  assert.equal(calls.slice(start).filter(call => call.url === '/api/health').length, 1, 'each load must refresh the availability check');
};
const assertParity = snapshot => {
  assert.deepEqual(snapshot.employees, normalizeUtilizationReport(rawReport()).rows, 'all successful figures and row ordering must retain the existing normalization');
  assert.deepEqual(snapshot.directors, directors.map(normalizeCountryDirector));
  assert.deepEqual(snapshot.settings, normalizeSettings(settings), 'settings thresholds remain from the existing reader');
};

resetBackendCheck();
await assert.rejects(checkBackend(), /Backend API is required/);
health = 'connected';
let start = calls.length;
const recovered = await readPlannedUtilization();
assertParity(recovered);
assertAllReaders(start);
assert.equal(calls.filter(call => call.url === '/api/health').length, 2, 'retry must recover a previously cached failed health check');

for (const path of paths) {
  failedPath = path;
  for (const status of [401, 403, 404, 500, 502, 503, 504]) {
    failureStatus = status;
    start = calls.length;
    await assert.rejects(readPlannedUtilization(), error => error instanceof ApiClientError && error.status === status, `${path} ${status} must reject the whole snapshot`);
    assertAllReaders(start);
  }
  networkFailure = true;
  start = calls.length;
  await assert.rejects(readPlannedUtilization(), TypeError, `${path} network failure must reject the whole snapshot`);
  assertAllReaders(start);
  networkFailure = false;
}
failedPath = null;
failureStatus = null;

let releaseSettings;
settingsGate = new Promise(resolve => { releaseSettings = resolve; });
let completed = false;
const pendingSnapshot = readPlannedUtilization().then(snapshot => { completed = true; return snapshot; });
// Other real readers can succeed, but a combined snapshot remains unpublished.
await new Promise(resolve => setImmediate(resolve));
assert.equal(completed, false, 'settings completion is required before resolving the snapshot');
releaseSettings();
assertParity(await pendingSnapshot);
settingsGate = null;

empty = true;
start = calls.length;
const emptySnapshot = await readPlannedUtilization();
assert.deepEqual(emptySnapshot.employees, [], 'a genuine successful empty report remains empty');
assert.deepEqual(emptySnapshot.directors, directors.map(normalizeCountryDirector));
assertAllReaders(start);
empty = false;
assertParity(await readPlannedUtilization());
assert(calls.every(call => call.init.method === undefined || call.init.method === 'GET'), 'report reads must perform no writes or export audit');

const messages = {
  loading: 'Loading planned utilization…',
  access: 'Access to planned utilization could not be confirmed.',
  unavailable: 'Planned utilization is unavailable.',
  error: 'Planned utilization could not be loaded.',
};
for (const status of ['loading', 'access', 'unavailable', 'error', 'ready']) {
  const html = renderToStaticMarkup(createElement(PlannedUtilizationStatus, {status, retry: () => {}}));
  for (const unsupportedClaim of [privateMessage, 'No critical overload', 'No resources match defined criteria', '0%']) assert(!html.includes(unsupportedClaim));
  if (status === 'ready') assert.equal(html, '');
  else {
    assert(html.includes(messages[status]));
    assert(html.includes(status === 'loading' ? 'role="status"' : 'role="alert"'));
    if (status !== 'loading') {
      assert(html.includes('Retry planned utilization'));
      assert(html.includes(status === 'access' ? 'Check your sign-in and report access, then retry.' : 'Check your connection and retry. If the problem continues, contact your administrator.'));
      assert(html.includes('type="button"'));
      assert(html.includes('focus-visible:'));
    }
  }
}
const initialMarkup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlannedUtilization)));
assert(initialMarkup.includes('Loading planned utilization…'));
assert(initialMarkup.includes('aria-label="Refresh planned utilization"'));
assert.match(initialMarkup, /<button[^>]*disabled=""[^>]*>[\s\S]*?Export Plan<\/button>/);
for (const unsupportedClaim of ['No critical overload', 'No resources match defined criteria', 'No planned utilization data was returned.', 'Avg. Planned Util.', 'Resource Planning Drill-down']) assert(!initialMarkup.includes(unsupportedClaim));

console.log('Planned utilization production-reader failures for each dependency, cached-health recovery, atomic completion, genuine empty, successful parity, GET-only calls and safe announced status checks passed.');
