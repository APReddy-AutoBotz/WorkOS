import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};
globalThis.sessionStorage = {
  getItem: (key) => (store.has(`session:${key}`) ? store.get(`session:${key}`) : null),
  setItem: (key, value) => store.set(`session:${key}`, String(value)),
  removeItem: (key) => store.delete(`session:${key}`),
  clear: () => {
    for (const key of [...store.keys()]) if (key.startsWith('session:')) store.delete(key);
  },
};

const { DataStorage } = await import('../src/services/storage.ts');
const { employeeService, allocationService, projectService } = await import('../src/services/api.ts');
const {
  buildOrgTree,
  detectHierarchyCycles,
  filterEmployeesByOrgVisibility,
  filterEmployeesForOrgChart,
  getDirectReports,
  validateEmployeeHierarchy,
} = await import('../src/services/orgChart.ts');
const { authService } = await import('../src/services/authService.ts');
const { productConfig } = await import('../src/config/productConfig.ts');

DataStorage.resetDemoData();

const orgChartView = readFileSync('src/components/employee/OrgChartView.tsx', 'utf8');
assert.match(orgChartView, /orgUnitInchargePattern = \/\(country director\|regional lead\|business unit lead\|company director\)/, 'org chart group header should be based on explicit incharge designations');
assert.match(orgChartView, /const leaders = incharges\.slice\(0, 1\)/, 'org chart group header should show one accountable incharge per unit card');
assert.doesNotMatch(orgChartView, /managerIds\.has\(employee\.id\)/, 'org chart group header must not promote ordinary reporting managers into the incharge slot');
assert.doesNotMatch(orgChartView, /leadershipPattern/, 'org chart group header must not infer incharge from broad leadership text matching');

const employees = await employeeService.getAll();
const allocations = await allocationService.getAll();
const projects = await projectService.getAll();

const tree = buildOrgTree(employees.filter(employee => employee.status !== 'Exited'));
assert.equal(tree.root.label, `${productConfig.organizationName} Group`, 'org tree should expose the configured organization root');
assert.ok(tree.root.children.length > 0, 'org tree should include leadership children');
assert.ok(tree.unassigned.length >= 1, 'org tree should surface unassigned or missing-manager employees');

const ceo = employees.find(employee => employee.employeeId === 'CEO-1');
const headOps = employees.find(employee => employee.employeeId === 'OPS-1');
assert.ok(ceo, 'demo data should include CEO/root leadership');
assert.ok(headOps, 'demo data should include Head of Operations');
assert.equal(headOps.reportingManagerId, ceo.id, 'Head of Operations should report to CEO');

const indiaEmployees = filterEmployeesForOrgChart(employees, { country: 'India', showInactive: false }, employees);
assert.ok(indiaEmployees.length > 0, 'country filter should return India employees');
assert.ok(indiaEmployees.every(employee => employee.country === 'India' && employee.status !== 'Exited'), 'country filter should constrain org employees');

const inactiveHidden = filterEmployeesForOrgChart(employees, { showInactive: false }, employees);
const inactiveShown = filterEmployeesForOrgChart(employees, { showInactive: true }, employees);
assert.equal(inactiveHidden.some(employee => employee.status === 'Exited'), false, 'inactive employees should be hidden by default');
assert.ok(inactiveShown.some(employee => employee.status === 'Exited'), 'inactive toggle should include exited employees');

const projectManager = employees.find(employee => employee.employeeId === 'PM-1');
const firstReport = employees.find(employee => employee.reportingManagerId === projectManager?.id && employee.status !== 'Exited');
assert.ok(projectManager && firstReport, 'test needs a project manager with active report');
const reassigned = { ...firstReport, reportingManagerId: projectManager.id };
assert.equal(validateEmployeeHierarchy(employees, reassigned).valid, true, 'valid manager reassignment should pass hierarchy validation');

const selfReporting = validateEmployeeHierarchy(employees, { ...firstReport, reportingManagerId: firstReport.id });
assert.equal(selfReporting.valid, false, 'self-reporting should be rejected');

const cycleEmployees = [
  { ...ceo, reportingManagerId: headOps.id },
  { ...headOps, reportingManagerId: ceo.id },
];
assert.ok(detectHierarchyCycles(cycleEmployees).length > 0, 'cycle detection should identify circular hierarchy');

const admin = await authService.login('admin-1', 'workos-test-only');
assert.equal(filterEmployeesByOrgVisibility({ user: admin, employees, allocations, projects }).length, employees.length, 'Admin should see full org chart');

const pmSession = await authService.login('pm-1', 'workos-test-only', 'ProjectManager');
const pmVisible = filterEmployeesByOrgVisibility({ user: pmSession, employees, allocations, projects });
assert.ok(pmVisible.some(employee => employee.id === projectManager.id), 'Project Manager should see self');
assert.ok(pmVisible.length < employees.length, 'Project Manager org chart should be scoped');

const employeeSession = await authService.login(firstReport.employeeId.toLowerCase(), 'workos-test-only', 'Employee');
const employeeVisible = filterEmployeesByOrgVisibility({ user: employeeSession, employees, allocations, projects });
assert.ok(employeeVisible.some(employee => employee.id === firstReport.id), 'Employee should see self');
assert.ok(employeeVisible.some(employee => employee.id === projectManager.id), 'Employee should see reporting chain');
assert.ok(employeeVisible.length <= getDirectReports(employees, firstReport.id).length + 5, 'Employee scope should stay narrow');

const clickRoute = `/employees/${firstReport.id}`;
assert.match(clickRoute, /^\/employees\/.+/, 'employee card click route should use existing employee detail route');

console.log(JSON.stringify({
  status: 'passed',
  employees: employees.length,
  rootChildren: tree.root.children.length,
  unassigned: tree.unassigned.length,
  pmVisible: pmVisible.length,
  employeeVisible: employeeVisible.length,
}, null, 2));
