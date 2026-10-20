import assert from 'node:assert/strict';
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}, acceptDownloads: true});
page.setDefaultTimeout(10000);
const pageErrors = [];
const unexpectedApi = [];
const unexpectedRemote = [];
const downloads = [];
let deliberateExports = 0;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('download', download => downloads.push(download));
page.on('request', request => {
  if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) unexpectedRemote.push(request.url());
});
await page.route('**/api/**', route => {
  unexpectedApi.push({method: route.request().method(), url: route.request().url()});
  return route.abort();
});

const readers = ['actual', 'timesheets', 'settings'];
const loadingText = 'Loading actual utilization…';
const emptyText = 'No actual utilization data was returned.';
const filteredEmptyText = 'No service delivery logs match the selected filters.';
const noLogsText = 'No service delivery logs recorded';
const noWeeksText = 'No weekly utilization logs available';
const noVarianceText = 'No approved variance data yet';
const genericError = 'Actual utilization could not be loaded.';
const accessError = 'Access to actual utilization could not be confirmed.';
const unavailableError = 'Actual utilization is unavailable.';
const settings = {utilizationThresholdHigh: 100, utilizationThresholdLow: 80, benchThreshold: 20, expectedWeeklyHours: 40};
const employee = (tag, suffix, plannedUtilization, overrides = {}) => ({
  id: `${tag}-${suffix}`, employeeId: `SYN-${tag}-${suffix}`, name: `Synthetic ${tag}-${suffix}`,
  email: `${tag}-${suffix}@example.invalid`, designation: 'Synthetic Specialist', department: 'Synthetic Delivery',
  country: 'Synthetic Country', primaryCountryDirectorId: 'synthetic-director', mappedCountryDirectorIds: [],
  status: 'Active', plannedUtilization, actualUtilization: 17, activeProjectCount: 2, ...overrides,
});
const employees = (tag = 'baseline') => [
  employee(tag, 'alpha', 80), employee(tag, 'beta', 90), employee(tag, 'gamma', 75),
  employee(tag, 'delta', 65), employee(tag, 'epsilon', 110), employee(tag, 'zeta', 70),
  employee(tag, 'submitted', 95), employee(tag, 'missing', 60),
  employee(tag, 'inactive', 999, {status: 'Inactive'}),
  employee(tag, 'excluded', 999, {utilizationEligible: false}),
];
const log = (tag, suffix, weekEnding, status, billableHours, totalHours = 40) => ({
  id: `log-${tag}-${suffix}-${weekEnding}-${status}`, employeeId: `${tag}-${suffix}`,
  employeeName: `Synthetic ${tag}-${suffix}`, weekEnding, status, billableHours, totalHours,
  submittedAt: status === 'Draft' ? undefined : `${weekEnding}T09:00:00Z`,
  approvedAt: status === 'Approved' ? `${weekEnding}T12:00:00Z` : undefined,
  rejectedAt: status === 'Rejected' ? `${weekEnding}T13:00:00Z` : undefined,
  rejectionReason: status === 'Rejected' ? '=synthetic-formula, "quoted"' : undefined,
  entries: [{id: `entry-${tag}-${suffix}`, date: weekEnding, projectId: 'synthetic-project',
    projectName: 'Synthetic Project', hours: totalHours, billable: true, notes: 'Synthetic "quoted", detail\nnext line'}],
});
const logs = (tag = 'baseline') => [
  log(tag, 'alpha', '2024-04-26', 'Approved', 48, 48.25),
  log(tag, 'beta', '2024-04-26', 'Approved', 20),
  log(tag, 'gamma', '2024-04-26', 'Approved', 35, 39.5),
  log(tag, 'delta', '2024-04-26', 'Approved', 24),
  log(tag, 'epsilon', '2024-04-26', 'Approved', 40),
  log(tag, 'zeta', '2024-04-26', 'Approved', 20),
  log(tag, 'submitted', '2024-04-26', 'Submitted', 19, 23.75),
  log(tag, 'beta', '2024-04-26', 'Rejected', 30),
  log(tag, 'gamma', '2024-04-26', 'Draft', 32),
  ...['2024-03-29', '2024-03-22', '2024-03-15', '2024-03-08', '2024-03-01', '2024-02-23', '2024-02-16']
    .map(week => log(tag, 'alpha', week, 'Approved', 32)),
];
const bundle = (tag = 'baseline', {empty = false, noEmployees = false, noTimesheets = false, expectedHours = 40, timesheets} = {}) => ({
  actual: {mode: 'actual', asOfDate: '2026-10-20', sourceDate: '2026-10-20', rows: empty || noEmployees ? [] : employees(tag)},
  timesheets: empty || noTimesheets ? [] : timesheets || logs(tag),
  settings: {...settings, expectedWeeklyHours: expectedHours},
});
const monthLogs = (tag = 'baseline', month = '2024-04') => logs(tag).filter(item => item.weekEnding.startsWith(month));
const button = name => page.getByRole('button', {name, exact: true});
const refreshButton = () => button('Refresh actual utilization');
const retryButton = () => button('Retry actual utilization');
const globalButton = () => button('Global Report');
const auditButton = () => button('Audit Trail');
const table = () => page.getByRole('table');
const search = () => page.getByPlaceholder('Search consultant...');
const period = () => page.getByRole('combobox', {name: 'Select actual utilization period', exact: true});
const statusFilter = () => page.getByRole('combobox', {name: 'Filter actual utilization logs', exact: true});
const kpi = title => page.locator('p').filter({hasText: title}).locator('..');
const section = title => page.getByRole('heading', {name: title, exact: true}).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " bg-white ")][1]');
const reconciliation = () => section('Actual vs Planned Reconciliation');
const watchlist = () => section('Variance Watchlist');
const reconciliationRows = () => reconciliation().locator('.space-y-4 > div');
const watchlistRows = () => watchlist().locator('.space-y-3 > div');
const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const pending = async (after = 0) => {
  await page.waitForFunction(after => window.actualHarness.pending.filter(item => item.id > after).length >= 3, after);
  return page.evaluate(after => window.actualHarness.pending.filter(item => item.id > after).slice(-3).map(({id, reader}) => ({id, reader})), after);
};
const lastId = attempt => Math.max(...attempt.map(item => item.id));
const settleOne = (item, result, status) => page.evaluate(({id, result, status}) => window.actualHarness.settle(id, result, status), {id: item.id, result, status});
const settle = async (attempt, result = bundle(), failure) => {
  for (const item of attempt) await settleOne(item, result[item.reader], failure?.reader === item.reader ? failure.status : undefined);
};
const effects = async () => ({downloads: downloads.length, writes: await page.evaluate(() => window.actualHarness.writes.length)});
const expectNoNewEffects = async (before, reason) => {
  await flush();
  assert.deepEqual(await effects(), before, reason);
};
const expectNoMeasurements = async () => {
  for (const title of ['Avg. Actual Util.', 'Submission Rate', 'Pending Review', 'Approved Logs', 'Logging Variance', 'Missing Logs',
    'Actual vs Planned Reconciliation', 'Variance Watchlist', 'Pending Logs', 'Approval Health', 'Timesheet Integrity Metric', 'Service Delivery Logs']) {
    // Pending Review is also a filter option, which remains present during recovery.
    assert.equal(await page.getByText(title, {exact: true}).evaluateAll(elements => elements.filter(element => element.tagName !== 'OPTION').length), 0, 'nonready reads hide all report measurements');
  }
  assert.equal(await table().count(), 0);
  for (const message of [filteredEmptyText, noLogsText, noWeeksText, noVarianceText]) assert.equal(await page.getByText(message, {exact: true}).count(), 0);
  assert.equal(await page.getByText('0', {exact: true}).count(), 0);
  assert.equal(await page.getByText('0%', {exact: true}).count(), 0);
};
const expectBlockedExports = async () => {
  assert.equal(await globalButton().isDisabled(), true, 'Global Report is disabled without current ready evidence');
  assert.equal(await auditButton().count(), 0, 'Audit Trail is absent without current ready evidence');
  const before = await effects();
  await globalButton().evaluate(element => element.click());
  await expectNoNewEffects(before, 'disabled Global Report never downloads or writes history/audit');
};
const expectLoading = async () => {
  await page.getByRole('status').getByText(loadingText, {exact: true}).waitFor();
  assert.equal(await refreshButton().isEnabled(), true);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  await expectNoMeasurements();
  await expectBlockedExports();
};
const expectSafeError = async message => {
  const alert = page.getByRole('alert');
  await alert.getByText(message, {exact: true}).waitFor();
  await alert.getByText(message === accessError
    ? 'Check your sign-in and report access, then retry.'
    : 'Check your connection and retry. If the problem continues, contact your administrator.', {exact: true}).waitFor();
  assert.equal(await retryButton().isEnabled(), true);
  assert.equal(await refreshButton().isEnabled(), true);
  assert.equal(await page.getByText(loadingText, {exact: true}).count(), 0);
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  await expectNoMeasurements();
  await expectBlockedExports();
  const body = await page.locator('body').innerText();
  for (const privateValue of ['synthetic-private', 'synthetic-secret', '/internal/provider', 'SYNTHETIC_PRIVATE_ERROR_CODE']) {
    assert.equal(body.includes(privateValue), false, 'backend/network details never appear in safe guidance');
  }
};
const refresh = async after => {
  await refreshButton().click();
  await expectLoading();
  return pending(after);
};
const expectReady = async () => {
  await table().waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByText(loadingText, {exact: true}).count(), 0);
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await globalButton().isEnabled(), true);
  assert.equal(await auditButton().isEnabled(), true);
  assert.equal(await page.getByRole('link', {name: 'Reports', exact: true}).getAttribute('href'), '/reports/utilization');
};
const expectTableRows = async expected => {
  const expectedRows = expected.map(({employeeName, weekEnding, status}) => ({employeeName, weekEnding, status}));
  await page.waitForFunction(expectedRows => JSON.stringify([...document.querySelectorAll('table tbody tr')].filter(row => row.cells.length === 6).map(row => ({
    employeeName: row.cells[0].querySelector('p').textContent, weekEnding: row.cells[1].textContent, status: row.cells[5].textContent.trim(),
  }))) === JSON.stringify(expectedRows), expectedRows);
  const actual = await table().locator('tbody tr').evaluateAll(rows => rows.filter(row => row.cells.length === 6).map(row => ({
    employeeName: row.cells[0].querySelector('p').textContent, weekEnding: row.cells[1].textContent,
    status: row.cells[5].textContent.trim(),
  })));
  assert.deepEqual(actual, expectedRows, 'existing log ordering and scope are preserved');
};
const expectSuccess = async (tag, expected = monthLogs(tag)) => {
  if (expected.length) await table().getByText(expected[0].employeeName, {exact: true}).first().waitFor();
  await expectReady();
  await expectTableRows(expected);
};
const expectEmpty = async () => {
  await page.getByRole('status').filter({hasText: emptyText}).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await expectNoMeasurements();
  assert.equal(await globalButton().isEnabled(), true, 'composite-empty ready preserves existing empty Global Report export');
  assert.equal(await auditButton().isEnabled(), true, 'composite-empty ready preserves distinct empty Audit Trail export');
};
const expectKpis = async values => {
  for (const [title, value] of values) assert.equal(await kpi(title).getByText(value, {exact: true}).count(), 1, `existing ${title} remains unchanged`);
};
const captureExports = label => page.evaluate(label => {
  window.actualHarness.capture('Global Report', `${label}-global`);
  window.actualHarness.capture('Audit Trail', `${label}-audit`);
}, label);
const invokeCaptured = labels => page.evaluate(labels => window.actualHarness.invoke(labels), labels);
const invalidateAndInvoke = async (after, labels) => {
  const before = await effects();
  await page.evaluate(labels => window.actualHarness.refreshAndInvoke(labels), labels);
  await expectNoNewEffects(before, 'both captured export callbacks are blocked synchronously before React rerenders refresh');
  await expectLoading();
  return pending(after);
};
const percent = value => `${new Intl.NumberFormat('en-GB', {maximumFractionDigits: 1, minimumFractionDigits: Number.isInteger(Math.round((value + Number.EPSILON) * 10) / 10) ? 0 : 1}).format(Math.round((value + Number.EPSILON) * 10) / 10)}%`;
const csv = rows => rows.length ? [Object.keys(rows[0]), ...rows.map(row => Object.values(row))].map(row => row.map(value => {
  const text = String(value);
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}).join(',')).join('\n') : '';
const expectedCsv = (name, source, expectedHours = 40) => csv(source.map(item => name === 'Global Report' ? {
  employeeId: item.employeeId, employeeName: item.employeeName, weekEnding: item.weekEnding,
  totalHours: item.totalHours, billableHours: item.billableHours,
  actualUtilization: item.status === 'Approved' ? percent(item.billableHours / (expectedHours || 40) * 100) : '0%',
  status: item.status, submittedAt: item.submittedAt || '', approvedAt: item.approvedAt || '',
  rejectedAt: item.rejectedAt || '', rejectionReason: item.rejectionReason || '',
} : {
  employeeId: item.employeeId, employeeName: item.employeeName, weekEnding: item.weekEnding,
  totalHours: item.totalHours, billableHours: item.billableHours, status: item.status, entries: JSON.stringify(item.entries),
}));
const expectExport = async (name, source, expectedHours = 40) => {
  const before = await effects();
  const fileName = name === 'Global Report' ? 'actual-utilization-global-report.csv' : 'actual-utilization-visible-logs.csv';
  const [download] = await Promise.all([page.waitForEvent('download'), button(name).click()]);
  assert.equal(download.suggestedFilename(), fileName);
  assert.equal(await download.failure(), null);
  const stream = await download.createReadStream();
  assert(stream, 'successful export provides a real browser download');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), expectedCsv(name, source, expectedHours), 'real CSV preserves distinct columns, scope, formatting, escaping and row order');
  await page.waitForFunction(count => window.actualHarness.writes.length >= count, before.writes + 2);
  assert.deepEqual(await effects(), {downloads: before.downloads + 1, writes: before.writes + 2});
  const [history, audit] = await page.evaluate(start => window.actualHarness.writes.slice(start), before.writes);
  const scope = {organizationId: 'synthetic-organization', legalEntityId: 'synthetic-legal-entity'};
  assert.deepEqual(history, {path: '/api/import-export-logs', scope, body: {
    operation: 'Export', channel: 'Actual Utilization', fileName, status: 'Success',
    totalRows: source.length, validRows: source.length, errorRows: 0,
  }});
  assert.deepEqual(audit, {path: '/api/audit-events', scope, body: {
    action: 'Export', module: 'Import / Export',
    details: `Export ${fileName} through Actual Utilization with ${source.length} row${source.length === 1 ? '' : 's'} (Success)`,
    entityType: 'ImportExportLog', entityId: `synthetic-export-${before.writes + 1}`,
    newValue: {channel: 'Actual Utilization', fileName, status: 'Success', totalRows: source.length, validRows: source.length, errorRows: 0},
  }}, 'unchanged saveImportExportLog writes exact scoped history and confirmed audit');
  deliberateExports++;
};
const expectNarrowFit = async locator => {
  await locator.waitFor();
  const bounds = await locator.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'announced state and recovery control fit a narrow viewport');
};

