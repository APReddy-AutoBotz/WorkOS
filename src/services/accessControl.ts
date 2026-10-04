import { Allocation, Employee, Project, UserRole, UserSession } from '../types';
import { filterEmployeesByOrgVisibility } from './orgChart';
import { hasPermission, ROUTE_PERMISSION_KEYS } from './permissions';

export const ROUTE_ROLES = {
  dashboard: ['Admin', 'HR', 'CountryDirector'],
  employeeWorkspace: ['Employee'],
  projectManagerWorkspace: ['ProjectManager'],
  planningWorkspace: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  actionCenter: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead', 'Employee'],
  employees: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead', 'Employee'],
  projects: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead', 'Employee'],
  clients: ['Admin', 'HR', 'CountryDirector'],
  allocations: ['Admin', 'ProjectManager', 'CountryDirector', 'HR'],
  timesheets: ['Admin', 'Employee', 'ProjectManager', 'TeamLead', 'HR', 'CountryDirector'],
  timesheetApproval: ['Admin', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  utilization: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  reportsCenter: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  dataQuality: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  brdTraceability: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  ess: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead', 'Employee'],
  leaveSelfService: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead', 'Employee'],
  leaveTeam: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  leaveAdmin: ['Admin', 'HR'],
  approvals: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  notifications: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead', 'Employee'],
  identityIntegrations: ['Admin', 'HR'],
  teamsIntegrations: ['Admin', 'HR'],
  teamsActions: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  resourcePlanning: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  workforceCommandCenter: ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'],
  importExport: ['Admin'],
  auditTrail: ['Admin'],
  adminSettings: ['Admin', 'HR'],
} satisfies Record<string, UserRole[]>;

export const hasRouteRole = (user: UserSession | null | undefined, roles: readonly UserRole[]) => {
  if (!user) return false;
  const routeKey = Object.entries(ROUTE_ROLES).find(([, routeRoles]) => routeRoles === roles)?.[0];
  const permissionKey = routeKey ? ROUTE_PERMISSION_KEYS[routeKey as keyof typeof ROUTE_PERMISSION_KEYS] : undefined;
  return permissionKey ? hasPermission(user, permissionKey) : roles.includes(user.role);
};

interface EmployeeAccessInput {
  user: UserSession | null | undefined;
  employeeId: string | undefined;
  employees: Employee[];
  allocations: Allocation[];
  projects: Project[];
}

export const canAccessEmployeeDetail = ({
  user,
  employeeId,
  employees,
  allocations,
  projects,
}: EmployeeAccessInput) => {
  if (!user || !employeeId) return false;
  if (['Admin', 'HR'].includes(user.role)) return true;
  if (user.id === employeeId) return true;

  const employee = employees.find(item => item.id === employeeId);
  if (!employee) return false;
  return filterEmployeesByOrgVisibility({ user, employees, allocations, projects })
    .some(scopedEmployee => scopedEmployee.id === employeeId);
};

export const canEditEmployeeData = (user: UserSession | null | undefined) =>
  hasPermission(user, 'employees.manage');

export const canResetEmployeePassword = (user: UserSession | null | undefined) =>
  hasPermission(user, 'employees.password_reset');

export const canOpenImportExport = (user: UserSession | null | undefined) =>
  hasPermission(user, 'imports.manage');

export const canManageAllocations = (user: UserSession | null | undefined) =>
  hasPermission(user, 'allocations.manage');

export const canOpenTimesheetApproval = (user: UserSession | null | undefined) =>
  hasPermission(user, 'timesheets.approve');

export const canEditProjectData = (user: UserSession | null | undefined) =>
  hasPermission(user, 'projects.manage');

export const canUpdateProjectStatus = (user: UserSession | null | undefined) =>
  hasPermission(user, 'projects.status_update');

export const canManageClients = (user: UserSession | null | undefined) =>
  hasPermission(user, 'clients.manage');

export const canManageNotifications = (user: UserSession | null | undefined) =>
  hasPermission(user, 'notifications.manage');

export const canManagePermissions = (user: UserSession | null | undefined) =>
  hasPermission(user, 'permissions.manage');

interface ProjectAccessInput {
  user: UserSession | null | undefined;
  project: Project | undefined;
  projectId: string | undefined;
  allocations: Allocation[];
  employees: Employee[];
}

export const canAccessProjectDetail = ({ user, project, projectId, allocations, employees }: ProjectAccessInput) => {
  if (!user || !projectId) return false;
  if (['Admin', 'HR'].includes(user.role)) return true;

  const projectAllocations = allocations.filter(allocation => allocation.projectId === projectId);

  if (
    user.role === 'ProjectManager' &&
    project &&
    (project.managerId === user.id || project.managerId === user.employeeId || project.managerName === user.name)
  ) {
    return true;
  }

  if (user.role === 'CountryDirector' && user.cdId) {
    const scopedEmployeeIds = new Set(employees
      .filter(employee =>
        employee.primaryCountryDirectorId === user.cdId ||
        employee.mappedCountryDirectorIds.includes(user.cdId!)
      )
      .map(employee => employee.id));
    if (projectAllocations.some(allocation => scopedEmployeeIds.has(allocation.employeeId))) return true;
  }

  return projectAllocations.some(allocation => allocation.employeeId === user.id || allocation.employeeId === user.employeeId);
};
