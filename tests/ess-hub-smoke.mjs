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
    for (const key of [...store.keys()]) {
      if (key.startsWith('session:')) store.delete(key);
    }
  },
};

const todayIso = new Date().toISOString().slice(0, 10);
const inRange = (startDate, endDate) => startDate <= todayIso && endDate >= todayIso;

const app = readFileSync('src/App.tsx', 'utf8');
const essPage = readFileSync('src/pages/LeaveManagement.tsx', 'utf8');
const employeeWorkspace = readFileSync('src/pages/EmployeeWorkspace.tsx', 'utf8');
const permissions = readFileSync('src/services/permissions.ts', 'utf8');
const sidebar = readFileSync('src/components/Layout/Sidebar.tsx', 'utf8');
const header = readFileSync('src/components/Layout/Header.tsx', 'utf8');
const employeeDetail = readFileSync('src/pages/EmployeeDetail.tsx', 'utf8');
const traceability = readFileSync('src/pages/BRDTraceability.tsx', 'utf8');
const requirements = readFileSync('docs/03-specifications/WOS01A_RETAINED_REQUIREMENTS.md', 'utf8');

const { DataStorage, STORAGE_KEYS } = await import('../src/services/storage.ts');
const {
  allocationService,
  approvalService,
  employeeService,
  leaveService,
  notificationService,
  projectService,
  timesheetService,
  adminService,
} = await import('../src/services/api.ts');
const { getAllocationLoad, getLatestApprovedActualUtilization, isProjectAvailableForPlanning, overlapsDateRange } = await import('../src/services/calculations.ts');

DataStorage.resetDemoData();

const [employees, projects, allocations, timesheets, settings, directors] = await Promise.all([
  employeeService.getAll(),
  projectService.getAll(),
  allocationService.getAll(),
  timesheetService.getAll(),
  adminService.getSettings(),
  adminService.getCountryDirectors(),
]);

const employee = employees.find((item) =>
  item.status === 'Active' &&
  allocations.some((allocation) =>
    allocation.employeeId === item.id &&
    allocation.status === 'Active' &&
    inRange(allocation.startDate, allocation.endDate)
  )
);
assert.ok(employee, 'ESS smoke requires one active employee with a current allocation');

const currentAllocations = allocations.filter((allocation) => {
  const project = projects.find((item) => item.id === allocation.projectId);
  return allocation.employeeId === employee.id &&
    allocation.status === 'Active' &&
    project &&
    isProjectAvailableForPlanning(project, todayIso, todayIso) &&
    overlapsDateRange(allocation.startDate, allocation.endDate, todayIso, todayIso);
});

const expectedPlanned = getAllocationLoad(employee.id, allocations, projects, todayIso, todayIso);
const essPlanned = currentAllocations.reduce((sum, allocation) => sum + allocation.percentage, 0);
assert.equal(essPlanned, expectedPlanned, 'ESS planned utilization must be derived from active allocation load');
assert.ok(currentAllocations.every((allocation) => projects.some((project) => project.id === allocation.projectId)), 'ESS current work must resolve project context from allocations');
if (employee.primaryCountryDirectorId) {
  assert.ok(directors.some((director) => director.id === employee.primaryCountryDirectorId), 'ESS primary Country Director mapping should resolve from employee master data');
}
assert.ok(Array.isArray(employee.mappedCountryDirectorIds), 'ESS should consume mapped Country Director relationships from employee master data');
assert.ok((employee.standardWeeklyHours || 40) > 0, 'ESS capacity profile should include or safely default standard weekly hours');

const approvedTimesheetEmployee = employees.find((item) =>
  timesheets.some((timesheet) => timesheet.employeeId === item.id && timesheet.status === 'Approved')
);
assert.ok(approvedTimesheetEmployee, 'ESS smoke requires one employee with an approved timesheet');
const approvedEmployeeTimesheets = timesheets.filter((timesheet) => timesheet.employeeId === approvedTimesheetEmployee.id);
const expectedActual = getLatestApprovedActualUtilization(approvedTimesheetEmployee.id, approvedEmployeeTimesheets, settings);
assert.ok(expectedActual >= 0, 'ESS actual utilization should calculate from approved timesheets');
assert.equal(approvedTimesheetEmployee.actualUtilization, expectedActual, 'employee actual utilization should match approved timesheet calculation used by ESS');

