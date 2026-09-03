import { Allocation, Employee, Project, UserSession } from '../types';

import { productConfig } from '../config/productConfig';
export type OrgChartNodeType = 'root' | 'group' | 'employee';

export interface OrgChartEmployeeNode {
  id: string;
  type: 'employee';
  employee: Employee;
  manager?: Employee;
  children: OrgChartNode[];
  depth: number;
  match?: boolean;
}

export interface OrgChartGroupNode {
  id: string;
  type: 'root' | 'group';
  label: string;
  subtitle?: string;
  groupingKey?: string;
  children: OrgChartNode[];
  depth: number;
  count: number;
  match?: boolean;
}

export type OrgChartNode = OrgChartEmployeeNode | OrgChartGroupNode;

export interface OrgChartTree {
  root: OrgChartGroupNode;
  unassigned: OrgChartEmployeeNode[];
  cycles: string[][];
  invalidManagerIds: Array<{ employeeId: string; managerId: string }>;
  totalEmployees: number;
}

export interface OrgChartFilterState {
  searchQuery?: string;
  country?: string;
  department?: string;
  role?: string;
  status?: string;
  utilization?: 'Any' | 'Eligible' | 'Excluded';
  showInactive?: boolean;
}

export interface HierarchyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const leadershipPattern = /(ceo|chief|group leadership|head of operations|country director|regional lead|business unit lead|company director)/i;

export const getOrgUnit = (employee: Employee) =>
  employee.businessUnit || employee.region || employee.country || 'Other';

export const getDirectReports = (employees: Employee[], employeeId: string) =>
  employees.filter(employee => employee.reportingManagerId === employeeId);

export const detectHierarchyCycles = (employees: Employee[]) => {
  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const cycles: string[][] = [];
  const seen = new Set<string>();

  for (const employee of employees) {
    if (seen.has(employee.id)) continue;
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: Employee | undefined = employee;

    while (current) {
      if (pathIndex.has(current.id)) {
        const cycle = path.slice(pathIndex.get(current.id));
        if (cycle.length > 0) cycles.push(cycle);
        break;
      }
      if (seen.has(current.id)) break;
      pathIndex.set(current.id, path.length);
      path.push(current.id);
      current = current.reportingManagerId ? byId.get(current.reportingManagerId) : undefined;
    }

    path.forEach(id => seen.add(id));
  }

  return cycles;
};

const containsEmployee = (node: OrgChartNode): boolean => {
  if (node.type === 'employee') return true;
  return node.children.some(containsEmployee);
};

const countEmployees = (node: OrgChartNode): number => {
  if (node.type === 'employee') return 1 + node.children.reduce((sum, child) => sum + countEmployees(child), 0);
  return node.children.reduce((sum, child) => sum + countEmployees(child), 0);
};

const applyDepth = (node: OrgChartNode, depth: number): OrgChartNode => {
  const children = node.children.map(child => applyDepth(child, depth + 1));
  if (node.type === 'employee') return { ...node, depth, children };
  return { ...node, depth, children, count: children.reduce((sum, child) => sum + countEmployees(child), 0) };
};

const shouldGroupChildren = (node: OrgChartEmployeeNode | OrgChartGroupNode, children: OrgChartNode[]) => {
  if (children.length < 3) return false;
  if (node.type === 'root') return true;
  if (node.type === 'employee') {
    const title = `${node.employee.designation} ${node.employee.department}`;
    return node.depth <= 2 || leadershipPattern.test(title);
  }
  return node.depth <= 1;
};

