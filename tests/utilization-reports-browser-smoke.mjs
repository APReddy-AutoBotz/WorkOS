import assert from 'node:assert/strict';
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}, acceptDownloads: true});
const pageErrors = [];
const unexpectedApi = [];
const unexpectedRemote = [];
let downloads = 0;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('download', () => { downloads += 1; });
page.on('request', request => {
  if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) unexpectedRemote.push(request.url());
});
await page.route('**/api/**', route => {
  unexpectedApi.push({method: route.request().method(), url: route.request().url()});
  return route.abort();
});

const lenses = ['planned', 'actual', 'forecast'];
const titles = {planned: 'Planned', actual: 'Current', forecast: 'Forecast'};
const emptyText = 'No utilization data was returned for the selected report.';
const noExceptionsText = 'No exceptions in the selected report.';
const loadingText = 'Loading utilization reports…';
const genericError = 'Utilization reports could not be loaded.';
const accessError = 'Access to utilization reports could not be confirmed.';
const unavailableError = 'Utilization reports are unavailable.';
const employee = (id, plannedUtilization, actualUtilization) => ({
  id,
  employeeId: `SYN-${id}`,
  name: `Synthetic ${id}`,
  email: `${id}@example.invalid`,
  designation: 'Synthetic Specialist',
  department: 'Synthetic Delivery',
  country: 'Synthetic Country',
  primaryCountryDirectorId: 'synthetic-director',
  mappedCountryDirectorIds: [],
  status: 'Active',
  plannedUtilization,
  actualUtilization,
  activeProjectCount: 1,
});
const report = (lens, tag = 'baseline', empty = false, noExceptions = false) => {
  const rows = empty ? [] : [
    employee(`${tag}-${lens}-high`, noExceptions ? 90 : 120, noExceptions ? 85 : 60),
    employee(`${tag}-${lens}-low`, noExceptions ? 90 : 60, noExceptions ? 85 : 15),
  ];
  return {
    mode: lens,
    asOfDate: '2026-10-18',
    sourceDate: '2026-10-18',
    forecastMonths: lens === 'forecast' ? 3 : null,
    expectedWeeklyHours: 40,
    thresholds: {high: 100, low: 80, bench: 20},
    summary: {
      rows: rows.length,
      averagePlanned: empty ? 0 : (lens === 'forecast' ? 96.5 : 90),
      averageActual: empty ? 0 : 37.5,
      overloaded: empty || noExceptions ? 0 : 1,
      underutilized: empty || noExceptions ? 0 : 2,
      bench: empty || noExceptions ? 0 : 1,
    },
    rows,
  };
};
const reports = (tag = 'baseline', emptyLens, noExceptions = false) => Object.fromEntries(
  lenses.map(lens => [lens, report(lens, tag, lens === emptyLens, noExceptions)]),
);
const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const button = name => page.getByRole('button', {name, exact: true});
const refreshButton = () => button('Refresh utilization reports');
const retryButton = () => button('Retry utilization reports');
const lensButton = lens => page.getByRole('button').filter({has: page.getByRole('heading', {name: titles[lens], exact: true})});
const snapshot = lens => page.locator('.dashboard-card').filter({has: page.getByRole('heading', {name: `${titles[lens]} Snapshot`, exact: true})});
const exceptions = lens => page.locator('.dashboard-card').filter({has: page.getByRole('heading', {name: `${titles[lens]} Exceptions`, exact: true})});
const pending = async (after = 0) => {
  await page.waitForFunction(after => window.utilizationHarness.pending.filter(item => item.id > after).length >= 3, after);
  return page.evaluate(after => window.utilizationHarness.pending.filter(item => item.id > after).slice(-3).map(({id, lens}) => ({id, lens})), after);
};
const lastId = attempt => Math.max(...attempt.map(item => item.id));
const settleOne = (item, result, status) => page.evaluate(({id, result, status}) => window.utilizationHarness.settle(id, result, status), {id: item.id, result, status});
const settle = async (attempt, result = reports(), failure) => {
  for (const item of attempt) await settleOne(item, result[item.lens], failure?.lens === item.lens ? failure.status : undefined);
};
const expectLoading = async () => {
  await page.getByRole('status').getByText(loadingText, {exact: true}).waitFor();
  assert.equal(await refreshButton().isEnabled(), true, 'refresh stays usable during a pending read');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await page.getByText(noExceptionsText, {exact: true}).count(), 0);
  assert.equal(await page.getByText('0', {exact: true}).count(), 0, 'loading does not imply a zero measurement');
  assert.equal(await page.getByText('0%', {exact: true}).count(), 0);
  for (const lens of lenses) assert.equal(await lensButton(lens).count(), 0, 'loading hides report measurements');
};
const expectSafeError = async message => {
  const alert = page.getByRole('alert');
  await alert.getByText(message, {exact: true}).waitFor();
  await alert.getByText(message === accessError
    ? 'Check your sign-in and report access, then retry.'
    : 'Check your connection and retry. If the problem continues, contact your administrator.', {exact: true}).waitFor();
  assert.equal(await retryButton().isEnabled(), true);
  assert.equal(await page.getByRole('status').count(), 0);
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await page.getByText(noExceptionsText, {exact: true}).count(), 0);
  assert.equal(await page.getByText('0', {exact: true}).count(), 0, 'failed reads do not imply a zero measurement');
  assert.equal(await page.getByText('0%', {exact: true}).count(), 0);
  for (const lens of lenses) {
    assert.equal(await lensButton(lens).count(), 0, 'failures hide report measurements');
    assert.equal(await snapshot(lens).count(), 0, 'failed reads do not leave stale success snapshots');
  }
  const text = await page.locator('body').innerText();
  for (const privateValue of ['synthetic-private', 'synthetic-secret', '/internal/provider', 'SYNTHETIC_PRIVATE_ERROR_CODE']) {
    assert.equal(text.includes(privateValue), false, 'raw backend/network error details stay private');
  }
};
const refresh = async after => {
  await refreshButton().click();
  await expectLoading();
  return pending(after);
};
const expectSuccess = async (lens, tag) => {
  await snapshot(lens).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('status').count(), 0);
  assert.equal(await exceptions(lens).getByText(`Synthetic ${tag}-${lens}-${lens === 'actual' ? 'low' : 'high'}`, {exact: true}).count(), 1);
};
const expectLinks = async lens => {
  assert.equal(await page.getByRole('link', {name: `Open ${titles[lens]}`, exact: true}).getAttribute('href'), `/utilization/${lens}`);
  assert.equal(await page.getByRole('link', {name: 'Open Detailed Report', exact: true}).getAttribute('href'), `/utilization/${lens}`);
  assert.equal(await page.getByRole('link', {name: 'Reports Center', exact: true}).getAttribute('href'), '/reports/center');
};
const expectNarrowFit = async locator => {
  await locator.waitFor();
  const bounds = await locator.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'read state fits the narrow viewport');
};