try {
  await page.goto(`${baseUrl}/tests/fixtures/actual-utilization.html`);
  await expectLoading();
  const initial = await pending();
  await settleOne(initial.find(item => item.reader === 'actual'), bundle().actual);
  await expectLoading();
  await settleOne(initial.find(item => item.reader === 'timesheets'), undefined, 500);
  await settleOne(initial.find(item => item.reader === 'settings'), settings);
  await expectSafeError(genericError);

  await retryButton().focus();
  await page.keyboard.press('Enter');
  await expectLoading();
  const recovered = await pending(lastId(initial));
  await settle(recovered);
  await expectSuccess('baseline');
  assert.equal(await period().inputValue(), '2024-04', 'a current month absent from successful logs falls back to latest returned month');
  assert.deepEqual(await period().locator('option').evaluateAll(options => options.map(option => ({value: option.value, label: option.textContent}))), [
    {value: 'all', label: 'All Periods'}, {value: '2024-04', label: 'April 2024'},
    {value: '2024-03', label: 'March 2024'}, {value: '2024-02', label: 'February 2024'},
  ], 'month choices derive from logs and preserve descending order');
  await expectKpis([['Avg. Actual Util.', '77.9%'], ['Submission Rate', '77.8%'], ['Pending Review', '1'],
    ['Approved Logs', '6'], ['Logging Variance', '21.3%'], ['Missing Logs', '1']]);
  const firstRow = table().locator('tbody tr').first();
  assert.deepEqual((await firstRow.locator('td').allTextContents()).slice(1), [
    '2024-04-26', '48.3h', '99%', '120%', 'Approved',
  ], 'existing approved-only utilization, total-hours rounding and billable-percent formatting remain visible');
  for (const state of ['Submitted', 'Rejected', 'Draft']) {
    const row = table().locator('tbody tr').filter({has: page.getByText(state, {exact: true})});
    assert.equal(await row.locator('td').nth(4).getByText('0%', {exact: true}).count(), 1, `${state} effort never becomes actual utilization`);
  }
  const week = reconciliationRows().first();
  assert.deepEqual(await week.locator('p').allTextContents(), ['Week Ending', '26 Apr', 'Gap', '-4%', 'Coverage', '88%', 'Review', '1']);
  assert.deepEqual(await week.locator('span.w-12').allTextContents(), ['78%', '82%']);
  assert.deepEqual(await week.locator('div.rounded-full[style]').evaluateAll(bars => bars.map(bar => bar.style.width)), ['78%', '82%'], 'actual CSS reconciliation bars preserve approved-only metrics');
  assert.deepEqual(await watchlistRows().locator('div.min-w-0 > p:first-child').allTextContents(),
    ['Synthetic baseline-alpha', 'Synthetic baseline-beta', 'Synthetic baseline-zeta', 'Synthetic baseline-gamma', 'Synthetic baseline-epsilon'], 'watchlist preserves largest absolute gaps, stable ties and five-row limit');
  for (const [index, gap, actual] of [[0, '+40%', '120%'], [1, '-40%', '50%'], [2, '-20%', '50%'], [3, '+12.5%', '87.5%'], [4, '-10%', '100%']]) {
    assert.equal(await watchlistRows().nth(index).getByText(gap, {exact: true}).count(), 1);
    assert.equal(await watchlistRows().nth(index).getByText(actual, {exact: true}).count(), 1);
  }
  const approvalBar = section('Approval Health').locator('div.bg-success');
  assert(Math.abs(await approvalBar.evaluate(bar => parseFloat(bar.style.width)) - (6 / 8 * 100)) < 0.001);
  assert.equal(await page.getByText('Synthetic baseline-inactive', {exact: true}).count(), 0);
  assert.equal(await page.getByText('Synthetic baseline-excluded', {exact: true}).count(), 0);
  await expectExport('Global Report', monthLogs());
  await search().fill('ALPHA');
  await expectTableRows([monthLogs()[0]]);
  await expectExport('Audit Trail', [monthLogs()[0]]);
  await expectExport('Global Report', monthLogs());
  await search().fill('');
  await period().selectOption('all');
  await expectTableRows(logs());
  assert.deepEqual(await reconciliationRows().evaluateAll(rows => rows.map(row => row.firstElementChild.querySelector('p:nth-child(2)').textContent)),
    ['26 Apr', '29 Mar', '22 Mar', '15 Mar', '08 Mar', '01 Mar'], 'reconciliation keeps newest six weeks in descending order');
  assert.deepEqual(await watchlistRows().locator('div.min-w-0 > p:first-child').allTextContents(),
    ['Synthetic baseline-alpha', 'Synthetic baseline-beta', 'Synthetic baseline-zeta', 'Synthetic baseline-gamma', 'Synthetic baseline-epsilon'], 'watchlist uses latest approved scope, not older weeks');
  await expectExport('Global Report', logs());
  await period().selectOption('2024-03');
  await expectTableRows(monthLogs('baseline', '2024-03'));
  await expectKpis([['Avg. Actual Util.', '80%'], ['Submission Rate', '100%'], ['Pending Review', '0'], ['Approved Logs', '5'], ['Logging Variance', '0%'], ['Missing Logs', '7']]);
  await statusFilter().selectOption('Pending Review');
  await table().getByText(filteredEmptyText, {exact: true}).waitFor();
  await page.getByText(noWeeksText, {exact: true}).waitFor();
  await page.getByText(noVarianceText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  await expectExport('Global Report', []);
  await expectExport('Audit Trail', []);
  await period().selectOption('2024-04');
  await expectTableRows([monthLogs()[6]]);
  await expectKpis([['Avg. Actual Util.', '0%'], ['Submission Rate', '100%'], ['Pending Review', '1'], ['Approved Logs', '0'], ['Logging Variance', '0%'], ['Missing Logs', '7']]);
  await expectExport('Global Report', [monthLogs()[6]]);
  await statusFilter().selectOption('Approved Only');
  await expectTableRows(monthLogs().slice(0, 6));
  await expectKpis([['Avg. Actual Util.', '77.9%'], ['Submission Rate', '100%'], ['Pending Review', '0'], ['Approved Logs', '6'], ['Logging Variance', '21.3%'], ['Missing Logs', '2']]);
  await expectExport('Audit Trail', monthLogs().slice(0, 6));
  await search().fill('no-synthetic-match');
  await table().getByText(filteredEmptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  await expectKpis([['Avg. Actual Util.', '77.9%']]);
  assert.equal(await reconciliationRows().count(), 1, 'search only filters delivery logs, not report figures');
  await expectExport('Audit Trail', []);
  await expectExport('Global Report', monthLogs().slice(0, 6));

  // Each dependency independently prevents a complete snapshot from publishing.
  let after = lastId(recovered);
  for (const lastReader of readers) {
    const attempt = await refresh(after);
    const data = bundle(`partial-${lastReader}`);
    for (const item of attempt.filter(item => item.reader !== lastReader)) await settleOne(item, data[item.reader]);
    await expectLoading();
    await settleOne(attempt.find(item => item.reader === lastReader), data[lastReader]);
    await expectReady();
    assert.equal(await search().inputValue(), 'no-synthetic-match');
    after = lastId(attempt);
  }
  await search().fill('alpha');
  await period().selectOption('2024-03');
  await expectTableRows(monthLogs('partial-settings', '2024-03'));
  await captureExports('before-failures');

  // Every logical reader exercises all safe HTTP/network classes. Real-service
  // coverage separately retains timesheets' nested employee lookup contract.
  let firstFailure = true;
  for (const reader of readers) {
    for (const status of [401, 403, 404, 500, 502, 503, 504, 'network']) {
      const attempt = firstFailure
        ? await invalidateAndInvoke(after, ['before-failures-global', 'before-failures-audit'])
        : await refresh(after);
      firstFailure = false;
      const before = await effects();
      await settle(attempt, bundle('failed-partial'), {reader, status});
      await expectSafeError(status === 401 || status === 403 ? accessError : [404, 502, 503, 504].includes(status) ? unavailableError : genericError);
      await invokeCaptured(['before-failures-global', 'before-failures-audit']);
      await expectNoNewEffects(before, 'failed generations cannot download or audit captured former ready data');
      assert.equal((await page.locator('body').innerText()).includes('Synthetic failed-partial'), false);
      after = lastId(attempt);
    }
  }
  await retryButton().click();
  const afterFailures = await pending(after);
  await settle(afterFailures, bundle('after-failures'));
  await expectSuccess('after-failures', monthLogs('after-failures', '2024-03'));
  assert.equal(await search().inputValue(), 'alpha');
  assert.equal(await period().inputValue(), '2024-03');
  assert.equal(await statusFilter().inputValue(), 'Approved Only', 'search, month and status selections survive failed refresh/retry');
  const beforeStaleCallbacks = await effects();
  await invokeCaptured(['before-failures-global', 'before-failures-audit']);
  await expectNoNewEffects(beforeStaleCallbacks, 'former ready handlers stay invalid when a newer generation is ready');
  await search().fill('');
  await statusFilter().selectOption('Consolidated');
  await period().selectOption('2024-04');

  // Configured capacity and the retained per-log/watchlist/export fallback are
  // exercised without changing the existing calculation or normalizer rules.
  const configured = await refresh(lastId(afterFailures));
  await settle(configured, bundle('configured', {expectedHours: 32}));
  await expectSuccess('configured');
  await expectKpis([['Avg. Actual Util.', '97.4%'], ['Logging Variance', '27.4%']]);
  assert.equal(await table().locator('tbody tr').first().locator('td').nth(4).getByText('150%', {exact: true}).count(), 1);
  assert.deepEqual(await watchlistRows().locator('div.min-w-0 > p:first-child').allTextContents(),
    ['Synthetic configured-alpha', 'Synthetic configured-gamma', 'Synthetic configured-beta', 'Synthetic configured-epsilon', 'Synthetic configured-delta']);
  await expectExport('Global Report', monthLogs('configured'), 32);
  const fallback = await refresh(lastId(configured));
  await settle(fallback, bundle('fallback', {expectedHours: 0}));
  await expectSuccess('fallback');
  assert.equal(await table().locator('tbody tr').first().locator('td').nth(4).getByText('120%', {exact: true}).count(), 1);
  assert.equal(await watchlistRows().first().getByText('120%', {exact: true}).count(), 1);
  await expectExport('Global Report', monthLogs('fallback'), 0);

  // Empty employees alone is not a composite-empty report: log rows and both
  // exports remain usable, while the pre-existing employee KPI list stays empty.
  const logsOnly = await refresh(lastId(fallback));
  await settle(logsOnly, bundle('logs-only', {noEmployees: true}));
  await expectSuccess('logs-only');
  assert.equal(await page.getByText('Avg. Actual Util.', {exact: true}).count(), 0);
  await expectExport('Global Report', monthLogs('logs-only'));
  await expectExport('Audit Trail', monthLogs('logs-only'));
  const employeesOnly = await refresh(lastId(logsOnly));
  await settle(employeesOnly, bundle('employees-only', {noTimesheets: true}));
  await expectReady();
  await table().getByText(noLogsText, {exact: true}).waitFor();
  assert.equal(await page.getByText(filteredEmptyText, {exact: true}).count(), 0);
  await expectKpis([['Avg. Actual Util.', '0%'], ['Missing Logs', '8']]);
  await expectExport('Global Report', []);
  await expectExport('Audit Trail', []);
  const empty = await refresh(lastId(employeesOnly));
  await settle(empty, bundle('genuine-empty', {empty: true}));
  await expectEmpty();
  await expectExport('Global Report', []);
  await expectExport('Audit Trail', []);
  const restored = await refresh(lastId(empty));
  await settle(restored, bundle('restored'));
  await expectSuccess('restored');
  await period().selectOption('2024-03');
  const fallbackMonth = await refresh(lastId(restored));
  await settle(fallbackMonth, bundle('fallback-month', {timesheets: monthLogs('fallback-month')}));
  await expectSuccess('fallback-month');
  assert.equal(await period().inputValue(), '2024-04', 'refresh falls back only when the chosen month no longer exists');
  await period().selectOption('all');
  const allPersists = await refresh(lastId(fallbackMonth));
  const mayLogs = monthLogs('all-persists').map(item => ({...item, weekEnding: '2024-05-31'}));
  await settle(allPersists, bundle('all-persists', {timesheets: mayLogs}));
  await expectSuccess('all-persists', mayLogs);
  assert.equal(await period().inputValue(), 'all', 'All Periods persists when returned month choices change');
  const beforeRaces = await refresh(lastId(allPersists));
  await settle(beforeRaces, bundle('before-races'));
  await expectSuccess('before-races', logs('before-races'));
  await captureExports('before-races');

  // Older successes/errors cannot end a newer load or replace its settled result.
  const staleSuccess = await invalidateAndInvoke(lastId(beforeRaces), ['before-races-global', 'before-races-audit']);
  const newestSuccess = await refresh(lastId(staleSuccess));
  await settle(staleSuccess, bundle('stale-success'));
  await flush();
  await expectLoading();
  await settle(newestSuccess, bundle('newest-success'));
  await expectSuccess('newest-success', logs('newest-success'));
  const staleError = await refresh(lastId(newestSuccess));
  const currentPending = await refresh(lastId(staleError));
  await settle(staleError, bundle('stale-error'), {reader: 'settings', status: 'network'});
  await flush();
  await expectLoading();
  await settle(currentPending, bundle('after-pending-error'));
  await expectSuccess('after-pending-error', logs('after-pending-error'));
  const oldErrorAfterSuccess = await refresh(lastId(currentPending));
  const currentSuccess = await refresh(lastId(oldErrorAfterSuccess));
  await settle(currentSuccess, bundle('current-success'));
  await expectSuccess('current-success', logs('current-success'));
  await settle(oldErrorAfterSuccess, bundle('old-error'), {reader: 'timesheets', status: 503});
  await flush();
  await expectSuccess('current-success', logs('current-success'));
  const oldSuccessAfterSuccess = await refresh(lastId(currentSuccess));
  const currentAfterSuccess = await refresh(lastId(oldSuccessAfterSuccess));
  await settle(currentAfterSuccess, bundle('current-after-success'));
  await expectSuccess('current-after-success', logs('current-after-success'));
  await settle(oldSuccessAfterSuccess, bundle('too-late-success'));
  await flush();
  await expectSuccess('current-after-success', logs('current-after-success'));
  const oldSuccessAfterError = await refresh(lastId(currentAfterSuccess));
  const currentError = await refresh(lastId(oldSuccessAfterError));
  await settle(currentError, bundle('current-error'), {reader: 'actual', status: 500});
  await expectSafeError(genericError);
  await settle(oldSuccessAfterError, bundle('stale-after-error'));
  await flush();
  await expectSafeError(genericError);
  const oldErrorAfterError = await refresh(lastId(currentError));
  const latestError = await refresh(lastId(oldErrorAfterError));
  await settle(latestError, bundle('latest-error'), {reader: 'timesheets', status: 403});
  await expectSafeError(accessError);
  await settle(oldErrorAfterError, bundle('stale-error-after-error'), {reader: 'settings', status: 503});
  await flush();
  await expectSafeError(accessError);
  for (const tag of ['stale-success', 'stale-error', 'old-error', 'too-late-success', 'stale-after-error']) {
    assert.equal((await page.locator('body').innerText()).includes(`Synthetic ${tag}`), false);
  }
  const beforeRaceCallbacks = await effects();
  await invokeCaptured(['before-failures-global', 'before-failures-audit', 'before-races-global', 'before-races-audit']);
  await expectNoNewEffects(beforeRaceCallbacks, 'no stale outcome restores captured export evidence');

  // Pending requests and captured loaded callbacks cannot survive unmount/remount.
  await retryButton().click();
  const beforeUnmount = await pending(lastId(latestError));
  await settle(beforeUnmount, bundle('before-unmount'));
  await expectSuccess('before-unmount', logs('before-unmount'));
  await captureExports('unmounted');
  const unmountedSuccess = await refresh(lastId(beforeUnmount));
  await page.evaluate(() => window.actualHarness.hide());
  await page.getByRole('heading', {name: 'Actual Utilization', exact: true}).waitFor({state: 'detached'});
  const beforeUnmountCallbacks = await effects();
  await invokeCaptured(['unmounted-global', 'unmounted-audit']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'unmounted loaded callbacks cannot export');
  await page.evaluate(() => window.actualHarness.show());
  await expectLoading();
  const remounted = await pending(lastId(unmountedSuccess));
  await settle(remounted, bundle('remounted'));
  await expectSuccess('remounted');
  await settle(unmountedSuccess, bundle('unmounted-success'));
  await flush();
  await expectSuccess('remounted');
  await invokeCaptured(['unmounted-global', 'unmounted-audit']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'old mounted callbacks remain invalid after remounted success');
  await captureExports('ready-unmounted');
  await page.evaluate(() => window.actualHarness.hide());
  await page.getByRole('heading', {name: 'Actual Utilization', exact: true}).waitFor({state: 'detached'});
  await invokeCaptured(['ready-unmounted-global', 'ready-unmounted-audit']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'unmount directly from ready invalidates both export callbacks');
  await page.evaluate(() => window.actualHarness.show());
  await expectLoading();
  const readyRemounted = await pending(lastId(remounted));
  await settle(readyRemounted, bundle('ready-remounted'));
  await expectSuccess('ready-remounted');
  await invokeCaptured(['ready-unmounted-global', 'ready-unmounted-audit']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'directly unmounted callbacks cannot use new mount evidence');
  const unmountedError = await refresh(lastId(readyRemounted));
  await page.evaluate(() => window.actualHarness.hide());
  await page.getByRole('heading', {name: 'Actual Utilization', exact: true}).waitFor({state: 'detached'});
  await settle(unmountedError, bundle('unmounted-error'), {reader: 'actual', status: 'network'});
  await flush();
  assert.equal(await page.locator('#root').innerText(), '');
  await page.evaluate(() => window.actualHarness.show());
  await expectLoading();
  const narrowFailure = await pending(lastId(unmountedError));
  await page.setViewportSize({width: 390, height: 844});
  await expectNarrowFit(page.getByRole('status').filter({hasText: loadingText}));
  await expectNarrowFit(refreshButton());
  await settle(narrowFailure, bundle('narrow-failure'), {reader: 'settings', status: 403});
  await expectSafeError(accessError);
  await expectNarrowFit(page.getByRole('alert'));
  await expectNarrowFit(retryButton());
  await retryButton().focus();
  await page.keyboard.press('Space');
  await expectLoading();
  const narrowRecovery = await pending(lastId(narrowFailure));
  await settle(narrowRecovery, bundle('narrow-recovery'));
  await expectSuccess('narrow-recovery');
  const narrowEmpty = await refresh(lastId(narrowRecovery));
  await settle(narrowEmpty, bundle('narrow-empty', {empty: true}));
  await expectEmpty();
  await expectNarrowFit(page.getByRole('status').filter({hasText: emptyText}));

  const calls = await page.evaluate(() => window.actualHarness.calls);
  assert.equal(calls.length % 3, 0);
  for (let index = 0; index < calls.length; index += 3) {
    assert.deepEqual(calls.slice(index, index + 3).map(({reader, args}) => ({reader, args})),
      readers.map(reader => ({reader, args: []})), 'every load preserves exact three logical reader contracts');
  }
  assert.equal(await page.evaluate(() => window.actualHarness.pending.length), 0);
  assert.equal(downloads.length, deliberateExports, 'only deliberate current-ready exports downloaded files');
  assert.equal(await page.evaluate(() => window.actualHarness.writes.length), deliberateExports * 2, 'only completed exports wrote synthetic history plus audit');
  assert.deepEqual(await page.evaluate(() => window.actualHarness.legacyAuditCalls), [], 'unchanged helper adds no duplicate legacy audit');
  assert((await page.evaluate(() => window.actualHarness.healthReads.length)) > 0, 'successful export exercises actual checkBackend through synthetic health');
  assert.deepEqual(await page.evaluate(() => window.actualHarness.unexpectedFetches), []);
  assert.deepEqual(unexpectedApi, [], 'all logical reader and export network boundaries stay synthetic');
  assert.deepEqual(unexpectedRemote, [], 'no provider or off-origin traffic');
  assert.deepEqual(pageErrors, [], 'handled failures, stale promises and exports cause no page errors');
  console.log('Actual utilization browser passed: three-reader safe failures, atomic completion, keyboard retry, true/filter/partial empty, unchanged approved metrics/month/status/search/reconciliation/watchlist/formatting, generation and unmount suppression, both real CSV/history/audit exports, narrow recovery and no real backend/provider traffic.');
} finally { await browser.close(); }