const groupEmployeeChildren = (parent: OrgChartEmployeeNode | OrgChartGroupNode, children: OrgChartNode[], depth: number): OrgChartNode[] => {
  if (!shouldGroupChildren(parent, children)) return children.map(child => applyDepth(child, depth));

  const grouped = new Map<string, OrgChartNode[]>();
  const passthrough: OrgChartNode[] = [];

  for (const child of children) {
    if (child.type !== 'employee') {
      passthrough.push(child);
      continue;
    }
    const unit = getOrgUnit(child.employee);
    grouped.set(unit, [...(grouped.get(unit) || []), child]);
  }

  const groups = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, groupChildren]) => applyDepth({
      id: `group-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      type: 'group' as const,
      label,
      subtitle: 'Country / region / business unit',
      groupingKey: label,
      children: groupChildren,
      depth,
      count: groupChildren.reduce((sum, child) => sum + countEmployees(child), 0),
    }, depth));

  return [...passthrough.map(child => applyDepth(child, depth)), ...groups];
};

export const buildOrgTree = (employees: Employee[], options: { rootLabel?: string } = {}): OrgChartTree => {
  const employeeIds = new Set(employees.map(employee => employee.id));
  const cycles = detectHierarchyCycles(employees);
  const cycleIds = new Set(cycles.flat());
  const invalidManagerIds: OrgChartTree['invalidManagerIds'] = [];
  const byManager = new Map<string, Employee[]>();
  const roots: Employee[] = [];
  const unassignedEmployees: Employee[] = [];

  for (const employee of employees) {
    const managerId = employee.reportingManagerId;
    if (!managerId) {
      roots.push(employee);
      continue;
    }
    if (managerId === employee.id || !employeeIds.has(managerId) || cycleIds.has(employee.id)) {
      invalidManagerIds.push({ employeeId: employee.id, managerId });
      unassignedEmployees.push(employee);
      continue;
    }
    byManager.set(managerId, [...(byManager.get(managerId) || []), employee]);
  }

  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const buildEmployeeNode = (employee: Employee, depth: number): OrgChartEmployeeNode => {
    const rawChildren = (byManager.get(employee.id) || [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(child => buildEmployeeNode(child, depth + 1));
    const node: OrgChartEmployeeNode = {
      id: `employee-${employee.id}`,
      type: 'employee',
      employee,
      manager: employee.reportingManagerId ? byId.get(employee.reportingManagerId) : undefined,
      children: [],
      depth,
    };
    node.children = groupEmployeeChildren(node, rawChildren, depth + 1);
    return node;
  };

  const rootChildren = roots
    .sort((a, b) => {
      const aLead = leadershipPattern.test(`${a.designation} ${a.department}`) ? 0 : 1;
      const bLead = leadershipPattern.test(`${b.designation} ${b.department}`) ? 0 : 1;
      return aLead - bLead || a.name.localeCompare(b.name);
    })
    .map(employee => buildEmployeeNode(employee, 1));

  const root: OrgChartGroupNode = applyDepth({
    id: 'your-organization-group-root',
    type: 'root',
    label: options.rootLabel || `${productConfig.organizationName} Group`,
    subtitle: 'Generated from Employee Master reporting relationships',
    children: rootChildren,
    depth: 0,
    count: employees.length,
  }, 0) as OrgChartGroupNode;

  return {
    root,
    unassigned: unassignedEmployees.sort((a, b) => a.name.localeCompare(b.name)).map(employee => buildEmployeeNode(employee, 1)),
    cycles,
    invalidManagerIds,
    totalEmployees: employees.length,
  };
};

export const getOrgChartFilters = (employees: Employee[]) => ({
  countries: Array.from(new Set(employees.map(employee => employee.country).filter(Boolean))).sort(),
  departments: Array.from(new Set(employees.map(employee => employee.department).filter(Boolean))).sort(),
  roles: Array.from(new Set(employees.map(employee => employee.designation).filter(Boolean))).sort(),
  businessUnits: Array.from(new Set(employees.map(getOrgUnit).filter(Boolean))).sort(),
});

export const filterEmployeesForOrgChart = (
  employees: Employee[],
  filters: OrgChartFilterState,
  allEmployees = employees,
) => {
  const query = (filters.searchQuery || '').trim().toLowerCase();
  const managerById = new Map(allEmployees.map(employee => [employee.id, employee]));

  return employees.filter(employee => {
    if (!filters.showInactive && employee.status === 'Exited') return false;
    if (filters.country && filters.country !== 'All Countries' && employee.country !== filters.country) return false;
    if (filters.department && filters.department !== 'All Departments' && employee.department !== filters.department) return false;
    if (filters.role && filters.role !== 'All Roles' && employee.designation !== filters.role) return false;
    if (filters.status && filters.status !== 'All Statuses' && employee.status !== filters.status) return false;
    if (filters.utilization === 'Eligible' && employee.utilizationEligible === false) return false;
    if (filters.utilization === 'Excluded' && employee.utilizationEligible !== false) return false;

    if (!query) return true;
    const manager = employee.reportingManagerId ? managerById.get(employee.reportingManagerId) : undefined;
    return [
      employee.name,
      employee.employeeId,
      employee.designation,
      employee.department,
      employee.country,
      employee.region,
      employee.businessUnit,
      manager?.name,
    ].some(value => (value || '').toLowerCase().includes(query));
  });
};

const collectManagerChain = (employeesById: Map<string, Employee>, employee: Employee | undefined) => {
  const chain = new Set<string>();
  let current = employee;
  while (current?.reportingManagerId && !chain.has(current.reportingManagerId)) {
    chain.add(current.reportingManagerId);
    current = employeesById.get(current.reportingManagerId);
  }
  return chain;
};

export const filterEmployeesByOrgVisibility = ({
  user,
  employees,
  allocations,
  projects,
}: {
  user: UserSession | null | undefined;
  employees: Employee[];
  allocations: Allocation[];
  projects: Project[];
}) => {
  if (!user) return [];
  if (user.role === 'Admin' || user.role === 'HR') return employees;

  if (user.role === 'CountryDirector' && user.cdId) {
    return employees.filter(employee =>
      employee.primaryCountryDirectorId === user.cdId ||
      employee.mappedCountryDirectorIds.includes(user.cdId!)
    );
  }

  const employeesById = new Map(employees.map(employee => [employee.id, employee]));
  const self = employees.find(employee => employee.id === user.id || employee.employeeId === user.employeeId);

  if (user.role === 'ProjectManager') {
    const managedProjectIds = new Set(projects
      .filter(project => project.managerId === user.id || project.managerId === user.employeeId || project.managerName === user.name)
      .map(project => project.id));
    const projectEmployeeIds = new Set(allocations
      .filter(allocation => managedProjectIds.has(allocation.projectId))
      .map(allocation => allocation.employeeId));
    if (self) {
      projectEmployeeIds.add(self.id);
      collectManagerChain(employeesById, self).forEach(id => projectEmployeeIds.add(id));
    }
    return employees.filter(employee => projectEmployeeIds.has(employee.id));
  }

  if (user.role === 'TeamLead' || user.role === 'Employee') {
    const visible = new Set<string>();
    if (self) {
      visible.add(self.id);
      collectManagerChain(employeesById, self).forEach(id => visible.add(id));
      getDirectReports(employees, self.id).forEach(report => visible.add(report.id));
    }
    return employees.filter(employee => visible.has(employee.id));
  }

  return [];
};

export const filterProjectsByOrgVisibility = ({
  user,
  projects,
  allocations,
  employees,
}: {
  user: UserSession | null | undefined;
  projects: Project[];
  allocations: Allocation[];
  employees: Employee[];
}) => {
  if (!user) return [];
  if (user.role === 'Admin' || user.role === 'HR') return projects;

  const userEmployeeIds = new Set([user.id, user.employeeId].filter((value): value is string => Boolean(value)));
  const self = employees.find(employee =>
    employee.id === user.id ||
    employee.id === user.employeeId ||
    employee.employeeId === user.employeeId ||
    employee.employeeId === user.id
  );
  if (self) {
    userEmployeeIds.add(self.id);
    userEmployeeIds.add(self.employeeId);
  }

  if (user.role === 'ProjectManager') {
    const userNames = new Set([user.name, user.userName]
      .filter((value): value is string => Boolean(value))
      .map(value => value.toLowerCase()));
    const assignedProjectIds = new Set(allocations
      .filter(allocation => userEmployeeIds.has(allocation.employeeId))
      .map(allocation => allocation.projectId));

    return projects.filter(project =>
      userEmployeeIds.has(project.managerId) ||
      userNames.has(project.managerName.toLowerCase()) ||
      assignedProjectIds.has(project.id)
    );
  }

  if (user.role === 'CountryDirector' && user.cdId) {
    const scopedEmployeeIds = new Set(employees
      .filter(employee =>
        employee.primaryCountryDirectorId === user.cdId ||
        employee.mappedCountryDirectorIds.includes(user.cdId!)
      )
      .map(employee => employee.id));
    const scopedProjectIds = new Set(allocations
      .filter(allocation => scopedEmployeeIds.has(allocation.employeeId))
      .map(allocation => allocation.projectId));
    return projects.filter(project => scopedProjectIds.has(project.id));
  }

  if (user.role === 'TeamLead' || user.role === 'Employee') {
    const ownProjectIds = new Set(allocations
      .filter(allocation => userEmployeeIds.has(allocation.employeeId))
      .map(allocation => allocation.projectId));
    return projects.filter(project => ownProjectIds.has(project.id));
  }

  return [];
};

export const validateEmployeeHierarchy = (employees: Employee[], candidate: Employee): HierarchyValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const managerId = candidate.reportingManagerId;

  if (managerId) {
    if (managerId === candidate.id) errors.push('An employee cannot report to themselves.');
    const manager = employees.find(employee => employee.id === managerId);
    if (!manager) errors.push('Reporting manager must reference an existing employee.');
    if (manager?.status === 'Exited') warnings.push('Reporting manager is inactive.');
  }

  const nextEmployees = employees.some(employee => employee.id === candidate.id)
    ? employees.map(employee => employee.id === candidate.id ? candidate : employee)
    : [...employees, candidate];
  const cycles = detectHierarchyCycles(nextEmployees);
  if (cycles.some(cycle => cycle.includes(candidate.id))) {
    errors.push('This reporting manager change would create a circular hierarchy.');
  }

  return { valid: errors.length === 0, errors, warnings };
};

export const validateDeactivateManager = (employees: Employee[], employeeId: string): HierarchyValidationResult => {
  const activeReports = employees.filter(employee => employee.reportingManagerId === employeeId && employee.status !== 'Exited');
  return {
    valid: true,
    errors: [],
    warnings: activeReports.length > 0
      ? [`This manager has ${activeReports.length} active direct report${activeReports.length === 1 ? '' : 's'}. Reassign them before or immediately after deactivation.`]
      : [],
  };
};
