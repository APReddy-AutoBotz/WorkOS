import assert from 'node:assert/strict';
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}, acceptDownloads: true, timezoneId: 'America/Los_Angeles'});
page.setDefaultTimeout(10000);
// Freeze Date, not timers/rAF: chart animation and asynchronous UI still run.
// Native setMonth is deliberately retained: Jan31 +1/+2/+3 = Mar3/Mar31/May1.
await page.clock.setFixedTime(new Date('2026-02-14T12:34:56.000Z'));
const pageErrors = [], unexpectedApi = [], unexpectedRemote = [], downloads = [];
let deliberateExports = 0;
let measurementProbeReported = false;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('download', download => downloads.push(download));
page.on('request', request => {
  if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) unexpectedRemote.push(request.url());
});
await page.route('**/api/**', route => {
  unexpectedApi.push({method: route.request().method(), url: route.request().url()});
  return route.abort();
});

const readers = ['employees', 'projects', 'allocations', 'settings', 'forecast'];
const loadingText = 'Loading forecast utilization…';
const emptyText = 'No forecast utilization data was returned.';
const sectionEmptyText = 'No resource forecasts were returned for this horizon.';
const filteredEmptyText = 'No resource forecasts match the selected filters.';
const genericError = 'Forecast utilization could not be loaded.';
const accessError = 'Access to forecast utilization could not be confirmed.';
const unavailableError = 'Forecast utilization is unavailable.';
const settings = {utilizationThresholdHigh: 110, utilizationThresholdLow: 75, benchThreshold: 20, expectedWeeklyHours: 40};
const employee = (tag, suffix, plannedUtilization, overrides = {}) => ({
  id: `${tag}-${suffix}`, employeeId: `SYN-${tag}-${suffix}`, name: `Synthetic ${tag}-${suffix}`,
  email: `${tag}-${suffix}@example.invalid`, designation: 'Synthetic Specialist', department: 'Synthetic Delivery',
  country: 'Synthetic Country', primaryCountryDirectorId: 'synthetic-director', mappedCountryDirectorIds: [],
  status: 'Active', plannedUtilization, actualUtilization: 17, activeProjectCount: 2, ...overrides,
});
const employees = (tag = 'baseline') => [
  employee(tag, 'alpha', 80, {name: `Synthetic ${tag}-alpha, "quoted"`}),
  employee(tag, 'beta', 90, {department: 'Synthetic Engineering'}),
  employee(tag, 'gamma', 70, {department: 'Synthetic Engineering'}),
  employee(tag, 'delta', 10, {department: 'Synthetic Support'}),
  employee(tag, 'epsilon', 95),
  employee(tag, 'zeta', 40, {employeeId: `=SYN-${tag}-zeta`, department: 'Synthetic Support'}),
  employee(tag, 'eta', 60),
  employee(tag, 'pm-future', 0, {designation: 'Project Manager', activeProjectCount: 0}),
  employee(tag, 'pm-mapped', 1, {designation: 'Project Manager', activeProjectCount: 0}),
  employee(tag, 'pm-never', 0, {designation: 'Project Manager', activeProjectCount: 0}),
  employee(tag, 'inactive', 999, {status: 'Inactive'}),
  employee(tag, 'excluded', 999, {utilizationEligible: false}),
  employee(tag, 'admin', 999, {employeeId: `ADMIN-${tag}`}),
  employee(tag, 'hr', 999, {department: 'Human Resources'}),
  employee(tag, 'director', 999, {designation: 'Country Director'}),
];
const project = (tag, suffix, status = 'Active', startDate = '2026-01-01', endDate = '2026-12-31') => ({
  id: `${tag}-${suffix}`, projectCode: `SYN-${suffix}`, name: `Synthetic ${tag}-${suffix}`, client: 'Synthetic Client',
  status, startDate, endDate, billable: true, managerId: 'synthetic-manager', managerName: 'Synthetic Manager',
});
const projects = tag => [
  project(tag, 'steady'), project(tag, 'beta', 'Active', '2026-01-01', '2026-03-31'),
  project(tag, 'gamma'), project(tag, 'gamma-future', 'Proposed', '2026-03-15'),
  project(tag, 'pm', 'Proposed', '2026-03-03'), project(tag, 'late', 'Active', '2026-06-01'),
  project(tag, 'completed', 'Completed'),
];
const allocation = (tag, suffix, person, target, percentage, startDate = '2026-01-01', endDate = '2026-12-31', overrides = {}) => ({
  id: `${tag}-allocation-${suffix}`, employeeId: `${tag}-${person}`, projectId: `${tag}-${target}`,
  employeeName: `Synthetic ${tag}-${person}`, projectName: `Synthetic ${tag}-${target}`,
  percentage, startDate, endDate, status: 'Active', billable: true, ...overrides,
});
const allocations = tag => [
  allocation(tag, 'alpha', 'alpha', 'steady', 80.04),
  allocation(tag, 'beta-base', 'beta', 'beta', 90, '2026-01-01', '2026-03-31'),
  allocation(tag, 'beta-extra', 'beta', 'beta', 30, '2026-01-01', '2026-03-03'),
  allocation(tag, 'gamma', 'gamma', 'gamma', 30),
  allocation(tag, 'gamma-future', 'gamma', 'gamma-future', 30),
  allocation(tag, 'epsilon', 'epsilon', 'steady', 75),
  allocation(tag, 'zeta', 'zeta', 'steady', 110),
  allocation(tag, 'eta', 'eta', 'steady', 110.1),
  allocation(tag, 'pm', 'pm-future', 'pm', 40),
  allocation(tag, 'late', 'alpha', 'late', 500),
  allocation(tag, 'inactive-allocation', 'alpha', 'steady', 999, '2026-01-01', '2026-02-02', {status: 'Inactive'}),
  allocation(tag, 'completed-project', 'alpha', 'completed', 999),
  allocation(tag, 'missing-project', 'alpha', 'missing', 999),
  allocation(tag, 'missing-employee', 'missing', 'steady', 0, '2026-01-01', '2026-01-31'),
  // Existing roll-off rules use active allocations independently of employee
  // utilization eligibility and project status. Deliberately shuffled >5 rows.
  allocation(tag, 'roll-fifth', 'hr', 'completed', 15, '2026-01-01', '2026-02-04'),
  allocation(tag, 'roll-first', 'director', 'completed', 11, '2026-01-01', '2026-01-31'),
  allocation(tag, 'roll-sixth', 'excluded', 'completed', 16, '2026-01-01', '2026-03-04'),
  allocation(tag, 'roll-third', 'admin', 'completed', 13, '2026-01-01', '2026-02-02'),
  allocation(tag, 'roll-second', 'inactive', 'completed', 12, '2026-01-01', '2026-02-01'),
  allocation(tag, 'roll-fourth', 'excluded', 'completed', 14, '2026-01-01', '2026-02-03'),
];
const dates=['2026-01-31','2026-03-03','2026-03-31','2026-05-01'];
const forecastPeriod=horizon=>({mode:'forecast',sourceDate:dates[0],asOfDate:dates[horizon],forecastMonths:horizon});
const bundle = (tag = 'baseline', horizon = 3, options = {}) => {
  const people = employees(tag);
  return {
    employees: options.empty ? [] : people,
    projects: options.empty ? [] : projects(tag),
    allocations: options.empty ? [] : allocations(tag),
    settings: {...settings, ...options.settings},
    forecast: {...forecastPeriod(horizon), rows: options.empty ? [] : [
      {...people[0], plannedUtilization: 80}, {...people[1], plannedUtilization: ({1: 33.3, 2: 44.4, 3: 0})[horizon]},
      {...people[3], plannedUtilization: 0}, {...people[4], plannedUtilization: 75},
      {...people[5], plannedUtilization: 110}, {...people[6], plannedUtilization: 110.1},
    ]},
  };
};
// Independent hand-derived golden values, not calls to product calculations.
// Supply raw demand is 525.14/565.14/565.14/475.14. Eligible capacity is
// 800/900/900/900: the zero-current-load PM becomes eligible only on Mar3.
const golden = [
  {suffix: 'alpha', loads: [80, 80, 80, 80], average: {1: 80, 2: 80, 3: 80}, horizon: {1: 80, 2: 80, 3: 80}, peak: 80, status: 'Stable'},
  {suffix: 'beta', loads: [120, 120, 90, 0], average: {1: 120, 2: 105, 3: 70}, horizon: {1: 33.3, 2: 44.4, 3: 0}, peak: 120, status: 'Overload'},
  {suffix: 'gamma', loads: [30, 30, 60, 60], average: {1: 30, 2: 45, 3: 50}, horizon: {1: 30, 2: 60, 3: 60}, peak: 60, status: 'Low Demand'},
  {suffix: 'delta', loads: [0, 0, 0, 0], average: {1: 0, 2: 0, 3: 0}, horizon: {1: 0, 2: 0, 3: 0}, peak: 0, status: 'Future Bench'},
  {suffix: 'epsilon', loads: [75, 75, 75, 75], average: {1: 75, 2: 75, 3: 75}, horizon: {1: 75, 2: 75, 3: 75}, peak: 75, status: 'Stable'},
  {suffix: 'zeta', loads: [110, 110, 110, 110], average: {1: 110, 2: 110, 3: 110}, horizon: {1: 110, 2: 110, 3: 110}, peak: 110, status: 'Stable'},
  {suffix: 'eta', loads: [110.1, 110.1, 110.1, 110.1], average: {1: 110.1, 2: 110.1, 3: 110.1}, horizon: {1: 110.1, 2: 110.1, 3: 110.1}, peak: 110.1, status: 'Overload'},
  {suffix: 'pm-future', loads: [0, 40, 40, 40], average: {1: 40, 2: 40, 3: 40}, horizon: {1: 40, 2: 40, 3: 40}, peak: 40, status: 'Low Demand'},
  {suffix: 'pm-mapped', loads: [0, 0, 0, 0], average: {1: 0, 2: 0, 3: 0}, horizon: {1: 0, 2: 0, 3: 0}, peak: 0, status: 'Future Bench'},
];
const checkpoints = ['Now', '+1M', '+2M', '+3M'];
const percent = value => `${new Intl.NumberFormat('en-GB', {maximumFractionDigits: 1}).format(value)}%`;
const button = name => page.getByRole('button', {name, exact: true});
const refreshButton = () => button('Refresh forecast utilization');
const retryButton = () => button('Retry forecast utilization');
const reportButton = () => button('Forecast Report');
const csvButton = () => button('Forecast');
const table = () => page.getByRole('table');
const search = () => page.getByPlaceholder('Search forecast...');
const department = () => page.getByRole('combobox');
const kpi = title => page.getByText(title, {exact: true}).locator('..');
const mainChartSvg = '.recharts-wrapper > svg.recharts-surface';
const chart = () => page.getByRole('heading', {name: 'Capacity vs Demand Horizon', exact: true}).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " bg-white ")][1]');
const riskGroup = title => page.getByRole('heading', {name: title, exact: true}).locator('..');
const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const pending = async (after = 0, horizon = 3) => {
  await page.waitForFunction(after => window.forecastHarness.pending.filter(item => item.id > after).length >= 5, after);
  const attempt = await page.evaluate(after => window.forecastHarness.pending.filter(item => item.id > after).slice(-5).map(({id, reader, args}) => ({id, reader, args})), after);
  assert.deepEqual(attempt.map(({reader, args}) => ({reader, args})), readers.map(reader => ({reader, args: reader === 'forecast' ? [horizon] : []})), 'every coordinated attempt reruns exact five logical readers and only the existing horizon argument');
  return attempt;
};
const lastId = attempt => Math.max(...attempt.map(item => item.id));
const settleOne = (item, result, status) => page.evaluate(({id, result, status}) => window.forecastHarness.settle(id, result, status), {id: item.id, result, status});
const settle = async (attempt, result = bundle(), failure) => {
  for (const item of attempt) await settleOne(item, result[item.reader], failure?.reader === item.reader ? failure.status : undefined);
};
const effects = async () => ({downloads: downloads.length, writes: await page.evaluate(() => window.forecastHarness.writes.length)});
const expectNoNewEffects = async (before, reason) => {
  await flush();
  assert.deepEqual(await effects(), before, reason);
};
const expectNoMeasurements = async () => {
  for (const title of ['Projected Avg. Util.', 'Projects below 100% allocation', 'Overload Risk', 'Future Bench', 'Demand Pressure', 'Active Horizon',
    'Capacity vs Demand Horizon', 'Horizon Risk Analysis', 'Resource Forecast Ledger', 'Hiring Trigger', 'Future Bench Pool']) {
    assert.equal(await page.getByText(title, {exact: true}).count(), 0, 'nonready reads hide all report figures and conclusions');
  }
  assert.equal(await table().count(), 0);
  assert.equal(await page.locator('.recharts-surface').count(), 0);
  for (const text of [sectionEmptyText, filteredEmptyText, 'Capacity unavailable', 'No roll-offs inside this horizon',
    'No future bench cases in this horizon', 'Measured allocation pressure is within the 90% review threshold.',
    'Allocated demand is within capacity at the measured checkpoints.', '0', '0%']) {
    const {matches, probes} = await page.getByText(text, {exact: true}).evaluateAll((elements, numeric) => {
      const matches = [], probes = [];
      for (const element of elements) {
        // Recharts retains its last measured axis label in a body-level span even
        // after the chart unmounts. Exempt only that offscreen, aria-hidden numeric
        // probe, never app content, other hidden nodes or a visible lookalike.
        const probe = numeric && element.tagName === 'SPAN' && element.id === 'recharts_measurement_span'
          && element.parentElement === document.body && element.getAttribute('aria-hidden') === 'true'
          && element.getBoundingClientRect().bottom < 0;
        (probe ? probes : matches).push(element.outerHTML);
      }
      return {matches, probes};
    }, text === '0' || text === '0%');
    if (probes.length && !measurementProbeReported) {
      console.log('Ignored retained Recharts offscreen numeric measurement probe:', probes);
      measurementProbeReported = true;
    }
    assert.deepEqual(matches, [], `pending/failure cannot look like a successful no-demand/bench/roll-off result: ${text}`);
  }
};
const verifyNoMeasurementsGuard = async () => {
  // Prove the narrow probe exception does not weaken numeric/conclusion checks,
  // including hidden app content and unrelated offscreen body instrumentation.
  for (const [text, parent, hidden, id] of [['0', 'root', false], ['0%', 'root', false], ['0', 'root', true],
    ['Capacity unavailable', 'root', false], ['0', 'body', true], ['0', 'root', true, 'recharts_measurement_span'],
    ['0', 'body', false, 'recharts_measurement_span']]) {
    await page.evaluate(({text, parent, hidden, id}) => {
      const sentinel = document.createElement('span');
      sentinel.id = id || 'synthetic-measurement-guard';
      sentinel.dataset.measurementGuard = 'true';
      sentinel.textContent = text;
      if (hidden) {
        sentinel.setAttribute('aria-hidden', 'true');
        sentinel.style.cssText = 'position:absolute;top:-20000px';
      }
      (parent === 'root' ? document.getElementById('root') : document.body).appendChild(sentinel);
    }, {text, parent, hidden, id});
    try {
      await assert.rejects(expectNoMeasurements, error => error.code === 'ERR_ASSERTION'
        && error.message.includes('pending/failure cannot look like a successful no-demand/bench/roll-off result'),
      'real numeric/conclusion leakage is rejected rather than hidden by the Recharts probe exception');
    } finally {
      await page.locator('[data-measurement-guard]').evaluate(element => element.remove());
    }
  }
  const sizing = page.locator('body > span#recharts_measurement_span');
  assert.equal(await sizing.count(), 1, 'the real Recharts measurement probe survives chart unmount');
  const original = await sizing.evaluate(element => ({text: element.textContent, ariaHidden: element.getAttribute('aria-hidden')}));
  try {
    await sizing.evaluate(element => { element.textContent = '0'; });
    await expectNoMeasurements();
    await sizing.evaluate(element => element.removeAttribute('aria-hidden'));
    await assert.rejects(expectNoMeasurements, /pending\/failure cannot look like a successful/,
      'the real measurement probe is not exempt when it loses its accessibility-safety attribute');
  } finally {
    await sizing.evaluate((element, original) => {
      element.textContent = original.text;
      if (original.ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', original.ariaHidden);
    }, original);
  }
  await expectNoMeasurements();
};
const expectBlockedExports = async () => {
  assert.equal(await reportButton().isDisabled(), true);
  assert.equal(await csvButton().isDisabled(), true);
  const before = await effects();
  await reportButton().evaluate(element => element.click());
  await expectNoNewEffects(before, 'nonready export controls never download or write history/audit');
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
  await alert.getByText(message === accessError ? 'Check your sign-in and report access, then retry.'
    : 'Check your connection and retry. If the problem continues, contact your administrator.', {exact: true}).waitFor();
  assert.equal(await retryButton().isEnabled(), true);
  assert.equal(await refreshButton().isEnabled(), true);
  assert.equal(await page.getByText(loadingText, {exact: true}).count(), 0);
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  await expectNoMeasurements();
  await expectBlockedExports();
  const body = await page.locator('body').innerText();
  for (const value of ['synthetic-private', 'synthetic-secret', '/internal/provider', 'SYNTHETIC_PRIVATE_ERROR_CODE']) assert.equal(body.includes(value), false, 'safe recovery does not expose raw diagnostics');
};
const refresh = async (after, horizon = 3) => {
  await refreshButton().click();
  await expectLoading();
  return pending(after, horizon);
};
const expectReady = async () => {
  await table().waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByText(loadingText, {exact: true}).count(), 0);
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await reportButton().isEnabled(), true);
  assert.equal(await csvButton().isEnabled(), true);
  assert.equal(await page.getByRole('link', {name: 'Reports', exact: true}).getAttribute('href'), '/reports/utilization');
};
const expectRows = async (tag, horizon = 3, chosen = golden) => {
  const expected = chosen.map(row => ({href: `/employees/${tag}-${row.suffix}`, cells: [
    ...row.loads.slice(0, horizon + 1).map(percent), percent(Math.max(...row.loads.slice(0, horizon + 1))), row.status,
  ]}));
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('table tbody tr')].filter(row => row.querySelector('a')).map(row => ({
    href: row.querySelector('a').getAttribute('href'), cells: [...row.cells].slice(2).map(cell => cell.textContent.trim()),
  }))) === JSON.stringify(expected), expected);
  assert.deepEqual(await table().locator('thead th').allTextContents(), ['Consultant', 'Department', ...checkpoints.slice(0, horizon + 1), 'Peak', 'Status']);
  assert.deepEqual(await table().locator('tbody tr').evaluateAll(rows => rows.filter(row => row.querySelector('a')).map(row => ({
    href: row.querySelector('a').getAttribute('href'), cells: [...row.cells].slice(2).map(cell => cell.textContent.trim()),
  }))), expected, 'eligible employee order, inclusive monthly checkpoints, rounding, peaks and configured status thresholds are unchanged');
};
const expectSuccess = async (tag, horizon = 3) => {
  await expectRows(tag, horizon);
  await expectReady();
};
const expectEmpty = async () => {
  await page.getByRole('status').getByText(emptyText, {exact: true}).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await expectNoMeasurements();
  assert.equal(await reportButton().isEnabled(), true, 'current-ready composite empty retains header empty CSV');
  assert.equal(await csvButton().isEnabled(), true);
};
const expectKpis = async horizon => {
  const values = [['Projected Avg. Util.', ({1: '53.2%', 2: '57.7%', 3: '52.8%'})[horizon]], ['Projects below 100% allocation', ({1:'2',2:'4',3:'3'})[horizon]],
    ['Overload Risk', '2'], ['Future Bench', horizon === 3 ? '3' : '2'], ['Demand Pressure', 'Within threshold'], ['Active Horizon', `${horizon} ${horizon === 1 ? 'Month' : 'Months'}`]];
  for (const [title, value] of values) assert.equal(await kpi(title).getByText(value, {exact: true}).count(), 1, `unchanged ${title}`);
};
const captureExports = label => page.evaluate(label => {
  window.forecastHarness.capture('Forecast Report', `${label}-report`);
  window.forecastHarness.capture('Forecast', `${label}-csv`);
}, label);
const invokeCaptured = labels => page.evaluate(labels => window.forecastHarness.invoke(labels), labels);
const invalidateAndInvoke = async (after, labels, horizon = 3, nextHorizon) => {
  const before = await effects();
  await page.evaluate(({labels, nextHorizon}) => nextHorizon
    ? window.forecastHarness.horizonAndInvoke(`${nextHorizon} ${nextHorizon === 1 ? 'Month' : 'Months'}`, labels)
    : window.forecastHarness.refreshAndInvoke(labels), {labels, nextHorizon});
  await expectNoNewEffects(before, 'retained handlers are invalid synchronously before horizon/refresh rerender or effects');
  await expectLoading();
  return pending(after, nextHorizon || horizon);
};
const csv = rows => rows.length ? [Object.keys(rows[0]), ...rows.map(row => Object.values(row))].map(row => row.map(value => {
  const text = String(value);
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}).join(',')).join('\n') : '';
const expectedCsv = (tag, horizon = 3, chosen = golden) => {
  const byId = new Map(employees(tag).map(person => [person.id, person]));
  return csv(chosen.map(row => {
    const person = byId.get(`${tag}-${row.suffix}`);
    return {employeeId: person.employeeId, name: person.name, department: person.department, country: person.country,
      currentPlannedUtilization: person.plannedUtilization, averageFutureLoad: row.average[horizon],
      peakForecastLoad: Math.max(...row.loads.slice(0, horizon + 1)), horizonLoad: row.horizon[horizon], status: row.status,
      ...Object.fromEntries(checkpoints.slice(0, horizon + 1).map((point, index) => [point, row.loads[index]])),
      horizon: `${horizon} ${horizon === 1 ? 'Month' : 'Months'}`,sourceDate:dates[0],horizonDate:dates[horizon]};
  }));
};
const expectExport = async (name, tag, horizon = 3, chosen = golden, expectedContent) => {
  const before = await effects();
  const [download] = await Promise.all([page.waitForEvent('download'), button(name).click()]);
  const fileName = 'forecast-utilization-export.csv';
  assert.equal(download.suggestedFilename(), fileName);
  assert.equal(await download.failure(), null);
  const stream = await download.createReadStream();
  assert(stream, 'real unchanged CSV helper supplies browser download bytes');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), expectedContent ?? expectedCsv(tag, horizon, chosen), 'exact unchanged CSV fields, dynamic horizon keys, row order, raw numbers, quoting and formula protection');
  await page.waitForFunction(count => window.forecastHarness.writes.length >= count, before.writes + 1);
  assert.deepEqual(await effects(), {downloads: before.downloads + 1, writes: before.writes + 1});
  const [history] = await page.evaluate(start => window.forecastHarness.writes.slice(start), before.writes);
  const scope = {organizationId: 'synthetic-organization', legalEntityId: 'synthetic-legal-entity'};
  assert.deepEqual(history, {path: '/api/import-export-logs', scope, body: {
    operation: 'Export', channel: 'Forecast Utilization', fileName, status: 'Success', totalRows: chosen.length, validRows: chosen.length, errorRows: 0,
  }});
  deliberateExports++;
};
const expectChart = async horizon => {
  const root = chart();
  const selector = '.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value';
  const labels = dates.slice(0, horizon + 1);
  await root.locator(mainChartSvg).waitFor();
  const handle = await root.elementHandle();
  try {
    await page.waitForFunction(({root, selector, labels}) => JSON.stringify([...root.querySelectorAll(selector)].map(tick => {
      const lines = [...tick.querySelectorAll('tspan')];
      return lines.length ? lines.map(line => line.textContent).join(' ') : tick.textContent;
    })) === JSON.stringify(labels), {root: handle, selector, labels});
    assert.deepEqual(await root.locator(selector).evaluateAll(ticks => ticks.map(tick => {
      const lines = [...tick.querySelectorAll('tspan')];
      return lines.length ? lines.map(line => line.textContent).join(' ') : tick.textContent;
    })), labels, 'chart keeps native month overflow, inclusive endpoints and distinct dated March checkpoints');
    // Recharts rectangle height ratios prove the actual plotted values, using
    // capacity as scale. Wait out animation before asserting exact ratios.
    const expected = [800, 900, 900, 900].slice(0, horizon + 1);
    const demand = [525.14, 565.14, 565.14, 475.14].slice(0, horizon + 1);
    await page.waitForFunction(({root, expected, demand}) => {
      const bars = [...root.querySelectorAll('.recharts-bar-rectangles')].map(group => [...group.querySelectorAll('path.recharts-rectangle')].map(path => Number(path.getAttribute('height'))));
      if (bars.length !== 2 || bars.some(series => series.length !== expected.length)) return false;
      return expected.every((value, index) => bars[0][index] > 0 && Math.abs(bars[1][index] / bars[0][index] - demand[index] / value) < 0.001)
        && expected.every((value, index) => Math.abs(bars[0][index] / bars[0][0] - value / expected[0]) < 0.001);
    }, {root: handle, expected, demand});
  } finally { await handle.dispose(); }
};
const expectNarrowFit = async locator => {
  await locator.waitFor();
  const bounds = await locator.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'safe announced state and recovery controls fit a narrow viewport');
};

