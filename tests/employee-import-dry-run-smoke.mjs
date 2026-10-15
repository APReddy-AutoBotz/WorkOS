import assert from 'node:assert/strict';
import {safeEmployeeImportDryRunErrors, validateEmployeeImportDryRun} from '../server/modules/imports/employee-import-dry-run.mjs';

const scope = {organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'};
const makeClient = ({
  existing = null,
  existingByEmployeeId = {},
  scopedEmployees,
  crossScope = null,
  emailOwner = null,
  user = null,
  usersByRecordId = {},
} = {}) => {
  const queries = [];
  const employees = scopedEmployees || [{
    id: 'employee-manager', employee_id: 'manager-1', status: 'Active', reporting_manager_id: null,
  }, ...(existing ? [existing] : [])];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({sql: String(sql).replace(/\s+/g, ' ').trim(), params});
      const statement = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      assert.doesNotMatch(statement, /^(insert|update|delete|upsert)\b/, 'Employee preview validation must issue no business writes');
      if (statement.includes('from country_directors')) return {rows: [{id: 'cd-synthetic'}]};
      if (statement.includes('from employees') && statement.includes('reporting_manager_id') && statement.includes('organization_id=$1')) return {rows: employees};
      if (statement.includes('legal_entity_id is distinct from')) return {rows: crossScope ? [crossScope] : []};
      if (statement.includes('from employees where employee_id = $1')) {
        const employee = existingByEmployeeId[params[0]] || existing;
        return {rows: employee ? [employee] : []};
      }
      if (statement.includes('lower(email)')) return {rows: emailOwner ? [emailOwner] : []};
      if (statement.includes('from users where employee_record_id')) {
        const linkedUser = usersByRecordId[params[0]] || user;
        return {rows: linkedUser ? [linkedUser] : []};
      }
      return {rows: []};
    },
  };
};
const baseRow = {
  employeeId: 'EMP-SYNTHETIC-DRYRUN',
  name: 'Synthetic Dry Run Employee',
  email: 'dryrun@example.test',
  primaryCountryDirectorId: 'cd-synthetic',
  reportingManagerId: 'manager-1',
  initialPasswordPresent: true,
};
const check = (client, rows, overrides = {}) => validateEmployeeImportDryRun({
  client,
  rows,
  rowNumbers: rows.map((_, index) => index + 2),
  duplicateRowNumbers: new Set(),
  duplicateErrors: [],
  scope,
  assertMayExit: async () => assert.fail('unexpected exit validation'),
  assertMayReactivate: async () => assert.fail('unexpected reactivation validation'),
  ...overrides,
});

const validClient = makeClient();
assert.deepEqual(await check(validClient, [baseRow]), {errors: [], validRows: 1});
assert.equal(validClient.queries.some(({sql}) => /^(insert|update|delete)\b/i.test(sql)), false);
assert(validClient.queries.some(({sql, params}) => sql.includes('organization_id=$1 and legal_entity_id=$2')
  && params[0] === scope.organizationId && params[1] === scope.legalEntityId),
'the employee graph used for manager validation is loaded only from the captured organization/legal-entity pair');

const missingCredentialClient = makeClient();
const missingCredential = await check(missingCredentialClient, [{...baseRow, initialPasswordPresent: false}]);
assert.equal(missingCredential.validRows, 0);
assert.equal(missingCredential.errors[0].field, 'initialPassword');
assert.equal(safeEmployeeImportDryRunErrors(missingCredential.errors)[0].message,
  'A new employee account requires an initial password before apply.');

const existingEmployeeClient = makeClient({
  existing: {id: 'employee-existing', status: 'Active'},
  user: {id: 'user-existing'},
});
const existingEmployee = await check(existingEmployeeClient, [{...baseRow, initialPasswordPresent: false}]);
assert.equal(existingEmployee.validRows, 1, 'an existing account does not require a new initial password for preview');
assert(existingEmployeeClient.queries.some(({sql}) => sql.includes('from users where employee_record_id')));

