import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}, acceptDownloads: true});
const pageErrors = [];
const requests = [];
let genericLogWrites = 0;
const genericLogBodies = [];
const submittedEmployeePasswords = [];
const responsePlans = [];
const syntheticHistory = [];
const syntheticHistoryByScope = new Map();
let deferNextGenericLogWrite = false;
let resolveGenericLogWriteStarted;
let releaseGenericLogWrite;
let genericLogWriteStarted = Promise.resolve();
let genericLogWriteGate = Promise.resolve();
let deferNextScopeValidation = false;
let resolveScopeValidationStarted;
let releaseScopeValidation;
let scopeValidationStarted = Promise.resolve();
let scopeValidationGate = Promise.resolve();
const prepareDeferredGenericLogWrite = () => {
  deferNextGenericLogWrite = true;
  genericLogWriteStarted = new Promise(resolve => { resolveGenericLogWriteStarted = resolve; });
  genericLogWriteGate = new Promise(resolve => { releaseGenericLogWrite = resolve; });
};
const prepareDeferredScopeValidation = () => {
  deferNextScopeValidation = true;
  scopeValidationStarted = new Promise(resolve => { resolveScopeValidationStarted = resolve; });
  scopeValidationGate = new Promise(resolve => { releaseScopeValidation = resolve; });
};
const scopeKeyFromHeaders = headers => JSON.stringify([
  headers['x-organization-id'] || null,
  headers['x-legal-entity-id'] || null,
]);
let operationSequence = 0;
let delayedScopeRequestResolve;
const delayedScopeRequestSeen = new Promise(resolve => { delayedScopeRequestResolve = resolve; });
let delayedApplyRequestResolve;
const delayedApplyRequestSeen = new Promise(resolve => { delayedApplyRequestResolve = resolve; });
let delayedErrorApplyRequestResolve;
const delayedErrorApplyRequestSeen = new Promise(resolve => { delayedErrorApplyRequestResolve = resolve; });
page.on('pageerror', error => pageErrors.push(error.message));
await page.addInitScript(() => {
  sessionStorage.setItem('workos_api_token', 'synthetic-token');
  if (!sessionStorage.getItem('workos_organization_scope')) {
    sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'}));
  }
  const originalText = File.prototype.text;
  File.prototype.text = function() {
    if (this.name.startsWith('employees-read-error-')) return Promise.reject(new Error('Synthetic file read failure'));
    return originalText.call(this);
  };
});

