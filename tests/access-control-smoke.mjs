import assert from 'node:assert/strict';

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

const { DataStorage } = await import('../src/services/storage.ts');
const { employeeService, projectService, allocationService } = await import('../src/services/api.ts');
const { authService } = await import('../src/services/authService.ts');
const {
  ROUTE_ROLES,
  canOpenDeploymentAuditWithoutOrganizationScope,
  canOpenAuditWithoutOrganizationScope,
  canFetchScopedAuditHistory,
  canFetchScopedWorkspaceData,
  canAccessEmployeeDetail,
  canAccessProjectDetail,
  canEditEmployeeData,
  canEditProjectData,
  canManageAllocations,
  canManagePermissions,
  canOpenImportExport,
  canOpenTimesheetApproval,
  canResetEmployeePassword,
  hasRouteRole,
} = await import('../src/services/accessControl.ts');
const { filterEmployeesByOrgVisibility, filterProjectsByOrgVisibility } = await import('../src/services/orgChart.ts');

DataStorage.resetDemoData();

const employees = await employeeService.getAll();
const projects = await projectService.getAll();
const allocations = await allocationService.getAll();

const admin = await authService.login('admin-1', 'workos-test-only');
assert.ok(admin, 'admin account should be available');
assert.equal(hasRouteRole(admin, ROUTE_ROLES.dashboard), true, 'admin should access the overview dashboard');
assert.equal(hasRouteRole(admin, ROUTE_ROLES.importExport), true, 'admin should access import/export');
assert.equal(hasRouteRole(admin, ROUTE_ROLES.auditTrail), true, 'admin should access audit trail');
assert.equal(hasRouteRole(admin, ROUTE_ROLES.brdTraceability), true, 'admin should access BRD traceability');
assert.equal(hasRouteRole(admin, ROUTE_ROLES.leaveAdmin), true, 'admin should access feature-gated leave administration when enabled');
assert.equal(hasRouteRole(admin, ROUTE_ROLES.identityIntegrations), true, 'admin should access feature-gated identity integrations when enabled');
assert.equal(canOpenImportExport(admin), true, 'admin should see import/export actions');
assert.equal(canManagePermissions(admin), true, 'admin should see permission settings');
assert.equal(canEditEmployeeData(admin), true, 'admin should see employee edit actions');
assert.equal(canResetEmployeePassword(admin), true, 'admin should see password reset actions');
assert.equal(canEditProjectData(admin), true, 'admin should see project edit actions');
assert.equal(canAccessEmployeeDetail({ user: admin, employeeId: employees[0].id, employees, allocations, projects }), true, 'admin should access any employee detail');

const hr = await authService.login('hr-1', 'workos-test-only', 'HR');
assert.ok(hr, 'HR account should be available');
assert.equal(hasRouteRole(hr, ROUTE_ROLES.dashboard), true, 'HR should access the overview dashboard');
assert.equal(hasRouteRole(hr, ROUTE_ROLES.planningWorkspace), true, 'HR should access the planning workspace');
assert.equal(hasRouteRole(hr, ROUTE_ROLES.adminSettings), true, 'HR should access governance settings');
assert.equal(hasRouteRole(hr, ROUTE_ROLES.auditTrail), false, 'HR should not access audit trail');
const designatedHrAuditor = { ...hr, permissions: [...(hr.permissions || []), 'audit.deployment.view'] };
assert.equal(hasRouteRole(designatedHrAuditor, ROUTE_ROLES.auditTrail), true,
  'an HR account with an explicit deployment-audit grant should access the audit page without Admin role');
assert.equal(canOpenDeploymentAuditWithoutOrganizationScope(designatedHrAuditor), true,
  'an explicitly designated auditor should reach the global reader without an organization scope');
assert.equal(canOpenDeploymentAuditWithoutOrganizationScope(admin), false,
  'an ordinary Admin still must pass the existing organization scope gate');
const designatedAdminAuditor = { ...admin, permissions: [...(admin.permissions || []), 'audit.deployment.view'] };
assert.equal(designatedAdminAuditor.permissions.includes('audit.view'), true,
  'the dual-permission fixture retains its ordinary scoped-audit permission');
assert.equal(canOpenDeploymentAuditWithoutOrganizationScope(designatedAdminAuditor), true,
  'an explicitly designated Admin who also has scoped audit permission must reach the deployment reader without selecting a scope');