const exitingEmployee = {id: 'employee-exiting', employee_id: baseRow.employeeId, status: 'Active'};
let exitCheckArgs;
const exitBlocked = await check(makeClient({existing: exitingEmployee, user: {id: 'user-exiting'}}), [
  {...baseRow, status: 'Exited', exitDate: '2026-10-01', initialPasswordPresent: false},
], {
  assertMayExit: async (...args) => {
    exitCheckArgs = args;
    const error = new Error('Worker has active dependencies');
    error.code = 'WORKER_DEPENDENCY_CONFLICT';
    error.dependencies = [{id: 'sensitive-dependent-record'}];
    throw error;
  },
});
assert.equal(exitBlocked.validRows, 0);
assert.equal(exitCheckArgs[0].queries.length > 0, true);
assert.deepEqual(exitCheckArgs.slice(1), [exitingEmployee, scope, '2026-10-01', {simulatedDirectReportIds: []}]);
assert.deepEqual(safeEmployeeImportDryRunErrors(exitBlocked.errors), [{rowNumber: 2, field: 'status',
  message: 'The Employee Master row failed validation. Review the row and field before applying.',
  code: 'WORKER_DEPENDENCY_CONFLICT'}], 'exit diagnostics omit dependency identifiers');

const exitedEmployee = {id: 'employee-reactivating', employee_id: baseRow.employeeId, status: 'Exited'};
let reactivationCheckArgs;
const reactivationBlocked = await check(makeClient({existing: exitedEmployee, user: {id: 'user-reactivating'}}), [
  {...baseRow, status: 'Active', initialPasswordPresent: false},
], {
  assertMayReactivate: async (...args) => {
    reactivationCheckArgs = args;
    const error = new Error('Worker reactivation conflicts with existing history');
    error.code = 'WORKER_VERSION_CONFLICT';
    throw error;
  },
});
assert.equal(reactivationBlocked.validRows, 0);
assert.equal(reactivationCheckArgs[0].queries.length > 0, true);
assert.deepEqual(reactivationCheckArgs[1], {
  employeeId: exitedEmployee.id,
  organizationId: scope.organizationId,
  legalEntityId: scope.legalEntityId,
  effectiveFrom: new Date().toISOString().slice(0, 10),
  status: 'Active',
});
assert.deepEqual(safeEmployeeImportDryRunErrors(reactivationBlocked.errors), [{rowNumber: 2, field: 'status',
  message: 'The Employee Master row failed validation. Review the row and field before applying.',
  code: 'WORKER_VERSION_CONFLICT'}]);

let simulatedExitDependencies;
const exitAfterReportMove = await check(makeClient({
  scopedEmployees: [
    {id: 'employee-report-a', employee_id: 'EMP-REPORT-A', status: 'Active', reporting_manager_id: 'employee-manager-b'},
    {id: 'employee-manager-b', employee_id: 'EMP-MANAGER-B', status: 'Active', reporting_manager_id: null},
    {id: 'employee-manager-c', employee_id: 'EMP-MANAGER-C', status: 'Active', reporting_manager_id: null},
  ],
  existingByEmployeeId: {
    'EMP-REPORT-A': {id: 'employee-report-a', employee_id: 'EMP-REPORT-A', status: 'Active', reporting_manager_id: 'employee-manager-b'},
    'EMP-MANAGER-B': {id: 'employee-manager-b', employee_id: 'EMP-MANAGER-B', status: 'Active', reporting_manager_id: null},
  },
  usersByRecordId: {'employee-report-a': {id: 'user-report-a'}, 'employee-manager-b': {id: 'user-manager-b'}},
}), [
  {...baseRow, employeeId: 'EMP-REPORT-A', email: 'report-a@example.test', reportingManagerId: 'EMP-MANAGER-C', initialPasswordPresent: false},
  {...baseRow, employeeId: 'EMP-MANAGER-B', email: 'manager-b@example.test', status: 'Exited', exitDate: '2026-10-01', reportingManagerId: undefined, initialPasswordPresent: false},
], {
  assertMayExit: async (_client, _employee, _scope, _effectiveDate, options) => {
    simulatedExitDependencies = options.simulatedDirectReportIds;
  },
});
assert.equal(exitAfterReportMove.validRows, 2,
  'a later manager exit preview sees an earlier accepted source-row reassignment');
assert.deepEqual(simulatedExitDependencies, [],
  'the moved direct report is absent from the later exit dependency set');

let remainingExitDependencies;
const exitWithUnchangedReport = await check(makeClient({
  scopedEmployees: [
    {id: 'employee-report-a', employee_id: 'EMP-REPORT-A', status: 'Active', reporting_manager_id: 'employee-manager-b'},
    {id: 'employee-manager-b', employee_id: 'EMP-MANAGER-B', status: 'Active', reporting_manager_id: null},
  ],
  existingByEmployeeId: {
    'EMP-MANAGER-B': {id: 'employee-manager-b', employee_id: 'EMP-MANAGER-B', status: 'Active', reporting_manager_id: null},
  },
  usersByRecordId: {'employee-manager-b': {id: 'user-manager-b'}},
}), [
  {...baseRow, employeeId: 'EMP-MANAGER-B', email: 'manager-b@example.test', status: 'Exited', exitDate: '2026-10-01', reportingManagerId: undefined, initialPasswordPresent: false},
], {
  assertMayExit: async (_client, _employee, _scope, _effectiveDate, options) => {
    remainingExitDependencies = options.simulatedDirectReportIds;
    if (remainingExitDependencies.length) {
      const error = new Error('Worker has active dependencies');
      error.code = 'WORKER_DEPENDENCY_CONFLICT';
      throw error;
    }
  },
});
assert.equal(exitWithUnchangedReport.validRows, 0);
assert.deepEqual(remainingExitDependencies, ['employee-report-a'],
  'preview still blocks an exit while an in-scope active report remains assigned');

