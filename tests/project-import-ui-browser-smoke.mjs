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
const syntheticHistory = [];
let operationSequence = 0;
page.on('pageerror', error => pageErrors.push(error.message));
await page.addInitScript(() => {
  sessionStorage.setItem('workos_api_token', 'synthetic-token');
  sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'}));
});

const operationResult = (body, {validRows = 1, errors = []} = {}) => ({
  status: body.dryRun ? 'Dry Run' : (validRows === 0 && errors.length ? 'Failed' : (errors.length ? 'Partial' : 'Success')),
  totalRows: body.totalRows,
  validRows,
  errorRows: errors.length,
  errors,
  log: {
    id: `batch-${++operationSequence}`,
    operation: 'Import',
    channel: ({
      'client-master/1': 'Client Master',
      'project-master/1': 'Project Master',
      'allocation-control/1': 'Allocation Control',
      'timesheet-import/1': 'Timesheet Import',
    })[body.schemaVersion],
    file_name: body.fileName,
    status: body.dryRun ? 'Dry Run' : (validRows === 0 && errors.length ? 'Failed' : (errors.length ? 'Partial' : 'Success')),
    total_rows: body.totalRows,
    valid_rows: validRows,
    error_rows: errors.length,
    errors: errors.length > 0 ? errors : null,
    user_name: 'Synthetic Admin',
    created_at: '2026-10-15T00:00:00.000Z',
    schema_version: body.schemaVersion,
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
  if (['/api/v1/imports/projects/apply', '/api/v1/imports/clients/apply',
    '/api/v1/imports/allocations/apply', '/api/v1/imports/timesheets/apply'].includes(path)) {
    const body = request.postDataJSON();
    requests.push({path, body, headers: request.headers()});
    const defaultErrors = body.rows.length === 0 ? body.clientErrors : [];
    const defaultValidRows = body.rows.length === 0 ? 0 : body.rows.length;
    const plan = responsePlans.shift() || {status: 200, body: operationResult(body, {validRows: defaultValidRows, errors: defaultErrors})};
    if (plan.status === 200 && plan.body?.log) syntheticHistory.unshift(plan.body.log);
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
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(syntheticHistory)});
    return;
  }
  if (path === '/api/projects') {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: 'project-synthetic', project_code: 'PROJECT-SYNTHETIC', name: 'Synthetic Project',
      client: 'Synthetic Client', manager_id: 'employee-synthetic', manager_name: 'Synthetic Manager',
      start_date: '2026-01-01', end_date: '2026-12-31', status: 'Active', billable: true,
    }])});
    return;
  }
  if (path === '/api/allocations') {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: 'allocation-synthetic', employee_id: 'employee-synthetic', project_id: 'project-synthetic',
      role_on_project: 'Consultant', percentage: 50, start_date: '2026-01-01', end_date: '2026-12-31',
      billable: true, status: 'Active',
    }])});
    return;
  }
  if (['/api/timesheets', '/api/settings', '/api/country-directors'].includes(path)) {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([])});
    return;
  }
  await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([])});
});