assert.equal(canFetchScopedAuditHistory(designatedAdminAuditor, false), false,
  'a dual-permission auditor without a validated scope must not fetch scoped history');
assert.equal(canFetchScopedAuditHistory(designatedAdminAuditor, true), true,
  'a dual-permission auditor may fetch scoped history after a scope is validated');
assert.equal(canFetchScopedAuditHistory(designatedHrAuditor, false), false,
  'a deployment-only auditor must not fetch scoped history');
assert.equal(canFetchScopedAuditHistory(admin, false, true), true,
  'ordinary demo-mode audit behavior remains available without a backend scope');
assert.equal(canFetchScopedAuditHistory(designatedAdminAuditor, false, true), false,
  'demo fallback must not bypass the selected-scope requirement for a deployment auditor with scoped permission');
assert.equal(canFetchScopedWorkspaceData(designatedHrAuditor, false, true), false,
  'the scope-free deployment audit shell must not preload tenant workspace data in demo fallback');
assert.equal(canFetchScopedWorkspaceData(admin, false, true), true,
  'ordinary demo sessions may retain their existing local workspace-data fallback');
assert.equal(canFetchScopedWorkspaceData(designatedAdminAuditor, true), true,
  'a designated auditor with a validated scope may use the scoped workspace shell');
const designatedOrganizationAuditor = { ...hr, permissions: ['audit.organization.view'] };
assert.equal(hasRouteRole(designatedOrganizationAuditor, ROUTE_ROLES.auditTrail), true,
  'a specifically designated non-Admin organization auditor may open the audit page');
assert.equal(canOpenAuditWithoutOrganizationScope(designatedOrganizationAuditor), true,
  'an organization auditor may use the organization-only reader without selecting a legal entity');
assert.equal(canFetchScopedAuditHistory(designatedOrganizationAuditor, false, true), false,
  'an organization auditor without audit.view must not fetch ordinary scoped history through demo fallback');
assert.equal(canFetchScopedWorkspaceData(designatedOrganizationAuditor, false, true), false,
  'a scope-free organization auditor must not preload demo tenant workspace data');
assert.equal(canFetchScopedWorkspaceData(designatedOrganizationAuditor, true), true,
  'an organization auditor who also has a validated data scope may use only that scoped workspace');
assert.equal(hasRouteRole(hr, ROUTE_ROLES.brdTraceability), true, 'HR should access BRD traceability');
assert.equal(hasRouteRole(hr, ROUTE_ROLES.leaveAdmin), true, 'HR should access feature-gated leave administration when enabled');
assert.equal(hasRouteRole(hr, ROUTE_ROLES.identityIntegrations), true, 'HR should access feature-gated identity integrations when enabled');
assert.equal(canOpenImportExport(hr), false, 'HR should not see import/export actions');
assert.equal(canManagePermissions(hr), false, 'HR should not see protected permission settings');
assert.equal(canEditEmployeeData(hr), true, 'HR should see employee edit actions');
assert.equal(canEditProjectData(hr), true, 'HR should see project edit actions');
assert.equal(canManageAllocations(hr), true, 'HR should see allocation controls inside planning workspace');

const projectManager = await authService.login('pm-1', 'workos-test-only', 'ProjectManager');
assert.ok(projectManager, 'PM account should be available');
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.dashboard), false, 'PM should land in project workspace instead of overview dashboard');
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.projectManagerWorkspace), true, 'PM should access PM Workspace');
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.planningWorkspace), true, 'PM should access Planning Workspace');
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.utilization), true, 'PM should access scoped planned and actual utilization reports');
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.brdTraceability), true, 'PM should access BRD traceability');
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.resourcePlanning), true, 'PM should access feature-gated resource planning when enabled');
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.identityIntegrations), false, 'PM should not access identity integrations');
const managedProject = projects.find(project =>
  project.managerId === projectManager.id ||
  project.managerId === projectManager.employeeId ||
  project.managerName === projectManager.name
);
assert.ok(managedProject, 'PM should manage at least one seeded project');
const pmVisibleProjects = filterProjectsByOrgVisibility({ user: projectManager, projects, allocations, employees });
assert.ok(pmVisibleProjects.some(project => project.id === managedProject.id), 'Project Master should list PM-managed projects');
const pmApiSessionShape = { ...projectManager, id: projectManager.employeeId };
assert.ok(
  filterProjectsByOrgVisibility({ user: pmApiSessionShape, projects, allocations, employees }).some(project => project.id === managedProject.id),
  'Project Master should resolve PM project scope when backend session id exposes the employee code'
);
assert.equal(
  canAccessProjectDetail({
    user: projectManager,
    project: managedProject,
    projectId: managedProject.id,
    allocations,
    employees,
  }),
  true,
  'PM should access managed project detail'
);
const managedEmployeeId = allocations.find(allocation => allocation.projectId === managedProject.id)?.employeeId;
assert.ok(managedEmployeeId, 'managed project should have at least one assigned employee');
assert.equal(
  canAccessEmployeeDetail({ user: projectManager, employeeId: managedEmployeeId, employees, allocations, projects }),
  true,
  'PM should access employees assigned to managed projects'
);
assert.equal(hasRouteRole(projectManager, ROUTE_ROLES.clients), false, 'PM should not access Client Portfolio');
assert.equal(canOpenImportExport(projectManager), false, 'PM should not see import/export actions');
assert.equal(canEditEmployeeData(projectManager), false, 'PM should not see employee edit actions');
assert.equal(canResetEmployeePassword(projectManager), false, 'PM should not see password reset actions');
assert.equal(canEditProjectData(projectManager), false, 'PM should not see project edit actions');
assert.equal(canManageAllocations(projectManager), true, 'PM should see allocation controls');