const operationResult = (body, {validRows = 1, errors = []} = {}) => ({
  status: body.dryRun ? 'Dry Run' : (validRows === 0 && errors.length ? 'Failed' : (errors.length ? 'Partial' : 'Success')),
  totalRows: body.totalRows,
  validRows,
  errorRows: errors.length,
  errors,
  ...(body.schemaVersion === 'employee-master/1' ? {replayed: false} : {}),
  log: {
    id: `batch-${++operationSequence}`,
    operation: 'Import',
    channel: ({
      'client-master/1': 'Client Master',
      'project-master/1': 'Project Master',
      'allocation-control/1': 'Allocation Control',
      'timesheet-import/1': 'Timesheet Import',
      'employee-master/1': 'Employee Master',
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
  if (path === '/api/auth/organization-scopes') {
    if (deferNextScopeValidation) {
      deferNextScopeValidation = false;
      resolveScopeValidationStarted();
      await scopeValidationGate;
    }
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([
      {organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic', organizationName: 'Synthetic Organization', legalEntityName: 'Synthetic Entity'},
      {organizationId: 'org-synthetic-next', legalEntityId: 'entity-synthetic-next', organizationName: 'Synthetic Organization Next', legalEntityName: 'Synthetic Entity Next'},
    ])});
    return;
  }
  if (['/api/v1/imports/employees/apply', '/api/v1/imports/projects/apply', '/api/v1/imports/clients/apply',
    '/api/v1/imports/allocations/apply', '/api/v1/imports/timesheets/apply'].includes(path)) {
    const body = request.postDataJSON();
    requests.push({path, body, headers: request.headers()});
    const defaultErrors = body.rows.length === 0 ? body.clientErrors : [];
    const defaultValidRows = body.rows.length === 0 ? 0 : body.rows.length;
    const plan = responsePlans.shift() || {status: 200};
    const responseBody = plan.body || operationResult(body, {validRows: defaultValidRows, errors: defaultErrors});
    if (path === '/api/v1/imports/projects/apply' && body.fileName === 'projects-scope-delayed.csv') {
      delayedScopeRequestResolve({body, headers: request.headers()});
    }
    if (path === '/api/v1/imports/projects/apply' && body.fileName === 'projects-scope-apply.csv' && body.dryRun === false) {
      delayedApplyRequestResolve({body, headers: request.headers()});
    }
    if (path === '/api/v1/imports/projects/apply' && body.fileName === 'projects-scope-apply-error.csv' && body.dryRun === false) {
      delayedErrorApplyRequestResolve({body, headers: request.headers()});
    }
    if (plan.delayMs) await new Promise(resolve => setTimeout(resolve, plan.delayMs));
    if (plan.status === 200 && responseBody.log) {
      syntheticHistory.unshift(responseBody.log);
      const scopeKey = scopeKeyFromHeaders(request.headers());
      syntheticHistoryByScope.set(scopeKey, [responseBody.log, ...(syntheticHistoryByScope.get(scopeKey) || [])]);
    }
    await route.fulfill({status: plan.status, contentType: 'application/json', body: JSON.stringify(responseBody)});
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
    genericLogBodies.push(request.postDataJSON());
    if (deferNextGenericLogWrite) {
      deferNextGenericLogWrite = false;
      resolveGenericLogWriteStarted();
      await genericLogWriteGate;
    }
    try {
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({id: 'unexpected-log'})});
    } catch {
      // A full-page scope reload may cancel this synthetic in-flight request.
    }
    return;
  }
  if (path === '/api/import-export-logs') {
    const scopedHistory = syntheticHistoryByScope.get(scopeKeyFromHeaders(request.headers())) || [];
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(scopedHistory)});
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
  if (path === '/api/country-directors') {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([{id: 'cd-synthetic', name: 'Synthetic Director'}])});
    return;
  }
  if (['/api/timesheets', '/api/settings'].includes(path)) {
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([])});
    return;
  }
  await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([])});
});