try {
  await page.goto(`${baseUrl}/tests/fixtures/utilization-reports.html`);
  await expectLoading();
  const initial = await pending();
  await settleOne(initial.find(item => item.lens === 'planned'), report('planned'));
  await expectLoading();
  await settleOne(initial.find(item => item.lens === 'actual'), undefined, 500);
  await settleOne(initial.find(item => item.lens === 'forecast'), report('forecast'));
  await expectSafeError(genericError);

  // Recovery is reachable without a mouse and refetches the complete read bundle.
  await retryButton().focus();
  await page.keyboard.press('Enter');
  await expectLoading();
  const keyboardRetry = await pending(lastId(initial));
  await settle(keyboardRetry);
  await expectSuccess('planned', 'baseline');
  assert.equal(await lensButton('planned').getByText('90%', {exact: true}).count(), 1);
  assert.equal(await lensButton('actual').getByText('37.5%', {exact: true}).count(), 1);
  assert.equal(await lensButton('forecast').getByText('96.5%', {exact: true}).count(), 1);
  assert.equal(await lensButton('planned').getByText('1', {exact: true}).count(), 1);
  assert.equal(await lensButton('actual').getByText('3', {exact: true}).count(), 1);
  assert.equal(await lensButton('forecast').getByText('1', {exact: true}).count(), 1);
  for (const lens of lenses) {
    await lensButton(lens).click();
    await expectSuccess(lens, 'baseline');
    await expectLinks(lens);
    assert.equal(await snapshot(lens).getByText('2', {exact: true}).count(), 1, 'existing population total is preserved');
    assert.equal(await snapshot(lens).getByText('1', {exact: true}).count(), 1, 'existing bench total is preserved');
    assert.equal(await snapshot(lens).getByText('37.5%', {exact: true}).count(), 1);
    const expectedRows = lens === 'actual' ? ['low', 'high'] : ['high'];
    assert.deepEqual(await exceptions(lens).getByRole('link', {name: 'Profile', exact: true}).evaluateAll(links => links.map(link => link.getAttribute('href'))),
      expectedRows.map(suffix => `/employees/baseline-${lens}-${suffix}`), 'existing threshold ordering and profile links are preserved');
  }

  // Error cases rotate across the three service methods.
  let after = lastId(keyboardRetry);
  for (const [index, status] of [401, 403, 404, 502, 503, 504, 500, 'network'].entries()) {
    const attempt = await refresh(after);
    const failureLens = lenses[index % lenses.length];
    await settle(attempt, reports('failed-attempt'), {lens: failureLens, status});
    await expectSafeError(status === 401 || status === 403 ? accessError : [404, 502, 503, 504].includes(status) ? unavailableError : genericError);
    assert.equal((await page.locator('body').innerText()).includes('Synthetic failed-attempt'), false, 'a partially successful bundle never appears as a successful report');
    after = lastId(attempt);
  }
  await retryButton().click();
  const recovered = await pending(after);
  await settle(recovered, reports('recovered'));
  await expectSuccess('forecast', 'recovered');
  await expectLinks('forecast');

  // A genuinely empty selected lens is distinct from populated, exception-free success.
  const plannedEmpty = await refresh(lastId(recovered));
  await settle(plannedEmpty, reports('selected-empty', 'planned'));
  await expectSuccess('forecast', 'selected-empty');
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0, 'an empty unselected report does not mask the selected data');
  await lensButton('planned').click();
  await page.getByText(emptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(noExceptionsText, {exact: true}).count(), 0);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('link', {name: 'Open Planned', exact: true}).getAttribute('href'), '/utilization/planned');
  assert.equal(await snapshot('planned').count(), 0, 'empty success does not invent snapshot measurements');
  assert.equal(await lensButton('planned').getByText('--', {exact: true}).count(), 2);
  await lensButton('actual').click();
  await expectSuccess('actual', 'selected-empty');
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  const actualEmpty = await refresh(lastId(plannedEmpty));
  await settle(actualEmpty, reports('actual-empty', 'actual'));
  await page.getByText(emptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(noExceptionsText, {exact: true}).count(), 0);
  await lensButton('forecast').click();
  const forecastEmpty = await refresh(lastId(actualEmpty));
  await settle(forecastEmpty, reports('forecast-empty', 'forecast'));
  await page.getByText(emptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(noExceptionsText, {exact: true}).count(), 0);
  const noExceptions = await refresh(lastId(forecastEmpty));
  await settle(noExceptions, reports('no-exceptions', undefined, true));
  await page.getByText(noExceptionsText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await snapshot('forecast').getByText('2', {exact: true}).count(), 1);

  // Refresh remains available while loading. Older successful data cannot end loading
  // or replace newer data, and an older rejection cannot replace newer success.
  const staleSuccess = await refresh(lastId(noExceptions));
  const newestSuccess = await refresh(lastId(staleSuccess));
  await settle(staleSuccess, reports('stale-success'));
  await flush();
  await expectLoading();
  assert.equal((await page.locator('body').innerText()).includes('Synthetic stale-success'), false);
  await settle(newestSuccess, reports('newest-success'));
  await expectSuccess('forecast', 'newest-success');
  const staleRejection = await refresh(lastId(newestSuccess));
  const currentSuccess = await refresh(lastId(staleRejection));
  await settle(currentSuccess, reports('current-success'));
  await expectSuccess('forecast', 'current-success');
  await settle(staleRejection, reports('stale-rejection'), {lens: 'actual', status: 503});
  await flush();
  await expectSuccess('forecast', 'current-success');
  const oldSuccessAfterCurrent = await refresh(lastId(currentSuccess));
  const currentAfterOldSuccess = await refresh(lastId(oldSuccessAfterCurrent));
  await settle(currentAfterOldSuccess, reports('current-after-old-success'));
  await expectSuccess('forecast', 'current-after-old-success');
  await settle(oldSuccessAfterCurrent, reports('too-late-success'));
  await flush();
  await expectSuccess('forecast', 'current-after-old-success');
  assert.equal((await page.locator('body').innerText()).includes('Synthetic too-late-success'), false);

  const oldRejectionWhilePending = await refresh(lastId(currentAfterOldSuccess));
  const currentPending = await refresh(lastId(oldRejectionWhilePending));
  await settle(oldRejectionWhilePending, reports('old-pending-rejection'), {lens: 'forecast', status: 'network'});
  await flush();
  await expectLoading();
  await settle(currentPending, reports('current-after-pending-rejection'));
  await expectSuccess('forecast', 'current-after-pending-rejection');
  const oldSuccessAfterFailure = await refresh(lastId(currentPending));
  const latestFailure = await refresh(lastId(oldSuccessAfterFailure));
  await settle(latestFailure, reports('latest-failure'), {lens: 'planned', status: 500});
  await expectSafeError(genericError);
  await settle(oldSuccessAfterFailure, reports('stale-after-failure'));
  await flush();
  await expectSafeError(genericError);
  assert.equal((await page.locator('body').innerText()).includes('Synthetic stale-after-failure'), false);

  // Responses that outlive an unmounted page cannot affect a newly mounted page.
  const unmountedSuccess = await refresh(lastId(latestFailure));
  await page.evaluate(() => window.utilizationHarness.hide());
  await page.getByRole('heading', {name: 'Utilization Reports', exact: true}).waitFor({state: 'detached'});
  await page.evaluate(() => window.utilizationHarness.show());
  await expectLoading();
  const remounted = await pending(lastId(unmountedSuccess));
  await settle(remounted, reports('remounted'));
  await expectSuccess('planned', 'remounted');
  await settle(unmountedSuccess, reports('unmounted-success'));
  await flush();
  await expectSuccess('planned', 'remounted');
  assert.equal((await page.locator('body').innerText()).includes('Synthetic unmounted-success'), false);
  const unmountedFailure = await refresh(lastId(remounted));
  await page.evaluate(() => window.utilizationHarness.hide());
  await page.getByRole('heading', {name: 'Utilization Reports', exact: true}).waitFor({state: 'detached'});
  await settle(unmountedFailure, reports('unmounted-failure'), {lens: 'planned', status: 'network'});
  await flush();
  assert.equal(await page.locator('#root').innerText(), '');
  await page.evaluate(() => window.utilizationHarness.show());
  await expectLoading();
  const narrowFailure = await pending(lastId(unmountedFailure));
  await page.setViewportSize({width: 390, height: 844});
  await expectNarrowFit(page.getByRole('status'));
  await expectNarrowFit(refreshButton());
  await settle(narrowFailure, reports('narrow-failure'), {lens: 'forecast', status: 403});
  await expectSafeError(accessError);
  await expectNarrowFit(page.getByRole('alert'));
  await expectNarrowFit(retryButton());
  await retryButton().focus();
  await page.keyboard.press('Space');
  await expectLoading();
  const narrowRecovery = await pending(lastId(narrowFailure));
  await settle(narrowRecovery, reports('narrow-recovery'));
  await expectSuccess('planned', 'narrow-recovery');
  await expectNarrowFit(snapshot('planned'));
  await expectLinks('planned');
  const narrowEmpty = await refresh(lastId(narrowRecovery));
  await settle(narrowEmpty, reports('narrow-empty', 'planned'));
  await page.getByRole('status').getByText(emptyText, {exact: true}).waitFor();
  await expectNarrowFit(page.getByRole('status'));
  assert.equal(await page.getByText(noExceptionsText, {exact: true}).count(), 0);

  const calls = await page.evaluate(() => window.utilizationHarness.calls);
  assert.equal(calls.length % 3, 0);
  for (let index = 0; index < calls.length; index += 3) {
    assert.deepEqual(calls.slice(index, index + 3).map(({lens, args}) => ({lens, args})), [
      {lens: 'planned', args: []}, {lens: 'actual', args: []}, {lens: 'forecast', args: [3]},
    ], 'retry/refresh preserve the three existing service API contracts');
  }
  assert.equal(await page.evaluate(() => window.utilizationHarness.pending.length), 0);
  assert.equal(await page.evaluate(() => window.utilizationHarness.writes()), 0);
  assert.equal(downloads, 0, 'reading and retrying do not initiate downloads');
  assert.deepEqual(unexpectedApi, [], 'the synthetic read harness makes no real backend requests');
  assert.deepEqual(unexpectedRemote, [], 'the synthetic read harness makes no provider or off-origin requests');
  assert.deepEqual(pageErrors, [], 'handled failures and stale rejected promises cause no page errors');
  console.log('Utilization report browser passed: loading, safe error classes, keyboard retry, selected-lens empty, preserved metrics/navigation, refresh races, unmount suppression, narrow layout and no writes/downloads/API requests.');
} finally { await browser.close(); }