const countryDirector = await authService.login('cd-1', 'workos-test-only', 'CountryDirector');
assert.ok(countryDirector?.cdId, 'Country Director session should include CD scope id');
assert.equal(hasRouteRole(countryDirector, ROUTE_ROLES.dashboard), true, 'CD should access the scoped overview dashboard');
assert.equal(hasRouteRole(countryDirector, ROUTE_ROLES.planningWorkspace), true, 'CD should access Planning Workspace');
assert.equal(hasRouteRole(countryDirector, ROUTE_ROLES.brdTraceability), true, 'CD should access BRD traceability');
assert.equal(hasRouteRole(countryDirector, ROUTE_ROLES.leaveTeam), true, 'CD should access feature-gated team leave calendar when enabled');
assert.equal(hasRouteRole(countryDirector, ROUTE_ROLES.workforceCommandCenter), true, 'CD should access feature-gated command center when enabled');
const cdEmployeeIds = new Set(employees
  .filter(employee =>
    employee.primaryCountryDirectorId === countryDirector.cdId ||
    employee.mappedCountryDirectorIds.includes(countryDirector.cdId)
  )
  .map(employee => employee.id));
const scopedAllocation = allocations.find(allocation => cdEmployeeIds.has(allocation.employeeId));
assert.ok(scopedAllocation, 'CD should have at least one scoped seeded allocation');
const scopedProject = await projectService.getById(scopedAllocation.projectId);
assert.ok(scopedProject, 'scoped allocation should reference a project');
assert.equal(
  canAccessProjectDetail({
    user: countryDirector,
    project: scopedProject,
    projectId: scopedProject.id,
    allocations,
    employees,
  }),
  true,
  'CD should access projects containing scoped employees'
);
assert.equal(
  canAccessEmployeeDetail({ user: countryDirector, employeeId: scopedAllocation.employeeId, employees, allocations, projects }),
  true,
  'CD should access scoped employee detail'
);
const unscopedEmployee = employees.find(employee => !cdEmployeeIds.has(employee.id));
assert.ok(unscopedEmployee, 'seed data should include an employee outside CD scope');
assert.equal(
  canAccessEmployeeDetail({ user: countryDirector, employeeId: unscopedEmployee.id, employees, allocations, projects }),
  false,
  'CD should not access unscoped employee detail'
);
assert.equal(canEditEmployeeData(countryDirector), false, 'CD should not see employee edit actions');
assert.equal(canResetEmployeePassword(countryDirector), false, 'CD should not see password reset actions');
assert.equal(canOpenImportExport(countryDirector), false, 'CD should not see import/export actions');
assert.equal(canManageAllocations(countryDirector), true, 'CD should see allocation controls for scoped employees');
assert.equal(canOpenTimesheetApproval(countryDirector), true, 'CD should see timesheet approval actions');