const csv = (projectCode, managerId = 'EMP-VALID') => [
  'projectCode,name,clientId,client,managerId,startDate,endDate,status,billable,projectType,country,notes',
  `${projectCode},Synthetic Project,client-synthetic,Synthetic Client,${managerId},2026-01-01,2026-12-31,,true,Delivery,GB,Synthetic test row`,
].join('\n');
const employeeCsv = (employeeId, name, password, mappedCountryDirectorId = 'cd-synthetic') => {
  const row = {
    employeeId, name, email: `${employeeId.toLowerCase()}@example.test`, designation: 'Consultant', department: 'Delivery',
    country: 'GB', region: '', businessUnit: '', reportingManagerId: '', primaryCountryDirectorId: 'cd-synthetic',
    mappedCountryDirectorIds: mappedCountryDirectorId, utilizationEligible: '', joiningDate: '', exitDate: '',
    standardWeeklyHours: '', capacityType: '', contractType: '', entraObjectId: '', teamsUserId: '', roles: '',
    initialPassword: password, status: 'Active',
  };
  const headers = ['employeeId', 'name', 'email', 'designation', 'department', 'country', 'region', 'businessUnit',
    'reportingManagerId', 'primaryCountryDirectorId', 'mappedCountryDirectorIds', 'utilizationEligible', 'joiningDate',
    'exitDate', 'standardWeeklyHours', 'capacityType', 'contractType', 'entraObjectId', 'teamsUserId', 'roles',
    'initialPassword', 'status'];
  return [headers.join(','), headers.map(header => row[header]).join(',')].join('\n');
};
const selectEmployeeCsv = async (fileName, contents) => {
  await page.locator('input[type="file"]').nth(0).setInputFiles({name: fileName, mimeType: 'text/csv', buffer: Buffer.from(contents)});
};
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
  const unreadableEmployeePassword = randomBytes(30).toString('base64url');
  submittedEmployeePasswords.push(unreadableEmployeePassword);
  await selectEmployeeCsv(`employees-read-error-${unreadableEmployeePassword}.csv`, employeeCsv(
    'EMP-UI-100', 'Synthetic Employee 100', unreadableEmployeePassword,
  ));
  await page.getByText('Could not read Employee Master CSV. Choose the file again to retry.', {exact: true}).waitFor();
  assert.equal((await page.locator('body').innerText()).includes(unreadableEmployeePassword), false,
    'Employee loading/read-failure UI never reveals an unparsed filename containing a credential');

  const firstEmployeePassword = randomBytes(30).toString('base64url');
  submittedEmployeePasswords.push(firstEmployeePassword);
  responsePlans.push({status: 503, body: {error: {code: 'TEMPORARY_UNAVAILABLE', message: 'Temporary service failure.'}}});
  await selectEmployeeCsv('employees-first.csv', employeeCsv('EMP-UI-101', 'Synthetic Employee 101', firstEmployeePassword));
  await page.getByRole('button', {name: 'Apply Valid Rows'}).waitFor();
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText(/The Employee Master apply result for employees-first\.csv was not confirmed\./).waitFor();
  const firstEmployeeApply = lastRequest();
  assert.equal(firstEmployeeApply.path, '/api/v1/imports/employees/apply');
  assert.equal(firstEmployeeApply.body.schemaVersion, 'employee-master/1');
  assert.equal(firstEmployeeApply.body.rows[0].initialPassword, firstEmployeePassword);
  const firstEmployeeKey = firstEmployeeApply.headers['idempotency-key'];
  assert.ok(firstEmployeeKey);
  responsePlans.push({status: 200, body: {...operationResult(firstEmployeeApply.body), replayed: true}});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText('Confirmed the saved Employee Master result for employees-first.csv. This retry replayed the first accepted result and did not change credentials.', {exact: true}).waitFor();
  assert.equal(lastRequest().headers['idempotency-key'], firstEmployeeKey,
    'Employee Master transport retries reuse the original operation key');
  assert.deepEqual(lastRequest().body, firstEmployeeApply.body,
    'Employee Master transport retries preserve the original payload, including the in-memory credential value');
  assert.equal(JSON.stringify(syntheticHistory).includes(firstEmployeePassword), false,
    'saved synthetic history never exposes the submitted initial credential');

  const diagnosticEmployeePassword = randomBytes(30).toString('base64url');
  submittedEmployeePasswords.push(diagnosticEmployeePassword);
  const employeePreflightLogged = page.waitForResponse(response => (
    new URL(response.url()).pathname === '/api/import-export-logs' && response.request().method() === 'POST'
  ));
  await selectEmployeeCsv(`employees-${diagnosticEmployeePassword}.csv`, employeeCsv(
    'EMP-UI-103', 'Synthetic Employee 103', diagnosticEmployeePassword, diagnosticEmployeePassword,
  ));
  await page.getByText('Employee Master validation failed for employees-.csv. Download the error report and correct the file.', {exact: true}).waitFor();
  await employeePreflightLogged;
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'an Employee row with a client-side diagnostic is excluded from apply');
  const diagnosticPreflightLog = genericLogBodies.at(-1);
  assert.equal(diagnosticPreflightLog.fileName, 'employees-.csv', 'Employee preflight history must redact credentials from filenames');
  assert.equal(JSON.stringify(diagnosticPreflightLog).includes(diagnosticEmployeePassword), false,
    'Employee preflight diagnostics and filenames must not retain an echoed credential');

  const changedEmployeePassword = randomBytes(30).toString('base64url');
  submittedEmployeePasswords.push(changedEmployeePassword);
  responsePlans.push({status: 409, body: {error: {code: 'IDEMPOTENCY_KEY_REUSED', message: 'This key was already used with different data.'}}});
  await selectEmployeeCsv('employees-changed.csv', employeeCsv('EMP-UI-102', 'Synthetic Employee 102', changedEmployeePassword));
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText(/The Employee Master key for employees-changed\.csv is tied to different non-credential data\./).waitFor();
  const conflictedEmployeeApply = lastRequest();
  assert.notEqual(conflictedEmployeeApply.headers['idempotency-key'], firstEmployeeKey,
    'a newly selected Employee Master CSV gets a fresh key');
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).isDisabled(), true,
    'a key conflict blocks repeat apply until a new CSV selection creates fresh operation state');

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
  assert.equal(requests.length, 10,
    'the first rejected Project preview includes three earlier Employee apply/retry requests');
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
  assert.equal(requests.length, 11,
    'the malformed-header Project preview is counted after prior Employee and Project requests');
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
  assert.equal(requests.length, 15,
    'Client preview, validation retry and apply requests are included in the v1 request count');

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
  await page.getByText('Applied 1 valid worklog import rows from timesheets-first.csv.', {exact: true}).waitFor();
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

  responsePlans.push({status: 200, delayMs: 250});
  await selectProjectCsv('projects-scope-delayed.csv', csv('PROJECT-SCOPE-DELAYED'));
  const delayedScopeRequest = await Promise.race([
    delayedScopeRequestSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Delayed scope dry-run request did not start.')), 3000)),
  ]);
  assert.equal(delayedScopeRequest.headers['x-organization-id'], 'org-synthetic');
  assert.equal(delayedScopeRequest.headers['x-legal-entity-id'], 'entity-synthetic');
  await page.evaluate(() => {
    sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic-next', legalEntityId: 'entity-synthetic-next'}));
    window.dispatchEvent(new Event('workos:organization-scope-changed'));
  });
  await page.getByText('Organization or legal-entity scope changed. Choose the CSV again to validate it for the current scope.', {exact: true}).waitFor();
  await page.waitForTimeout(350);
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).count(), 0,
    'a dry-run response started in the previous scope cannot restore a pending import after scope changes');
  await page.getByText('No bulk data operations have been run yet in this workspace.', {exact: true}).waitFor();
  assert.equal(await page.getByRole('region', {name: 'Import / Export History'}).getByText('projects-scope-delayed.csv', {exact: true}).count(), 0,
    'history fetched after a scope switch must not show the prior organization/entity batch');

  await selectProjectCsv('projects-scope-pending.csv', csv('PROJECT-SCOPE-PENDING'));
  await page.getByText('Server dry run complete for projects-scope-pending.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const scopedPendingPreview = lastRequest();
  assert.equal(scopedPendingPreview.headers['x-organization-id'], 'org-synthetic-next');
  assert.equal(scopedPendingPreview.headers['x-legal-entity-id'], 'entity-synthetic-next');
  await page.evaluate(() => {
    sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic-final', legalEntityId: 'entity-synthetic-final'}));
    window.dispatchEvent(new Event('workos:organization-scope-changed'));
  });
  await page.getByText('No bulk data operations have been run yet in this workspace.', {exact: true}).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].every(button => button.textContent.trim() !== 'Apply Valid Rows'));
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).count(), 0,
    'a validated pending batch is discarded on organization or legal-entity scope change');

  await selectProjectCsv('projects-scope-current.csv', csv('PROJECT-SCOPE-CURRENT'));
  await page.getByText('Server dry run complete for projects-scope-current.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  const currentScopePreview = lastRequest();
  assert.equal(currentScopePreview.headers['x-organization-id'], 'org-synthetic-final');
  assert.equal(currentScopePreview.headers['x-legal-entity-id'], 'entity-synthetic-final');
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await page.getByText('Applied 1 valid project master rows from projects-scope-current.csv.', {exact: true}).waitFor();
  const currentScopeApply = lastRequest();
  assert.equal(currentScopeApply.headers['x-organization-id'], 'org-synthetic-final');
  assert.equal(currentScopeApply.headers['x-legal-entity-id'], 'entity-synthetic-final');

  await selectProjectCsv('projects-scope-apply.csv', csv('PROJECT-SCOPE-APPLY'));
  await page.getByText('Server dry run complete for projects-scope-apply.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  responsePlans.push({status: 200, delayMs: 250});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  const delayedApplyRequest = await Promise.race([
    delayedApplyRequestSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Delayed scope apply request did not start.')), 3000)),
  ]);
  assert.equal(delayedApplyRequest.headers['x-organization-id'], 'org-synthetic-final');
  assert.equal(delayedApplyRequest.headers['x-legal-entity-id'], 'entity-synthetic-final');
  assert.equal(delayedApplyRequest.body.dryRun, false, 'the in-flight request is the original-scope apply');
  assert.equal(await page.locator('input[type="file"]').nth(2).isDisabled(), true,
    'file selection stays disabled while the old-scope apply is unresolved');
  await page.evaluate(() => {
    sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic-next', legalEntityId: 'entity-synthetic-next'}));
    window.dispatchEvent(new Event('workos:organization-scope-changed'));
  });
  await page.getByText('The organization or legal-entity scope changed while an import apply was in progress. The request may still finish under its original scope, but its result will be hidden. Switch back to that scope and check Import History before retrying.', {exact: true}).waitFor();
  await page.getByText('An import apply response arrived after the scope changed, so its result details are hidden. Switch back to the original scope and check Import History before retrying.', {exact: true}).waitFor();
  const switchedScopeHistory = page.getByRole('region', {name: 'Import / Export History'});
  await switchedScopeHistory.getByText('projects-scope-pending.csv', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).count(), 0,
    'a stale apply response cannot restore its previous-scope pending import');
  assert.equal(await page.getByText('Applied 1 valid project master rows from projects-scope-apply.csv.', {exact: true}).count(), 0,
    'a stale apply response does not expose old-scope result details');
  assert.equal(await page.getByRole('region', {name: 'Import / Export History'}).getByText('projects-scope-apply.csv', {exact: true}).count(), 0,
    'history in the new scope does not reveal the old-scope apply batch');
  assert.equal(await page.locator('input[type="file"]').nth(2).isDisabled(), false,
    'file selection becomes available after the in-flight request finishes');
  assert.ok(await page.evaluate(() => sessionStorage.getItem('workos_import_apply_scope_switch_notice')),
    'an apply-in-flight scope switch persists a short-lived, non-sensitive warning across the header reload');
  await page.reload();
  await page.getByText('The previous-scope import apply may have completed. Switch back to the original scope and check Import History before retrying.', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('workos_import_apply_scope_switch_notice')), null,
    'the persisted warning is consumed on the reloaded page');

  await selectProjectCsv('projects-scope-apply-error.csv', csv('PROJECT-SCOPE-APPLY-ERROR'));
  await page.getByText('Server dry run complete for projects-scope-apply-error.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  responsePlans.push({status: 500, delayMs: 250, body: {error: {code: 'SYNTHETIC_STALE_APPLY', message: 'Synthetic private apply error details.'}}});
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  const delayedErrorApplyRequest = await Promise.race([
    delayedErrorApplyRequestSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Delayed scope error-apply request did not start.')), 3000)),
  ]);
  assert.equal(delayedErrorApplyRequest.body.dryRun, false);
  await page.evaluate(() => {
    sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'}));
    window.dispatchEvent(new Event('workos:organization-scope-changed'));
  });
  await page.getByText('An import apply response arrived after the scope changed, so its result details are hidden. Switch back to the original scope and check Import History before retrying.', {exact: true}).waitFor();
  assert.equal(await page.getByText('Synthetic private apply error details.', {exact: true}).count(), 0,
    'a stale apply error does not expose server error details in the new scope');
  assert.equal(await page.getByRole('button', {name: 'Apply Valid Rows'}).count(), 0,
    'a stale apply error does not restore the old-scope apply control');
  await page.locator('input[type="file"]').nth(2).waitFor({state: 'visible'});
  assert.equal(await page.locator('input[type="file"]').nth(2).isDisabled(), false,
    'file selection becomes available once the stale error response finishes');

  assert.equal(genericLogWrites, 3, 'Employee local preflight retains one legacy marker per selected file, while versioned applies create no duplicate generic history logs');
  assert(genericLogBodies.every(entry => submittedEmployeePasswords.every(password => !JSON.stringify(entry).includes(password))),
    'Employee generic preflight logs must never contain any submitted initial credential');

  await page.reload();
  await page.getByText('The previous-scope import apply may have completed. Switch back to the original scope and check Import History before retrying.', {exact: true}).waitFor();
  await selectProjectCsv('projects-scope-switch-race.csv', csv('PROJECT-SCOPE-SWITCH-RACE'));
  await page.getByText('Server dry run complete for projects-scope-switch-race.csv: 1/1 rows are valid. Review saved errors before applying.', {exact: true}).waitFor();
  responsePlans.push({status: 200, delayMs: 250});
  const delayedScopeValidationApplyRequest = page.waitForRequest(request => {
    const body = request.postDataJSON();
    return new URL(request.url()).pathname === '/api/v1/imports/projects/apply'
      && body.fileName === 'projects-scope-switch-race.csv' && body.dryRun === false;
  });
  await page.getByRole('button', {name: 'Apply Valid Rows'}).click();
  await delayedScopeValidationApplyRequest;
  prepareDeferredScopeValidation();
  const delayedScopeValidationReload = page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 5000});
  const scopeSelection = page.getByLabel('Organization context').selectOption('org-synthetic-next:entity-synthetic-next');
  await scopeValidationStarted;
  await page.getByText('Applied 1 valid project master rows from projects-scope-switch-race.csv.', {exact: true}).waitFor();
  assert.ok(await page.evaluate(() => sessionStorage.getItem('workos_import_apply_scope_switch_notice')),
    'starting real scope validation persists an apply warning before a delayed selector response can arrive');
  releaseScopeValidation();
  await Promise.all([delayedScopeValidationReload, scopeSelection]);
  await page.getByText('The previous-scope import apply may have completed. Switch back to the original scope and check Import History before retrying.', {exact: true}).waitFor();
  await page.getByRole('region', {name: 'Import / Export History'}).getByText('projects-scope-pending.csv', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Data Exports'}).click();
  prepareDeferredGenericLogWrite();
  const exportDownload = page.waitForEvent('download', {timeout: 5000});
  await page.getByTitle('Download Employee Master Export').click();
  await genericLogWriteStarted;
  assert.equal((await exportDownload).suggestedFilename(), 'employees.csv',
    'the synthetic export starts downloading before the saved-history request resolves');
  const scopeReload = page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 5000});
  await page.getByLabel('Organization context').selectOption('org-synthetic-next:entity-synthetic-next');
  await scopeReload;
  releaseGenericLogWrite();
  await page.getByText('An export was in progress when the organization/entity scope changed. It may have been canceled or downloaded under the original scope; check Import History there before retrying.', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('workos_import_export_scope_switch_notice')), null,
    'the export warning survives the real organization selector reload and is consumed');

  await page.goto(`${baseUrl}/tests/fixtures/project-import-ui.html?view=reports`);
  await page.getByLabel('Organization context').waitFor();
  prepareDeferredGenericLogWrite();
  const reportDownload = page.waitForEvent('download', {timeout: 5000});
  await page.getByRole('button', {name: 'CSV'}).first().click();
  await genericLogWriteStarted;
  assert.equal((await reportDownload).suggestedFilename(), 'employees.csv',
    'the Reports Center export starts downloading before the saved-history request resolves');
  const reportScopeReload = page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 5000});
  await page.getByLabel('Organization context').selectOption('org-synthetic:entity-synthetic');
  await reportScopeReload;
  releaseGenericLogWrite();
  await page.getByText('An export was in progress when the organization/entity scope changed. It may have been canceled or downloaded under the original scope; check Import History there before retrying.', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('workos_import_export_scope_switch_notice')), null,
    'the Reports Center export warning survives the real organization selector reload and is consumed');
  assert.deepEqual(pageErrors, []);
  console.log('Employee, project, client, allocation, and timesheet import browser smoke passed: first-result Employee retries, server preview gates, stable retries, fresh keys, saved diagnostics, and invalid-row no-apply cases.');
} finally {
  await browser.close();
}
