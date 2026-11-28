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
page.on('pageerror', error => pageErrors.push(error.message));
page.on('download', download => downloads.push(download));
page.on('request', request => {
  if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) unexpectedRemote.push(request.url());
});
await page.route('**/api/**', route => {
  unexpectedApi.push({method: route.request().method(), url: route.request().url()});
  return route.abort();
});

const readers = ['planned', 'directors', 'settings'];
const loadingText = 'Loading planned utilization…';
const emptyText = 'No planned utilization data was returned.';
const filteredEmptyText = 'No resources match defined criteria';
const noOverloadText = 'No critical overload';
const genericError = 'Planned utilization could not be loaded.';
const accessError = 'Access to planned utilization could not be confirmed.';
const unavailableError = 'Planned utilization is unavailable.';
const settings = {utilizationThresholdHigh: 100, utilizationThresholdLow: 80, benchThreshold: 20, expectedWeeklyHours: 40};
const directors = [
  {id: 'synthetic-director-a', name: 'Synthetic Lead A', country: 'Synthetic Country'},
  {id: 'synthetic-director-b', name: 'Synthetic Lead B', country: 'Synthetic Country'},
];
const employee = (tag, suffix, plannedUtilization, overrides = {}) => ({
  id: `${tag}-${suffix}`,
  employeeId: `SYN-${tag}-${suffix}`,
  name: `Synthetic ${tag}-${suffix}`,
  email: `${tag}-${suffix}@example.invalid`,
  designation: 'Synthetic Specialist',
  department: 'Synthetic Delivery',
  country: 'Synthetic Country',
  primaryCountryDirectorId: 'synthetic-director-a',
  mappedCountryDirectorIds: [],
  status: 'Active',
  plannedUtilization,
  actualUtilization: 45,
  activeProjectCount: 2,
  ...overrides,
});
const rows = (tag = 'baseline', noOverload = false) => [
  employee(tag, 'medium', 90),
  employee(tag, 'high', noOverload ? 95 : 125, {department: 'Synthetic Engineering', primaryCountryDirectorId: 'synthetic-director-b', mappedCountryDirectorIds: ['synthetic-director-a']}),
  employee(tag, 'low', 65, {department: 'Synthetic Engineering'}),
  employee(tag, 'very-high', noOverload ? 85 : 145, {primaryCountryDirectorId: 'synthetic-director-b'}),
  employee(tag, 'bench', 10, {department: 'Synthetic Support', activeProjectCount: 0}),
  employee(tag, 'inactive', 999, {status: 'Inactive'}),
  employee(tag, 'excluded', 999, {utilizationEligible: false}),
];
const bundle = (tag = 'baseline', {empty = false, noOverload = false} = {}) => ({
  planned: {mode: 'planned', asOfDate: '2026-10-20', sourceDate: '2026-10-20', rows: empty ? [] : rows(tag, noOverload)},
  directors,
  settings,
});
const eligibleRows = tag => rows(tag).slice(0, 5);
const button = name => page.getByRole('button', {name, exact: true});
const refreshButton = () => button('Refresh planned utilization');
const retryButton = () => button('Retry planned utilization');
const planButton = () => button('Export Plan');
const csvButton = () => button('CSV');
const table = () => page.getByRole('table');
const search = () => page.getByPlaceholder('Filter resource name...');
const filters = () => page.getByRole('combobox');
const kpi = title => page.getByText(title, {exact: true}).locator('..');
const chart = title => page.locator('div.bg-white').filter({has: page.getByRole('heading', {name: title, exact: true})});
const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const pending = async (after = 0) => {
  await page.waitForFunction(after => window.plannedHarness.pending.filter(item => item.id > after).length >= 3, after);
  return page.evaluate(after => window.plannedHarness.pending.filter(item => item.id > after).slice(-3).map(({id, reader}) => ({id, reader})), after);
};
const lastId = attempt => Math.max(...attempt.map(item => item.id));
const settleOne = (item, result, status) => page.evaluate(({id, result, status}) => window.plannedHarness.settle(id, result, status), {id: item.id, result, status});
const settle = async (attempt, result = bundle(), failure) => {
  for (const item of attempt) await settleOne(item, result[item.reader], failure?.reader === item.reader ? failure.status : undefined);
};
const effects = async () => ({downloads: downloads.length, writes: await page.evaluate(() => window.plannedHarness.writes.length)});
const expectNoNewEffects = async (before, reason) => {
  await flush();
  assert.deepEqual(await effects(), before, reason);
};
const expectNoMeasurements = async () => {
  for (const title of ['Avg. Planned Util.', 'Overloaded', 'Underutilized', 'Bench Count', 'Overload Density', 'Utilization FTE']) {
    assert.equal(await page.getByText(title, {exact: true}).count(), 0, 'nonready reads hide KPI measurements');
  }
  assert.equal(await table().count(), 0);
  assert.equal(await page.locator('.recharts-surface').count(), 0);
  assert.equal(await page.getByText(noOverloadText, {exact: true}).count(), 0);
  assert.equal(await page.getByText(filteredEmptyText, {exact: true}).count(), 0);
  assert.equal(await page.getByText('0', {exact: true}).count(), 0);
  assert.equal(await page.getByText('0%', {exact: true}).count(), 0);
};
const expectBlockedExports = async () => {
  assert.equal(await planButton().isDisabled(), true, 'Export Plan is disabled without current ready evidence');
  assert.equal(await csvButton().count(), 0, 'table CSV control is absent without current ready evidence');
  const before = await effects();
  await planButton().evaluate(element => element.click());
  await expectNoNewEffects(before, 'disabled Export Plan never downloads or writes history/audit');
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
  assert.equal(await page.getByRole('status').count(), 0);
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
const expectSuccess = async tag => {
  await table().getByText(`Synthetic ${tag}-medium`, {exact: true}).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('status').count(), 0);
  assert.equal(await planButton().isEnabled(), true);
  assert.equal(await csvButton().isEnabled(), true);
  assert.equal(await page.getByRole('link', {name: 'Reports', exact: true}).getAttribute('href'), '/reports/utilization');
};
const expectEmpty = async () => {
  await page.getByRole('status').getByText(emptyText, {exact: true}).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await expectNoMeasurements();
  assert.equal(await planButton().isEnabled(), true, 'genuine-empty ready preserves existing empty CSV export behavior');
  assert.equal(await csvButton().count(), 0);
};
const expectTableRows = async expected => {
  await page.waitForFunction(hrefs => JSON.stringify([...document.querySelectorAll('table tbody tr a')].map(link => link.getAttribute('href'))) === JSON.stringify(hrefs),
    expected.map(row => `/employees/${row.id}`));
  assert.deepEqual(await table().locator('tbody tr a').evaluateAll(links => links.map(link => link.getAttribute('href'))),
    expected.map(row => `/employees/${row.id}`), 'existing row order and employee profile destinations are preserved');
};
const captureExports = label => page.evaluate(label => {
  window.plannedHarness.capture('Export Plan', `${label}-plan`);
  window.plannedHarness.capture('CSV', `${label}-csv`);
}, label);
const invokeCaptured = labels => page.evaluate(labels => window.plannedHarness.invoke(labels), labels);
const invalidateAndInvoke = async (after, labels) => {
  const before = await effects();
  await page.evaluate(labels => window.plannedHarness.refreshAndInvoke(labels), labels);
  await expectNoNewEffects(before, 'captured Export Plan and CSV callbacks are blocked synchronously at generation invalidation');
  await expectLoading();
  return pending(after);
};
const expectedCsv = employees => {
  if (!employees.length) return '';
  const headers = ['employeeId', 'name', 'department', 'country', 'countryDirector', 'plannedUtilization', 'actualUtilization', 'activeProjectCount', 'status', 'utilizationEligible'];
  const data = employees.map(emp => [emp.employeeId, emp.name, emp.department, emp.country,
    directors.find(director => director.id === emp.primaryCountryDirectorId)?.name || emp.primaryCountryDirectorId,
    emp.plannedUtilization, emp.actualUtilization, emp.activeProjectCount, emp.status, 'Yes']);
  return [headers, ...data].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
};
const expectExport = async (name, employees) => {
  const before = await effects();
  const [download] = await Promise.all([page.waitForEvent('download'), button(name).click()]);
  assert.equal(download.suggestedFilename(), 'planned-utilization-export.csv');
  assert.equal(await download.failure(), null);
  const stream = await download.createReadStream();
  assert(stream, 'successful export provides a real browser download');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), expectedCsv(employees), 'unchanged CSV columns, rows and ordering come from the real CSV helper');
  await page.waitForFunction(count => window.plannedHarness.writes.length >= count, before.writes + 1);
  assert.deepEqual(await effects(), {downloads: before.downloads + 1, writes: before.writes + 1});
  const [history] = await page.evaluate(start => window.plannedHarness.writes.slice(start), before.writes);
  const scope = {organizationId: 'synthetic-organization', legalEntityId: 'synthetic-legal-entity'};
  assert.deepEqual(history, {path: '/api/import-export-logs', scope, body: {
    operation: 'Export', channel: 'Planned Utilization', fileName: 'planned-utilization-export.csv', status: 'Success',
    totalRows: employees.length, validRows: employees.length, errorRows: 0,
  }});
};
const expectNarrowFit = async locator => {
  await locator.waitFor();
  const bounds = await locator.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'read state and recovery controls fit a narrow viewport');
};

