// Synthetic API responses through the real production-mode React transport/decoder.
// No database, seed, mutation API, authentication provider or business clock is changed.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {day, scope, user, pending, base, next} from './support/operational-attention-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({root, mode: 'production', clearScreen: false, logLevel: 'error', server: {host: '127.0.0.1', port: 0, hmr: false}, define: {'import.meta.env.VITE_APP_MODE': JSON.stringify('production'), 'import.meta.env.VITE_ALLOW_TEST_FALLBACK': JSON.stringify('false')}});
let browser;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({headless: true, ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {})});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}});
  await context.addInitScript(({user, scope}) => {
    sessionStorage.setItem('workos_session', JSON.stringify(user));
    sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
    sessionStorage.setItem('workos_api_token', 'synthetic-attention-token');
  }, {user, scope});
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], requests = [], unexpected = [], external = [];
  let release, dispatched, delayed = false, fail = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());});
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({method: request.method(), path: url.pathname});
    if (request.method() !== 'GET' || url.pathname !== '/api/v1/operational-control/snapshot') {unexpected.push(requests.at(-1)); return route.abort();}
    if (delayed) {dispatched(); await new Promise(resolve => {release = resolve;});}
    await route.fulfill({status: fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(fail ? {error: {message: 'Synthetic source unavailable'}} : url.searchParams.has('after') ? next : base)});
  });
  await page.goto(origin + '/tests/fixtures/operational-control.html');
  const attention = page.getByRole('region', {name: 'Operational attention', exact: true});
  const fillSelection = async () => {
    for (const label of ['Control actual starts', 'Control actual ends', 'Control forecast starts']) await page.getByLabel(label, {exact: true}).fill(day);
    await page.getByLabel('Control forecast months', {exact: true}).selectOption('1');
  };
  await fillSelection();
  await page.getByRole('button', {name: 'Load operational control', exact: true}).click();
  await attention.waitFor();
  assert.equal(requests.length, 1);
  assert.match(await attention.innerText(), /2 \/ 10/);
  assert.match(await attention.innerText(), /Visible pending stages\s+5/);
  assert.match(await attention.innerText(), /hidden counts are unknown/);
  assert.equal(await attention.getByRole('article').count(), 8);
  await attention.getByRole('button', {name: /Show more attention items/}).click();
  assert.equal(await attention.getByRole('article').count(), 12);
  await attention.getByRole('button', {name: 'Pending reviews 5', exact: true}).click();
  assert.equal(await attention.getByRole('article').count(), 5);
  assert.match(await attention.getByRole('article').first().innerText(), /5 whole days/);
  await attention.getByLabel('Search current-page attention', {exact: true}).fill('ÁLVARO');
  assert.equal(await attention.getByRole('article').count(), 5);
  await attention.getByLabel('Search current-page attention', {exact: true}).fill('absent-worker');
  await attention.getByText('No attention items match these filters.', {exact: true}).waitFor();
  await attention.getByRole('button', {name: 'Clear attention filters', exact: true}).click();
  assert.equal(await attention.getByRole('article').count(), 8);
  await attention.getByRole('button', {name: 'Pending reviews 5', exact: true}).click();
  await attention.getByRole('article').first().getByRole('button').click();
  const handoff = page.getByRole('region', {name: 'Operational source handoff', exact: true});
  assert.equal(await handoff.getByLabel('Bulk instance reference', {exact: true}).inputValue(), pending[4].id);
  assert.equal(await handoff.getByLabel('Bulk source kind', {exact: true}).inputValue(), 'Work');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Operational source handoff');
  assert.equal(requests.length, 1, 'Opening a queue item does not inspect, decide or mutate automatically');
  await page.getByRole('button', {name: 'Close operational handoff', exact: true}).click();
  assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), /Open source review for SYN-0/);
  await attention.getByRole('button', {name: 'Data gaps 4', exact: true}).click();
  await attention.getByRole('button', {name: 'Inspect actual source for SYN-1: Actual work unavailable', exact: true}).click();
  assert.equal(await handoff.getByLabel('Governed actual worker', {exact: true}).inputValue(), 'worker-01');
  assert.equal(await handoff.getByLabel('Actual period starts', {exact: true}).inputValue(), day);
  await page.getByRole('button', {name: 'Close operational handoff', exact: true}).click();
  await attention.getByRole('button', {name: 'Staffing signals 3', exact: true}).click();
  await attention.getByRole('article').first().getByRole('button').click();
  assert.equal(await handoff.getByLabel('Forecast worker', {exact: true}).inputValue(), 'worker-00');
  assert.equal(requests.length, 1);
  await page.getByRole('button', {name: 'Close operational handoff', exact: true}).click();
  await attention.getByRole('button', {name: 'All attention 12', exact: true}).click();
  if (process.env.WORKOS_ATTENTION_SCREENSHOT_DIR) {
    await mkdir(process.env.WORKOS_ATTENTION_SCREENSHOT_DIR, {recursive: true});
    await attention.screenshot({path: process.env.WORKOS_ATTENTION_SCREENSHOT_DIR + '/attention-desktop.png'});
  }
  await page.setViewportSize({width: 390, height: 844});
  assert(await attention.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Attention panel fits a narrow viewport');
  if (process.env.WORKOS_ATTENTION_SCREENSHOT_DIR) await attention.screenshot({path: process.env.WORKOS_ATTENTION_SCREENSHOT_DIR + '/attention-mobile.png'});
  await attention.getByLabel('Search current-page attention', {exact: true}).fill('Álvaro');
  await page.getByRole('button', {name: 'Next scoped control page', exact: true}).click();
  await attention.getByText('No attention signals in the returned sources', {exact: true}).waitFor();
  assert.equal(await attention.getByLabel('Search current-page attention', {exact: true}).inputValue(), '', 'Filters are reset for a new source page');
  assert.match(await attention.innerText(), /0 \/ 1/);
  assert.equal(await attention.getByText('Synthetic Álvaro', {exact: false}).count(), 0);
  await page.getByRole('button', {name: 'Refresh control from first page', exact: true}).click();
  await attention.getByRole('button', {name: 'Pending reviews 5', exact: true}).waitFor();
  // Same mounted view: token/role/scope loss cannot reuse old queue sources.
  await page.evaluate(() => {sessionStorage.setItem('workos_api_token', 'synthetic-replaced-token'); window.dispatchEvent(new Event('focus'));});
  await page.getByText(/Account, active role, token or scope changed/).waitFor();
  assert.equal(await attention.count(), 0);
  await fillSelection();
  await page.getByRole('button', {name: 'Load operational control', exact: true}).click();
  await attention.waitFor();
  delayed = true;
  const started = new Promise(resolve => {dispatched = resolve;});
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/operational-control/snapshot');
  await page.getByRole('button', {name: 'Refresh control from first page', exact: true}).click();
  await started;
  await page.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
  release(); await completed;
  await page.getByText(/Account, active role, token or scope changed/).waitFor();
  assert.equal(await attention.count(), 0, 'Late response cannot restore cleared attention');
  assert.equal(await handoff.count(), 0);
  delayed = false; fail = true;
  await fillSelection();
  await page.getByRole('button', {name: 'Load operational control', exact: true}).click();
  await page.getByText(/Operational snapshot could not be confirmed/).waitFor();
  assert.equal(await attention.count(), 0, 'Failed source never appears as an empty successful queue');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, []);
  assert(requests.every(request => request.method === 'GET'));
  console.log('Operational attention browser passed: real React/production decoder with synthetic API only; page coverage, restricted/limited counts, search/filter/ordering, bounded reveal, original-source handoffs without automatic requests, mobile fit, pagination reset, context/late-response clear and failure isolation. No PostgreSQL or real approval decision validation claimed.');
} finally {await browser?.close(); await vite.close();}