const importedManagerRows = await check(makeClient(), [
  {...baseRow, employeeId: 'EMP-DRYRUN-MANAGER', email: 'manager@example.test', reportingManagerId: undefined},
  {...baseRow, employeeId: 'EMP-DRYRUN-CHILD', email: 'child@example.test', reportingManagerId: 'EMP-DRYRUN-MANAGER'},
]);
assert.equal(importedManagerRows.validRows, 2,
  'a valid later source row can reference an earlier employee created by the same import');

const cycleRows = [
  {id: 'employee-cycle-a', employee_id: 'EMP-CYCLE-A', status: 'Active', reporting_manager_id: 'employee-cycle-root'},
  {id: 'employee-cycle-b', employee_id: 'EMP-CYCLE-B', status: 'Active', reporting_manager_id: 'employee-cycle-root'},
  {id: 'employee-cycle-root', employee_id: 'EMP-CYCLE-ROOT', status: 'Active', reporting_manager_id: null},
];
const managerCycleClient = makeClient({
  scopedEmployees: cycleRows,
  existingByEmployeeId: { 'EMP-CYCLE-A': cycleRows[0], 'EMP-CYCLE-B': cycleRows[1] },
  usersByRecordId: {'employee-cycle-a': {id: 'user-cycle-a'}, 'employee-cycle-b': {id: 'user-cycle-b'}},
});
const managerCycle = await check(managerCycleClient, [
  {...baseRow, employeeId: 'EMP-CYCLE-A', email: 'cycle-a@example.test', reportingManagerId: 'EMP-CYCLE-B', initialPasswordPresent: false},
  {...baseRow, employeeId: 'EMP-CYCLE-B', email: 'cycle-b@example.test', reportingManagerId: 'EMP-CYCLE-A', initialPasswordPresent: false},
], {rowNumbers: [2, 3]});
assert.equal(managerCycle.validRows, 1,
  'preview applies accepted earlier manager edges in memory before checking later rows');
assert.deepEqual(safeEmployeeImportDryRunErrors(managerCycle.errors), [{rowNumber: 3, field: 'reportingManagerId',
  message: 'The Employee Master row failed validation. Review the row and field before applying.'}]);
assert.equal(managerCycleClient.queries.some(({sql}) => /^(insert|update|delete)\b/i.test(sql)), false,
  'simulating accepted manager changes never writes them during preview');

const scopedConflictClient = makeClient({crossScope: {id: 'employee-other-entity'}});
const scopedConflict = await check(scopedConflictClient, [baseRow]);
assert.equal(scopedConflict.validRows, 0);
assert.equal(scopedConflict.errors[0].code, 'EMPLOYEE_SCOPE_CONFLICT');
const safeScopedConflict = safeEmployeeImportDryRunErrors(scopedConflict.errors);
assert.deepEqual(safeScopedConflict, [{rowNumber: 2, field: 'employeeId',
  message: 'The Employee Master row failed validation. Review the row and field before applying.',
  code: 'EMPLOYEE_SCOPE_CONFLICT'}]);

const duplicateRow = {rowNumber: 3, field: 'employeeId', message: 'Duplicate employee ID EMP-SYNTHETIC-DRYRUN.', sourceIdentifier: 'prior credential echo'};
const duplicateClient = makeClient();
const duplicates = await check(duplicateClient, [baseRow, {...baseRow, employeeId: 'EMP-SYNTHETIC-DUP'}], {
  rowNumbers: [2, 3],
  duplicateRowNumbers: new Set([3]),
  duplicateErrors: [duplicateRow],
});
assert.equal(duplicates.validRows, 1);
assert.equal(JSON.stringify(safeEmployeeImportDryRunErrors(duplicates.errors)).includes('prior credential echo'), false,
  'preview diagnostics never return client-supplied source identifiers or messages');

console.log('Employee import dry-run validation smoke passed: scoped checks, no business writes, credential-presence guard and safe diagnostics.');
