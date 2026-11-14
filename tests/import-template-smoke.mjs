import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const templateDir = join('templates', 'import');

const requiredHeaders = {
  'employees-template.csv': ['employeeId', 'name', 'email', 'designation', 'department', 'country', 'region', 'businessUnit', 'reportingManagerId', 'primaryCountryDirectorId', 'mappedCountryDirectorIds', 'utilizationEligible', 'joiningDate', 'exitDate', 'standardWeeklyHours', 'capacityType', 'contractType', 'entraObjectId', 'teamsUserId', 'roles', 'initialPassword', 'status'],
  'clients-template.csv': ['id', 'name', 'industry', 'accountOwnerId', 'countryDirectorIds', 'status'],
  'projects-template.csv': ['projectCode', 'name', 'clientId', 'client', 'managerId', 'startDate', 'endDate', 'status', 'billable', 'projectType', 'country', 'notes'],
  'allocations-template.csv': ['id', 'employeeId', 'projectId', 'roleOnProject', 'percentage', 'startDate', 'endDate', 'billable', 'status', 'comments'],
  'timesheets-template.csv': ['employeeId', 'weekEnding', 'workType', 'projectId', 'clientName', 'category', 'date', 'hours', 'remark', 'billable', 'status', 'rejectionReason'],
};

for (const [fileName, expectedHeaders] of Object.entries(requiredHeaders)) {
  const csv = readFileSync(join(templateDir, fileName), 'utf8').trim();
  assert.ok(csv, `${fileName} should not be empty`);
  const [headerLine, ...rows] = csv.split(/\r?\n/);
  const headers = headerLine.split(',');
  assert.deepEqual(headers, expectedHeaders, `${fileName} headers must match import contract`);
  assert.ok(rows.length >= 1, `${fileName} should include at least one example row`);
  for (const [index, row] of rows.entries()) {
    const values = row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(value => value.replace(/^"|"$/g, '').replace(/""/g, '"'));
    assert.equal(values.length, headers.length, `${fileName} row ${index + 2} must align with every header`);
    if (fileName === 'employees-template.csv') {
      const employee = Object.fromEntries(headers.map((header, column) => [header, values[column]]));
      assert.match(employee.utilizationEligible, /^(true|false)$/);
      assert.match(employee.joiningDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(employee.standardWeeklyHours, '40');
      assert.ok(['Delivery', 'Governance'].includes(employee.capacityType));
      assert.equal(employee.contractType, 'Permanent');
      assert.ok(employee.roles.split('|').includes('Employee') || employee.roles === 'Admin');
      assert.equal(employee.initialPassword, '');
      assert.equal(employee.status, 'Active');
      assert.ok(employee.email.endsWith('@example.invalid'), 'Template identities must use a reserved, non-deliverable example domain');
    }
  }
}

console.log(JSON.stringify({
  status: 'passed',
  templates: Object.keys(requiredHeaders),
}, null, 2));