const teamLead = { ...projectManager, role: 'TeamLead' };
assert.equal(hasRouteRole(teamLead, ROUTE_ROLES.planningWorkspace), true, 'Team Lead should access planning signals');
assert.equal(canManageAllocations(teamLead), false, 'Team Lead should not see allocation edit controls inside planning workspace');
const teamLeadReport = employees.find(employee => employee.reportingManagerId === teamLead.id);
assert.ok(teamLeadReport, 'seed data should include a direct report for Team Lead scope');
assert.equal(
  canAccessEmployeeDetail({ user: teamLead, employeeId: teamLeadReport.id, employees, allocations, projects }),
  true,
  'Team Lead should access direct-report employee detail'
);
const teamLeadScopeIds = new Set(filterEmployeesByOrgVisibility({ user: teamLead, employees, allocations, projects }).map(employee => employee.id));
const outsideTeamLeadScope = employees.find(employee => !teamLeadScopeIds.has(employee.id));
assert.ok(outsideTeamLeadScope, 'seed data should include employees outside Team Lead scope');
assert.equal(
  canAccessEmployeeDetail({ user: teamLead, employeeId: outsideTeamLeadScope.id, employees, allocations, projects }),
  false,
  'Team Lead should not access unrelated employee detail'
);

const allocatedEmployee = employees.find(employee =>
  employee.employeeId.startsWith('EMP-') &&
  allocations.some(allocation => allocation.employeeId === employee.id)
);
assert.ok(allocatedEmployee, 'seed data should include an allocated employee user');
const employee = await authService.login(allocatedEmployee.employeeId, 'workos-test-only', 'Employee');
assert.ok(employee, 'employee account should be available');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.dashboard), false, 'employee should land in timesheet workspace instead of overview dashboard');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.planningWorkspace), false, 'employee should not access Planning Workspace');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.employeeWorkspace), true, 'employee should access My Workspace');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.projects), true, 'employee should access scoped Project Master records');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.utilization), false, 'employee should not access global planned or actual utilization reports');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.brdTraceability), false, 'employee should not access BRD traceability');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.leaveSelfService), true, 'employee should access feature-gated leave self-service when enabled');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.leaveAdmin), false, 'employee should not access leave administration');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.resourcePlanning), false, 'employee should not access resource planning');
assert.equal(canAccessEmployeeDetail({ user: employee, employeeId: allocatedEmployee.id, employees, allocations, projects }), true, 'employee should access own detail');
assert.equal(canEditEmployeeData(employee), false, 'employee should not see employee edit actions');
assert.equal(canManageAllocations(employee), false, 'employee should not see allocation controls');
assert.equal(canOpenTimesheetApproval(employee), false, 'employee should not see timesheet approval actions');
const unrelatedProject = projects.find(project =>
  !allocations.some(allocation => allocation.projectId === project.id && allocation.employeeId === employee.id)
);
assert.ok(unrelatedProject, 'seed data should include a project unrelated to the employee');
const employeeVisibleProjectIds = new Set(filterProjectsByOrgVisibility({ user: employee, projects, allocations, employees }).map(project => project.id));
const employeeAllocatedProjectIds = new Set(allocations
  .filter(allocation => allocation.employeeId === employee.id)
  .map(allocation => allocation.projectId));
assert.ok(employeeVisibleProjectIds.size > 0, 'Project Master should list employee allocation-backed projects');
assert.ok([...employeeVisibleProjectIds].every(projectId => employeeAllocatedProjectIds.has(projectId)), 'employee Project Master scope should stay limited to own allocations');
assert.equal(employeeVisibleProjectIds.has(unrelatedProject.id), false, 'employee Project Master scope should not include unrelated projects');
const employeeApiSessionShape = { ...employee, id: employee.employeeId };
const employeeApiVisibleProjectIds = new Set(filterProjectsByOrgVisibility({ user: employeeApiSessionShape, projects, allocations, employees }).map(project => project.id));
assert.deepEqual(employeeApiVisibleProjectIds, employeeVisibleProjectIds, 'Project Master should resolve employee project scope when backend session id exposes the employee code');
assert.equal(
  canAccessProjectDetail({
    user: employee,
    project: unrelatedProject,
    projectId: unrelatedProject.id,
    allocations,
    employees,
  }),
  false,
  'employee should not access unrelated project detail'
);
assert.equal(
  canAccessProjectDetail({
    user: projectManager,
    project: unrelatedProject,
    projectId: unrelatedProject.id,
    allocations,
    employees,
  }),
  false,
  'PM should not access unmanaged project detail'
);

console.log(JSON.stringify({
  status: 'passed',
  checkedRoles: ['Admin', 'HR', 'ProjectManager', 'CountryDirector', 'Employee'],
  managedProject: managedProject.projectCode,
  scopedProject: scopedProject.projectCode,
}, null, 2));
