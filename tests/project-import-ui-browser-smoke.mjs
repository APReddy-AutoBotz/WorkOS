import assert from 'node:assert/strict';

const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}});
const pageErrors = [];
const requests = [];
let genericLogWrites = 0;
const responsePlans = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.addInitScript(() => {
  sessionStorage.setItem('workos_api_token', 'synthetic-token');
  sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'}));
});

const operationResult = (body, {validRows = 1, errors = []} = {}) => ({
  status: body.dryRun ? 'Dry Run' : (errors.length ? 'Partial' : 'Success'),
  totalRows: body.totalRows,
  validRows,
  errorRows: errors.length,
  errors,
  log: {
    id: `batch-${requests.length}`,
    operation: 'Import',
    channel: 'Project Master',
    file_name: body.fileName,
    status: body.dryRun ? 'Dry Run' : (errors.length ? 'Partial' : 'Success'),
    total_rows: body.totalRows,
    valid_rows: validRows,
    error_rows: errors.length,
    user_name: 'Synthetic Admin',
    created_at: '2026-10-15T00:00:00.000Z',
    schema_version: 'project-master/1',
    dry_run: body.dryRun,
  },
});

await page.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path === '/api/health') {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({database: 'connected'})});
    return;
  }
  if (path === '/api/v1/imports/projects/apply') {
    const body = request.postDataJSON();
    requests.push({body, headers: request.headers()});
    const defaultErrors = body.rows.length === 0 ? body.clientErrors : [];
    const defaultValidRows = body.rows.length === 0 ? 0 : body.rows.length;
    const plan = responsePlans.shift() || {status: 200, body: operationResult(body, {validRows: defaultValidRows, errors: defaultErrors})};
    await route.fulfill({status: plan.status, contentType: 'application/json', body: JSON.stringify(plan.body)});
    return;
  }
  if (path === '/api/employees') {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: 'employee-synthetic', employee_id: 'EMP-VALID', name: 'Synthetic Manager', email: 'manager@example.test',
      designation: 'Manager', department: 'Delivery', country: 'GB', primary_country_director_id: 'cd-synthetic',
      mapped_country_director_ids: [], status: 'Active', utilization_eligible: true,
    }])});
    return;
  }
  if (path === '/api/import-export-logs' && request.method() === 'POST') {
    genericLogWrites += 1;
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({id: 'unexpected-log'})});
    return;
  }
  if (path === '/api/import-export-logs') {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([])});
    return;
  }
  if (['/api/projects', '/api/allocations', '/api/timesheets', '/api/settings', '/api/country-directors'].includes(path)) {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([])});
    return;
  }
  await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([])});
});

