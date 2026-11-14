import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
// Exercise the real production service path, never the test/demo fallback.
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const {readUtilizationOverview, UtilizationOverviewStatus} = await import('../src/pages/UtilizationReports.tsx');
const {ApiClientError, checkBackend, resetBackendCheck, normalizeUtilizationReport} = await import('../src/services/apiClient.ts');
const values = new Map();
globalThis.sessionStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
globalThis.localStorage = {getItem: () => { throw new Error('Production overview must not read local records'); }};
globalThis.window = {location: {pathname: '/reports/utilization'}};
let health = 'offline';
let failure = 0;
let network = false;
let empty = false;
const calls = [];
const privateMessage = '<script>private-report-internals</script>';
const raw = mode => ({mode, asOfDate: '2026-10-20', sourceDate: '2026-10-20', forecastMonths: mode === 'forecast' ? 3 : null, expectedWeeklyHours: 40,
  thresholds: {high: 100, low: 80, bench: 20},
  summary: {rows: empty ? 0 : 1, averagePlanned: empty ? 0 : 78.9, averageActual: empty ? 0 : 43.2, overloaded: 0, underutilized: empty ? 0 : 1, bench: 0},
  rows: empty ? [] : [{id: 'synthetic-worker', employee_id: 'SYN-1', name: 'Synthetic Worker', department: 'Synthetic', planned_utilization: 78.9, actual_utilization: 43.2}],
});
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init});
  if (url === '/api/health') return new Response(JSON.stringify({database: health}), {status: 200});
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include');
  assert(['/api/reports/planned-utilization', '/api/reports/actual-utilization', '/api/reports/forecast-utilization?months=3'].includes(url));
  if (network) throw new TypeError(privateMessage);
  const mode = url.includes('planned') ? 'planned' : url.includes('actual') ? 'actual' : 'forecast';
  return new Response(JSON.stringify(failure ? {error: privateMessage} : raw(mode)), {status: failure || 200});
};
resetBackendCheck();
await assert.rejects(checkBackend(), /Backend API is required/);
health = 'connected';
const recovered = await readUtilizationOverview();
assert.equal(calls.filter(call => call.url === '/api/health').length, 2, 'overview retry must refresh cached failed health');
for (const mode of ['planned', 'actual', 'forecast']) assert.deepEqual(recovered[mode], normalizeUtilizationReport(raw(mode)), 'successful reports retain existing normalization and figures');
for (const status of [401, 403, 404, 500, 503]) {
  failure = status;
  await assert.rejects(readUtilizationOverview(), error => error instanceof ApiClientError && error.status === status);
}
failure = 0;
network = true;
await assert.rejects(readUtilizationOverview(), TypeError);
network = false;
empty = true;
for (const report of Object.values(await readUtilizationOverview())) {
  assert.deepEqual(report.rows, []);
  assert.equal(report.summary.rows, 0);
}
assert(calls.every(call => call.init.method === undefined || call.init.method === 'GET'));
for (const status of ['loading', 'access', 'unavailable', 'error', 'ready']) {
  const html = renderToStaticMarkup(createElement(UtilizationOverviewStatus, {status, retry: () => {}}));
  assert(!html.includes(privateMessage));
  assert(!html.includes('No exceptions'));
  assert(!html.includes('Population'));
  assert(!html.includes('0%'));
  if (status === 'loading') assert(html.includes('role="status"') && html.includes('Loading utilization reports…'));
  else if (status === 'ready') assert.equal(html, '');
  else assert(html.includes('role="alert"') && html.includes('Retry utilization reports'));
}
console.log('Utilization overview real-service failure propagation, cached-health retry, genuine empty, unchanged figures, read-only calls and safe status checks passed.');