const csv = (projectCode, managerId = 'EMP-VALID') => [
  'projectCode,name,clientId,client,managerId,startDate,endDate,status,billable,projectType,country,notes',
  `${projectCode},Synthetic Project,client-synthetic,Synthetic Client,${managerId},2026-01-01,2026-12-31,,true,Delivery,GB,Synthetic test row`,
].join('\n');
const selectProjectCsv = async (fileName, contents) => {
  await page.locator('input[type="file"]').nth(2).setInputFiles({name: fileName, mimeType: 'text/csv', buffer: Buffer.from(contents)});
};
const selectClientCsv = async (fileName, contents) => {
  await page.locator('input[type="file"]').nth(1).setInputFiles({name: fileName, mimeType: 'text/csv', buffer: Buffer.from(contents)});
};
const selectAllocationCsv = async (fileName, contents) => {
  await page.locator('input[type="file"]').nth(3).setInputFiles({name: fileName, mimeType: 'text/csv', buffer: Buffer.from(contents)});
};
const selectTimesheetCsv = async (fileName, contents) => {
  await page.locator('input[type="file"]').nth(4).setInputFiles({name: fileName, mimeType: 'text/csv', buffer: Buffer.from(contents)});
};
const clientCsv = (clientId, name = 'Synthetic Client', status = 'Active') => [
  'id,name,industry,accountOwnerId,countryDirectorIds,status',
  `${clientId},${name},Technology,,,${status}`,
].join('\n');
const allocationCsv = (id = '', percentage = 25, status = '') => [
  'id,employeeId,projectId,roleOnProject,percentage,startDate,endDate,billable,status,comments',
  `${id},EMP-VALID,PROJECT-SYNTHETIC,Consultant,${percentage},2026-09-01,2026-12-31,true,${status},Synthetic allocation row`,
].join('\n');
const timesheetCsv = (status = '') => [
  'employeeId,weekEnding,workType,projectId,clientName,category,date,hours,remark,billable,status,rejectionReason',
  `EMP-VALID,2026-09-27,Project Work,PROJECT-SYNTHETIC,,Delivery,2026-09-25,7.5,Synthetic entry,true,${status},`,
].join('\n');
const lastRequest = () => requests.at(-1);
try {
  await page.goto(`${baseUrl}/tests/fixtures/project-import-ui.html`);
  await page.getByRole('heading', {name: 'Import / Export', exact: true}).waitFor();
  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await selectProjectCsv('projects-first.csv', csv('PROJECT-UI-101'));
  await page.getByRole('button', {name: 'Retry Validation'}).waitFor();
  const firstPreview = lastRequest();
  assert.equal(firstPreview.body.dryRun, true);
  assert.equal(firstPreview.body.schemaVersion, 'project-master/1');
  assert.equal(firstPreview.body.rows.length, 1);
  assert.equal(firstPreview.body.rows[0].status, '', 'blank optional project status cells remain eligible for server defaulting');
  const firstPreviewKey = firstPreview.headers['idempotency-key'];
  assert.ok(firstPreviewKey);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'Apply remains disabled until server-side validation is confirmed');

  responsePlans.push({status: 200, body: operationResult(firstPreview.body)});
  await page.getByRole('button', {name: 'Retry Validation'}).click();
  await page.getByText('Server dry run complete for projects-first.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const dryRunRetry = lastRequest();
  assert.equal(dryRunRetry.headers['idempotency-key'], firstPreviewKey, 'validation retry reuses the same key');
  assert.deepEqual(dryRunRetry.body, firstPreview.body, 'validation retry preserves its exact payload');
  assert.equal(syntheticHistory[0].errors, null,
    'the synthetic history batch mirrors the server’s null persisted-errors shape when a batch has no row errors');
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

  const changedCsv = `${csv('PROJECT-UI-202')}\nPROJECT-UI-203,Synthetic Project 203,client-synthetic,Synthetic Client,EMP-VALID,2026-01-01,2026-12-31,Proposed,true,Delivery,GB,Synthetic test row`;
  await selectProjectCsv('projects-changed.csv', changedCsv);
  await page.getByText('Server dry run complete for projects-changed.csv: 2/2 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const changedPreview = lastRequest();
  assert.notEqual(changedPreview.headers['idempotency-key'], firstPreviewKey,
    'a changed/reselected file starts a new idempotency operation');
  assert.equal(changedPreview.body.rows.length, 2);
  assert.equal(changedPreview.body.rows[0].projectCode, 'PROJECT-UI-202');

  const applyDiagnostic = {rowNumber: 3, field: 'managerId', sourceIdentifier: 'PROJECT-UI-203', message: 'The manager was removed before apply.'};
  responsePlans.push({status: 200, body: operationResult({...changedPreview.body, dryRun: false}, {validRows: 1, errors: [applyDiagnostic]})});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText(/Project Master apply finished with 1 valid rows and 1 errors for projects-changed\.csv\. View saved diagnostic details in Import History\./).waitFor();
  const historyPanel = page.getByRole('region', {name: 'Import / Export History'});
  const partialHistoryItem = historyPanel.getByRole('listitem').filter({hasText: 'projects-changed.csv'}).filter({hasText: 'Partial'});
  await partialHistoryItem.getByText('Import · Partial · 1/2 valid', {exact: true}).waitFor();
  await partialHistoryItem.getByText('View details for projects-changed.csv', {exact: true}).click();
  await partialHistoryItem.getByText('Row 3 · managerId', {exact: true}).waitFor();
  await partialHistoryItem.getByText('Source identifier: PROJECT-UI-203', {exact: true}).waitFor();
  await partialHistoryItem.getByText('The manager was removed before apply.', {exact: true}).waitFor();

  await selectProjectCsv('projects-rejected.csv', csv('PROJECT-UI-303', 'MISSING-MANAGER'));
  await page.getByText('Server dry run complete for projects-rejected.csv: 0/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const rejectedPreview = lastRequest();
  assert.deepEqual(rejectedPreview.body.rows, [], 'all client-rejected rows are passed only as diagnostics to the server dry run');
  assert.equal(rejectedPreview.body.dryRun, true);
  assert.equal(rejectedPreview.body.clientErrors.length, 1);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'a zero-valid-row dry run cannot be applied');
  assert.equal(requests.length, 7);
  const malformedCsv = csv('PROJECT-UI-404').replace('projectCode,name', 'projectCodeMissing,name');
  await selectProjectCsv('projects-malformed-header.csv', malformedCsv);
  await page.getByText('Server dry run complete for projects-malformed-header.csv: 0/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const malformedPreview = lastRequest();
  assert.deepEqual(malformedPreview.body.rows, [], 'malformed-header input remains excluded from apply candidates');
  assert.ok(malformedPreview.body.clientErrors.some(error => error.rowNumber === 1 && error.field === 'header'),
    'header-level validation is retained as a diagnostic');
  assert.equal(malformedPreview.body.dryRun, true);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'a malformed-header dry run cannot apply source rows that were not submitted');
  assert.equal(requests.length, 8);
  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await selectClientCsv('clients-first.csv', clientCsv('', 'Synthetic Client', ''));
  await page.getByRole('button', {name: 'Retry Validation'}).waitFor();
  const firstClientPreview = lastRequest();
  assert.equal(firstClientPreview.path, '/api/v1/imports/clients/apply');
  assert.equal(firstClientPreview.body.schemaVersion, 'client-master/1');
  assert.equal(firstClientPreview.body.dryRun, true);
  assert.equal(firstClientPreview.body.rows[0].id, '', 'blank optional client IDs remain eligible for server-generated IDs');
  assert.equal(firstClientPreview.body.rows[0].status, '', 'blank optional client statuses remain eligible for server defaults');
  const firstClientPreviewKey = firstClientPreview.headers['idempotency-key'];
  assert.ok(firstClientPreviewKey);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'Client Master apply remains disabled until server-side validation is confirmed');

  responsePlans.push({status: 200, body: operationResult(firstClientPreview.body)});
  await page.getByRole('button', {name: 'Retry Validation'}).click();
  await page.getByText('Server dry run complete for clients-first.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  assert.equal(lastRequest().headers['idempotency-key'], firstClientPreviewKey,
    'Client Master validation retry reuses the same key');
  assert.deepEqual(lastRequest().body, firstClientPreview.body,
    'Client Master validation retry preserves its exact request payload');
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), false);

  responsePlans.push({status: 200, body: operationResult({...lastRequest().body, dryRun: false})});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText('Applied 1 valid client master rows from clients-first.csv.', {exact: true}).waitFor();
  const clientApply = lastRequest();
  assert.equal(clientApply.path, '/api/v1/imports/clients/apply');
  assert.equal(clientApply.body.dryRun, false);
  assert.notEqual(clientApply.headers['idempotency-key'], firstClientPreviewKey,
    'Client Master apply uses a separate idempotency key from dry run');

  await selectClientCsv('clients-changed.csv', clientCsv('CLIENT-UI-202', 'Synthetic Client Changed'));
  await page.getByText('Server dry run complete for clients-changed.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const changedClientPreview = lastRequest();
  assert.notEqual(changedClientPreview.headers['idempotency-key'], firstClientPreviewKey,
    'a newly selected Client Master file starts fresh idempotency keys');
  assert.equal(changedClientPreview.body.schemaVersion, 'client-master/1');
  assert.equal(requests.length, 12);

  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await selectAllocationCsv('allocations-first.csv', allocationCsv());
  await page.getByRole('button', {name: 'Retry Validation'}).waitFor();
  const firstAllocationPreview = lastRequest();
  assert.equal(firstAllocationPreview.path, '/api/v1/imports/allocations/apply');
  assert.equal(firstAllocationPreview.body.schemaVersion, 'allocation-control/1');
  assert.equal(firstAllocationPreview.body.dryRun, true);
  assert.equal(firstAllocationPreview.body.rows[0].id, '', 'a blank Allocation Control ID remains eligible for server-generated identity');
  assert.equal(firstAllocationPreview.body.rows[0].status, '', 'a blank Allocation Control status remains eligible for the server default');
  const firstAllocationDryRunKey = firstAllocationPreview.headers['idempotency-key'];
  assert.ok(firstAllocationDryRunKey);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'Allocation Control apply stays disabled until the server confirms its dry run');

  responsePlans.push({status: 200, body: operationResult(firstAllocationPreview.body)});
  await page.getByRole('button', {name: 'Retry Validation'}).click();
  await page.getByText('Server dry run complete for allocations-first.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  assert.equal(lastRequest().headers['idempotency-key'], firstAllocationDryRunKey,
    'Allocation Control validation retry keeps the same key');
  assert.deepEqual(lastRequest().body, firstAllocationPreview.body,
    'Allocation Control validation retry keeps the exact request body');

  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText(/The apply result for allocations-first\.csv was not confirmed\./).waitFor();
  const allocationApply = lastRequest();
  assert.equal(allocationApply.body.dryRun, false);
  assert.notEqual(allocationApply.headers['idempotency-key'], firstAllocationDryRunKey,
    'Allocation Control apply has a separate key from dry run');
  const allocationApplyKey = allocationApply.headers['idempotency-key'];
  responsePlans.push({status: 200, body: operationResult(allocationApply.body)});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText('Applied 1 valid allocation control rows from allocations-first.csv.', {exact: true}).waitFor();
  assert.equal(lastRequest().headers['idempotency-key'], allocationApplyKey,
    'Allocation Control apply retry reuses its original key');
  assert.deepEqual(lastRequest().body, allocationApply.body,
    'Allocation Control apply retry preserves the exact approved rows');

  await selectAllocationCsv('allocations-changed.csv', allocationCsv('allocation-ui-202', 30, 'Active'));
  await page.getByText('Server dry run complete for allocations-changed.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  assert.notEqual(lastRequest().headers['idempotency-key'], firstAllocationDryRunKey,
    'a newly selected Allocation Control file starts a fresh operation');
  await selectAllocationCsv('allocations-rejected.csv', allocationCsv().replace('EMP-VALID', 'MISSING-EMPLOYEE'));
  await page.getByText('Server dry run complete for allocations-rejected.csv: 0/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const rejectedAllocationPreview = lastRequest();
  assert.deepEqual(rejectedAllocationPreview.body.rows, [], 'a fully rejected Allocation Control CSV sends no apply candidate rows');
  assert.equal(rejectedAllocationPreview.body.dryRun, true);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'a zero-valid-row Allocation Control dry run cannot be applied');

  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await selectTimesheetCsv('timesheets-first.csv', timesheetCsv());
  await page.getByRole('button', {name: 'Retry Validation'}).waitFor();
  const firstTimesheetPreview = lastRequest();
  assert.equal(firstTimesheetPreview.path, '/api/v1/imports/timesheets/apply');
  assert.equal(firstTimesheetPreview.body.schemaVersion, 'timesheet-import/1');
  assert.equal(firstTimesheetPreview.body.dryRun, true);
  assert.equal(firstTimesheetPreview.body.rows[0].status, '', 'a blank timesheet status remains eligible for its existing default');
  const firstTimesheetDryRunKey = firstTimesheetPreview.headers['idempotency-key'];
  responsePlans.push({status: 200, body: operationResult(firstTimesheetPreview.body)});
  await page.getByRole('button', {name: 'Retry Validation'}).click();
  await page.getByText('Server dry run complete for timesheets-first.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  assert.equal(lastRequest().headers['idempotency-key'], firstTimesheetDryRunKey,
    'Timesheet validation retry keeps the same key');
  assert.deepEqual(lastRequest().body, firstTimesheetPreview.body,
    'Timesheet validation retry keeps the exact request body');

  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText(/The apply result for timesheets-first\.csv was not confirmed\./).waitFor();
  const timesheetApply = lastRequest();
  assert.notEqual(timesheetApply.headers['idempotency-key'], firstTimesheetDryRunKey,
    'Timesheet apply has a separate key from dry run');
  const timesheetApplyKey = timesheetApply.headers['idempotency-key'];
  responsePlans.push({status: 200, body: operationResult(timesheetApply.body)});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText('Applied 1 valid timesheet import rows from timesheets-first.csv.', {exact: true}).waitFor();
  assert.equal(lastRequest().headers['idempotency-key'], timesheetApplyKey,
    'Timesheet apply retry reuses its original key');
  assert.deepEqual(lastRequest().body, timesheetApply.body,
    'Timesheet apply retry preserves its exact approved rows');

  await selectTimesheetCsv('timesheets-changed.csv', timesheetCsv('Submitted'));
  await page.getByText('Server dry run complete for timesheets-changed.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  assert.notEqual(lastRequest().headers['idempotency-key'], firstTimesheetDryRunKey,
    'a newly selected Timesheet file starts a fresh operation');
  await selectTimesheetCsv('timesheets-rejected.csv', timesheetCsv().replace('EMP-VALID', 'MISSING-EMPLOYEE'));
  await page.getByText('Server dry run complete for timesheets-rejected.csv: 0/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const rejectedTimesheetPreview = lastRequest();
  assert.deepEqual(rejectedTimesheetPreview.body.rows, [], 'a fully rejected Timesheet CSV sends no apply candidate rows');
  assert.equal(rejectedTimesheetPreview.body.dryRun, true);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'a zero-valid-row Timesheet dry run cannot be applied');

  assert.equal(genericLogWrites, 0, 'versioned dry runs and applies do not create duplicate generic history logs');
  assert.deepEqual(pageErrors, []);
  console.log('Project, client, allocation, and timesheet import browser smoke passed: server preview gates, stable retries, fresh keys, saved diagnostics, and invalid-row no-apply cases.');
} finally {
  await browser.close();
}
