import assert from 'node:assert/strict';
import {
  attachImportErrorSourceIdentifiers,
  importErrorRowSchema,
  isSafeImportErrorSourceIdentifier,
  normalizeImportErrorSourceIdentifier,
  resolveImportApplyRowNumbers,
} from '../server/modules/imports/import-error-provenance.mjs';
import {attachPreflightSourceIdentifiers} from '../src/lib/importErrorProvenance.ts';

assert.equal(isSafeImportErrorSourceIdentifier('EMP-001'), true);
assert.equal(isSafeImportErrorSourceIdentifier('x'.repeat(200)), true);
assert.equal(isSafeImportErrorSourceIdentifier(''), false);
assert.equal(isSafeImportErrorSourceIdentifier('   '), false);
assert.equal(isSafeImportErrorSourceIdentifier('EMP\n001'), false);
assert.equal(isSafeImportErrorSourceIdentifier('EMP\u202e001'), false);
assert.equal(isSafeImportErrorSourceIdentifier('\ud800'), false);
assert.equal(isSafeImportErrorSourceIdentifier('x'.repeat(201)), false);
assert.equal(normalizeImportErrorSourceIdentifier(null), null);
assert.equal(normalizeImportErrorSourceIdentifier('   '), null);

assert.equal(importErrorRowSchema.safeParse({rowNumber: 2, field: 'email', message: 'Required'}).success, true,
  'older error rows without a source ID remain valid');
assert.equal(importErrorRowSchema.safeParse({rowNumber: 2, message: 'Required', sourceIdentifier: null}).success, true);
assert.equal(importErrorRowSchema.safeParse({rowNumber: 0, message: 'Invalid row'}).success, false);
assert.equal(importErrorRowSchema.safeParse({rowNumber: 2, message: 'Invalid ID', sourceIdentifier: 'x'.repeat(201)}).success, false);
assert.equal(importErrorRowSchema.safeParse({rowNumber: 2, message: 'Invalid ID', sourceIdentifier: 'bad\u0000id'}).success, false);
assert.equal(importErrorRowSchema.safeParse({rowNumber: 2, message: 'Invalid ID', sourceIdentifier: 'EMP\u202e001'}).success, false);

const originalRows = [
  {employeeId: 'EMP-PREFLIGHT-REJECTED', name: '', email: 'invalid@example.test'},
  {employeeId: 'EMP-SERVER-REJECTED', name: 'Rejected by server', email: 'server-rejected@example.test'},
  {employeeId: 'EMP-SAVED', name: 'Saved', email: 'saved@example.test'},
];
const preflightErrors = attachPreflightSourceIdentifiers('employees', originalRows, [
  {rowNumber: 2, field: 'name', message: 'Name is required.'},
  {rowNumber: 1, field: 'header', message: 'Missing header.'},
]);
assert.deepEqual(preflightErrors.map(error => error.sourceIdentifier), ['EMP-PREFLIGHT-REJECTED', null],
  'preflight IDs must come from the original CSV row, before valid rows are filtered');
const headerErrorWithForgedIdentifier = attachImportErrorSourceIdentifiers({
  errors: [{rowNumber: 1, field: 'header', message: 'Missing header.', sourceIdentifier: 'NOT-A-ROW'}],
  clientErrors: [{rowNumber: 1, field: 'header', message: 'Missing header.', sourceIdentifier: 'NOT-A-ROW'}],
  rows: originalRows,
  rowNumbers: [2, 3, 4],
  mappingIsReliable: true,
  sourceIdentifierForRow: row => row.employeeId,
});
assert.equal(headerErrorWithForgedIdentifier[0].sourceIdentifier, null,
  'header errors cannot claim a data-row source identifier');

const timesheetErrorWithForgedIdentifier = attachImportErrorSourceIdentifiers({
  errors: [{rowNumber: 2, field: 'employeeId', message: 'Rejected.', sourceIdentifier: 'FORGED-EMPLOYEE-ID'}],
  clientErrors: [{rowNumber: 2, field: 'employeeId', message: 'Rejected.', sourceIdentifier: 'FORGED-EMPLOYEE-ID'}],
  rows: [{employeeId: 'EMP-1'}],
  rowNumbers: [3],
  mappingIsReliable: true,
  sourceIdentifierForRow: () => null,
  allowClientSourceIdentifiers: false,
});
assert.equal(timesheetErrorWithForgedIdentifier[0].sourceIdentifier, null,
  'timesheet errors must discard client-supplied IDs because this import has no upstream identifier');

for (const [channel, rows, expected] of [
  ['clients', [{id: 'CLIENT-1'}], 'CLIENT-1'],
  ['projects', [{projectCode: 'PROJECT-1'}], 'PROJECT-1'],
  ['allocations', [{id: 'ALLOCATION-1'}], 'ALLOCATION-1'],
  ['timesheets', [{employeeId: 'EMP-1'}], null],
]) {
  assert.equal(attachPreflightSourceIdentifiers(channel, rows, [
    {rowNumber: 2, field: 'field', message: 'Invalid.'},
  ])[0].sourceIdentifier, expected, `${channel} preflight source identifier mapping`);
}
assert.equal(attachPreflightSourceIdentifiers('clients', [{id: 'bad\u007fid'}], [
  {rowNumber: 2, message: 'Invalid.'},
])[0].sourceIdentifier, null, 'malformed source IDs remain absent');

const rowsAfterPreflight = [
  {employeeId: 'EMP-SERVER-REJECTED'},
  {employeeId: 'EMP-SAVED'},
];
const clientErrors = [
  {rowNumber: 2, field: 'name', message: 'Name is required.', sourceIdentifier: 'EMP-PREFLIGHT-REJECTED'},
];
const rowMapping = resolveImportApplyRowNumbers({rows: rowsAfterPreflight, totalRows: 3, clientErrors});
assert.deepEqual(rowMapping, {rowNumbers: [3, 4], mappingIsReliable: true},
  'server row mapping must restore original row numbers after the preflight-invalid row was filtered');
const responseErrors = attachImportErrorSourceIdentifiers({
  errors: [...clientErrors, {rowNumber: 3, field: 'primaryCountryDirectorId', message: 'Required.', code: 'MISSING_DIRECTOR'}],
  clientErrors,
  rows: rowsAfterPreflight,
  ...rowMapping,
  sourceIdentifierForRow: row => row.employeeId,
});
assert.deepEqual(responseErrors, [
  {...clientErrors[0]},
  {rowNumber: 3, field: 'primaryCountryDirectorId', message: 'Required.', code: 'MISSING_DIRECTOR', sourceIdentifier: 'EMP-SERVER-REJECTED'},
], 'server errors must map to the matching original row and preserve existing error metadata');

const inconsistentMapping = resolveImportApplyRowNumbers({rows: rowsAfterPreflight, totalRows: 4, clientErrors});
assert.equal(inconsistentMapping.mappingIsReliable, false,
  'inconsistent row counts must fail closed instead of guessing an original row');
const unverifiedServerError = attachImportErrorSourceIdentifiers({
  errors: [clientErrors[0], {rowNumber: 2, message: 'Unknown row.'}],
  rows: rowsAfterPreflight,
  clientErrors,
  ...inconsistentMapping,
  sourceIdentifierForRow: row => row.employeeId,
});
assert.deepEqual(unverifiedServerError.map(error => error.sourceIdentifier), [null, null],
  'provenance must be omitted when original row attribution is unproven');

console.log(JSON.stringify({
  status: 'passed',
  coverage: ['identifier validation', 'original CSV row attribution', 'filtered-row mapping', 'fail-closed mapping'],
}, null, 2));
