import assert from 'node:assert/strict';
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}, acceptDownloads: true});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let downloads = 0;
page.on('download', () => { downloads += 1; });
await page.addInitScript(() => sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'})));
const row = id => ({id, source: 'Import', activeRole: 'HR', correlationId: `saved-correlation:${id}`, operationId: `saved-operation:${id}`, importBatchId: `saved-batch:${id}`, sourceIdentifier: `source:${id}`, importProcessingResult: 'Dry Run', timestamp: '2026-10-18T00:00:00Z', userId: 'reader-synthetic', userName: 'Synthetic Reader', userRole: 'HR', module: 'Employee', action: 'Update', entityId: id, details: `Synthetic evidence ${id}`});
const pending = async (after = 0) => {
  await page.waitForFunction(after => window.auditHarness.pending.some(request => request.id > after), after);
  return page.evaluate(after => window.auditHarness.pending.filter(request => request.id > after).at(-1).id, after);
};
const flushRender = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settle = async (id, rows = [], status) => page.evaluate(({id, rows, status}) => window.auditHarness.settle(id, rows, status), {id, rows, status});
const noExport = async () => {
  assert(await page.getByRole('button', {name: 'Export Logs', exact: true}).isDisabled());
  await page.getByRole('button', {name: 'Export Logs', exact: true}).evaluate(button => button.click());
  assert.equal(await page.evaluate(() => window.auditHarness.writes()), 0);
  assert.equal(downloads, 0);
};
const provenance = () => page.getByRole('region', {name: 'Recorded audit provenance', exact: true});
const assertProvenance = async id => {
  await provenance().getByText(`saved-operation:${id}`, {exact: true}).waitFor();
  assert.equal(await provenance().getByText(`saved-correlation:${id}`, {exact: true}).count(), 1);
  assert.equal(await provenance().getByText(`saved-batch:${id}`, {exact: true}).count(), 1);
  assert.equal(await provenance().getByText(`source:${id}`, {exact: true}).count(), 1);
  assert.equal(await provenance().getByText('Dry Run', {exact: true}).count(), 1);
  assert.equal(await provenance().locator('a,button,input').count(), 0, 'inspection adds no action or navigation');
};
try {
  await page.goto(`${baseUrl}/tests/fixtures/scoped-audit-history.html`);
  await page.getByText('Loading selected-scope audit history…', {exact: true}).waitFor();
  assert.equal(await page.getByText('No audit records were returned', {exact: false}).count(), 0);
  await noExport();
  await settle(await pending(), [], 503);
  await page.getByRole('alert').getByText('Selected-scope audit history could not be loaded.', {exact: false}).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('private-password-token'), false);
  assert.equal(await page.getByText('No audit records were returned', {exact: false}).count(), 0);
  await noExport();
  await page.getByRole('button', {name: 'Retry audit history'}).focus();
  await page.keyboard.press('Enter');
  await page.getByText('Loading selected-scope audit history…', {exact: true}).waitFor();
  await noExport();
  await settle(await pending(), [], 'network');
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', {name: 'Retry audit history'}).click();
  await settle(await pending(), [], 403);
  await page.getByRole('alert').getByText('Selected-scope audit access was denied.', {exact: false}).waitFor();
  await noExport();
  await page.getByRole('button', {name: 'Retry audit history'}).click();
  await settle(await pending());
  await page.getByText('No audit records were returned for the selected organization and legal entity.', {exact: true}).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('button', {name: 'Export Logs', exact: true}).isDisabled(), false);

  await page.evaluate(() => window.auditHarness.scope('org-synthetic', 'entity-synthetic'));
  await settle(await pending(), [row('current-evidence')]);
  await page.getByRole('button', {name: 'View audit entry current-evidence', exact: true}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', {name: 'Governance Review', exact: true}).waitFor();
  await assertProvenance('current-evidence');
  await page.evaluate(() => {
    window.auditHarness.scope('org-next', 'entity-next');
    // Exercise the action guard before React commits the scope-change render.
    Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Export Logs')).click();
  });
  await page.getByText('Loading selected-scope audit history…', {exact: true}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Governance Review', exact: true}).count(), 0);
  assert.equal(await page.getByRole('button', {name: 'View audit entry current-evidence', exact: true}).count(), 0);
  assert.equal(await provenance().count(), 0, 'scope changes clear provenance immediately');
  await noExport();
  const oldSuccess = await pending();
  await page.evaluate(() => window.auditHarness.scope('org-newest', 'entity-newest'));
  const newest = await pending(oldSuccess);
  assert.notEqual(newest, oldSuccess);
  await settle(newest, [row('newest-evidence')]);
  await page.getByRole('button', {name: 'View audit entry newest-evidence', exact: true}).waitFor();
  await settle(oldSuccess, [row('stale-success')]);
  await flushRender();
  assert.equal(await page.getByRole('button', {name: 'View audit entry stale-success', exact: true}).count(), 0);
  await page.evaluate(() => window.auditHarness.scope('org-old-error', 'entity-old-error'));
  const oldError = await pending();
  await page.evaluate(() => window.auditHarness.scope('org-current', 'entity-current'));
  const current = await pending(oldError);
  await settle(current, [row('current-after-error')]);
  await page.getByRole('button', {name: 'View audit entry current-after-error', exact: true}).waitFor();
  await settle(oldError, [], 503);
  await flushRender();
  assert.equal(await page.getByRole('alert').count(), 0, 'late prior-scope failure must not overwrite current evidence');

  await page.evaluate(() => window.auditHarness.scope('org-actor', 'entity-actor'));
  const priorActor = await pending();
  await page.evaluate(() => window.auditHarness.actor('synthetic-reader-two'));
  const currentActor = await pending(priorActor);
  await settle(currentActor, [row('current-actor')]);
  await page.getByRole('button', {name: 'View audit entry current-actor', exact: true}).click();
  await assertProvenance('current-actor');
  await settle(priorActor, [row('stale-actor')]);
  await flushRender();
  assert.equal(await page.getByRole('button', {name: 'View audit entry stale-actor', exact: true}).count(), 0);
  await page.evaluate(() => window.auditHarness.scope('org-actor', 'entity-actor'));
  const oldSameRole = await pending(currentActor);
  await page.evaluate(() => window.auditHarness.role('TeamLead'));
  await page.getByText('Loading selected-scope audit history…', {exact: true}).waitFor();
  assert.equal(await provenance().count(), 0, 'active-role changes remove saved provenance before fresh evidence');
  const priorRole = await pending(oldSameRole);
  await page.evaluate(() => window.auditHarness.role('HR'));
  const currentRole = await pending(priorRole);
  await settle(currentRole, [row('current-role')]);
  await page.getByRole('button', {name: 'View audit entry current-role', exact: true}).waitFor();
  await settle(oldSameRole, [row('stale-same-role')]);
  await settle(priorRole, [], 503);
  await flushRender();
  assert.equal(await page.getByRole('alert').count(), 0, 'a stale different-role failure cannot replace current evidence');
  assert.equal(await page.getByRole('button', {name: 'View audit entry stale-same-role', exact: true}).count(), 0, 'returning HR to TeamLead to HR cannot accept an older same-key request');

  await page.getByPlaceholder('Filter by user or target action...').fill('no matching synthetic row');
  await page.getByText('No audit records match the current filters.', {exact: true}).waitFor();
  await page.getByPlaceholder('Filter by user or target action...').fill('');
  await page.evaluate(() => window.auditHarness.scope('org-unmount', 'entity-unmount'));
  const unmounted = await pending();
  await page.evaluate(() => window.auditHarness.hide());
  await page.getByRole('heading', {name: 'Audit Trail', exact: true}).waitFor({state: 'detached'});
  await settle(unmounted, [row('unmounted-evidence')]);
  await flushRender();
  await page.evaluate(() => window.auditHarness.show());
  await page.getByText('Loading selected-scope audit history…', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'View audit entry unmounted-evidence', exact: true}).count(), 0);
  await settle(await pending(), [], 503);
  await page.setViewportSize({width: 390, height: 844});
  const alert = page.getByRole('alert');
  await alert.waitFor();
  const bounds = await alert.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'failure/retry state fits narrow viewport');
  await page.getByRole('button', {name: 'Retry audit history'}).click();
  await settle(await pending(), [row('export-ready')]);
  await page.getByRole('button', {name: 'View audit entry export-ready', exact: true}).waitFor();
  await page.getByRole('button', {name: 'View audit entry export-ready', exact: true}).focus();
  await page.keyboard.press('Enter');
  await assertProvenance('export-ready');
  // Visible text can appear before the spring-driven drawer reaches its target.
  // Observe in-viewport, stable positions across frames instead of sleeping.
  await provenance().evaluate(section => new Promise((resolve, reject) => {
    const drawer = section.closest('.fixed');
    let previous;
    let stable = 0;
    const deadline = performance.now() + 5000;
    const frame = () => {
      const bounds = section.getBoundingClientRect();
      const outer = drawer?.getBoundingClientRect();
      const fitted = outer && Math.abs(outer.right - innerWidth) <= 0.25
        && bounds.x >= 0 && bounds.right <= innerWidth + 0.25;
      stable = fitted && previous !== undefined && Math.abs(bounds.x - previous) < 0.05 ? stable + 1 : 0;
      previous = bounds.x;
      if (stable >= 3) resolve();
      else if (performance.now() >= deadline) reject(new Error('Synthetic audit drawer did not settle inside viewport'));
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  const detailBounds = await provenance().boundingBox();
  assert(detailBounds && detailBounds.x >= 0 && detailBounds.x + detailBounds.width <= 391, 'saved references wrap inside the narrow detail drawer');
  await page.getByRole('tab', {name: 'Selected organization', exact: true}).evaluate(button => button.click());
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export Logs', exact: true}).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^audit-logs-.*\.csv$/);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8');
  assert.equal(csv.split('\n')[0], '"timestamp","user","role","module","action","target","oldValue","newValue","details"');
  assert(!csv.includes('saved-operation:') && !csv.includes('saved-batch:'), 'existing export contents are unchanged');
  assert.equal(await page.evaluate(() => window.auditHarness.writes()), 1, 'successful selected-scope export retains its existing audit write');
  const requestsBeforeDenied = await page.evaluate(() => window.auditHarness.pending.length);
  await page.evaluate(() => window.auditHarness.permission(false));
  await page.getByText('You do not have access to selected-scope audit history.', {exact: false}).waitFor();
  assert.equal(await page.evaluate(() => window.auditHarness.pending.length), requestsBeforeDenied);
  assert(await page.getByRole('button', {name: 'Export Logs', exact: true}).isDisabled());
  await page.evaluate(() => window.auditHarness.permission(true));
  await pending();
  await page.evaluate(() => window.auditHarness.scope(null, null));
  await page.getByText('Select an organization and legal entity to access its selected-scope audit records.', {exact: true}).waitFor();
  assert(await page.getByRole('button', {name: 'Export Logs', exact: true}).isDisabled());
  assert.equal((await page.locator('body').innerText()).includes('private-password-token'), false);
  await page.goto(`${baseUrl}/tests/fixtures/scoped-audit-history.html?deployment=1`);
  const backgroundScopedRequest = await pending();
  await page.getByRole('tab', {name: 'Deployment-wide', exact: true}).click();
  await page.getByRole('button', {name: 'View audit entry deployment-evidence', exact: true}).click();
  await page.getByRole('heading', {name: 'Governance Review', exact: true}).waitFor();
  await settle(backgroundScopedRequest, [], 503);
  await flushRender();
  assert.equal(await page.getByRole('button', {name: 'View audit entry deployment-evidence', exact: true})
    .evaluate(button => button.closest('tr').classList.contains('bg-orange-50/30')), true,
    'an unrelated selected-scope failure must retain the current deployment selection, independently of exit animation');
  assert.equal(await page.getByRole('heading', {name: 'Governance Review', exact: true}).count(), 1);
  assert.equal(await page.getByRole('button', {name: 'Export Logs', exact: true}).count(), 0,
    'deployment history remains unavailable for list export');
  assert.equal(await page.getByRole('button', {name: 'Report', exact: true}).count(), 0,
    'deployment history remains unavailable for single-entry export');
  assert.equal(await page.evaluate(() => window.auditHarness.writes()), 0);
  await page.getByRole('tab', {name: 'Selected organization', exact: true}).evaluate(button => button.click());
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Governance Review', exact: true}).count(), 0);
  assert.deepEqual(errors, []);
  console.log('Selected-scope audit browser passed: loading/empty/denied/failure, keyboard retry, export guards, late-scope responses, unmount and narrow layout.');
} finally { await browser.close(); }