try {
  await page.goto(`${baseUrl}/tests/fixtures/planned-utilization.html`);
  await expectLoading();
  const initial = await pending();
  await settleOne(initial.find(item => item.reader === 'planned'), bundle().planned);
  await expectLoading();
  await settleOne(initial.find(item => item.reader === 'directors'), undefined, 500);
  await settleOne(initial.find(item => item.reader === 'settings'), settings);
  await expectSafeError(genericError);

  // A complete retry is keyboard-reachable and restores all existing read data.
  await retryButton().focus();
  await page.keyboard.press('Enter');
  await expectLoading();
  const recovered = await pending(lastId(initial));
  await settle(recovered);
  await expectSuccess('baseline');
  for (const [title,delta] of [['Overloaded','2%'],['Underutilized','3%']]) {
    assert.equal(await kpi(title).locator('..').getByText(delta,{exact:true}).count(),0);
  }
  for (const [title, value] of [['Avg. Planned Util.', '87%'], ['Overloaded', '2'], ['Underutilized', '1'], ['Bench Count', '1'], ['Overload Density', '40%'], ['Utilization FTE', '5']]) {
    assert.equal(await kpi(title).getByText(value, {exact: true}).count(), 1, 'existing utilization metrics remain unchanged');
  }
  const departmentChart = chart('Planned Allocation by Department');
  const directorChart = chart('Mix by Practice Lead');
  await departmentChart.locator('.recharts-surface').waitFor();
  await directorChart.locator('.recharts-surface').waitFor();
  // Recharts 3.8 portals axis labels into a separate SVG z-index layer. Their
  // axis-specific label group survives that portal; the axis ancestor does not.
  const departmentTickSelector = '.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value';
  const expectedDepartments = ['Synthetic Delivery', 'Synthetic Engineering', 'Synthetic Support'];
  const departmentChartRoot = await departmentChart.elementHandle();
  try {
    // SVG textContent concatenates wrapped tspans without their visual line break.
    await page.waitForFunction(({root, selector, labels}) => {
      const actual = [...root.querySelectorAll(selector)].map(tick => {
        const lines = [...tick.querySelectorAll('tspan')];
        return lines.length ? lines.map(line => line.textContent).join(' ') : tick.textContent;
      });
      return JSON.stringify(actual) === JSON.stringify(labels);
    },
    {root: departmentChartRoot, selector: departmentTickSelector, labels: expectedDepartments});
    assert.deepEqual(await departmentChart.locator(departmentTickSelector).evaluateAll(ticks => ticks.map(tick => {
      const lines = [...tick.querySelectorAll('tspan')];
      return lines.length ? lines.map(line => line.textContent).join(' ') : tick.textContent;
    })), expectedDepartments, 'department chart preserves descending planned-load order');
  } catch (error) {
    // On an assertion failure, expose only bounded synthetic chart DOM evidence.
    // Keep exact expected labels, order and count as the hosted acceptance gate.
    const observation = await departmentChart.evaluate((root, selector) => {
      const describeTick = tick => ({
        tag: tick.tagName,
        classes: tick.getAttribute('class'),
        textContent: tick.textContent,
        tspans: [...tick.querySelectorAll('tspan')].slice(0, 8).map(line => line.textContent),
        fontSize: getComputedStyle(tick).fontSize,
        width: tick.getAttribute('width'),
        withinDepartmentChart: root.contains(tick),
        parentClasses: tick.parentElement?.getAttribute('class'),
        outerHTML: tick.outerHTML.slice(0, 1200),
      });
      const scopedLabels = [...root.querySelectorAll(selector)];
      const scopedTickValues = [...root.querySelectorAll('.recharts-cartesian-axis-tick-value')];
      const globalTickValues = [...document.querySelectorAll('.recharts-cartesian-axis-tick-value')];
      return {
        selector,
        chartConnected: root.isConnected,
        chartClasses: root.getAttribute('class'),
        scopedLabelCount: scopedLabels.length,
        scopedLabels: scopedLabels.slice(0, 6).map(describeTick),
        scopedTickValueCount: scopedTickValues.length,
        scopedTickValues: scopedTickValues.slice(0, 6).map(describeTick),
        globalTickValueCount: globalTickValues.length,
        globalTickValues: globalTickValues.slice(0, 12).map(describeTick),
        tickLabelGroups: [...root.querySelectorAll('g[class*="tick-label"]')].slice(0, 12).map(group => group.getAttribute('class')),
        surfaces: [...root.querySelectorAll('svg.recharts-surface')].slice(0, 2).map(svg => ({width: svg.getAttribute('width'), height: svg.getAttribute('height'), viewBox: svg.getAttribute('viewBox')})),
      };
    }, departmentTickSelector).catch(observationError => ({observationError: observationError.message}));
    console.error('Synthetic planned department chart assertion evidence:', JSON.stringify(observation));
    throw error;
  } finally {
    await departmentChartRoot.dispose();
  }
  for (const value of ['Synthetic Lead A', 'Synthetic Lead B', '73% Avg.', '135% Avg.']) {
    await directorChart.getByText(value, {exact: true}).waitFor();
    assert.equal(await directorChart.getByText(value, {exact: true}).count(), 1, 'director chart preserves primary and mapped membership averages');
  }
  const overload = page.locator('div.bg-orange-50').filter({has: page.getByRole('heading', {name: 'Over-Allocated', exact: true})});
  assert.deepEqual(await overload.locator('.space-y-3 > div > span:first-child').allTextContents(),
    ['Synthetic baseline-very-high', 'Synthetic baseline-high'], 'overloads retain descending ordering');
  await expectTableRows(eligibleRows('baseline'));
  assert.equal(await table().getByText('Synthetic baseline-inactive', {exact: true}).count(), 0);
  assert.equal(await table().getByText('Synthetic baseline-excluded', {exact: true}).count(), 0);
  await expectExport('Export Plan', eligibleRows('baseline'));
  await search().fill('SYN-baseline-high');
  await expectTableRows([rows()[1]]);
  await expectExport('CSV', [rows()[1]]);
  await search().fill('medium');
  await expectTableRows([rows()[0]]);
  await search().fill('');
  await filters().nth(0).selectOption('Synthetic Engineering');
  await expectTableRows([rows()[1], rows()[2]]);
  await filters().nth(1).selectOption('synthetic-director-a');
  await expectTableRows([rows()[1], rows()[2]]);
  await filters().nth(1).selectOption('synthetic-director-b');
  await expectTableRows([rows()[1]]);
  await filters().nth(0).selectOption('All Departments');
  await filters().nth(1).selectOption('synthetic-director-a');
  await expectTableRows([rows()[0], rows()[1], rows()[2], rows()[4]]);
  await filters().nth(2).selectOption('above');
  await expectTableRows([rows()[1]]);
  await filters().nth(1).selectOption('All Directors');
  await expectTableRows([rows()[1], rows()[3]]);
  await filters().nth(2).selectOption('within');
  await expectTableRows([rows()[0]]);
  await filters().nth(2).selectOption('below');
  await expectTableRows([rows()[2], rows()[4]]);
  await button('Deep Audit').click();
  assert.equal(await filters().nth(2).inputValue(), 'above');
  await expectTableRows([rows()[1], rows()[3]]);
  await filters().nth(2).selectOption('All Bands');
  await search().fill('no-synthetic-match');
  await table().getByText(filteredEmptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await kpi('Avg. Planned Util.').getByText('87%', {exact: true}).count(), 1);
  assert.equal(await departmentChart.locator('.recharts-surface').count(), 1);
  await expectExport('Export Plan', []);
  await expectExport('CSV', []);
  await search().fill('');
  await expectSuccess('baseline');
  await search().fill('medium');
  await filters().nth(0).selectOption('Synthetic Delivery');
  await filters().nth(1).selectOption('synthetic-director-a');
  await filters().nth(2).selectOption('within');
  await expectTableRows([rows()[0]]);
  await captureExports('baseline');

  // All three required reader failures exercise every safe HTTP/network class.
  // A partial success may never publish rows or enable either export action.
  let after = lastId(recovered);
  let firstFailure = true;
  for (const reader of readers) {
    for (const status of [401, 403, 404, 502, 503, 504, 500, 'network']) {
      const attempt = firstFailure
        ? await invalidateAndInvoke(after, ['baseline-plan', 'baseline-csv'])
        : await refresh(after);
      firstFailure = false;
      const before = await effects();
      await settle(attempt, bundle('failed-partial'), {reader, status});
      await expectSafeError(status === 401 || status === 403 ? accessError : [404, 502, 503, 504].includes(status) ? unavailableError : genericError);
      await invokeCaptured(['baseline-plan', 'baseline-csv']);
      await expectNoNewEffects(before, 'failed and invalidated generations cannot export or audit captured old data');
      assert.equal((await page.locator('body').innerText()).includes('Synthetic failed-partial'), false);
      after = lastId(attempt);
    }
  }
  await retryButton().click();
  const afterFailures = await pending(after);
  await settle(afterFailures, bundle('after-failures'));
  await expectSuccess('after-failures');
  assert.equal(await search().inputValue(), 'medium', 'search survives failed refresh and successful retry');
  assert.deepEqual(await filters().evaluateAll(selects => selects.map(select => select.value)),
    ['Synthetic Delivery', 'synthetic-director-a', 'within'], 'all existing filter selections survive recovery');
  await expectTableRows([rows('after-failures')[0]]);
  const beforeStaleCallbacks = await effects();
  await invokeCaptured(['baseline-plan', 'baseline-csv']);
  await expectNoNewEffects(beforeStaleCallbacks, 'old loaded handlers stay invalid after a newer generation becomes ready');
  await search().fill('');
  await filters().nth(0).selectOption('All Departments');
  await filters().nth(1).selectOption('All Directors');
  await filters().nth(2).selectOption('All Bands');
  await expectTableRows(eligibleRows('after-failures'));
  await expectExport('CSV', eligibleRows('after-failures'));

  // Genuine-empty ready differs from filter-empty and populated no-overload ready.
  const empty = await refresh(lastId(afterFailures));
  await settle(empty, bundle('genuine-empty', {empty: true}));
  await expectEmpty();
  await expectExport('Export Plan', []);
  const noOverload = await refresh(lastId(empty));
  await settle(noOverload, bundle('no-overload', {noOverload: true}));
  await expectSuccess('no-overload');
  await page.getByText(noOverloadText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await kpi('Utilization FTE').getByText('5', {exact: true}).count(), 1);
  assert.equal(await kpi('Overloaded').getByText('0', {exact: true}).count(), 1);
  await captureExports('no-overload');

  // Older successes/errors cannot end newer loading or replace settled outcomes.
  const staleSuccess = await invalidateAndInvoke(lastId(noOverload), ['no-overload-plan', 'no-overload-csv']);
  const newestSuccess = await refresh(lastId(staleSuccess));
  await settle(staleSuccess, bundle('stale-success'));
  await flush();
  await expectLoading();
  await settle(newestSuccess, bundle('newest-success'));
  await expectSuccess('newest-success');
  const staleError = await refresh(lastId(newestSuccess));
  const currentPending = await refresh(lastId(staleError));
  await settle(staleError, bundle('stale-error'), {reader: 'settings', status: 'network'});
  await flush();
  await expectLoading();
  await settle(currentPending, bundle('after-pending-error'));
  await expectSuccess('after-pending-error');
  const oldErrorAfterSuccess = await refresh(lastId(currentPending));
  const currentSuccess = await refresh(lastId(oldErrorAfterSuccess));
  await settle(currentSuccess, bundle('current-success'));
  await expectSuccess('current-success');
  await settle(oldErrorAfterSuccess, bundle('old-error'), {reader: 'directors', status: 503});
  await flush();
  await expectSuccess('current-success');
  const oldSuccessAfterSuccess = await refresh(lastId(currentSuccess));
  const currentAfterSuccess = await refresh(lastId(oldSuccessAfterSuccess));
  await settle(currentAfterSuccess, bundle('current-after-success'));
  await expectSuccess('current-after-success');
  await settle(oldSuccessAfterSuccess, bundle('too-late-success'));
  await flush();
  await expectSuccess('current-after-success');
  const oldSuccessAfterError = await refresh(lastId(currentAfterSuccess));
  const currentError = await refresh(lastId(oldSuccessAfterError));
  await settle(currentError, bundle('current-error'), {reader: 'planned', status: 500});
  await expectSafeError(genericError);
  await settle(oldSuccessAfterError, bundle('stale-after-error'));
  await flush();
  await expectSafeError(genericError);
  const oldErrorAfterError = await refresh(lastId(currentError));
  const latestError = await refresh(lastId(oldErrorAfterError));
  await settle(latestError, bundle('latest-error'), {reader: 'directors', status: 403});
  await expectSafeError(accessError);
  await settle(oldErrorAfterError, bundle('stale-error-after-error'), {reader: 'settings', status: 503});
  await flush();
  await expectSafeError(accessError);
  for (const tag of ['stale-success', 'stale-error', 'old-error', 'too-late-success', 'stale-after-error']) {
    assert.equal((await page.locator('body').innerText()).includes(`Synthetic ${tag}`), false);
  }
  const beforeRaceCallbacks = await effects();
  await invokeCaptured(['baseline-plan', 'baseline-csv', 'no-overload-plan', 'no-overload-csv']);
  await expectNoNewEffects(beforeRaceCallbacks, 'stale success/error generations never restore old export evidence');

  // Pending bundles and captured callbacks cannot survive page unmount/remount.
  await retryButton().click();
  const beforeUnmount = await pending(lastId(latestError));
  await settle(beforeUnmount, bundle('before-unmount'));
  await expectSuccess('before-unmount');
  await captureExports('unmounted');
  const unmountedSuccess = await refresh(lastId(beforeUnmount));
  await page.evaluate(() => window.plannedHarness.hide());
  await page.getByRole('heading', {name: 'Planned Utilization', exact: true}).waitFor({state: 'detached'});
  const beforeUnmountCallbacks = await effects();
  await invokeCaptured(['unmounted-plan', 'unmounted-csv']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'unmounted loaded callbacks do not download or audit');
  await page.evaluate(() => window.plannedHarness.show());
  await expectLoading();
  const remounted = await pending(lastId(unmountedSuccess));
  await settle(remounted, bundle('remounted'));
  await expectSuccess('remounted');
  await settle(unmountedSuccess, bundle('unmounted-success'));
  await flush();
  await expectSuccess('remounted');
  await invokeCaptured(['unmounted-plan', 'unmounted-csv']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'old mounted callbacks stay invalid after remounted success');
  // Unmount directly from ready too, without prior refresh invalidating it.
  await captureExports('ready-unmounted');
  await page.evaluate(() => window.plannedHarness.hide());
  await page.getByRole('heading', {name: 'Planned Utilization', exact: true}).waitFor({state: 'detached'});
  await invokeCaptured(['ready-unmounted-plan', 'ready-unmounted-csv']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'direct ready unmount invalidates both captured export callbacks');
  await page.evaluate(() => window.plannedHarness.show());
  await expectLoading();
  const readyRemounted = await pending(lastId(remounted));
  await settle(readyRemounted, bundle('ready-remounted'));
  await expectSuccess('ready-remounted');
  await invokeCaptured(['ready-unmounted-plan', 'ready-unmounted-csv']);
  await expectNoNewEffects(beforeUnmountCallbacks, 'directly unmounted callbacks cannot export from the new mount');
  const unmountedError = await refresh(lastId(readyRemounted));
  await page.evaluate(() => window.plannedHarness.hide());
  await page.getByRole('heading', {name: 'Planned Utilization', exact: true}).waitFor({state: 'detached'});
  await settle(unmountedError, bundle('unmounted-error'), {reader: 'planned', status: 'network'});
  await flush();
  assert.equal(await page.locator('#root').innerText(), '');
  await page.evaluate(() => window.plannedHarness.show());
  await expectLoading();
  const narrowFailure = await pending(lastId(unmountedError));
  await page.setViewportSize({width: 390, height: 844});
  await expectNarrowFit(page.getByRole('status'));
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
  await expectTableRows(eligibleRows('narrow-recovery'));
  const custom = await refresh(lastId(narrowRecovery));
  const configured = bundle('custom-bands');
  configured.settings = {...settings, utilizationThresholdLow: 65, utilizationThresholdHigh: 125};
  await settle(custom, configured);
  const bands = filters().nth(2);
  await bands.selectOption({label:'65–125%'});
  await expectTableRows(configured.planned.rows.slice(0,3));
  await bands.selectOption({label:'Under 65%'});
  await expectTableRows([configured.planned.rows[4]]);
  await bands.selectOption({label:'Over 125%'});
  await expectTableRows([configured.planned.rows[3]]);
  const narrowEmpty = await refresh(lastId(custom));
  await settle(narrowEmpty, bundle('narrow-empty', {empty: true}));
  await expectEmpty();
  await expectNarrowFit(page.getByRole('status'));

  const calls = await page.evaluate(() => window.plannedHarness.calls);
  assert.equal(calls.length % 3, 0);
  for (let index = 0; index < calls.length; index += 3) {
    assert.deepEqual(calls.slice(index, index + 3).map(({reader, args}) => ({reader, args})),
      readers.map(reader => ({reader, args: []})), 'retry and refresh preserve the exact existing three-reader API contracts');
  }
  assert.equal(await page.evaluate(() => window.plannedHarness.pending.length), 0);
  assert.equal(downloads.length, 6, 'only six deliberate current-ready exports downloaded files');
  assert.equal(await page.evaluate(() => window.plannedHarness.writes.length), 6, 'each successful export records history once');
  assert.deepEqual(await page.evaluate(() => window.plannedHarness.legacyAuditCalls), [], 'the unchanged helper does not add duplicate legacy audit writes');
  assert((await page.evaluate(() => window.plannedHarness.healthReads.length)) > 0, 'successful export exercised actual backend-availability contract through synthetic health');
  assert.deepEqual(await page.evaluate(() => window.plannedHarness.unexpectedFetches), []);
  assert.deepEqual(unexpectedApi, [], 'all service boundary traffic remains inside the synthetic fixture');
  assert.deepEqual(unexpectedRemote, [], 'no provider or off-origin traffic');
  assert.deepEqual(pageErrors, [], 'handled failures, stale promises and exports cause no page errors');
  console.log('Planned utilization browser passed: three-reader safe failures, keyboard retry, genuine/filter empty, unchanged metrics/charts/filters/order/profile links, generation and unmount suppression, captured export guards, actual CSV/history/audit success, narrow states and no real backend/provider traffic.');
} finally { await browser.close(); }
