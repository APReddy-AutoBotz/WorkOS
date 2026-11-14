import assert from 'node:assert/strict';
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const rows = Array.from({length: 10}, (_, index) => ({
  id: `batch-${index}`, operation: 'Import', channel: 'Employee CSV', fileName: `synthetic-${index}.csv`,
  status: 'Partial', totalRows: 26, validRows: 1, errorRows: 25,
  userName: 'Synthetic Admin', timestamp: '2026-10-15T00:00:00Z',
  errors: Array.from({length: 25}, (_, row) => ({rowNumber: row + 2, field: 'employeeId',
    sourceIdentifier: row === 0 ? '<img src=x onerror=alert(1)>' : null, message: `Synthetic diagnostic ${row + 1}`})),
}));
const settle = async (data, reject = false) => {
  await page.waitForFunction(() => window.historyHarness.pending.length > 0);
  await page.evaluate(({data, reject}) => {
    const request = window.historyHarness.pending.shift();
    if (reject) request.reject(new Error('private diagnostic must not render'));
    else request.resolve(data);
  }, {data, reject});
};
try {
  await page.goto(`${baseUrl}/tests/fixtures/import-history-panel.html`);
  await page.getByText('Loading operation history…').waitFor();
  assert.equal(await page.getByText('No bulk data operations', {exact: false}).count(), 0);
  await settle(rows);
  await page.getByText('Page 1 of 2', {exact: true}).waitFor();
  const firstBatch = page.locator('section[aria-labelledby="import-history-title"] > ul > li').first();
  const firstDiagnostics = firstBatch.locator('ol[aria-label="Row diagnostics for synthetic-0.csv"]');
  const summary = firstBatch.getByText('View details for synthetic-0.csv', {exact: true});
  await summary.focus();
  await page.keyboard.press('Enter');
  await firstDiagnostics.getByText('Synthetic diagnostic 1', {exact: true}).waitFor();
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await firstDiagnostics.getByText('Synthetic diagnostic 21', {exact: true}).count(), 0);
  await firstBatch.getByRole('button', {name: 'Show more row diagnostics'}).click();
  await firstDiagnostics.getByText('Synthetic diagnostic 25', {exact: true}).waitFor();
  await summary.click();
  await summary.click();
  await page.getByRole('button', {name: 'Next', exact: true}).click();
  await page.getByText('Page 2 of 2', {exact: true}).waitFor();
  assert(await page.getByRole('button', {name: 'Next', exact: true}).isDisabled());
  await page.getByRole('button', {name: 'Previous', exact: true}).click();
  assert(await page.getByRole('button', {name: 'Previous', exact: true}).isDisabled());

  await page.evaluate(() => window.historyHarness.refresh());
  await page.getByText('Loading operation history…').waitFor();
  await page.waitForFunction(() => window.historyHarness.pending.length > 0);
  await page.evaluate(() => window.historyHarness.rejectNext({correlationId: 'history-reference-one'}));
  await page.getByRole('alert').waitFor();
  await page.getByText('history-reference-one', {exact: true}).waitFor();
  assert.equal(await page.getByText('Operation reference', {exact: true}).count(), 0, 'read-only history has no fabricated operation reference');
  assert.equal(await page.getByText('private diagnostic must not render').count(), 0);
  assert.equal(await page.getByText('synthetic-0.csv', {exact: true}).count(), 0);
  await page.getByRole('button', {name: 'Retry history'}).focus();
  await page.keyboard.press('Enter');
  await page.getByText('Loading operation history…').waitFor();
  assert.equal(await page.getByText('history-reference-one', {exact: true}).count(), 0, 'retry clears the prior attempt reference before completion');
  await page.waitForFunction(() => window.historyHarness.pending.length > 0);
  await page.evaluate(() => window.historyHarness.rejectNext({correlationId: 'history-reference-two', operationId: '<script>private</script>'}));
  await page.getByText('history-reference-two', {exact: true}).waitFor();
  assert.equal(await page.getByText('Operation reference', {exact: true}).count(), 0);
  assert.equal((await page.locator('script').allTextContents()).some(text => text.includes('private</script>')), false,
    'invalid identifiers are never inserted as markup');
  await page.getByRole('button', {name: 'Retry history'}).click();
  await settle([]);
  await page.getByText('No bulk data operations', {exact: false}).waitFor();
  assert.equal(await page.getByText('history-reference-two', {exact: true}).count(), 0, 'successful refresh removes failed attempt references');

  // Older refresh and old-scope replies must not replace the latest request.
  await page.evaluate(() => window.historyHarness.refresh());
  await page.waitForFunction(() => window.historyHarness.pending.length === 1);
  await page.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-changed')));
  await page.waitForFunction(() => window.historyHarness.pending.length === 2);
  await page.evaluate(data => window.historyHarness.pending.pop().resolve(data), [rows[9]]);
  await page.getByText('synthetic-9.csv', {exact: true}).waitFor();
  await settle([rows[0]]);
  await page.waitForTimeout(50);
  assert.equal(await page.getByText('synthetic-0.csv', {exact: true}).count(), 0);
  await page.evaluate(() => window.historyHarness.refresh());
  await page.waitForFunction(() => window.historyHarness.pending.length === 1);
  await page.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-changed')));
  await page.waitForFunction(() => window.historyHarness.pending.length === 2);
  await page.evaluate(() => window.historyHarness.rejectNext({correlationId: 'old-scope-private-reference'}));
  await settle([rows[9]]);
  await page.getByText('synthetic-9.csv', {exact: true}).waitFor();
  assert.equal(await page.getByText('old-scope-private-reference', {exact: true}).count(), 0, 'late old-scope failures cannot reveal their identifiers');
  await page.evaluate(() => window.historyHarness.refresh());
  await page.waitForFunction(() => window.historyHarness.pending.length === 1);
  await page.evaluate(() => window.historyHarness.hide());
  await settle(rows);
  await page.evaluate(() => window.historyHarness.show());
  await settle([rows[0]]);
  await page.getByText('View details for synthetic-0.csv', {exact: true}).click();
  await page.setViewportSize({width: 390, height: 844});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile view must not overflow horizontally');
  await page.evaluate(() => window.historyHarness.refresh());
  await page.waitForFunction(() => window.historyHarness.pending.length === 1);
  await page.evaluate(() => window.historyHarness.rejectNext({correlationId: 'a'.repeat(128), operationId: 'narrow-operation-reference'}));
  await page.getByText('a'.repeat(128), {exact: true}).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'long support references wrap on narrow screens');
  await page.evaluate(() => window.historyHarness.hide());
  await page.locator('section[aria-labelledby="import-history-title"]').waitFor({state: 'detached'});
  await page.evaluate(() => window.historyHarness.show());
  await settle([]);
  assert.equal(await page.getByText('narrow-operation-reference', {exact: true}).count(), 0, 'unmount/remount cannot retain prior identifiers');
  if (process.env.WORKOS_BROWSER_SCREENSHOT) await page.screenshot({path: process.env.WORKOS_BROWSER_SCREENSHOT, fullPage: true});
  assert.deepEqual(errors, []);
  console.log('Import history browser smoke passed: details/keyboard, error paging, history paging, retry, scope race, unmount/remount, narrow viewport.');
} finally { await browser.close(); }