const csv = (projectCode, managerId = 'EMP-VALID') => [
  'projectCode,name,clientId,client,managerId,startDate,endDate,status,billable,projectType,country,notes',
  `${projectCode},Synthetic Project,client-synthetic,Synthetic Client,${managerId},2026-01-01,2026-12-31,Proposed,true,Delivery,GB,Synthetic test row`,
].join('\n');
const selectProjectCsv = async (fileName, contents) => {
  await page.locator('input[type="file"]').nth(2).setInputFiles({name: fileName, mimeType: 'text/csv', buffer: Buffer.from(contents)});
};
const lastRequest = () => requests.at(-1);
try {
  await page.goto(`${baseUrl}/tests/fixtures/project-import-ui.html`);
  await page.getByRole('heading', {name: 'Import / Export'}).waitFor();
  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await selectProjectCsv('projects-first.csv', csv('PROJECT-UI-101'));
  await page.getByRole('button', {name: 'Retry Validation'}).waitFor();
  const firstPreview = lastRequest();
  assert.equal(firstPreview.body.dryRun, true);
  assert.equal(firstPreview.body.schemaVersion, 'project-master/1');
  assert.equal(firstPreview.body.rows.length, 1);
  const firstPreviewKey = firstPreview.headers['idempotency-key'];
  assert.ok(firstPreviewKey);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'Apply remains disabled until server-side validation is confirmed');

  responsePlans.push({status: 200, body: operationResult(firstPreview.body)});
  await page.getByRole('button', {name: 'Retry Validation'}).click();
  await page.getByText('Server dry run complete for projects-first.csv: 1/1 rows are valid.', {exact: true}).waitFor();
  const dryRunRetry = lastRequest();
  assert.equal(dryRunRetry.headers['idempotency-key'], firstPreviewKey, 'validation retry reuses the same key');
  assert.deepEqual(dryRunRetry.body, firstPreview.body, 'validation retry preserves its exact payload');
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), false);

  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText(/The apply result for projects-first\.csv was not confirmed\./).waitFor();
  const firstApply = lastRequest();
  assert.equal(firstApply.body.dryRun, false);
  assert.notEqual(firstApply.headers['idempotency-key'], firstPreviewKey,
    'the apply operation uses a key separate from the successful dry-run operation');
  const firstApplyKey = firstApply.headers['idempotency-key'];

  responsePlans.push({status: 200, body: operationResult(firstApply.body)});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText('Applied 1 valid project master rows from projects-first.csv.', {exact: true}).waitFor();
  assert.equal(lastRequest().headers['idempotency-key'], firstApplyKey, 'apply retry reuses the same key');
  assert.deepEqual(lastRequest().body, firstApply.body, 'apply retry preserves the exact payload');

  await selectProjectCsv('projects-changed.csv', csv('PROJECT-UI-202'));
  await page.getByText('Server dry run complete for projects-changed.csv: 1/1 rows are valid.', {exact: true}).waitFor();
  const changedPreview = lastRequest();
  assert.notEqual(changedPreview.headers['idempotency-key'], firstPreviewKey,
    'a changed/reselected file starts a new idempotency operation');
  assert.equal(changedPreview.body.rows[0].projectCode, 'PROJECT-UI-202');

  const applyDiagnostic = {rowNumber: 2, field: 'managerId', message: 'The manager was removed before apply.'};
  responsePlans.push({status: 200, body: operationResult(changedPreview.body, {validRows: 0, errors: [applyDiagnostic]})});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText(/Project Master apply finished with 0 valid rows and 1 errors for projects-changed\.csv\. View saved diagnostic details in Import History\./).waitFor();

  await selectProjectCsv('projects-rejected.csv', csv('PROJECT-UI-303', 'MISSING-MANAGER'));
  await page.getByText('Server dry run complete for projects-rejected.csv: 0/1 rows are valid.', {exact: true}).waitFor();
  const rejectedPreview = lastRequest();
  assert.deepEqual(rejectedPreview.body.rows, [], 'all client-rejected rows are passed only as diagnostics to the server dry run');
  assert.equal(rejectedPreview.body.dryRun, true);
  assert.equal(rejectedPreview.body.clientErrors.length, 1);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'a zero-valid-row dry run cannot be applied');
  assert.equal(requests.length, 7);
  const malformedCsv = csv('PROJECT-UI-404').replace('projectCode,name', 'projectCodeMissing,name');
  await selectProjectCsv('projects-malformed-header.csv', malformedCsv);
  await page.getByText('Server dry run complete for projects-malformed-header.csv: 0/1 rows are valid.', {exact: true}).waitFor();
  const malformedPreview = lastRequest();
  assert.deepEqual(malformedPreview.body.rows, [], 'malformed-header input remains excluded from apply candidates');
  assert.ok(malformedPreview.body.clientErrors.some(error => error.rowNumber === 1 && error.field === 'header'),
    'header-level validation is retained as a diagnostic');
  assert.equal(malformedPreview.body.dryRun, true);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'a malformed-header dry run cannot apply source rows that were not submitted');
  assert.equal(requests.length, 8);
  assert.equal(genericLogWrites, 0, 'server dry runs and applies do not create a duplicate generic history log');
  assert.deepEqual(pageErrors, []);
  console.log('Project import browser smoke passed: server preview gate, stable retries, fresh keys, saved apply diagnostics, and invalid-row no-apply cases.');
} finally {
  await browser.close();
}
