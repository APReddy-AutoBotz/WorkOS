import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyPersistedTerminology, productConfig } from '../src/config/productConfig.ts';
import { displayEntityType, termPluralTitle, termTitle } from '../src/config/terminology.ts';
import { getReportExportOptions } from '../src/lib/reportExport.ts';
import { loadRuntimeTerminology } from '../src/config/RuntimeTerminology.tsx';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const keys = ['employee', 'manager', 'teamLead', 'businessUnit', 'region', 'regionalOwner', 'engagement', 'project', 'worklog'];
const synthetic = Object.fromEntries(keys.map((key, index) => [key, `scope alpha ${key} ${index}`]));

applyPersistedTerminology(synthetic);
for (const key of keys) assert.equal(productConfig.terminology[key], synthetic[key], `${key} must accept persisted runtime terminology`);
assert.equal(termTitle('project'), 'Scope Alpha Project 7');
assert.equal(termPluralTitle('employee'), 'Scope Alpha Employee 0s');
assert.equal(displayEntityType('Timesheet'), 'Scope Alpha Worklog 8');

const reports = getReportExportOptions();
assert.match(reports.find(option => option.id === 'master_emp').title, /Scope Alpha Employee 0/);
assert.match(reports.find(option => option.id === 'master_prj').description, /scope alpha engagement 6/);
assert.match(reports.find(option => option.id === 'timesheet_logs').title, /Scope Alpha Worklog 8/);
assert.equal(reports.find(option => option.id === 'timesheet_logs').fileName, 'timesheets.csv', 'CSV filenames remain canonical');

applyPersistedTerminology(Object.fromEntries(keys.map(key => [key, `scope beta ${key}`])));
assert.equal(termTitle('employee'), 'Scope Beta Employee', 'scope refresh changes labels without a rebuild');
applyPersistedTerminology({});
assert.notEqual(termTitle('employee'), 'Scope Beta Employee', 'missing/fetch-failed terms restore configured defaults');
applyPersistedTerminology({ employee: 'unsafe stale label' });
await loadRuntimeTerminology(true, async () => { throw new Error('synthetic fetch failure'); });
assert.notEqual(termTitle('employee'), 'Unsafe Stale Label', 'fetch failure clears stale persisted terms');
await loadRuntimeTerminology(false, async () => ({ terms: synthetic }));
assert.notEqual(termTitle('employee'), 'Scope Alpha Employee 0', 'unauthenticated loading never applies persisted terms');

const surfaces = {
  employee: ['src/components/Layout/Sidebar.tsx', 'src/components/forms/EmployeeForm.tsx'],
  manager: ['src/components/forms/EmployeeForm.tsx', 'src/components/forms/ProjectForm.tsx'],
  teamLead: ['src/components/forms/ProjectForm.tsx', 'src/components/employee/OrgChartView.tsx'],
  businessUnit: ['src/components/forms/EmployeeForm.tsx', 'src/components/employee/OrgChartView.tsx'],
  region: ['src/components/forms/EmployeeForm.tsx', 'src/components/employee/OrgChartView.tsx'],
  regionalOwner: ['src/components/forms/EmployeeForm.tsx', 'src/lib/reportExport.ts'],
  engagement: ['src/pages/ProjectDetail.tsx', 'src/lib/reportExport.ts'],
  project: ['src/components/Layout/Sidebar.tsx', 'src/components/forms/ProjectForm.tsx'],
  worklog: ['src/lib/reportExport.ts', 'src/services/api.ts'],
};
for (const [key, files] of Object.entries(surfaces)) {
  assert(files.some(file => read(file).includes(`'${key}'`)), `${key} must be consumed on a covered display surface`);
}

const runtime = read('src/config/RuntimeTerminology.tsx');
assert.match(runtime, /workos:organization-scope-changed/);
assert.match(runtime, /applyPersistedTerminology\(\{\}\)/, 'unauthenticated/fetch failure fallback remains deterministic');

const canonical = [
  ['src/components/Layout/Sidebar.tsx', "path: '/employees'"],
  ['src/components/Layout/Sidebar.tsx', "path: '/projects'"],
  ['src/services/api.ts', "eventType: 'ApprovalRequested'"],
  ['src/services/api.ts', 'entityType: next.entityType'],
  ['src/lib/reportExport.ts', "fileName: 'timesheets.csv'"],
];
for (const [file, token] of canonical) assert(read(file).includes(token), `canonical token changed: ${file} ${token}`);

const literalBypassAllowList = new Set([
  'src/components/ui/PageHeader.tsx', // canonical breadcrumb-to-route mapping
  'src/services/permissions.ts', // stable permission registry documentation
]);
for (const file of literalBypassAllowList) assert(fs.existsSync(path.join(root, file)));

const coveredLiteralScan = {
  'src/components/Layout/Sidebar.tsx': ['Employee Directory', 'Project Master'],
  'src/components/forms/EmployeeForm.tsx': ['Employee ID is required', '>Employee ID<', '>Region<', '>Business Unit<', '>Reporting Manager<'],
  'src/components/forms/ProjectForm.tsx': ['Project Name is required', 'Project Code is required', '>Project Manager<'],
  'src/lib/reportExport.ts': ['Employee Master Export', 'Project Master Export', 'Timesheet Audit Export', 'Employee-project assignments'],
};
for (const [file, literals] of Object.entries(coveredLiteralScan)) {
  const source = read(file);
  for (const literal of literals) assert(!source.includes(literal), `covered display literal bypasses terminology: ${file}: ${literal}`);
}

console.log('Runtime terminology smoke checks passed');