const leaveTypes = await leaveService.getTypes();
const leaveType = leaveTypes.find((type) => type.active);
assert.ok(leaveType, 'ESS leave panel requires an active leave type when leave is enabled');
const availabilityBefore = (await leaveService.getAvailability()).find((row) => row.employeeId === employee.id);
assert.ok(availabilityBefore, 'employee should have leave-adjusted availability row');
const leaveRequest = await leaveService.submitRequest({
  id: '',
  employeeId: employee.id,
  leaveTypeId: leaveType.id,
  startDate: '2026-07-06',
  endDate: '2026-07-10',
  totalDays: 0,
  status: 'Submitted',
  reason: 'ESS relationship smoke test',
});
await leaveService.updateRequestStatus(leaveRequest.id, 'Approved');
const availabilityAfter = (await leaveService.getAvailability()).find((row) => row.employeeId === employee.id);
assert.ok(availabilityAfter.approvedLeaveDays >= availabilityBefore.approvedLeaveDays + 5, 'approved leave should flow into ESS availability');
assert.ok(availabilityAfter.availabilityHours < availabilityBefore.availabilityHours, 'approved leave should reduce leave-adjusted availability hours');

const approval = (await approvalService.getAll()).find((record) =>
  record.entityType === 'LeaveRequest' &&
  record.entityId === leaveRequest.id &&
  record.subjectEmployeeId === employee.id
);
assert.ok(approval, 'leave request should create an employee-scoped approval record for ESS actions');

const notifications = await notificationService.getAll();
assert.ok(notifications.some((event) => event.recipientEmployeeId === employee.id), 'approval decisions should create employee-scoped notifications for ESS actions');

assert.match(app, /if \(role === 'Employee'\) return '\/ess'/, 'employee home route should target unified ESS hub');
assert.match(app, /path="\/my-workspace"[\s\S]*<EmployeeWorkspace \/>/, 'My Workspace compatibility route should remain available');
assert.match(employeeWorkspace, /<ESSHome initialSection="work" \/>/, 'My Workspace route should render ESS focused on Work & Utilization');
assert.match(permissions, /ess: 'employee_workspace\.view'/, 'ESS route should use core employee workspace permission');
assert.match(sidebar, /name: `My \$\{productConfig\.productName\} Hub`[\s\S]*path: '\/ess'[\s\S]*navRoles: \['Employee'\]/, 'sidebar should expose the configured primary employee ESS hub without weakening its route or navigation role');
assert.doesNotMatch(header, /page-my-workspace/, 'header search should not expose My Workspace as a separate navigation concept');
assert.match(header, /page-ess[\s\S]*title: `My \$\{productConfig\.productName\} Hub`[\s\S]*path: '\/ess'/, 'header search should expose the configured unified ESS hub on its canonical route');
assert.match(employeeDetail, /isSelfServiceView \? '\/ess' : '\/employees'/, 'employee self-profile back link should return to the unified ESS hub');
assert.match(traceability, /module: `ESS \/ My \$\{productConfig\.productName\} Hub`[\s\S]*engineeringStatus: 'Prod Core RC'[\s\S]*\/my-workspace remains a compatibility route only/, 'BRD traceability should use the configured product label while preserving ESS lifecycle evidence');
assert.match(essPage, /leaveFeatureEnabled\(\)[\s\S]*EmployeeLeavePanel/, 'leave-specific ESS section should remain release-gated');
assert.match(essPage, /Primary CD[\s\S]*Mapped CDs[\s\S]*Employment[\s\S]*Leave Policy/, 'ESS profile should expose manager, Country Director, employment, capacity, and leave-policy relationships');
assert.match(essPage, /type EssActionItem[\s\S]*href: '\/timesheets'[\s\S]*href: '\/leave\/my'[\s\S]*href: notificationsFeatureEnabled\(\) \? '\/notifications'/, 'ESS personal actions should be structured follow-ups with target routes');
assert.match(essPage, /actionStyles[\s\S]*actionItems\.slice\(0, 6\)\.map[\s\S]*to=\{action\.href\}/, 'ESS personal actions should render as actionable severity-coded links');
assert.match(essPage, /getLatestApprovedActualUtilization[\s\S]*currentAllocations\.reduce/, 'ESS should compose actual utilization and planned allocation load from shared logic');
assert.match(requirements, /ESS \/ My WorkOS Hub[\s\S]*allocation-derived work[\s\S]*approved-timesheet actual utilization/, 'BRD source of truth should describe unified ESS relationships');

console.log(JSON.stringify({
  status: 'passed',
  employee: employee.employeeId,
  currentAllocations: currentAllocations.length,
  plannedUtilization: essPlanned,
  directors: directors.length,
  approvedLeaveDaysBefore: availabilityBefore.approvedLeaveDays,
  approvedLeaveDaysAfter: availabilityAfter.approvedLeaveDays,
  notifications: notifications.length,
}, null, 2));