try {
  await page.goto(`${baseUrl}/tests/fixtures/forecast-utilization.html`);
  assert.equal(await button('3 Months').getAttribute('aria-pressed'), 'true', 'default three-month horizon is preserved');
  await expectLoading();
  const initial = await pending();
  await settleOne(initial.find(item => item.reader === 'forecast'), bundle().forecast);
  await expectLoading();
  await settleOne(initial.find(item => item.reader === 'employees'), undefined, 500);
  for (const item of initial.filter(item => !['forecast', 'employees'].includes(item.reader))) await settleOne(item, bundle()[item.reader]);
  await expectSafeError(genericError);

  await retryButton().focus();
  await page.keyboard.press('Enter');
  await expectLoading();
  const recovered = await pending(lastId(initial));
  await settle(recovered);
  await expectSuccess('baseline');
  await expectKpis(3);
  await expectChart(3);
  await page.getByText('65.6% in 2026-01-31', {exact: true}).waitFor();
  await page.getByText('Allocated demand is within capacity at the measured checkpoints.', {exact: true}).waitFor();
  await page.getByText('Measured allocation pressure is within the 90% review threshold.', {exact: true}).waitFor();
  const rolloffs = riskGroup('Upcoming Roll-offs (3 Months)');
  const rollNames = ['director', 'inactive', 'admin', 'excluded', 'hr'].map(suffix => `Synthetic baseline-${suffix}`);
  await page.waitForFunction(names => {
    const heading = [...document.querySelectorAll('h6')].find(h => h.textContent === 'Upcoming Roll-offs (3 Months)');
    return heading && JSON.stringify([...heading.parentElement.querySelectorAll('a')].map(link => link.textContent)) === JSON.stringify(names);
  }, rollNames);
  assert.deepEqual(await rolloffs.getByRole('link').allTextContents(), rollNames, 'active roll-offs preserve eligibility independence, ascending dates and top-five truncation');
  assert.deepEqual(await rolloffs.locator('span').allTextContents(), ['31 Jan', '01 Feb', '02 Feb', '03 Feb', '04 Feb']);
  assert.deepEqual(await riskGroup('Future Bench Watch').getByRole('link').locator('p:first-child').allTextContents(),
    ['Synthetic baseline-beta', 'Synthetic baseline-delta', 'Synthetic baseline-pm-mapped'], 'authoritative report zero puts beta on bench while omitted gamma/PM rows use successful checkpoint fallback');
  for (const suffix of ['pm-never', 'inactive', 'excluded', 'admin', 'hr', 'director']) assert.equal(await table().getByText(`Synthetic baseline-${suffix}`, {exact: true}).count(), 0);
  await expectExport('Forecast Report', 'baseline');
  await search().fill('ALPHA');
  await expectRows('baseline', 3, [golden[0]]);
  await expectExport('Forecast', 'baseline', 3, [golden[0]]);
  await search().fill('SYN-baseline-gamma');
  await expectRows('baseline', 3, [golden[2]]);
  await expectExport('Forecast Report', 'baseline', 3, [golden[2]]);
  await search().fill('');
  await department().selectOption('Synthetic Engineering');
  await expectRows('baseline', 3, [golden[1], golden[2]]);
  await expectExport('Forecast', 'baseline', 3, [golden[1], golden[2]]);
  await search().fill('no-synthetic-match');
  await table().getByRole('status').getByText(filteredEmptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  await expectKpis(3);
  await expectChart(3);
  assert.equal(await rolloffs.getByRole('link').count(), 5, 'filter-empty ledger retains useful independent roll-offs and chart');
  await expectExport('Forecast Report', 'baseline', 3, []);
  await expectExport('Forecast', 'baseline', 3, []);
  await search().fill('');
  await department().selectOption('All Departments');
  await expectSuccess('baseline');
  await captureExports('baseline');
  const sameHorizonCalls = await page.evaluate(() => window.forecastHarness.calls.length);
  await button('3 Months').click();
  await flush();
  assert.equal(await page.evaluate(() => window.forecastHarness.calls.length), sameHorizonCalls, 'reselecting the current horizon is a safe no-op');
  await expectSuccess('baseline');

  // Invalidate in the same JS turn as selection, before React rerender/effects.
  const oneMonth = await invalidateAndInvoke(lastId(recovered), ['baseline-report', 'baseline-csv'], 3, 1);
  await verifyNoMeasurementsGuard();
  await settle(oneMonth, bundle('one-month', 1));
  await expectSuccess('one-month', 1);
  await expectKpis(1);
  await expectChart(1);
  await expectExport('Forecast Report', 'one-month', 1);
  await expectExport('Forecast', 'one-month', 1);
  await captureExports('one-month');
  const twoMonths = await invalidateAndInvoke(lastId(oneMonth), ['one-month-report', 'one-month-csv'], 1, 2);
  await settle(twoMonths, bundle('two-months', 2));
  await expectSuccess('two-months', 2);
  await expectKpis(2);
  await expectChart(2);
  await expectExport('Forecast Report', 'two-months', 2);
  await expectExport('Forecast', 'two-months', 2);
  await captureExports('two-months');
  const threeMonths = await invalidateAndInvoke(lastId(twoMonths), ['two-months-report', 'two-months-csv'], 2, 3);
  await settle(threeMonths, bundle('three-months'));
  await expectSuccess('three-months');
  await expectKpis(3);
  await expectChart(3);
  const beforeOldHorizons = await effects();
  await invokeCaptured(['baseline-report', 'baseline-csv', 'one-month-report', 'one-month-csv', 'two-months-report', 'two-months-csv']);
  await expectNoNewEffects(beforeOldHorizons, 'matching a formerly selected horizon never revives an older generation callback');

  // Each independently delayed dependency holds all measurements atomic.
  let after = lastId(threeMonths);
  for (const delayed of readers) {
    const attempt = await refresh(after);
    const data = bundle(`partial-${delayed}`);
    for (const item of attempt.filter(item => item.reader !== delayed)) await settleOne(item, data[item.reader]);
    await expectLoading();
    await settleOne(attempt.find(item => item.reader === delayed), data[delayed]);
    await expectSuccess(`partial-${delayed}`);
    after = lastId(attempt);
  }
  await search().fill('gamma');
  await department().selectOption('Synthetic Engineering');
  await captureExports('before-failures');
  let firstFailure = true;
  for (const reader of readers) {
    for (const status of [401, 403, 404, 500, 502, 503, 504, 'network']) {
      const attempt = firstFailure
        ? await invalidateAndInvoke(after, ['before-failures-report', 'before-failures-csv'])
        : await refresh(after);
      firstFailure = false;
      const before = await effects();
      await settle(attempt, bundle('failed-partial'), {reader, status});
      await expectSafeError([401, 403].includes(status) ? accessError : [404, 502, 503, 504].includes(status) ? unavailableError : genericError);
      await invokeCaptured(['before-failures-report', 'before-failures-csv']);
      await expectNoNewEffects(before, 'failed evidence, including failed forecast, never enables old CSV or successful omitted-row fallback');
      assert.equal((await page.locator('body').innerText()).includes('Synthetic failed-partial'), false);
      after = lastId(attempt);
    }
  }
  await retryButton().click();
  await expectLoading();
  const afterFailures = await pending(after);
  await settle(afterFailures, bundle('after-failures'));
  await expectReady();
  await expectRows('after-failures', 3, [golden[2]]);
  assert.equal(await search().inputValue(), 'gamma');
  assert.equal(await department().inputValue(), 'Synthetic Engineering', 'search and department survive retry/recovery');
  const beforeFailureCallbacks = await effects();
  await invokeCaptured(['before-failures-report', 'before-failures-csv']);
  await expectNoNewEffects(beforeFailureCallbacks, 'older handlers remain invalid after new ready evidence');
  await search().fill('');
  await department().selectOption('All Departments');

  // A real server zero must win over a NONZERO final checkpoint. Alpha's
  // allocation still yields 80% at every checkpoint and an 80% future average.
  const authoritativeZero = await refresh(lastId(afterFailures));
  const zeroData = bundle('authoritative-zero');
  zeroData.forecast.rows[0].plannedUtilization = 0;
  const zeroGolden = golden.map(row => row.suffix === 'alpha'
    ? {...row, horizon: {...row.horizon, 3: 0}, status: 'Future Bench'} : row);
  await settle(authoritativeZero, zeroData);
  await expectReady();
  await expectRows('authoritative-zero', 3, zeroGolden);
  assert.equal(await kpi('Projected Avg. Util.').getByText('43.9%', {exact: true}).count(), 1);
  assert.equal(await kpi('Future Bench').getByText('4', {exact: true}).count(), 1);
  assert.deepEqual(await riskGroup('Future Bench Watch').getByRole('link').locator('p:first-child').allTextContents(),
    ['Synthetic authoritative-zero-beta', 'Synthetic authoritative-zero-alpha, "quoted"', 'Synthetic authoritative-zero-delta', 'Synthetic authoritative-zero-pm-mapped']);
  await expectExport('Forecast Report', 'authoritative-zero', 3, zeroGolden);
  await expectExport('Forecast', 'authoritative-zero', 3, zeroGolden);

  // Successful omission of that same employee restores its nonzero fallback.
  // Omission of all rows is still successful evidence, never a failed report.
  const omitted = await refresh(lastId(authoritativeZero));
  const omittedData = bundle('omitted-report');
  omittedData.forecast.rows = [];
  await settle(omitted, omittedData);
  await expectSuccess('omitted-report');
  await page.getByText(emptyText, {exact: true}).waitFor({state: 'detached'});
  await expectExport('Forecast Report', 'omitted-report');
  await expectExport('Forecast', 'omitted-report');

  // Seven successful zero-horizon rows retain the five-highest-current bench
  // watch order without hiding total bench count or the zero-valued chart.
  const bench = await refresh(lastId(omitted));
  const benchPeople = [10, 70, 30, 60, 20, 50, 40].map((load, index) => employee('bench', String(index), load));
  await settle(bench, {employees: benchPeople, projects: [], allocations: [], settings,
    forecast: {...forecastPeriod(3),rows: benchPeople.map(person => ({...person, plannedUtilization: 0}))}});
  await expectReady();
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr a').length === 7);
  assert.deepEqual(await riskGroup('Future Bench Watch').getByRole('link').locator('p:first-child').allTextContents(),
    [1, 3, 5, 6, 2].map(index => `Synthetic bench-${index}`), 'bench watch uses descending current planned load and top five');
  assert.equal(await kpi('Future Bench').getByText('7', {exact: true}).count(), 1);
  await page.getByText('0% in 2026-01-31',{exact:true}).waitFor();
  await page.getByRole('status').getByText('No roll-offs inside this horizon', {exact: true}).waitFor();
  assert.equal(await chart().locator(mainChartSvg).count(), 1, 'successful zero demand keeps its real chart');

  const pressure = await refresh(lastId(bench));
  const pressurePerson = employee('pressure', 'only', 125);
  await settle(pressure, {employees: [pressurePerson], projects: [project('pressure', 'steady')], settings,
    allocations: [allocation('pressure', 'steady', 'only', 'steady', 125)], forecast: {...forecastPeriod(3),rows: [{...pressurePerson, plannedUtilization: 125}]}});
  await expectReady();
  await page.getByText('125% in 2026-01-31', {exact: true}).waitFor();
  await page.getByText('Allocations exceed capacity by 25 allocation percentage points at this checkpoint.', {exact: true}).waitFor();
  await page.getByText('Peak demand reaches 125% of active capacity; review hiring or project start dates.', {exact: true}).waitFor();
  assert.equal(await kpi('Demand Pressure').getByText('Above threshold', {exact: true}).count(), 1);
  await page.getByRole('status').getByText('No future bench cases in this horizon', {exact: true}).waitFor();

  // Resource-ledger empty does not suppress independent active-allocation
  // roll-offs, even when their people/projects are not utilization-eligible.
  const sectionEmpty = await refresh(lastId(pressure));
  const sectionData = bundle('section-empty');
  sectionData.employees = sectionData.employees.slice(10);
  await settle(sectionEmpty, sectionData);
  await page.getByText('Capacity unavailable',{exact:true}).waitFor();
  await page.getByText('No staffing signal is available without eligible capacity.',{exact:true}).waitFor();
  assert.equal(await kpi('Demand Pressure').getByText('Unavailable',{exact:true}).count(),1);
  await expectReady();
  await table().getByRole('status').getByText(sectionEmptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0);
  assert.equal(await riskGroup('Upcoming Roll-offs (3 Months)').getByRole('link').count(), 5);
  assert.equal(await chart().locator(mainChartSvg).count(), 1);
  await expectExport('Forecast Report', 'section-empty', 3, []);
  await expectExport('Forecast', 'section-empty', 3, []);

  // Check roll-off inclusive start/end boundaries without top-five truncation.
  const boundary = await refresh(lastId(sectionEmpty));
  const boundaryPerson = employee('boundary', 'excluded', 0, {utilizationEligible: false});
  const boundaryData = {employees: [boundaryPerson], projects: [project('boundary', 'completed', 'Completed')], settings,
    allocations: ['2026-01-30', '2026-01-31', '2026-03-03', '2026-03-04', '2026-05-01', '2026-05-02'].map((date, index) =>
      allocation('boundary', String(index), 'excluded', 'completed', index + 1, '2026-01-01', date)), forecast: {...forecastPeriod(3),rows: []}};
  await settle(boundary, boundaryData);
  await expectReady();
  await table().getByRole('status').getByText(sectionEmptyText, {exact: true}).waitFor();
  assert.deepEqual(await riskGroup('Upcoming Roll-offs (3 Months)').locator('span').allTextContents(), ['31 Jan', '03 Mar', '04 Mar', '01 May']);
  await button('1 Month').click();
  const boundaryOne = await pending(lastId(boundary), 1);
  await settle(boundaryOne, {...boundaryData,forecast:{...forecastPeriod(1),rows:[]}});
  await expectReady();
  await page.waitForFunction(() => [...document.querySelectorAll('h6')].some(h => h.textContent === 'Upcoming Roll-offs (1 Month)'));
  assert.deepEqual(await riskGroup('Upcoming Roll-offs (1 Month)').locator('span').allTextContents(), ['31 Jan', '03 Mar']);
  await button('3 Months').click();
  const noRoster = await pending(lastId(boundaryOne));
  const noRosterData = bundle('no-roster');
  noRosterData.employees = [];
  await settle(noRoster, noRosterData);
  await expectReady();
  await table().getByRole('status').getByText(sectionEmptyText, {exact: true}).waitFor();
  assert.equal(await page.getByText(emptyText, {exact: true}).count(), 0, 'nonempty projects/allocations/report rows prevent false composite empty');
  await chart().getByRole('status').getByText('No capacity and demand checkpoints were returned for this horizon.', {exact: true}).waitFor();
  const empty = await refresh(lastId(noRoster));
  await settle(empty, bundle('genuine-empty', 3, {empty: true}));
  await expectEmpty();
  await expectExport('Forecast Report', 'genuine-empty', 3, []);
  await expectExport('Forecast', 'genuine-empty', 3, []);
  const restored = await refresh(lastId(empty));
  await settle(restored, bundle('restored'));
  await expectSuccess('restored');
  await captureExports('before-races');

  // Six stale-result permutations: old success/error while current pending,
  // after current success, and after current error, never changing that state.
  let latest = restored;
  for (const [oldKind, newKind] of [['success', 'pending'], ['error', 'pending'], ['success', 'success'], ['error', 'success'], ['success', 'error'], ['error', 'error']]) {
    const old = await refresh(lastId(latest));
    const current = await refresh(lastId(old));
    const oldFailure = oldKind === 'error' ? {reader: 'forecast', status: 503} : undefined;
    const currentFailure = newKind === 'error' ? {reader: 'employees', status: 403} : undefined;
    const tag = `race-${oldKind}-${newKind}`;
    if (newKind === 'pending') {
      await settle(old, bundle(`stale-${tag}`), oldFailure);
      await flush();
      await expectLoading();
      await settle(current, bundle(tag));
      await expectSuccess(tag);
    } else {
      await settle(current, bundle(tag), currentFailure);
      if (newKind === 'error') await expectSafeError(accessError);
      else await expectSuccess(tag);
      await settle(old, bundle(`stale-${tag}`), oldFailure);
      await flush();
      if (newKind === 'error') await expectSafeError(accessError);
      else await expectSuccess(tag);
    }
    assert.equal((await page.locator('body').innerText()).includes(`Synthetic stale-${tag}`), false);
    latest = current;
  }
  await retryButton().click();
  const beforeHorizonRace = await pending(lastId(latest));
  await settle(beforeHorizonRace, bundle('before-horizon-race'));
  await expectSuccess('before-horizon-race');
  await captureExports('before-horizon-race');
  const oldOne = await invalidateAndInvoke(lastId(beforeHorizonRace), ['before-horizon-race-report', 'before-horizon-race-csv'], 3, 1);
  await button('3 Months').click();
  await expectLoading();
  const oldThree = await pending(lastId(oldOne), 3);
  await button('1 Month').click();
  await expectLoading();
  const latestOne = await pending(lastId(oldThree), 1);
  await settle(oldOne, bundle('stale-first-one', 1));
  await flush();
  await expectLoading();
  await settle(latestOne, bundle('latest-one', 1));
  await expectSuccess('latest-one', 1);
  await settle(oldThree, bundle('stale-three'), {reader: 'settings', status: 'network'});
  await flush();
  await expectSuccess('latest-one', 1);
  const beforeStale = await effects();
  await invokeCaptured(['before-races-report', 'before-races-csv', 'before-horizon-race-report', 'before-horizon-race-csv']);
  await expectNoNewEffects(beforeStale, 'stale permutations and 1→3→1 never restore prior export authority');

  // Pending and directly ready unmounts invalidate callbacks across new mounts.
  await captureExports('unmounted');
  const unmountedSuccess = await refresh(lastId(latestOne), 1);
  await page.evaluate(() => window.forecastHarness.hide());
  await page.getByRole('heading', {name: 'Forecast Utilization', exact: true}).waitFor({state: 'detached'});
  const beforeUnmount = await effects();
  await invokeCaptured(['unmounted-report', 'unmounted-csv']);
  await expectNoNewEffects(beforeUnmount, 'callbacks cannot export after pending unmount');
  await page.evaluate(() => window.forecastHarness.show());
  await expectLoading();
  const remounted = await pending(lastId(unmountedSuccess));
  await settle(remounted, bundle('remounted'));
  await expectSuccess('remounted');
  await settle(unmountedSuccess, bundle('unmounted-success', 1));
  await flush();
  await expectSuccess('remounted');
  await invokeCaptured(['unmounted-report', 'unmounted-csv']);
  await expectNoNewEffects(beforeUnmount, 'callbacks from a prior mount remain invalid after ready remount');
  await captureExports('ready-unmounted');
  await page.evaluate(() => window.forecastHarness.hide());
  await page.getByRole('heading', {name: 'Forecast Utilization', exact: true}).waitFor({state: 'detached'});
  await invokeCaptured(['ready-unmounted-report', 'ready-unmounted-csv']);
  await expectNoNewEffects(beforeUnmount, 'directly ready unmount invalidates both retained export handlers');
  await page.evaluate(() => window.forecastHarness.show());
  await expectLoading();
  const readyRemounted = await pending(lastId(remounted));
  await settle(readyRemounted, bundle('ready-remounted'));
  await expectSuccess('ready-remounted');
  await invokeCaptured(['ready-unmounted-report', 'ready-unmounted-csv']);
  await expectNoNewEffects(beforeUnmount, 'directly unmounted handlers cannot use fresh mount evidence');
  const unmountedError = await refresh(lastId(readyRemounted));
  await page.evaluate(() => window.forecastHarness.hide());
  await page.getByRole('heading', {name: 'Forecast Utilization', exact: true}).waitFor({state: 'detached'});
  await settle(unmountedError, bundle('unmounted-error'), {reader: 'forecast', status: 'network'});
  await flush();
  assert.equal(await page.locator('#root').innerText(), '');
  await page.evaluate(() => window.forecastHarness.show());
  const narrowFailure = await pending(lastId(unmountedError));
  await page.setViewportSize({width: 390, height: 844});
  await expectLoading();
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
  await refreshButton().focus();
  await page.keyboard.press('Enter');
  await expectLoading();
  const narrowEmpty = await pending(lastId(narrowRecovery));
  await settle(narrowEmpty, bundle('narrow-empty', 3, {empty: true}));
  await expectEmpty();
  await expectNarrowFit(page.getByRole('status').filter({hasText: emptyText}));

  const calls = await page.evaluate(() => window.forecastHarness.calls);
  assert.equal(calls.length % 5, 0);
  for (let index = 0; index < calls.length; index += 5) {
    assert.deepEqual(calls.slice(index, index + 5).map(item => item.reader), readers, 'every load retains all five reader contracts');
    assert.deepEqual(calls.slice(index, index + 4).map(item => item.args), [[], [], [], []]);
    assert([1, 2, 3].includes(calls[index + 4].args[0]) && calls[index + 4].args.length === 1);
  }
  assert.equal(await page.evaluate(() => window.forecastHarness.pending.length), 0);
  assert.equal(downloads.length, deliberateExports, 'only deliberate current-ready exports produce files');
  assert.equal(await page.evaluate(() => window.forecastHarness.writes.length), deliberateExports, 'only deliberate exports produce exact scoped history and audit');
  assert.deepEqual(await page.evaluate(() => window.forecastHarness.legacyAuditCalls), []);
  assert((await page.evaluate(() => window.forecastHarness.healthReads.length)) > 0, 'unchanged helper performs actual cached health through the synthetic boundary');
  assert.deepEqual(await page.evaluate(() => window.forecastHarness.unexpectedFetches), []);
  assert.deepEqual(unexpectedApi, [], 'no real API requests');
  assert.deepEqual(unexpectedRemote, [], 'no provider or off-origin traffic');
  assert.deepEqual(pageErrors, [], 'safe failures and stale promises create no unhandled page errors');
  console.log('Forecast utilization browser passed: five-reader safe failures/atomic recovery, native month/horizon/checkpoint and eligibility/calculation oracles, zero vs omitted report fallback, useful genuine/section/filter empties, synchronous stale-handler/1→3→1/six-permutation/unmount suppression, both real CSV/history/audit exports, narrow keyboard retry/refresh and no real backend/provider traffic.');
} finally { await browser.close(); }
