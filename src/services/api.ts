import {normalizeImportSubmissionTiming,type ImportSubmissionTiming} from './submissionDeadline';
import {normalizeImportOvertimeWarnings,type ImportOvertimeWarnings} from './overtimeCapture';
import {canonicalHours,sumHours} from '../../shared/work-hours.mjs';
/**
 * api.ts — Dual-mode service layer.
 * AUTO-DETECTS backend: if /api/health returns database:connected → uses REST API.
 * Otherwise → falls back to localStorage (demo mode). Zero code change needed to switch.
 */
import type { Employee, Project, Allocation, TimesheetSummary, AuditLog, ImportExportLog, SystemSettings, CountryDirector, RoleDefinition, Client, CatalogItem, UtilizationReport, UtilizationReportMode, UserAccount, DataQualityReport, DashboardReport, LeaveType, LeavePolicy, HolidayCalendar, LeaveBalance, LeaveRequest, LeaveAvailabilityEntry, ApprovalRecord, ApprovalDelegation, ApprovalSlaReport, NotificationEvent, NotificationTemplate, NotificationPreference, NotificationDeliveryAttempt, IdentityProviderLink, EntraRoleMapping, TeamsUserLink, TeamsActionToken, IntegrationEventLog, IntegrationHealthReport, ResourcePlanningReport, WorkforceCommandCenterReport, PermissionConfig, PermissionDefinition, PermissionKey, PermissionUserSummary, RolePermissionSetting, UserPermissionGrant, OrganizationAuditScope, OrganizationAuditGrantConfig, OrganizationAuditGrant, OrganizationSetupReadiness, OrganizationProfile, LegalEntityProfile } from '../types';
import { DataStorage, STORAGE_KEYS } from './storage';
import { authService } from './authService';
import {
  api, checkBackend, getOrganizationScope, ApiClientError, isDemoFallbackAllowed,
  normalizeEmployee, normalizeProject, normalizeAllocation,
  normalizeClient, normalizeTimesheetSummary, normalizeWorkAssurance, normalizeAuditLog,
  normalizeSettings, normalizeCatalogItem, normalizeRoleDefinition,
  normalizeCountryDirector, normalizeImportExportLog, normalizeUtilizationReport,
  normalizeDataQualityReport, normalizeDashboardReport, normalizeLeaveType,
  normalizeLeavePolicy, normalizeHolidayCalendar, normalizeLeaveBalance,
  normalizeLeaveRequest, normalizeApprovalRecord, normalizeApprovalDelegation,
  normalizeApprovalSlaReport, normalizeNotificationEvent, normalizeNotificationTemplate,
  normalizeNotificationPreference, normalizeNotificationDeliveryAttempt,
  normalizeIdentityProviderLink, normalizeEntraRoleMapping, normalizeTeamsUserLink,
  normalizeTeamsActionToken, normalizeIntegrationEventLog, normalizeIntegrationHealthReport,
  normalizeResourcePlanningReport, normalizeWorkforceCommandCenterReport,
} from './apiClient';
import type { OrganizationScope } from './apiClient';
import {canFetchScopedAuditHistory} from './accessControl';
import { buildResourcePlanningReport, getAllocationLoad, getLatestApprovedActualUtilization, getActiveAllocationsForEmployee, getDefaultUtilizationEligible, getUtilizationEligibleEmployees } from './calculations';
import { roundMetric } from '../lib/format';
import { validateDeactivateManager, validateEmployeeHierarchy } from './orgChart';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_DEFINITIONS, SYSTEM_ROLES, hasPermission } from './permissions';

import {normalizeTerminologyConfiguration, rememberTerminologySave, TERMINOLOGY_KEYS, type TerminologyConfiguration} from './terminologyConfiguration';
import {captureOrganizationProfileContext, assertOrganizationProfileContext, isOrganizationProfileContextCurrent, type OrganizationProfileContext} from './organizationProfileScope';

import { productConfig } from '../config/productConfig';
import { displayEntityType } from '../config/terminology';
const todayIso = () => new Date().toISOString().split('T')[0];
const sha256 = async (value: string) => {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
};
const generateTemporaryPassword = () => `WOS-${crypto.randomUUID().slice(0, 8)}`;
type CsvImportRow = Record<string, string>;
const employeePreviewRowFields = [
  'employeeId', 'name', 'email', 'designation', 'department', 'country', 'region', 'businessUnit',
  'reportingManagerId', 'primaryCountryDirectorId', 'mappedCountryDirectorIds', 'utilizationEligible',
  'joiningDate', 'exitDate', 'standardWeeklyHours', 'capacityType', 'contractType', 'entraObjectId',
  'teamsUserId', 'roles', 'status',
] as const;
type ImportApplyError = {
  rowNumber: number;
  field?: string;
  message: string;
  sourceIdentifier?: string | null;
};
type ImportApplyResult = {
  captureWarnings?: ImportOvertimeWarnings[];
  submissionTiming?: ImportSubmissionTiming[];
  status: ImportExportLog['status'];
  totalRows: number;
  validRows: number;
  errorRows: number;
  errors: ImportApplyError[];
  replayed?: boolean;
  log?: ImportExportLog;
};
type VersionedImportResult = ImportApplyResult & {
  schemaVersion: string;
  dryRun: boolean;
};

const assertExpectedImportScope = (expectedScope?: OrganizationScope | null) => {
  if (expectedScope === undefined) return;
  const currentScope = getOrganizationScope();
  if (expectedScope?.organizationId !== currentScope?.organizationId
    || expectedScope?.legalEntityId !== currentScope?.legalEntityId) {
    throw new Error('Organization or legal-entity scope changed before the import request was sent. Re-validate the CSV for the current scope.');
  }
};

const actor = () => {
  const s = authService.getCurrentUser();
  return { id: s?.id || 'sys', name: s?.name || 'System', role: s?.role || 'Admin' };
};

const requireLocalPermissionManager = () => {
  const currentUser = authService.getCurrentUser();
  if (!hasPermission(currentUser, 'permissions.manage')) {
    throw new Error('Permission settings require protected permission-management access.');
  }
};

const buildDefaultRolePermissionSettings = (): RolePermissionSetting[] =>
  SYSTEM_ROLES.flatMap(roleName =>
    PERMISSION_DEFINITIONS.map(permission => ({
      roleName,
      permissionKey: permission.key,
      enabled: DEFAULT_ROLE_PERMISSIONS[roleName].includes(permission.key),
    }))
  );

const normalizePermissionConfig = (raw: Record<string, unknown>): PermissionConfig => ({
  permissions: Array.isArray(raw.permissions) ? raw.permissions as PermissionDefinition[] : PERMISSION_DEFINITIONS,
  rolePermissions: Array.isArray(raw.rolePermissions)
    ? raw.rolePermissions as RolePermissionSetting[]
    : Array.isArray(raw.role_permissions)
      ? (raw.role_permissions as Record<string, unknown>[]).map(row => ({
        roleName: String(row.role_name) as RolePermissionSetting['roleName'],
        permissionKey: String(row.permission_key),
        enabled: Boolean(row.enabled),
        updatedAt: row.updated_at ? String(row.updated_at) : undefined,
      }))
      : buildDefaultRolePermissionSettings(),
  userGrants: Array.isArray(raw.userGrants)
    ? raw.userGrants as UserPermissionGrant[]
    : Array.isArray(raw.user_grants)
      ? (raw.user_grants as Record<string, unknown>[]).map(row => ({
        id: String(row.id),
        userId: String(row.user_id),
        employeeId: row.employee_id ? String(row.employee_id) : undefined,
        userName: row.username ? String(row.username) : undefined,
        displayName: row.display_name ? String(row.display_name) : undefined,
        activeRole: row.active_role ? String(row.active_role) : undefined,
        permissionKey: String(row.permission_key),
        grantedBy: row.granted_by ? String(row.granted_by) : undefined,
        createdAt: row.created_at ? String(row.created_at) : undefined,
      }))
      : [],
  users: Array.isArray(raw.users)
    ? (raw.users as Record<string, unknown>[]).map(row => ({
      id: String(row.id),
      employeeRecordId: row.employee_record_id ? String(row.employee_record_id) : row.employeeRecordId ? String(row.employeeRecordId) : undefined,
      employeeId: String(row.employee_id || row.employeeId || ''),
      userName: String(row.username || row.userName || ''),
      displayName: String(row.display_name || row.displayName || row.username || ''),
      email: String(row.email || ''),
      roles: Array.isArray(row.roles) ? row.roles as PermissionUserSummary['roles'] : [],
      status: row.status === 'Disabled' ? 'Disabled' : 'Active',
    }))
    : [],
});

// ── Computed utilization (used in both modes) ────────────────────────────────
function enrichEmployees(employees: Employee[], allocations: Allocation[], projects: Project[], timesheets: TimesheetSummary[], settings: SystemSettings): Employee[] {
  const today = todayIso();
  return employees.map(emp => ({
    ...emp,
    plannedUtilization: getAllocationLoad(emp.id, allocations, projects, today, today),
    actualUtilization: getLatestApprovedActualUtilization(emp.id, timesheets, settings),
    activeProjectCount: getActiveAllocationsForEmployee(emp.id, allocations, projects, today, today).length,
  }));
}

const getLocalApprovalRecords = () => DataStorage.get<ApprovalRecord[]>(STORAGE_KEYS.APPROVAL_RECORDS, []);

const saveLocalApprovalRecord = (record: ApprovalRecord) => {
  const records = getLocalApprovalRecords();
  DataStorage.set(STORAGE_KEYS.APPROVAL_RECORDS, [record, ...records.filter(item => item.id !== record.id)]);
};

const ensureLocalApprovalRecord = (record: Omit<ApprovalRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }) => {
  const existing = getLocalApprovalRecords().find(item => item.entityType === record.entityType && item.entityId === record.entityId);
  const next: ApprovalRecord = {
    ...existing,
    ...record,
    id: existing?.id || record.id || crypto.randomUUID(),
    createdAt: existing?.createdAt || record.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveLocalApprovalRecord(next);
  if (next.status === 'Pending') {
    const displayType = displayEntityType(next.entityType);
    createLocalNotification({
      recipientEmployeeId: next.subjectEmployeeId,
      recipientName: next.subjectEmployeeName,
      eventType: 'ApprovalRequested',
      title: `${displayType} approval requested`,
      body: `${next.requesterName || next.subjectEmployeeName || 'A user'} submitted ${displayType.toLowerCase()} for approval.`,
      entityType: next.entityType,
      entityId: next.entityId,
      severity: 'Info',
    });
  }
  return next;
};

const decideLocalApprovalRecord = (entityType: string, entityId: string, status: ApprovalRecord['status'], comments?: string) => {
  const u = actor();
  const existing = getLocalApprovalRecords().find(item => item.entityType === entityType && item.entityId === entityId);
  if (!existing) return null;
  const next: ApprovalRecord = {
    ...existing,
    status,
    comments,
    approverId: u.id,
    approverName: u.name,
    approverRole: u.role,
    activeRole: u.role,
    decidedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveLocalApprovalRecord(next);
  const displayType = displayEntityType(next.entityType);
  createLocalNotification({
    recipientEmployeeId: next.subjectEmployeeId,
    recipientName: next.subjectEmployeeName,
    eventType: 'ApprovalDecided',
    title: `${displayType} approval ${status.toLowerCase()}`,
    body: `${displayType} ${next.entityId} was ${status.toLowerCase()}.`,
    entityType: next.entityType,
    entityId: next.entityId,
    severity: status === 'Rejected' ? 'Warning' : 'Info',
  });
  return next;
};

const recordLocalAllocationChangeApproval = (action: 'Create' | 'Update' | 'End', allocation: Allocation, previous?: Allocation) => {
  const u = actor();
  const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
  const projects = DataStorage.get<Project[]>(STORAGE_KEYS.PROJECTS, []);
  const employee = employees.find(item => item.id === allocation.employeeId);
  const project = projects.find(item => item.id === allocation.projectId);
  return ensureLocalApprovalRecord({
    entityType: 'AllocationChange',
    entityId: `allocation-change-${crypto.randomUUID()}`,
    subjectEmployeeId: allocation.employeeId,
    subjectEmployeeName: employee?.name,
    requesterId: u.id,
    requesterName: u.name,
    approverId: u.id,
    approverName: u.name,
    approverRole: u.role,
    activeRole: u.role,
    status: 'Approved',
    comments: JSON.stringify({
      action,
      allocationId: allocation.id,
      employeeId: employee?.employeeId || allocation.employeeId,
      projectCode: project?.projectCode || allocation.projectId,
      previous,
      allocation,
    }),
    source: 'Web',
    dueAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  });
};

const createLocalNotification = (notification: Omit<NotificationEvent, 'id' | 'createdAt'>) => {
  const event: NotificationEvent = {
    ...notification,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const events = DataStorage.get<NotificationEvent[]>(STORAGE_KEYS.NOTIFICATION_EVENTS, []);
  DataStorage.set(STORAGE_KEYS.NOTIFICATION_EVENTS, [event, ...events]);
  const attempts = DataStorage.get<NotificationDeliveryAttempt[]>(STORAGE_KEYS.NOTIFICATION_DELIVERY_ATTEMPTS, []);
  DataStorage.set(STORAGE_KEYS.NOTIFICATION_DELIVERY_ATTEMPTS, [{
    id: crypto.randomUUID(),
    notificationId: event.id,
    channel: 'InApp',
    provider: 'mock',
    status: 'Delivered',
    responseMetadata: { mode: 'local' },
    attemptedAt: new Date().toISOString(),
  }, ...attempts]);
  const u = actor();
  DataStorage.logAction(u.id, u.name, u.role, 'Send Notification', 'Notifications', `Sent notification ${event.title}`, { entityType: event.entityType, entityId: event.entityId, source: 'System' });
  return event;
};

// ── Employee Service ─────────────────────────────────────────────────────────
export const employeeService = {
  getAll: async (): Promise<Employee[]> => {
    if (await checkBackend()) {
      const [rawEmps, rawAllocs, rawProjects, rawTS, rawSettings] = await Promise.all([
        api.get<Record<string, unknown>[]>('/api/employees'),
        api.get<Record<string, unknown>[]>('/api/allocations'),
        api.get<Record<string, unknown>[]>('/api/projects'),
        api.get<Record<string, unknown>[]>('/api/timesheets'),
        api.get<Array<{ key: string; value: unknown }>>('/api/settings'),
      ]);
      const projects = rawProjects.map(normalizeProject);
      const projectMap = new Map(projects.map(p => [p.id, p]));
      const allocations = rawAllocs.map(r => normalizeAllocation(r, projectMap));
      const settings = normalizeSettings(rawSettings);
      const employees = rawEmps.map(normalizeEmployee);
      const timesheets = rawTS.map(r => normalizeTimesheetSummary(r, new Map()));
      return enrichEmployees(employees, allocations, projects, timesheets, settings);
    }
    return DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
  },
  getById: async (id: string): Promise<Employee | undefined> => {
    const list = await employeeService.getAll();
    return list.find(e => e.id === id);
  },
  save: async (emp: Employee): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/employees', {
        employee_id: emp.employeeId,
        name: emp.name,
        email: emp.email,
        designation: emp.designation,
        department: emp.department,
        country: emp.country,
        region: emp.region || null,
        business_unit: emp.businessUnit || null,
        reporting_manager_id: emp.reportingManagerId || null,
        primary_country_director_id: emp.primaryCountryDirectorId,
        mapped_country_director_ids: emp.mappedCountryDirectorIds,
        utilization_eligible: emp.utilizationEligible ?? getDefaultUtilizationEligible(emp),
        joining_date: emp.joiningDate || null,
        exit_date: emp.exitDate || null,
        standard_weekly_hours: emp.standardWeeklyHours ?? null,
        capacity_type: emp.capacityType || null,
        contract_type: emp.contractType || null,
        leave_policy_id: emp.leavePolicyId || null,
        entra_object_id: emp.entraObjectId || null,
        teams_user_id: emp.teamsUserId || null,
        status: emp.status,
      });
      return;
    }
    // localStorage mode
    const list = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const idx = list.findIndex(e => e.id === emp.id);
    const validation = validateEmployeeHierarchy(list, emp);
    if (!validation.valid) {
      throw new Error(validation.errors.join(' '));
    }
    const previous = idx >= 0 ? list[idx] : undefined;
    const nextEmployee = {
      ...emp,
      utilizationEligible: emp.utilizationEligible ?? getDefaultUtilizationEligible(emp),
    };
    if (idx >= 0) list[idx] = nextEmployee; else list.push(nextEmployee);
    DataStorage.set(STORAGE_KEYS.EMPLOYEES, list);
    DataStorage.ensureUserAccounts();
    DataStorage.recalculateUtilization();
    const u = actor();
    const hierarchyChanged = previous && (
      previous.reportingManagerId !== nextEmployee.reportingManagerId ||
      previous.country !== nextEmployee.country ||
      previous.department !== nextEmployee.department ||
      previous.businessUnit !== nextEmployee.businessUnit ||
      previous.status !== nextEmployee.status
    );
    const action = idx >= 0
      ? hierarchyChanged ? 'Reassign Employee' : 'Update Employee'
      : 'Create Employee';
    DataStorage.logAction(u.id, u.name, u.role, action, 'Employee', `${idx >= 0 ? 'Updated' : 'Created'} employee ${emp.name}`, {
      entityType: 'Employee',
      entityId: emp.id,
      oldValue: previous,
      newValue: nextEmployee,
    });
  },
  delete: async (id: string): Promise<void> => {
    if (await checkBackend()) {
      await api.delete(`/api/employees/${id}`, { confirm_direct_reports: true });
      return;
    }
    const list = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const previous = list.find(e => e.id === id);
    const validation = validateDeactivateManager(list, id);
    DataStorage.set(STORAGE_KEYS.EMPLOYEES, list.map(e => e.id === id ? { ...e, status: 'Exited' as const } : e));
    DataStorage.ensureUserAccounts();
    DataStorage.recalculateUtilization();
    if (previous) {
      const u = actor();
      DataStorage.logAction(u.id, u.name, u.role, 'Deactivate Employee', 'Employee', `Deactivated employee ${previous.name}${validation.warnings.length ? `; ${validation.warnings.join(' ')}` : ''}`, {
        entityType: 'Employee',
        entityId: previous.id,
        oldValue: previous,
        newValue: { ...previous, status: 'Exited' },
        reason: validation.warnings.join(' '),
      });
    }
  },
};

// ── Project Service ──────────────────────────────────────────────────────────
export const projectService = {
  getAll: async (): Promise<Project[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/projects');
      return raw.map(normalizeProject);
    }
    return DataStorage.get<Project[]>(STORAGE_KEYS.PROJECTS, []);
  },
  getById: async (id: string): Promise<Project | undefined> => {
    const list = await projectService.getAll();
    return list.find(p => p.id === id);
  },
  save: async (proj: Project): Promise<void> => {
    if (await checkBackend()) {
      const clients = await clientService.getAll();
      const client = clients.find(c => c.id === proj.clientId || c.name === proj.client);
      await api.post('/api/projects', {
        id: proj.id,
        project_code: proj.projectCode,
        name: proj.name,
        client_id: client?.id || proj.clientId,
        manager_id: proj.managerId,
        start_date: proj.startDate,
        end_date: proj.endDate,
        status: proj.status,
        billable: proj.billable,
        notes: (proj as unknown as Record<string, unknown>).notes || null,
      });
      return;
    }
    const list = DataStorage.get<Project[]>(STORAGE_KEYS.PROJECTS, []);
    const idx = list.findIndex(p => p.id === proj.id);
    const previous = idx >= 0 ? list[idx] : undefined;
    if (idx >= 0) list[idx] = proj; else list.push(proj);
    DataStorage.set(STORAGE_KEYS.PROJECTS, list);
    DataStorage.recalculateUtilization();
    const u = actor();
    DataStorage.logAction(
      u.id,
      u.name,
      u.role,
      previous ? 'Update Project' : 'Create Project',
      'Projects',
      `${previous ? 'Updated' : 'Created'} project ${proj.projectCode || proj.name}`,
      { entityType: 'Project', entityId: proj.id, oldValue: previous, newValue: proj }
    );
  },
  close: async (id: string): Promise<boolean> => {
    if (await checkBackend()) {
      await api.patch(`/api/projects/${id}/status`, { status: 'Completed' });
      return true;
    }
    const list = DataStorage.get<Project[]>(STORAGE_KEYS.PROJECTS, []);
    const proj = list.find(p => p.id === id);
    if (!proj) return false;
    const nextProject = { ...proj, status: 'Completed' as const, endDate: todayIso() };
    DataStorage.set(STORAGE_KEYS.PROJECTS, list.map(p => p.id === id ? nextProject : p));
    DataStorage.recalculateUtilization();
    const u = actor();
    DataStorage.logAction(
      u.id,
      u.name,
      u.role,
      'Update Project Status',
      'Projects',
      `Closed project ${proj.projectCode || proj.name}`,
      { entityType: 'Project', entityId: id, oldValue: proj, newValue: nextProject }
    );
    return true;
  },
};

// ── Client Service ───────────────────────────────────────────────────────────
export const clientService = {
  getAll: async (): Promise<Client[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/clients');
      return raw.map(normalizeClient);
    }
    return DataStorage.get<Client[]>(STORAGE_KEYS.CLIENTS, []);
  },
  getById: async (id: string): Promise<Client | undefined> => {
    const list = await clientService.getAll();
    return list.find(c => c.id === id);
  },
  save: async (client: Client): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/clients', {
        id: client.id,
        name: client.name,
        industry: client.industry,
        account_owner_id: client.accountOwnerId || null,
        country_director_ids: client.countryDirectorIds,
        status: client.status,
      });
      return;
    }
    const list = DataStorage.get<Client[]>(STORAGE_KEYS.CLIENTS, []);
    const idx = list.findIndex(c => c.id === client.id);
    const previous = idx >= 0 ? list[idx] : undefined;
    if (idx >= 0) list[idx] = client; else list.push(client);
    DataStorage.set(STORAGE_KEYS.CLIENTS, list);
    if (previous && previous.name !== client.name) {
      const projects = DataStorage.get<Project[]>(STORAGE_KEYS.PROJECTS, []);
      DataStorage.set(STORAGE_KEYS.PROJECTS, projects.map(project => (
        project.clientId === client.id || project.client === previous.name
          ? { ...project, client: client.name, clientId: client.id }
          : project
      )));
    }
    const u = actor();
    DataStorage.logAction(
      u.id,
      u.name,
      u.role,
      previous ? 'Update Client' : 'Create Client',
      'Clients',
      `${previous ? 'Updated' : 'Created'} client ${client.name}`,
      { entityType: 'Client', entityId: client.id, oldValue: previous, newValue: client }
    );
  },
  delete: async (id: string): Promise<boolean> => {
    if (await checkBackend()) {
      await api.delete(`/api/clients/${id}`);
      return true;
    }
    const list = DataStorage.get<Client[]>(STORAGE_KEYS.CLIENTS, []);
    const client = list.find(c => c.id === id);
    if (!client) return false;
    const nextClient = { ...client, status: 'Inactive' as const };
    DataStorage.set(STORAGE_KEYS.CLIENTS, list.map(c => c.id === id ? nextClient : c));
    const u = actor();
    DataStorage.logAction(
      u.id,
      u.name,
      u.role,
      'Deactivate Client',
      'Clients',
      `Deactivated client ${client.name}`,
      { entityType: 'Client', entityId: id, oldValue: client, newValue: nextClient }
    );
    return true;
  },
};

// ── Allocation Service ───────────────────────────────────────────────────────
export const allocationService = {
  getAll: async (): Promise<Allocation[]> => {
    if (await checkBackend()) {
      const [rawAllocs, rawProjects] = await Promise.all([
        api.get<Record<string, unknown>[]>('/api/allocations'),
        api.get<Record<string, unknown>[]>('/api/projects'),
      ]);
      const projects = rawProjects.map(normalizeProject);
      const projectMap = new Map(projects.map(p => [p.id, p]));
      return rawAllocs.map(r => normalizeAllocation(r, projectMap));
    }
    return DataStorage.get<Allocation[]>(STORAGE_KEYS.ALLOCATIONS, []);
  },
  save: async (alloc: Allocation): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/allocations', {
        id: alloc.id,
        employee_id: alloc.employeeId,
        project_id: alloc.projectId,
        role_on_project: alloc.roleOnProject || null,
        percentage: alloc.percentage,
        start_date: alloc.startDate,
        end_date: alloc.endDate,
        billable: alloc.billable,
        status: alloc.status,
      });
      return;
    }
    const list = DataStorage.get<Allocation[]>(STORAGE_KEYS.ALLOCATIONS, []);
    const idx = list.findIndex(a => a.id === alloc.id);
    const previous = idx >= 0 ? list[idx] : undefined;
    const next = { ...alloc, id: alloc.id || crypto.randomUUID() };
    if (idx >= 0) list[idx] = next; else list.push(next);
    DataStorage.set(STORAGE_KEYS.ALLOCATIONS, list);
    recordLocalAllocationChangeApproval(previous ? 'Update' : 'Create', next, previous);
    DataStorage.recalculateUtilization();
  },
  delete: async (id: string): Promise<boolean> => {
    if (await checkBackend()) {
      await api.delete(`/api/allocations/${id}`);
      return true;
    }
    const list = DataStorage.get<Allocation[]>(STORAGE_KEYS.ALLOCATIONS, []);
    const alloc = list.find(a => a.id === id);
    if (!alloc) return false;
    const next = { ...alloc, status: 'Completed' as const, endDate: todayIso() };
    DataStorage.set(STORAGE_KEYS.ALLOCATIONS, list.map(a => a.id === id ? next : a));
    recordLocalAllocationChangeApproval('End', next, alloc);
    DataStorage.recalculateUtilization();
    return true;
  },
};

// ── Timesheet Service ────────────────────────────────────────────────────────
export const timesheetService = {
  getAll: async (): Promise<TimesheetSummary[]> => {
    if (await checkBackend()) {
      const [rawTS, rawEmps] = await Promise.all([
        api.get<Record<string, unknown>[]>('/api/timesheets'),
        api.get<Record<string, unknown>[]>('/api/employees'),
      ]);
      const empMap = new Map(rawEmps.map(r => [String(r.id), { ...normalizeEmployee(r), plannedUtilization: 0, actualUtilization: 0, activeProjectCount: 0 }]));
      return rawTS.map(r => normalizeTimesheetSummary(r, empMap));
    }
    return DataStorage.get<TimesheetSummary[]>(STORAGE_KEYS.TIMESHEETS, []);
  },
  save: async (ts: TimesheetSummary): Promise<TimesheetSummary['workAssurance']> => {
    const serializedEntries = ts.entries.map(e => ({ ...e, hours: canonicalHours(e.hours) }));
    const roundedEntries = serializedEntries.map(e => ({ ...e, hours: Number(e.hours) }));
    const totalHours = Number(sumHours(roundedEntries.map(entry => entry.hours)));
    const billableHours = Number(sumHours(roundedEntries.filter(entry => entry.billable).map(entry => entry.hours)));
    if (await checkBackend()) {
      const saved = await api.post<Record<string, unknown>>('/api/timesheets', {
        employee_id: ts.employeeId,
        week_ending: ts.weekEnding,
        status: ts.status,
        rejection_reason: ts.rejectionReason || null,
        entries: serializedEntries.map(e => ({
          id: e.id,
          project_id: e.projectId || null,
          work_type: e.workType,
          client_name: e.clientName || null,
          category: e.category || null,
          work_date: e.date,
          hours: e.hours,
          remark: e.remark || null,
          evidence_url: e.evidenceUrl,
          work_reference: e.workReference,
          billable: e.billable,
        })),
      });
      return normalizeWorkAssurance(saved.work_assurance);
    }
    // localStorage save with future-week guard
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const weekStart = new Date(ts.weekEnding);
    weekStart.setDate(weekStart.getDate() - 4);
    const currWeekStart = new Date(today);
    const d = currWeekStart.getDay();
    currWeekStart.setDate(currWeekStart.getDate() + (d === 0 ? -6 : 1 - d));
    if (weekStart > currWeekStart) throw new Error('Future week timesheets cannot be saved or submitted.');
    const list = DataStorage.get<TimesheetSummary[]>(STORAGE_KEYS.TIMESHEETS, []);
    const idx = list.findIndex(t => t.employeeId === ts.employeeId && t.weekEnding === ts.weekEnding);
    const next = { ...ts, entries: roundedEntries, totalHours, billableHours, updatedAt: new Date().toISOString() };
    if (idx >= 0) list[idx] = next; else list.push(next);
    DataStorage.set(STORAGE_KEYS.TIMESHEETS, list);
    if (next.status === 'Submitted') {
      ensureLocalApprovalRecord({
        entityType: 'Timesheet',
        entityId: next.id || `${next.employeeId}:${next.weekEnding}`,
        subjectEmployeeId: next.employeeId,
        subjectEmployeeName: next.employeeName,
        requesterId: next.employeeId,
        requesterName: next.employeeName,
        status: 'Pending',
        source: 'Web',
      });
    }
    DataStorage.recalculateUtilization();
  },
  approve: async (timesheetId: string, _reason?: string): Promise<void> => {
    if (await checkBackend()) {
      const backendId = timesheetId.includes(':')
        ? (await timesheetService.getAll()).find(t => `${t.employeeId}:${t.weekEnding}` === timesheetId)?.id
        : timesheetId;
      if (!backendId) throw new Error('Timesheet record was not found for approval.');
      await api.patch(`/api/timesheets/${backendId}/status`, { status: 'Approved' });
      return;
    }
    const [empId, weekEnding] = timesheetId.includes(':') ? timesheetId.split(':') : [timesheetId, ''];
    const list = DataStorage.get<TimesheetSummary[]>(STORAGE_KEYS.TIMESHEETS, []);
    DataStorage.set(STORAGE_KEYS.TIMESHEETS, list.map(t =>
      (t.employeeId === empId && t.weekEnding === weekEnding)
        ? { ...t, status: 'Approved' as const, approvedAt: new Date().toISOString() }
        : t
    ));
    decideLocalApprovalRecord('Timesheet', timesheetId, 'Approved');
  },
  reject: async (timesheetId: string, reason: string): Promise<void> => {
    if (await checkBackend()) {
      const backendId = timesheetId.includes(':')
        ? (await timesheetService.getAll()).find(t => `${t.employeeId}:${t.weekEnding}` === timesheetId)?.id
        : timesheetId;
      if (!backendId) throw new Error('Timesheet record was not found for rejection.');
      await api.patch(`/api/timesheets/${backendId}/status`, { status: 'Rejected', reason });
      return;
    }
    const [empId, weekEnding] = timesheetId.includes(':') ? timesheetId.split(':') : [timesheetId, ''];
    const list = DataStorage.get<TimesheetSummary[]>(STORAGE_KEYS.TIMESHEETS, []);
    DataStorage.set(STORAGE_KEYS.TIMESHEETS, list.map(t =>
      (t.employeeId === empId && t.weekEnding === weekEnding)
        ? { ...t, status: 'Rejected' as const, rejectionReason: reason, rejectionNote: reason, rejectedAt: new Date().toISOString() }
        : t
    ));
    decideLocalApprovalRecord('Timesheet', timesheetId, 'Rejected', reason);
  },
};

// ── Admin Service ────────────────────────────────────────────────────────────
const leaveDayCount = (startDate: string, endDate: string) => {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  let days = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) days += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};

const leaveYear = (dateValue: string) => Number(dateValue.slice(0, 4));

const calculateLocalAccruedLeaveDays = (policy?: LeavePolicy, asOfDate = todayIso()) => {
  const annualAllowance = Number(policy?.annualAllowanceDays || 0);
  const method = String(policy?.accrualMethod || 'Annual').toLowerCase();
  if (method.includes('month') || method.includes('prorat')) {
    const month = new Date(`${asOfDate}T00:00:00`).getMonth() + 1;
    return roundMetric((annualAllowance * month) / 12);
  }
  if (method.includes('manual')) return 0;
  return roundMetric(annualAllowance);
};

const findLocalLeavePolicyForEmployee = (employee: Employee) => {
  const policies = DataStorage.get<LeavePolicy[]>(STORAGE_KEYS.LEAVE_POLICIES, []);
  if (employee.leavePolicyId) {
    const explicit = policies.find(policy => policy.id === employee.leavePolicyId && policy.status === 'Active');
    if (explicit) return explicit;
  }
  return policies.find(policy => policy.status === 'Active' && policy.country.toLowerCase() === employee.country.toLowerCase())
    || policies.find(policy => policy.status === 'Active' && policy.country.toLowerCase() === 'global');
};

const ensureLocalLeaveBalanceForRequest = (employee: Employee, leaveTypeId: string, year: number, asOfDate: string) => {
  const leaveTypes = DataStorage.get<LeaveType[]>(STORAGE_KEYS.LEAVE_TYPES, []);
  const leaveType = leaveTypes.find(type => type.id === leaveTypeId && type.active);
  if (!leaveType) throw new Error('Leave request must reference an active leave type.');

  const policy = findLocalLeavePolicyForEmployee(employee);
  if (!policy && leaveType.paid) throw new Error('Paid leave requires an active leave policy for this employee.');
  if (policy?.leaveTypeIds?.length && !policy.leaveTypeIds.includes(leaveTypeId)) {
    throw new Error('Selected leave type is not enabled in the employee leave policy.');
  }

  if (!leaveType.paid) return { leaveType, policy, balance: undefined };

  const accruedDays = calculateLocalAccruedLeaveDays(policy, asOfDate);
  const balances = DataStorage.get<LeaveBalance[]>(STORAGE_KEYS.LEAVE_BALANCES, []);
  const existing = balances.find(balance =>
    balance.employeeId === employee.id &&
    balance.leaveTypeId === leaveTypeId &&
    balance.year === year
  );

  if (!existing) {
    const nextBalance: LeaveBalance = {
      id: crypto.randomUUID(),
      employeeId: employee.id,
      employeeName: employee.name,
      leaveTypeId,
      leaveTypeName: leaveType.name,
      policyId: policy?.id,
      year,
      openingDays: 0,
      accruedDays,
      usedDays: 0,
      adjustedDays: 0,
      pendingDays: 0,
      availableDays: accruedDays,
      updatedAt: new Date().toISOString(),
    };
    DataStorage.set(STORAGE_KEYS.LEAVE_BALANCES, [nextBalance, ...balances]);
  } else if ((policy?.id && existing.policyId !== policy.id) || accruedDays > existing.accruedDays) {
    DataStorage.set(STORAGE_KEYS.LEAVE_BALANCES, balances.map(balance =>
      balance.id === existing.id
        ? { ...balance, policyId: policy?.id || balance.policyId, accruedDays: Math.max(balance.accruedDays, accruedDays), updatedAt: new Date().toISOString() }
        : balance
    ));
  }

  const refreshed = refreshLocalLeaveBalances();
  return {
    leaveType,
    policy,
    balance: refreshed.find(balance => balance.employeeId === employee.id && balance.leaveTypeId === leaveTypeId && balance.year === year),
  };
};

const refreshLocalLeaveBalances = () => {
  const balances = DataStorage.get<LeaveBalance[]>(STORAGE_KEYS.LEAVE_BALANCES, []);
  const requests = DataStorage.get<LeaveRequest[]>(STORAGE_KEYS.LEAVE_REQUESTS, []);
  const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
  const leaveTypes = DataStorage.get<LeaveType[]>(STORAGE_KEYS.LEAVE_TYPES, []);
  const employeesById = new Map(employees.map(employee => [employee.id, employee]));
  const leaveTypeById = new Map(leaveTypes.map(type => [type.id, type]));
  const next = balances.map(balance => {
    const matchingRequests = requests.filter(request =>
      request.employeeId === balance.employeeId &&
      request.leaveTypeId === balance.leaveTypeId &&
      new Date(`${request.startDate}T00:00:00`).getFullYear() === balance.year
    );
    const usedDays = matchingRequests
      .filter(request => request.status === 'Approved')
      .reduce((sum, request) => sum + request.totalDays, 0);
    const pendingDays = matchingRequests
      .filter(request => request.status === 'Submitted')
      .reduce((sum, request) => sum + request.totalDays, 0);
    const availableDays = Math.max(0, balance.openingDays + balance.accruedDays + balance.adjustedDays - usedDays - pendingDays);
    return {
      ...balance,
      employeeName: balance.employeeName || employeesById.get(balance.employeeId)?.name,
      leaveTypeName: balance.leaveTypeName || leaveTypeById.get(balance.leaveTypeId)?.name,
      usedDays,
      pendingDays,
      availableDays,
      updatedAt: new Date().toISOString(),
    };
  });
  DataStorage.set(STORAGE_KEYS.LEAVE_BALANCES, next);
  return next;
};

const buildLocalLeaveAvailability = async (): Promise<LeaveAvailabilityEntry[]> => {
  const [employees, requests, calendars] = await Promise.all([
    employeeService.getAll(),
    leaveService.getRequests(),
    leaveService.getHolidayCalendars(),
  ]);
  const currentYear = new Date().getFullYear();
  return employees
    .filter(employee => employee.status !== 'Exited')
    .map(employee => {
      const approvedLeaveDays = requests
        .filter(request =>
          request.employeeId === employee.id &&
          request.status === 'Approved' &&
          new Date(`${request.startDate}T00:00:00`).getFullYear() === currentYear
        )
        .reduce((sum, request) => sum + request.totalDays, 0);
      const holidayDays = calendars
        .filter(calendar => calendar.status === 'Active' && calendar.year === currentYear && (calendar.country === 'Global' || calendar.country === employee.country))
        .flatMap(calendar => calendar.holidays)
        .filter(holiday => {
          const day = new Date(`${holiday.date}T00:00:00`).getDay();
          return day !== 0 && day !== 6;
        }).length;
      const standardWeeklyHours = employee.standardWeeklyHours || 40;
      const dailyHours = standardWeeklyHours / 5;
      return {
        employeeId: employee.id,
        employeeName: employee.name,
        standardWeeklyHours,
        approvedLeaveDays,
        holidayDays,
        availabilityHours: Math.max(0, standardWeeklyHours * 52 - (approvedLeaveDays + holidayDays) * dailyHours),
      };
    });
};

export const leaveService = {
  getTypes: async (): Promise<LeaveType[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/leave/types');
      return raw.map(normalizeLeaveType);
    }
    return DataStorage.get<LeaveType[]>(STORAGE_KEYS.LEAVE_TYPES, []);
  },
  saveType: async (type: LeaveType): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/leave/types', {
        id: type.id,
        code: type.code,
        name: type.name,
        paid: type.paid,
        requires_approval: type.requiresApproval,
        active: type.active,
      });
      return;
    }
    const list = DataStorage.get<LeaveType[]>(STORAGE_KEYS.LEAVE_TYPES, []);
    const idx = list.findIndex(item => item.id === type.id);
    if (idx >= 0) list[idx] = type; else list.push(type);
    DataStorage.set(STORAGE_KEYS.LEAVE_TYPES, list);
  },
  getPolicies: async (): Promise<LeavePolicy[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/leave/policies');
      return raw.map(normalizeLeavePolicy);
    }
    return DataStorage.get<LeavePolicy[]>(STORAGE_KEYS.LEAVE_POLICIES, []);
  },
  savePolicy: async (policy: LeavePolicy): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/leave/policies', {
        id: policy.id,
        name: policy.name,
        country: policy.country,
        annual_allowance_days: policy.annualAllowanceDays,
        carry_forward_days: policy.carryForwardDays,
        accrual_method: policy.accrualMethod,
        status: policy.status,
        leave_type_ids: policy.leaveTypeIds,
      });
      return;
    }
    const list = DataStorage.get<LeavePolicy[]>(STORAGE_KEYS.LEAVE_POLICIES, []);
    const idx = list.findIndex(item => item.id === policy.id);
    if (idx >= 0) list[idx] = policy; else list.push(policy);
    DataStorage.set(STORAGE_KEYS.LEAVE_POLICIES, list);
    const u = actor();
    DataStorage.logAction(u.id, u.name, u.role, idx >= 0 ? 'Update' : 'Create', 'Leave', `${idx >= 0 ? 'Updated' : 'Created'} leave policy ${policy.name}`, { entityType: 'LeavePolicy', entityId: policy.id });
  },
  getHolidayCalendars: async (): Promise<HolidayCalendar[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/holiday-calendars');
      return raw.map(normalizeHolidayCalendar);
    }
    return DataStorage.get<HolidayCalendar[]>(STORAGE_KEYS.HOLIDAY_CALENDARS, []);
  },
  saveHolidayCalendar: async (calendar: HolidayCalendar): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/holiday-calendars', {
        id: calendar.id,
        name: calendar.name,
        country: calendar.country,
        year: calendar.year,
        status: calendar.status,
        holidays: calendar.holidays.map(holiday => ({
          id: holiday.id,
          name: holiday.name,
          date: holiday.date,
          type: holiday.type,
        })),
      });
      return;
    }
    const list = DataStorage.get<HolidayCalendar[]>(STORAGE_KEYS.HOLIDAY_CALENDARS, []);
    const idx = list.findIndex(item => item.id === calendar.id);
    if (idx >= 0) list[idx] = calendar; else list.push(calendar);
    DataStorage.set(STORAGE_KEYS.HOLIDAY_CALENDARS, list);
  },
  getBalances: async (): Promise<LeaveBalance[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/leave/balances');
      return raw.map(normalizeLeaveBalance);
    }
    return refreshLocalLeaveBalances();
  },
  saveBalance: async (balance: LeaveBalance): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/leave/balances', {
        id: balance.id,
        employee_id: balance.employeeId,
        leave_type_id: balance.leaveTypeId,
        policy_id: balance.policyId || null,
        year: balance.year,
        opening_days: balance.openingDays,
        accrued_days: balance.accruedDays,
        adjusted_days: balance.adjustedDays,
      });
      return;
    }
    const list = DataStorage.get<LeaveBalance[]>(STORAGE_KEYS.LEAVE_BALANCES, []);
    const idx = list.findIndex(item => item.id === balance.id);
    if (idx >= 0) list[idx] = balance; else list.push(balance);
    DataStorage.set(STORAGE_KEYS.LEAVE_BALANCES, list);
    refreshLocalLeaveBalances();
  },
  getRequests: async (): Promise<LeaveRequest[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/leave/requests');
      return raw.map(normalizeLeaveRequest);
    }
    const employees = await employeeService.getAll();
    const types = DataStorage.get<LeaveType[]>(STORAGE_KEYS.LEAVE_TYPES, []);
    const employeesById = new Map(employees.map(employee => [employee.id, employee]));
    const typesById = new Map(types.map(type => [type.id, type]));
    return DataStorage.get<LeaveRequest[]>(STORAGE_KEYS.LEAVE_REQUESTS, []).map(request => ({
      ...request,
      employeeName: request.employeeName || employeesById.get(request.employeeId)?.name,
      leaveTypeName: request.leaveTypeName || typesById.get(request.leaveTypeId)?.name,
    }));
  },
  submitRequest: async (request: LeaveRequest): Promise<LeaveRequest> => {
    const totalDays = request.totalDays || leaveDayCount(request.startDate, request.endDate);
    if (request.endDate < request.startDate) throw new Error('Leave end date must be on or after start date.');
    if (leaveYear(request.startDate) !== leaveYear(request.endDate)) throw new Error('Leave requests that span calendar years must be split by year.');
    if (totalDays <= 0) throw new Error('Leave request must include at least one business day.');
    if (await checkBackend()) {
      const raw = await api.post<Record<string, unknown>>('/api/leave/requests', {
        employee_id: request.employeeId,
        leave_type_id: request.leaveTypeId,
        start_date: request.startDate,
        end_date: request.endDate,
        total_days: totalDays,
        reason: request.reason || null,
      });
      return normalizeLeaveRequest(raw);
    }
    const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const employee = employees.find(item => item.id === request.employeeId || item.employeeId === request.employeeId);
    if (!employee || employee.status === 'Exited') throw new Error('Leave request must reference an active employee.');
    const existingRequests = DataStorage.get<LeaveRequest[]>(STORAGE_KEYS.LEAVE_REQUESTS, []);
    const overlapping = existingRequests.find(item =>
      item.employeeId === employee.id &&
      ['Draft', 'Submitted', 'Approved'].includes(item.status) &&
      item.startDate <= request.endDate &&
      item.endDate >= request.startDate &&
      item.id !== request.id
    );
    if (overlapping) throw new Error('Leave request overlaps an existing draft, submitted, or approved request.');
    const { leaveType, balance } = ensureLocalLeaveBalanceForRequest(employee, request.leaveTypeId, leaveYear(request.startDate), request.startDate);
    if (leaveType.paid && balance && balance.availableDays < totalDays) {
      throw new Error(`Insufficient leave balance. Available: ${balance.availableDays} day(s), requested: ${totalDays} day(s).`);
    }
    const types = DataStorage.get<LeaveType[]>(STORAGE_KEYS.LEAVE_TYPES, []);
    const next: LeaveRequest = {
      ...request,
      id: request.id || crypto.randomUUID(),
      totalDays,
      status: 'Submitted',
      employeeId: employee.id,
      employeeName: employee.name,
      leaveTypeName: types.find(type => type.id === request.leaveTypeId)?.name,
      submittedAt: new Date().toISOString(),
      createdAt: request.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const list = DataStorage.get<LeaveRequest[]>(STORAGE_KEYS.LEAVE_REQUESTS, []);
    DataStorage.set(STORAGE_KEYS.LEAVE_REQUESTS, [next, ...list.filter(item => item.id !== next.id)]);
    ensureLocalApprovalRecord({
      entityType: 'LeaveRequest',
      entityId: next.id,
      subjectEmployeeId: next.employeeId,
      subjectEmployeeName: next.employeeName,
      requesterId: next.employeeId,
      requesterName: next.employeeName,
      status: 'Pending',
      source: 'Web',
    });
    refreshLocalLeaveBalances();
    const u = actor();
    DataStorage.logAction(u.id, u.name, u.role, 'Submit Leave', 'Leave', `Submitted leave request for ${next.employeeName || next.employeeId}`, { entityType: 'LeaveRequest', entityId: next.id, newValue: next });
    return next;
  },
  updateRequest: async (id: string, request: Pick<LeaveRequest, 'leaveTypeId' | 'startDate' | 'endDate' | 'reason'>): Promise<LeaveRequest> => {
    const totalDays = leaveDayCount(request.startDate, request.endDate);
    if (request.endDate < request.startDate) throw new Error('Leave end date must be on or after start date.');
    if (leaveYear(request.startDate) !== leaveYear(request.endDate)) throw new Error('Leave requests that span calendar years must be split by year.');
    if (totalDays <= 0) throw new Error('Leave request must include at least one business day.');
    if (await checkBackend()) {
      return normalizeLeaveRequest(await api.patch<Record<string, unknown>>(`/api/leave/requests/${id}`, {
        leave_type_id: request.leaveTypeId,
        start_date: request.startDate,
        end_date: request.endDate,
        total_days: totalDays,
        reason: request.reason || null,
      }));
    }
    const list = DataStorage.get<LeaveRequest[]>(STORAGE_KEYS.LEAVE_REQUESTS, []);
    const previous = list.find(item => item.id === id);
    if (!previous) throw new Error('Leave request was not found.');
    if (previous.status !== 'Submitted') throw new Error('Only submitted leave requests can be edited.');
    const existingRequests = list.filter(item => item.id !== id);
    const overlapping = existingRequests.find(item =>
      item.employeeId === previous.employeeId &&
      ['Draft', 'Submitted', 'Approved'].includes(item.status) &&
      item.startDate <= request.endDate &&
      item.endDate >= request.startDate
    );
    if (overlapping) throw new Error('Leave request overlaps an existing draft, submitted, or approved request.');
    const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const employee = employees.find(item => item.id === previous.employeeId);
    if (!employee) throw new Error('Leave request employee was not found.');
    const { leaveType, balance } = ensureLocalLeaveBalanceForRequest(employee, request.leaveTypeId, leaveYear(request.startDate), request.startDate);
    if (leaveType.paid && balance && balance.availableDays + previous.totalDays < totalDays) {
      throw new Error(`Insufficient leave balance. Available: ${balance.availableDays} day(s), requested: ${totalDays} day(s).`);
    }
    const types = DataStorage.get<LeaveType[]>(STORAGE_KEYS.LEAVE_TYPES, []);
    const next: LeaveRequest = {
      ...previous,
      leaveTypeId: request.leaveTypeId,
      leaveTypeName: types.find(type => type.id === request.leaveTypeId)?.name,
      startDate: request.startDate,
      endDate: request.endDate,
      totalDays,
      reason: request.reason,
      updatedAt: new Date().toISOString(),
    };
    DataStorage.set(STORAGE_KEYS.LEAVE_REQUESTS, list.map(item => item.id === id ? next : item));
    refreshLocalLeaveBalances();
    const u = actor();
    DataStorage.logAction(u.id, u.name, u.role, 'Update Leave', 'Leave', `Updated leave request for ${next.employeeName || next.employeeId}`, { entityType: 'LeaveRequest', entityId: next.id, oldValue: previous, newValue: next });
    return next;
  },
  updateRequestStatus: async (id: string, status: 'Approved' | 'Rejected' | 'Cancelled', comments?: string): Promise<LeaveRequest> => {
    if (await checkBackend()) {
      const user = authService.getCurrentUser();
      const canApproveLeave = user?.permissions?.includes('leave.approve') || ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead'].includes(user?.role || '');
      const path = status === 'Cancelled' && !canApproveLeave ? `/api/leave/requests/${id}/cancel` : `/api/leave/requests/${id}/status`;
      return normalizeLeaveRequest(await api.patch<Record<string, unknown>>(path, { status, comments }));
    }
    const list = DataStorage.get<LeaveRequest[]>(STORAGE_KEYS.LEAVE_REQUESTS, []);
    const previous = list.find(item => item.id === id);
    if (!previous) throw new Error('Leave request was not found.');
    if (status === 'Cancelled' && !['Submitted', 'Approved'].includes(previous.status)) {
      throw new Error('Only submitted or approved leave requests can be cancelled.');
    }
    if (status !== 'Cancelled' && previous.status !== 'Submitted') {
      throw new Error('Only submitted leave requests can be approved or rejected.');
    }
    const u = actor();
    const next = {
      ...previous,
      status,
      comments,
      approverId: u.id,
      approverName: u.name,
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    DataStorage.set(STORAGE_KEYS.LEAVE_REQUESTS, list.map(item => item.id === id ? next : item));
    decideLocalApprovalRecord('LeaveRequest', id, status === 'Cancelled' ? 'Cancelled' : status, comments);
    refreshLocalLeaveBalances();
    DataStorage.logAction(u.id, u.name, u.role, `${status} Leave`, 'Leave', `${status} leave request for ${next.employeeName || next.employeeId}`, { entityType: 'LeaveRequest', entityId: next.id, oldValue: previous, newValue: next, reason: comments });
    return next;
  },
  getAvailability: async (): Promise<LeaveAvailabilityEntry[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/reports/availability');
      return raw.map(row => ({
        employeeId: String(row.employee_id ?? row.employeeId),
        employeeName: String(row.employee_name ?? row.employeeName),
        standardWeeklyHours: Number(row.standard_weekly_hours ?? row.standardWeeklyHours ?? 40),
        approvedLeaveDays: Number(row.approved_leave_days ?? row.approvedLeaveDays ?? 0),
        holidayDays: Number(row.holiday_days ?? row.holidayDays ?? 0),
        availabilityHours: Number(row.availability_hours ?? row.availabilityHours ?? 0),
      }));
    }
    return buildLocalLeaveAvailability();
  },
};

const canUseLocalApprovalDelegation = (record: ApprovalRecord, userEmployeeRecordId: string) => {
  const today = todayIso();
  const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
  const subject = employees.find(employee => employee.id === record.subjectEmployeeId || employee.employeeId === record.subjectEmployeeId);
  if (!subject) return false;
  return DataStorage.get<ApprovalDelegation[]>(STORAGE_KEYS.APPROVAL_DELEGATIONS, []).some(delegation =>
    delegation.status === 'Active' &&
    delegation.delegateId === userEmployeeRecordId &&
    delegation.startDate <= today &&
    delegation.endDate >= today &&
    (subject.id === delegation.delegatorId || subject.reportingManagerId === delegation.delegatorId)
  );
};

const canViewLocalApprovalRecord = (record: ApprovalRecord) => {
  const user = authService.getCurrentUser();
  if (!user) return true;
  if (['Admin', 'HR'].includes(user.role)) return true;
  if (record.subjectEmployeeId === user.id || record.subjectEmployeeId === user.employeeId) return true;

  const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
  const subject = employees.find(employee => employee.id === record.subjectEmployeeId || employee.employeeId === record.subjectEmployeeId);
  if (subject && ['ProjectManager', 'TeamLead'].includes(user.role) && subject.reportingManagerId === user.id) return true;
  if (subject && user.role === 'CountryDirector' && (subject.primaryCountryDirectorId === user.cdId || subject.mappedCountryDirectorIds.includes(user.cdId || ''))) return true;
  return canUseLocalApprovalDelegation(record, user.id);
};

export const approvalService = {
  getAll: async (): Promise<ApprovalRecord[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/approvals');
      return raw.map(normalizeApprovalRecord);
    }
    return getLocalApprovalRecords().filter(canViewLocalApprovalRecord);
  },
  decide: async (id: string, status: 'Approved' | 'Rejected' | 'Cancelled', comments?: string): Promise<ApprovalRecord> => {
    if (await checkBackend()) {
      return normalizeApprovalRecord(await api.patch<Record<string, unknown>>(`/api/approvals/${id}/status`, { status, comments }));
    }
    const records = getLocalApprovalRecords();
    const record = records.find(item => item.id === id);
    if (!record) throw new Error('Approval record was not found.');
    if (record.status !== 'Pending') throw new Error('Only pending approvals can be decided.');
    if (!canViewLocalApprovalRecord(record)) throw new Error('Approval is outside active-role data scope.');
    const u = actor();
    const next: ApprovalRecord = {
      ...record,
      status,
      comments,
      approverId: u.id,
      approverName: u.name,
      approverRole: u.role,
      activeRole: u.role,
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveLocalApprovalRecord(next);
    createLocalNotification({
      recipientEmployeeId: next.subjectEmployeeId,
      recipientName: next.subjectEmployeeName,
      eventType: 'ApprovalDecided',
      title: `${next.entityType} approval ${status.toLowerCase()}`,
      body: `${next.entityType} ${next.entityId} was ${status.toLowerCase()}.`,
      entityType: next.entityType,
      entityId: next.entityId,
      severity: status === 'Rejected' ? 'Warning' : 'Info',
    });
    if (record.entityType === 'Timesheet') {
      const timesheets = DataStorage.get<TimesheetSummary[]>(STORAGE_KEYS.TIMESHEETS, []);
      DataStorage.set(STORAGE_KEYS.TIMESHEETS, timesheets.map(timesheet => {
        const key = timesheet.id || `${timesheet.employeeId}:${timesheet.weekEnding}`;
        return key === record.entityId
          ? {
              ...timesheet,
              status: status === 'Approved' ? 'Approved' : 'Rejected',
              rejectionReason: status === 'Rejected' ? comments : undefined,
              approvedAt: status === 'Approved' ? new Date().toISOString() : timesheet.approvedAt,
              rejectedAt: status === 'Rejected' ? new Date().toISOString() : timesheet.rejectedAt,
            }
          : timesheet;
      }));
    }
    if (record.entityType === 'LeaveRequest') {
      const requests = DataStorage.get<LeaveRequest[]>(STORAGE_KEYS.LEAVE_REQUESTS, []);
      DataStorage.set(STORAGE_KEYS.LEAVE_REQUESTS, requests.map(request => request.id === record.entityId
        ? { ...request, status, comments, approverId: u.id, approverName: u.name, decidedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        : request
      ));
      refreshLocalLeaveBalances();
    }
    return next;
  },
  getDelegations: async (): Promise<ApprovalDelegation[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/approval-delegations');
      return raw.map(normalizeApprovalDelegation);
    }
    const user = authService.getCurrentUser();
    const delegations = DataStorage.get<ApprovalDelegation[]>(STORAGE_KEYS.APPROVAL_DELEGATIONS, []);
    if (!user || ['Admin', 'HR'].includes(user.role)) return delegations;
    return delegations.filter(delegation => delegation.delegatorId === user.id || delegation.delegateId === user.id);
  },
  saveDelegation: async (delegation: ApprovalDelegation): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/approval-delegations', {
        id: delegation.id,
        delegator_id: delegation.delegatorId,
        delegate_id: delegation.delegateId,
        role: delegation.role,
        start_date: delegation.startDate,
        end_date: delegation.endDate,
        status: delegation.status,
        reason: delegation.reason || null,
      });
      return;
    }
    const user = authService.getCurrentUser();
    if (delegation.endDate < delegation.startDate) throw new Error('Delegation end date must be on or after start date.');
    if (delegation.delegatorId === delegation.delegateId) throw new Error('Delegator and delegate must be different employees.');
    if (user && !['Admin', 'HR'].includes(user.role) && delegation.delegatorId !== user.id) {
      throw new Error('Users can create delegations only for themselves.');
    }
    const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const delegator = employees.find(employee => employee.id === delegation.delegatorId);
    const delegate = employees.find(employee => employee.id === delegation.delegateId);
    if (!delegator || !delegate || delegator.status === 'Exited' || delegate.status === 'Exited') {
      throw new Error('Delegation requires active delegator and delegate employees.');
    }
    const list = DataStorage.get<ApprovalDelegation[]>(STORAGE_KEYS.APPROVAL_DELEGATIONS, []);
    const overlapping = list.some(item =>
      item.id !== delegation.id &&
      item.delegatorId === delegation.delegatorId &&
      item.delegateId === delegation.delegateId &&
      item.status === 'Active' &&
      delegation.status === 'Active' &&
      item.startDate <= delegation.endDate &&
      item.endDate >= delegation.startDate
    );
    if (overlapping) throw new Error('An active approval delegation already overlaps this date range.');
    const idx = list.findIndex(item => item.id === delegation.id);
    const next = { ...delegation, id: delegation.id || crypto.randomUUID() };
    const previous = idx >= 0 ? list[idx] : undefined;
    if (idx >= 0) list[idx] = next; else list.push(next);
    DataStorage.set(STORAGE_KEYS.APPROVAL_DELEGATIONS, list);
    const u = actor();
    DataStorage.logAction(u.id, u.name, u.role, idx >= 0 ? 'Update Approval Delegation' : 'Create Approval Delegation', 'Approvals', `${idx >= 0 ? 'Updated' : 'Created'} approval delegation ${next.id}`, { entityType: 'ApprovalDelegation', entityId: next.id, oldValue: previous, newValue: next, reason: next.reason });
  },
  getSlaReport: async (): Promise<ApprovalSlaReport> => {
    if (await checkBackend()) {
      return normalizeApprovalSlaReport(await api.get<Record<string, unknown>>('/api/reports/approval-sla'));
    }
    const rows = getLocalApprovalRecords();
    const now = Date.now();
    const pending = rows.filter(row => row.status === 'Pending');
    const ages = pending.map(row => Math.max(0, (now - new Date(row.createdAt).getTime()) / 36e5));
    return {
      generatedAt: new Date().toISOString(),
      pendingCount: pending.length,
      overdueCount: pending.filter(row => row.dueAt && new Date(row.dueAt).getTime() < now).length,
      averageAgeHours: ages.length ? Number((ages.reduce((sum, age) => sum + age, 0) / ages.length).toFixed(1)) : 0,
      rows,
    };
  },
};

export const notificationService = {
  getAll: async (): Promise<NotificationEvent[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/notifications');
      return raw.map(normalizeNotificationEvent);
    }
    return DataStorage.get<NotificationEvent[]>(STORAGE_KEYS.NOTIFICATION_EVENTS, []);
  },
  markRead: async (id: string): Promise<void> => {
    if (await checkBackend()) {
      await api.patch(`/api/notifications/${id}/read`, {});
      return;
    }
    const list = DataStorage.get<NotificationEvent[]>(STORAGE_KEYS.NOTIFICATION_EVENTS, []);
    DataStorage.set(STORAGE_KEYS.NOTIFICATION_EVENTS, list.map(item => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
  },
  getTemplates: async (): Promise<NotificationTemplate[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/notification-templates');
      return raw.map(normalizeNotificationTemplate);
    }
    return DataStorage.get<NotificationTemplate[]>(STORAGE_KEYS.NOTIFICATION_TEMPLATES, []);
  },
  saveTemplate: async (template: NotificationTemplate): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/notification-templates', {
        id: template.id,
        event_type: template.eventType,
        channel: template.channel,
        subject: template.subject,
        body: template.body,
        active: template.active,
      });
      return;
    }
    const list = DataStorage.get<NotificationTemplate[]>(STORAGE_KEYS.NOTIFICATION_TEMPLATES, []);
    const idx = list.findIndex(item => item.id === template.id);
    if (idx >= 0) list[idx] = template; else list.push({ ...template, id: template.id || crypto.randomUUID() });
    DataStorage.set(STORAGE_KEYS.NOTIFICATION_TEMPLATES, list);
  },
  getPreferences: async (): Promise<NotificationPreference[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/notification-preferences');
      return raw.map(normalizeNotificationPreference);
    }
    return DataStorage.get<NotificationPreference[]>(STORAGE_KEYS.NOTIFICATION_PREFERENCES, []);
  },
  savePreference: async (preference: NotificationPreference): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/notification-preferences', {
        id: preference.id,
        employee_id: preference.employeeId,
        event_type: preference.eventType,
        in_app: preference.inApp,
        email: preference.email,
        teams: preference.teams,
      });
      return;
    }
    const list = DataStorage.get<NotificationPreference[]>(STORAGE_KEYS.NOTIFICATION_PREFERENCES, []);
    const idx = list.findIndex(item => item.id === preference.id);
    if (idx >= 0) list[idx] = preference; else list.push({ ...preference, id: preference.id || crypto.randomUUID() });
    DataStorage.set(STORAGE_KEYS.NOTIFICATION_PREFERENCES, list);
  },
  getDeliveryAttempts: async (): Promise<NotificationDeliveryAttempt[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/notification-delivery-attempts');
      return raw.map(normalizeNotificationDeliveryAttempt);
    }
    return DataStorage.get<NotificationDeliveryAttempt[]>(STORAGE_KEYS.NOTIFICATION_DELIVERY_ATTEMPTS, []);
  },
  sendTestDelivery: async (employeeId: string, channels: Array<'InApp' | 'Email' | 'Teams'>): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/notifications/test-delivery', {
        employee_id: employeeId,
        channels,
        title: `${productConfig.productName} notification test`,
        body: `This validates configured notification delivery from ${productConfig.productName}.`,
      });
      return;
    }
    const now = new Date().toISOString();
    const event: NotificationEvent = {
      id: crypto.randomUUID(),
      recipientEmployeeId: employeeId,
      eventType: 'TestDelivery',
      title: `${productConfig.productName} notification test`,
      body: `This validates configured notification delivery from ${productConfig.productName}.`,
      entityType: 'NotificationTest',
      entityId: employeeId,
      severity: 'Info',
      createdAt: now,
    };
    const attempts = channels.map(channel => ({
      id: crypto.randomUUID(),
      notificationId: event.id,
      channel,
      provider: channel === 'InApp' ? 'internal' : 'mock',
      status: 'Delivered',
      responseMetadata: { mode: channel === 'InApp' ? 'internal' : 'mock', deterministic: true },
      attemptedAt: now,
    }));
    DataStorage.set(STORAGE_KEYS.NOTIFICATION_EVENTS, [event, ...DataStorage.get<NotificationEvent[]>(STORAGE_KEYS.NOTIFICATION_EVENTS, [])]);
    DataStorage.set(STORAGE_KEYS.NOTIFICATION_DELIVERY_ATTEMPTS, [...attempts, ...DataStorage.get<NotificationDeliveryAttempt[]>(STORAGE_KEYS.NOTIFICATION_DELIVERY_ATTEMPTS, [])]);
  },
};

export interface IdentityProviderAdapter {
  provider: string;
  linkIdentity(link: IdentityProviderLink): Promise<IdentityProviderLink>;
}

export interface NotificationProviderAdapter {
  provider: string;
  send(event: NotificationEvent): Promise<IntegrationEventLog>;
}

export interface TeamsActionAdapter {
  provider: string;
  createActionToken(token: Omit<TeamsActionToken, 'id' | 'token' | 'createdAt'>): Promise<TeamsActionToken>;
  executeActionToken(token: string, comments?: string): Promise<TeamsActionToken>;
}

const getLocalIntegrationLogs = () => DataStorage.get<IntegrationEventLog[]>(STORAGE_KEYS.INTEGRATION_EVENT_LOGS, []);

const writeLocalIntegrationLog = (log: Omit<IntegrationEventLog, 'id' | 'createdAt'>) => {
  const next: IntegrationEventLog = {
    ...log,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  DataStorage.set(STORAGE_KEYS.INTEGRATION_EVENT_LOGS, [next, ...getLocalIntegrationLogs()].slice(0, 300));
  const u = actor();
  DataStorage.logAction(u.id, u.name, u.role, log.eventType, 'Integrations', `${log.provider} ${log.eventType}`, {
    entityType: log.entityType,
    entityId: log.entityId,
    newValue: log.responsePayload,
    source: log.provider === 'teams' ? 'Teams' : 'System',
  });
  return next;
};

const getLocalIntegrationHealth = (): IntegrationHealthReport => {
  const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
  const identityLinks = DataStorage.get<IdentityProviderLink[]>(STORAGE_KEYS.INTEGRATION_IDENTITY_LINKS, []);
  const roleMappings = DataStorage.get<EntraRoleMapping[]>(STORAGE_KEYS.INTEGRATION_ENTRA_ROLE_MAPPINGS, []);
  const teamsLinks = DataStorage.get<TeamsUserLink[]>(STORAGE_KEYS.INTEGRATION_TEAMS_USER_LINKS, []);
  const tokens = DataStorage.get<TeamsActionToken[]>(STORAGE_KEYS.INTEGRATION_TEAMS_ACTION_TOKENS, []);
  const events = getLocalIntegrationLogs();
  const activeEmployees = employees.filter(employee => employee.status === 'Active');
  const linkedIdentityEmployeeIds = new Set(identityLinks.filter(link => link.status === 'Linked').map(link => link.employeeId));
  const linkedTeamsEmployeeIds = new Set(teamsLinks.filter(link => link.status === 'Linked').map(link => link.employeeId));
  const now = new Date().toISOString();
  return {
    generatedAt: now,
    identityProvider: 'local',
    teamsProvider: 'mock',
    emailProvider: 'mock',
    linkedIdentityCount: linkedIdentityEmployeeIds.size,
    linkedTeamsCount: linkedTeamsEmployeeIds.size,
    activeRoleMappings: roleMappings.filter(mapping => mapping.active).length,
    openActionTokens: tokens.filter(token => !token.usedAt && token.expiresAt > now).length,
    recentFailures: events.filter(event => event.status === 'Failed').length,
    missingIdentityLinks: activeEmployees.filter(employee => !linkedIdentityEmployeeIds.has(employee.id)).length,
    missingTeamsLinks: activeEmployees.filter(employee => !linkedTeamsEmployeeIds.has(employee.id)).length,
    graphCredentialReady: false,
    emailCredentialReady: true,
    teamsCredentialReady: true,
    teamsActivityType: 'systemDefault',
    credentialChecks: [
      { area: 'Core', key: 'APP_URL', label: 'Application URL', configured: true },
      { area: 'Identity', key: 'IDENTITY_PROVIDER', label: 'Identity provider mode', configured: true },
      { area: 'Email', key: 'EMAIL_PROVIDER', label: 'Email provider mode', configured: true },
      { area: 'Teams', key: 'TEAMS_PROVIDER', label: 'Teams provider mode', configured: true },
    ],
    events: events.slice(0, 25),
  };
};

export const integrationService = {
  getIdentityLinks: async (): Promise<IdentityProviderLink[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/integrations/identity-links');
      return raw.map(normalizeIdentityProviderLink);
    }
    return DataStorage.get<IdentityProviderLink[]>(STORAGE_KEYS.INTEGRATION_IDENTITY_LINKS, []);
  },
  saveIdentityLink: async (link: IdentityProviderLink): Promise<IdentityProviderLink> => {
    if (await checkBackend()) {
      return normalizeIdentityProviderLink(await api.post<Record<string, unknown>>('/api/integrations/identity-links', {
        id: link.id,
        employee_id: link.employeeId,
        provider: link.provider,
        provider_subject: link.providerSubject,
        provider_upn: link.providerUpn || null,
        status: link.status,
      }));
    }
    const links = DataStorage.get<IdentityProviderLink[]>(STORAGE_KEYS.INTEGRATION_IDENTITY_LINKS, []);
    const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const employee = employees.find(item => item.id === link.employeeId);
    const next = {
      ...link,
      id: link.id || crypto.randomUUID(),
      employeeName: employee?.name || link.employeeName,
      linkedAt: link.linkedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    DataStorage.set(STORAGE_KEYS.INTEGRATION_IDENTITY_LINKS, [next, ...links.filter(item => item.id !== next.id && item.employeeId !== next.employeeId)]);
    DataStorage.set(STORAGE_KEYS.EMPLOYEES, employees.map(item => item.id === next.employeeId ? { ...item, entraObjectId: next.providerSubject } : item));
    writeLocalIntegrationLog({
      provider: next.provider,
      eventType: 'IdentityLinkUpserted',
      entityType: 'IdentityProviderLink',
      entityId: next.id,
      status: 'Success',
      responsePayload: { employeeId: next.employeeId, providerSubject: next.providerSubject },
    });
    return next;
  },
  getEntraRoleMappings: async (): Promise<EntraRoleMapping[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/integrations/entra-role-mappings');
      return raw.map(normalizeEntraRoleMapping);
    }
    return DataStorage.get<EntraRoleMapping[]>(STORAGE_KEYS.INTEGRATION_ENTRA_ROLE_MAPPINGS, []);
  },
  saveEntraRoleMapping: async (mapping: EntraRoleMapping): Promise<EntraRoleMapping> => {
    if (await checkBackend()) {
      return normalizeEntraRoleMapping(await api.post<Record<string, unknown>>('/api/integrations/entra-role-mappings', {
        id: mapping.id,
        group_id: mapping.groupId,
        group_name: mapping.groupName,
        role_name: mapping.roleName,
        active: mapping.active,
      }));
    }
    const mappings = DataStorage.get<EntraRoleMapping[]>(STORAGE_KEYS.INTEGRATION_ENTRA_ROLE_MAPPINGS, []);
    const next = { ...mapping, id: mapping.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
    DataStorage.set(STORAGE_KEYS.INTEGRATION_ENTRA_ROLE_MAPPINGS, [next, ...mappings.filter(item => item.id !== next.id && item.groupId !== next.groupId)]);
    writeLocalIntegrationLog({
      provider: 'entra',
      eventType: 'RoleMappingUpserted',
      entityType: 'EntraRoleMapping',
      entityId: next.id,
      status: 'Success',
      responsePayload: { roleName: next.roleName, groupName: next.groupName },
    });
    return next;
  },
  getTeamsUserLinks: async (): Promise<TeamsUserLink[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/integrations/teams-user-links');
      return raw.map(normalizeTeamsUserLink);
    }
    return DataStorage.get<TeamsUserLink[]>(STORAGE_KEYS.INTEGRATION_TEAMS_USER_LINKS, []);
  },
  saveTeamsUserLink: async (link: TeamsUserLink): Promise<TeamsUserLink> => {
    if (await checkBackend()) {
      return normalizeTeamsUserLink(await api.post<Record<string, unknown>>('/api/integrations/teams-user-links', {
        id: link.id,
        employee_id: link.employeeId,
        teams_user_id: link.teamsUserId,
        teams_upn: link.teamsUpn || null,
        teams_tenant_id: link.teamsTenantId || null,
        status: link.status,
      }));
    }
    const links = DataStorage.get<TeamsUserLink[]>(STORAGE_KEYS.INTEGRATION_TEAMS_USER_LINKS, []);
    const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const employee = employees.find(item => item.id === link.employeeId);
    const next = {
      ...link,
      id: link.id || crypto.randomUUID(),
      employeeName: employee?.name || link.employeeName,
      linkedAt: link.linkedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    DataStorage.set(STORAGE_KEYS.INTEGRATION_TEAMS_USER_LINKS, [next, ...links.filter(item => item.id !== next.id && item.employeeId !== next.employeeId)]);
    DataStorage.set(STORAGE_KEYS.EMPLOYEES, employees.map(item => item.id === next.employeeId ? { ...item, teamsUserId: next.teamsUserId } : item));
    writeLocalIntegrationLog({
      provider: 'teams',
      eventType: 'TeamsUserLinkUpserted',
      entityType: 'TeamsUserLink',
      entityId: next.id,
      status: 'Success',
      responsePayload: { employeeId: next.employeeId, teamsUserId: next.teamsUserId },
    });
    return next;
  },
  createTeamsActionToken: async (token: Omit<TeamsActionToken, 'id' | 'token' | 'createdAt'>): Promise<TeamsActionToken> => {
    if (await checkBackend()) {
      return normalizeTeamsActionToken(await api.post<Record<string, unknown>>('/api/integrations/teams-action-tokens', {
        entity_type: token.entityType,
        entity_id: token.entityId,
        action: token.action,
        target_url: token.targetUrl || null,
        expires_at: token.expiresAt,
      }));
    }
    const u = actor();
    const next: TeamsActionToken = {
      ...token,
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      createdBy: u.id,
      createdAt: new Date().toISOString(),
    };
    const appOrigin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
    next.actionUrl = `${appOrigin}/teams/actions/${encodeURIComponent(next.token)}`;
    const tokens = DataStorage.get<TeamsActionToken[]>(STORAGE_KEYS.INTEGRATION_TEAMS_ACTION_TOKENS, []);
    DataStorage.set(STORAGE_KEYS.INTEGRATION_TEAMS_ACTION_TOKENS, [next, ...tokens]);
    writeLocalIntegrationLog({
      provider: 'teams',
      eventType: 'TeamsActionTokenCreated',
      entityType: token.entityType,
      entityId: token.entityId,
      status: 'Success',
      responsePayload: { action: token.action, deterministic: true },
    });
    return next;
  },
  executeTeamsActionToken: async (token: string, comments?: string): Promise<TeamsActionToken> => {
    if (await checkBackend()) {
      return normalizeTeamsActionToken(await api.post<Record<string, unknown>>(`/api/integrations/teams-action-tokens/${encodeURIComponent(token)}/execute`, { comments }));
    }
    const tokens = DataStorage.get<TeamsActionToken[]>(STORAGE_KEYS.INTEGRATION_TEAMS_ACTION_TOKENS, []);
    const existing = tokens.find(item => item.token === token);
    if (!existing) throw new Error('Teams action token was not found.');
    if (existing.usedAt) throw new Error('Teams action token has already been used.');
    if (existing.expiresAt < new Date().toISOString()) throw new Error('Teams action token has expired.');
    if (existing.entityType === 'ApprovalRecord' && (existing.action === 'approve' || existing.action === 'reject')) {
      await approvalService.decide(existing.entityId, existing.action === 'approve' ? 'Approved' : 'Rejected', comments || 'Decided from deterministic Teams action.');
    }
    const next = { ...existing, usedAt: new Date().toISOString() };
    DataStorage.set(STORAGE_KEYS.INTEGRATION_TEAMS_ACTION_TOKENS, tokens.map(item => item.id === next.id ? next : item));
    writeLocalIntegrationLog({
      provider: 'teams',
      eventType: 'TeamsActionTokenExecuted',
      entityType: existing.entityType,
      entityId: existing.entityId,
      status: 'Success',
      requestPayload: { action: existing.action },
      responsePayload: { deterministic: true, usedAt: next.usedAt },
    });
    return next;
  },
  sendTeamsActionNotification: async (token: string, recipientEmployeeId: string, title: string, body: string): Promise<TeamsActionToken> => {
    if (await checkBackend()) {
      return normalizeTeamsActionToken(await api.post<Record<string, unknown>>(`/api/integrations/teams-action-tokens/${encodeURIComponent(token)}/send`, {
        recipient_employee_id: recipientEmployeeId,
        title,
        body,
      }));
    }
    const tokens = DataStorage.get<TeamsActionToken[]>(STORAGE_KEYS.INTEGRATION_TEAMS_ACTION_TOKENS, []);
    const existing = tokens.find(item => item.token === token);
    if (!existing) throw new Error('Teams action token was not found.');
    const appOrigin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
    const actionUrl = `${appOrigin}/teams/actions/${encodeURIComponent(token)}`;
    const notificationEvent: NotificationEvent = {
      id: crypto.randomUUID(),
      recipientEmployeeId,
      eventType: 'TeamsAction',
      title,
      body: `${body}\n\nAction link: ${actionUrl}`,
      entityType: existing.entityType,
      entityId: existing.entityId,
      severity: 'Info',
      createdAt: new Date().toISOString(),
    };
    const attempt: NotificationDeliveryAttempt = {
      id: crypto.randomUUID(),
      notificationId: notificationEvent.id,
      channel: 'Teams',
      provider: 'mock',
      status: 'Delivered',
      responseMetadata: { mode: 'mock', actionUrl, deterministic: true },
      attemptedAt: new Date().toISOString(),
    };
    DataStorage.set(STORAGE_KEYS.NOTIFICATION_EVENTS, [notificationEvent, ...DataStorage.get<NotificationEvent[]>(STORAGE_KEYS.NOTIFICATION_EVENTS, [])]);
    DataStorage.set(STORAGE_KEYS.NOTIFICATION_DELIVERY_ATTEMPTS, [attempt, ...DataStorage.get<NotificationDeliveryAttempt[]>(STORAGE_KEYS.NOTIFICATION_DELIVERY_ATTEMPTS, [])]);
    writeLocalIntegrationLog({
      provider: 'teams',
      eventType: 'TeamsActionNotificationSent',
      entityType: existing.entityType,
      entityId: existing.entityId,
      status: 'Success',
      responsePayload: { action: existing.action, actionUrl, notificationId: notificationEvent.id },
    });
    return { ...existing, actionUrl, notificationId: notificationEvent.id };
  },
  getIntegrationEvents: async (): Promise<IntegrationEventLog[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/integrations/events');
      return raw.map(normalizeIntegrationEventLog);
    }
    return getLocalIntegrationLogs();
  },
  getHealth: async (): Promise<IntegrationHealthReport> => {
    if (await checkBackend()) {
      return normalizeIntegrationHealthReport(await api.get<Record<string, unknown>>('/api/integrations/health'));
    }
    return getLocalIntegrationHealth();
  },
};

const normalizeOrganizationProfileDate = (value: unknown) => {
  const text = String(value);
  // The profile API returns PostgreSQL DATE as text. Retain only unambiguous
  // legacy UTC-midnight compatibility, never truncate a timezone-shifted date.
  if (/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(text)) return text.slice(0, 10);
  throw new ApiClientError('Organization profile effective date is invalid.', {status: 502});
};
const normalizeOrganizationProfile = (row: Record<string, unknown>): OrganizationProfile => ({
  organizationId:String(row.organization_id), code:String(row.organization_code), name:String(row.organization_name),
  legalName:String(row.legal_name), productDisplayName:String(row.product_display_name), supportContact:String(row.support_contact),
  defaultLocale:String(row.default_locale), defaultTimeZone:String(row.default_time_zone), baseCurrency:String(row.base_currency),
  fiscalYearStart:String(row.fiscal_year_start), defaultWeekStart:Number(row.default_week_start), effectiveFrom:normalizeOrganizationProfileDate(row.profile_effective_from),
});
const normalizeLegalEntityProfile = (row: Record<string, unknown>): LegalEntityProfile => ({
  id:String(row.id), organizationId:String(row.organization_id), code:String(row.code), legalName:String(row.legal_name),
  registrationIdentifier:row.registration_identifier as string|null|undefined, taxIdentifier:row.tax_identifier as string|null|undefined,
  reportingCurrency:String(row.reporting_currency), address:row.address as LegalEntityProfile['address'], status:row.status as LegalEntityProfile['status'],
  effectiveFrom:String(row.profile_effective_from), entityEffectiveFrom:String(row.effective_from), effectiveTo:row.effective_to as string|null|undefined,
});

export const adminService = {
  getTerminologyConfiguration: async (context: OrganizationProfileContext | null = captureOrganizationProfileContext()): Promise<TerminologyConfiguration> => {
    const captured = assertOrganizationProfileContext(context);
    const connected = await checkBackend();
    assertOrganizationProfileContext(captured);
    if (!connected) throw new ApiClientError('Terminology configuration requires the server.', {status: 503});
    return normalizeTerminologyConfiguration(await api.getWithScope<Record<string, unknown>>('/api/organization-setup/terminology', captured.scope));
  },
  saveTerminologyConfiguration: async (configuration: TerminologyConfiguration, context: OrganizationProfileContext | null = captureOrganizationProfileContext()): Promise<TerminologyConfiguration> => {
    const captured = assertOrganizationProfileContext(context);
    const terms = Object.fromEntries(TERMINOLOGY_KEYS.map(key => {
      const {singular, plural, helpText} = configuration.terms[key];
      return [key, {singular, plural, helpText}];
    }));
    const saved = normalizeTerminologyConfiguration(await api.postTerminologyWithScope<Record<string, unknown>>({terms, effectiveFrom: configuration.effectiveFrom}, captured.scope));
    if (isOrganizationProfileContextCurrent(captured)) {
      rememberTerminologySave(captured, saved);
      window.dispatchEvent(new Event('workos:organization-scope-changed'));
    }
    return saved;
  },
  getOrganizationProfile: async (context: OrganizationProfileContext | null = captureOrganizationProfileContext()): Promise<OrganizationProfile> => {
    const captured = assertOrganizationProfileContext(context);
    const connected = await checkBackend();
    assertOrganizationProfileContext(captured);
    if (!connected) throw new ApiClientError('Organization profile requires the server.', {status: 503});
    return normalizeOrganizationProfile(await api.getWithScope<Record<string, unknown>>('/api/organization-setup/profile', captured.scope));
  },
  updateOrganizationProfile: async (profile: OrganizationProfile, context: OrganizationProfileContext | null = captureOrganizationProfileContext()): Promise<OrganizationProfile> => {
    const captured = assertOrganizationProfileContext(context);
    if (profile.organizationId !== captured.scope.organizationId) {
      throw new ApiClientError('Organization profile does not match the selected scope.', {status: 403});
    }
    // Only ordinary metadata is writable. Code and any extra caller fields are
    // deliberately omitted; organization identity must match the captured scope.
    const {name, legalName, productDisplayName, supportContact, defaultLocale, defaultTimeZone,
      baseCurrency, fiscalYearStart, defaultWeekStart, effectiveFrom} = profile;
    return normalizeOrganizationProfile(await api.putWithScope<Record<string, unknown>>('/api/organization-setup/profile', {
      organizationId: captured.scope.organizationId, name, legalName, productDisplayName, supportContact,
      defaultLocale, defaultTimeZone, baseCurrency, fiscalYearStart, defaultWeekStart, effectiveFrom,
    }, captured.scope));
  },
  getOrganizationSetupReadinessForProfile: async (context: OrganizationProfileContext | null = captureOrganizationProfileContext()): Promise<OrganizationSetupReadiness> => {
    const captured = assertOrganizationProfileContext(context);
    const connected = await checkBackend();
    assertOrganizationProfileContext(captured);
    if (!connected) throw new ApiClientError('Organization readiness requires the server.', {status: 503});
    return api.getWithScope<OrganizationSetupReadiness>('/api/organization-setup/readiness', captured.scope);
  },
  getLegalEntities: async (): Promise<LegalEntityProfile[]> => {
    if (!(await checkBackend())) return [];
    return (await api.get<Record<string, unknown>[]>('/api/organization-setup/legal-entities')).map(normalizeLegalEntityProfile);
  },
  createLegalEntity: async (profile: Omit<LegalEntityProfile, 'id'|'organizationId'|'entityEffectiveFrom'>): Promise<LegalEntityProfile> =>
    normalizeLegalEntityProfile(await api.post<Record<string, unknown>>('/api/organization-setup/legal-entities', profile)),
  updateLegalEntity: async (profile: LegalEntityProfile): Promise<LegalEntityProfile> =>
    normalizeLegalEntityProfile(await api.put<Record<string, unknown>>(`/api/organization-setup/legal-entities/${profile.id}`, profile)),
  getOrganizationSetupReadiness: async (): Promise<OrganizationSetupReadiness | null> => {
    if (!(await checkBackend())) return null;
    return api.get<OrganizationSetupReadiness>('/api/organization-setup/readiness');
  },
  // Strict presentation reader: keep legacy Dashboard/report-export fallback semantics separate.
  getScopedAuditHistory: async (): Promise<AuditLog[]> => {
    if (!canFetchScopedAuditHistory(authService.getCurrentUser(), Boolean(getOrganizationScope()), isDemoFallbackAllowed())) {
      throw new ApiClientError('Selected-scope audit access is required.', {status: 403});
    }
    // Production reads always reach the authoritative API; retry is not trapped by a cached health failure.
    if (!isDemoFallbackAllowed() || await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/audit-logs');
      return raw.map(normalizeAuditLog);
    }
    // Local evidence is permitted only in explicitly configured test/demo mode.
    return DataStorage.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
  },
  getAuditLogs: async (): Promise<AuditLog[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.view')) {
      return [];
    }
    if (await checkBackend()) {
      try {
        const raw = await api.get<Record<string, unknown>[]>('/api/audit-logs');
        return raw.map(normalizeAuditLog);
      } catch (error) {
        return [];
      }
    }
    return DataStorage.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
  },
  getDeploymentAuditLogsForHistory: async (): Promise<AuditLog[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.deployment.view')) {
      throw new ApiClientError('Deployment audit access is required.', {status: 403});
    }
    return (await api.get<Record<string, unknown>[]>('/api/deployment-audit-logs')).map(normalizeAuditLog);
  },
  getDeploymentIntegrationEventsForHistory: async (): Promise<IntegrationEventLog[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.deployment.view')) {
      throw new ApiClientError('Deployment audit access is required.', {status: 403});
    }
    return (await api.get<Record<string, unknown>[]>('/api/v1/deployment-integration-events')).map(normalizeIntegrationEventLog);
  },
  getDeploymentAuditLogs: async (): Promise<AuditLog[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.deployment.view')) return [];
    if (!(await checkBackend())) return [];
    try {
      const raw = await api.get<Record<string, unknown>[]>('/api/deployment-audit-logs');
      return raw.map(normalizeAuditLog);
    } catch {
      return [];
    }
  },
  getDeploymentIntegrationEvents: async (): Promise<IntegrationEventLog[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.deployment.view')) return [];
    if (!(await checkBackend())) return [];
    try {
      const raw = await api.get<Record<string, unknown>[]>('/api/v1/deployment-integration-events');
      return raw.map(normalizeIntegrationEventLog);
    } catch {
      return [];
    }
  },
  getOrganizationAuditScopesForHistory: async (): Promise<OrganizationAuditScope[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.organization.view')) {
      throw new ApiClientError('Organization audit access is required.', {status: 403});
    }
    const rows = await api.get<Record<string, unknown>[]>('/api/organization-audit-scopes');
    return rows.map(row => ({organizationId: String(row.organization_id), organizationCode: String(row.organization_code),
      organizationName: String(row.organization_name), status: String(row.status)}));
  },
  getOrganizationAuditLogsForHistory: async (organizationId: string): Promise<AuditLog[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.organization.view')) {
      throw new ApiClientError('Organization audit access is required.', {status: 403});
    }
    if (typeof organizationId !== 'string' || !organizationId.trim()) {
      throw new ApiClientError('An authorized organization must be selected.', {status: 400});
    }
    const rows = await api.get<Record<string, unknown>[]>(`/api/organization-audit-logs?organizationId=${encodeURIComponent(organizationId)}`);
    return rows.map(normalizeAuditLog);
  },
  getOrganizationAuditScopes: async (): Promise<OrganizationAuditScope[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.organization.view')) return [];
    if (!(await checkBackend())) return [];
    try {
      const rows = await api.get<Record<string, unknown>[]>('/api/organization-audit-scopes');
      return rows.map(row => ({
        organizationId: String(row.organization_id),
        organizationCode: String(row.organization_code),
        organizationName: String(row.organization_name),
        status: String(row.status),
      }));
    } catch {
      return [];
    }
  },
  getOrganizationAuditLogs: async (organizationId: string): Promise<AuditLog[]> => {
    if (!hasPermission(authService.getCurrentUser(), 'audit.organization.view')) return [];
    if (!(await checkBackend())) return [];
    try {
      const raw = await api.get<Record<string, unknown>[]>(`/api/organization-audit-logs?organizationId=${encodeURIComponent(organizationId)}`);
      return raw.map(normalizeAuditLog);
    } catch {
      return [];
    }
  },
  getImportExportLogs: async (): Promise<ImportExportLog[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/import-export-logs');
      return raw.map(normalizeImportExportLog);
    }
    return DataStorage.get<ImportExportLog[]>(STORAGE_KEYS.IMPORT_EXPORT_LOGS, []);
  },
  saveImportExportLog: async (log: Omit<ImportExportLog, 'id' | 'timestamp' | 'userName'> & Partial<Pick<ImportExportLog, 'id' | 'timestamp' | 'userName'>>, expectedScope: OrganizationScope | null, requireAuditConfirmation = false): Promise<ImportExportLog> => {
    const backendAvailable = await checkBackend();
    assertExpectedImportScope(expectedScope);
    if (backendAvailable) {
      const raw = await api.postWithScope<Record<string, unknown>>('/api/import-export-logs', {
        operation: log.operation,
        channel: log.channel,
        fileName: log.fileName,
        status: log.status,
        totalRows: log.totalRows,
        validRows: log.validRows,
        errorRows: log.errorRows,
        errors: log.errors,
      }, expectedScope);
      // Both writes remain bound to the operation's captured organization/entity even
      // if the UI switches scopes while the first request is in flight.
      const auditWrite = api.postWithScope('/api/audit-events', {
        action: log.operation,
        module: 'Import / Export',
        details: `${log.operation} ${log.fileName} through ${log.channel} with ${log.totalRows} row${log.totalRows === 1 ? '' : 's'} (${log.status})`,
        entityType: 'ImportExportLog',
        entityId: String(raw.id || log.fileName),
        newValue: {
          channel: log.channel,
          fileName: log.fileName,
          status: log.status,
          totalRows: log.totalRows,
          validRows: log.validRows,
          errorRows: log.errorRows,
        },
      }, expectedScope);
      if (requireAuditConfirmation) await auditWrite;
      else await auditWrite.catch(() => {});
      return normalizeImportExportLog(raw);
    }
    if (requireAuditConfirmation) throw new Error('Export history and audit require an available backend.');
    const u = actor();
    const nextLog: ImportExportLog = {
      ...log,
      id: log.id || crypto.randomUUID(),
      timestamp: log.timestamp || new Date().toISOString(),
      userName: log.userName || u.name,
    };
    const logs = DataStorage.get<ImportExportLog[]>(STORAGE_KEYS.IMPORT_EXPORT_LOGS, []);
    DataStorage.set(STORAGE_KEYS.IMPORT_EXPORT_LOGS, [nextLog, ...logs].slice(0, 100));
    return nextLog;
  },
  applyEmployeeImport: async (fileName: string, rows: CsvImportRow[], idempotencyKey: string, clientErrors: ImportApplyError[] = [], totalRows = rows.length, expectedScope?: OrganizationScope | null): Promise<ImportApplyResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.postWithHeaders<Record<string, unknown>>('/api/v1/imports/employees/apply', {
      schemaVersion: 'employee-master/1',
      fileName,
      rows,
      totalRows,
      clientErrors,
    }, {'Idempotency-Key': idempotencyKey});
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? rows.length),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      replayed: raw.replayed === true,
      log: raw.log && typeof raw.log === 'object' ? normalizeImportExportLog(raw.log as Record<string, unknown>) : undefined,
    };
  },
  runVersionedEmployeeImport: async (request: {
    rows: CsvImportRow[];
    clientErrors?: ImportApplyError[];
    totalRows: number;
    idempotencyKey: string;
  }, expectedScope?: OrganizationScope | null): Promise<VersionedImportResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const rows = request.rows.map(row => {
      // CSVs can contain arbitrary extra headers, including credential columns.
      // Build the preview payload from the canonical nonsecret schema before fetch.
      const safeRow = employeePreviewRowFields.reduce<CsvImportRow>((result, field) => {
        if (Object.prototype.hasOwnProperty.call(row, field)) result[field] = row[field];
        return result;
      }, {});
      return {...safeRow, initialPasswordPresent: Boolean(row.initialPassword)};
    });
    const clientErrors = (request.clientErrors || []).map(error => ({
      rowNumber: error.rowNumber,
      ...(error.field ? {field: error.field} : {}),
      message: 'The Employee Master row failed preflight validation.',
    }));
    const raw = await api.postWithHeaders<Record<string, unknown>>('/api/v1/imports/employees/apply', {
      schemaVersion: 'employee-master/1',
      dryRun: true,
      fileName: 'Employee Master import.csv',
      rows,
      totalRows: request.totalRows,
      clientErrors,
    }, {'Idempotency-Key': request.idempotencyKey});
    const log = raw.log && typeof raw.log === 'object' ? raw.log as Record<string, unknown> : undefined;
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? request.totalRows),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      replayed: raw.replayed === true,
      log: log ? normalizeImportExportLog(log) : undefined,
      schemaVersion: typeof log?.schema_version === 'string' ? log.schema_version : '',
      dryRun: log?.dry_run === true,
    };
  },
  applyClientImport: async (fileName: string, rows: CsvImportRow[], clientErrors: ImportApplyError[] = [], totalRows = rows.length, expectedScope?: OrganizationScope | null): Promise<ImportApplyResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.post<Record<string, unknown>>('/api/imports/clients/apply', {
      fileName,
      rows,
      totalRows,
      clientErrors,
    });
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? rows.length),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: raw.log && typeof raw.log === 'object' ? normalizeImportExportLog(raw.log as Record<string, unknown>) : undefined,
    };
  },
  applyProjectImport: async (fileName: string, rows: CsvImportRow[], clientErrors: ImportApplyError[] = [], totalRows = rows.length, expectedScope?: OrganizationScope | null): Promise<ImportApplyResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.post<Record<string, unknown>>('/api/imports/projects/apply', {
      fileName,
      rows,
      totalRows,
      clientErrors,
    });
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? rows.length),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: raw.log && typeof raw.log === 'object' ? normalizeImportExportLog(raw.log as Record<string, unknown>) : undefined,
    };
  },
  runVersionedProjectImport: async (request: {
    fileName: string;
    rows: CsvImportRow[];
    clientErrors?: ImportApplyError[];
    totalRows: number;
    dryRun: boolean;
    idempotencyKey: string;
  }, expectedScope?: OrganizationScope | null): Promise<VersionedImportResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.postWithHeaders<Record<string, unknown>>('/api/v1/imports/projects/apply', {
      schemaVersion: 'project-master/1',
      dryRun: request.dryRun,
      fileName: request.fileName,
      rows: request.rows,
      totalRows: request.totalRows,
      clientErrors: request.clientErrors || [],
    }, {'Idempotency-Key': request.idempotencyKey});
    const log = raw.log && typeof raw.log === 'object' ? raw.log as Record<string, unknown> : undefined;
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? request.totalRows),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: log ? normalizeImportExportLog(log) : undefined,
      schemaVersion: typeof log?.schema_version === 'string' ? log.schema_version : '',
      dryRun: log?.dry_run === true,
    };
  },
  runVersionedClientImport: async (request: {
    fileName: string;
    rows: CsvImportRow[];
    clientErrors?: ImportApplyError[];
    totalRows: number;
    dryRun: boolean;
    idempotencyKey: string;
  }, expectedScope?: OrganizationScope | null): Promise<VersionedImportResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.postWithHeaders<Record<string, unknown>>('/api/v1/imports/clients/apply', {
      schemaVersion: 'client-master/1',
      dryRun: request.dryRun,
      fileName: request.fileName,
      rows: request.rows,
      totalRows: request.totalRows,
      clientErrors: request.clientErrors || [],
    }, {'Idempotency-Key': request.idempotencyKey});
    const log = raw.log && typeof raw.log === 'object' ? raw.log as Record<string, unknown> : undefined;
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? request.totalRows),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: log ? normalizeImportExportLog(log) : undefined,
      schemaVersion: typeof log?.schema_version === 'string' ? log.schema_version : '',
      dryRun: log?.dry_run === true,
    };
  },
  runVersionedAllocationImport: async (request: {
    fileName: string;
    rows: CsvImportRow[];
    clientErrors?: ImportApplyError[];
    totalRows: number;
    dryRun: boolean;
    idempotencyKey: string;
  }, expectedScope?: OrganizationScope | null): Promise<VersionedImportResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.postWithHeaders<Record<string, unknown>>('/api/v1/imports/allocations/apply', {
      schemaVersion: 'allocation-control/1',
      dryRun: request.dryRun,
      fileName: request.fileName,
      rows: request.rows,
      totalRows: request.totalRows,
      clientErrors: request.clientErrors || [],
    }, {'Idempotency-Key': request.idempotencyKey});
    const log = raw.log && typeof raw.log === 'object' ? raw.log as Record<string, unknown> : undefined;
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? request.totalRows),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: log ? normalizeImportExportLog(log) : undefined,
      schemaVersion: typeof log?.schema_version === 'string' ? log.schema_version : '',
      dryRun: log?.dry_run === true,
    };
  },
  runVersionedTimesheetImport: async (request: {
    fileName: string;
    rows: CsvImportRow[];
    clientErrors?: ImportApplyError[];
    totalRows: number;
    dryRun: boolean;
    idempotencyKey: string;
  }, expectedScope?: OrganizationScope | null): Promise<VersionedImportResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.postWithHeaders<Record<string, unknown>>('/api/v1/imports/timesheets/apply', {
      schemaVersion: 'timesheet-import/1',
      dryRun: request.dryRun,
      fileName: request.fileName,
      rows: request.rows,
      totalRows: request.totalRows,
      clientErrors: request.clientErrors || [],
    }, {'Idempotency-Key': request.idempotencyKey});
    const log = raw.log && typeof raw.log === 'object' ? raw.log as Record<string, unknown> : undefined;
    return {
      captureWarnings:normalizeImportOvertimeWarnings(raw.captureWarnings),submissionTiming:normalizeImportSubmissionTiming(raw.submissionTiming),
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? request.totalRows),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: log ? normalizeImportExportLog(log) : undefined,
      schemaVersion: typeof log?.schema_version === 'string' ? log.schema_version : '',
      dryRun: log?.dry_run === true,
    };
  },
  applyAllocationImport: async (fileName: string, rows: CsvImportRow[], clientErrors: ImportApplyError[] = [], totalRows = rows.length, expectedScope?: OrganizationScope | null): Promise<ImportApplyResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.post<Record<string, unknown>>('/api/imports/allocations/apply', {
      fileName,
      rows,
      totalRows,
      clientErrors,
    });
    return {
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? rows.length),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: raw.log && typeof raw.log === 'object' ? normalizeImportExportLog(raw.log as Record<string, unknown>) : undefined,
    };
  },
  applyTimesheetImport: async (fileName: string, rows: CsvImportRow[], clientErrors: ImportApplyError[] = [], totalRows = rows.length, expectedScope?: OrganizationScope | null): Promise<ImportApplyResult | null> => {
    if (!(await checkBackend())) return null;
    assertExpectedImportScope(expectedScope);
    const raw = await api.post<Record<string, unknown>>('/api/imports/timesheets/apply', {
      fileName,
      rows,
      totalRows,
      clientErrors,
    });
    return {
      captureWarnings:normalizeImportOvertimeWarnings(raw.captureWarnings),submissionTiming:normalizeImportSubmissionTiming(raw.submissionTiming),
      status: raw.status as ImportExportLog['status'],
      totalRows: Number(raw.totalRows ?? rows.length),
      validRows: Number(raw.validRows ?? 0),
      errorRows: Number(raw.errorRows ?? 0),
      errors: Array.isArray(raw.errors) ? raw.errors as ImportApplyError[] : [],
      log: raw.log && typeof raw.log === 'object' ? normalizeImportExportLog(raw.log as Record<string, unknown>) : undefined,
    };
  },
  resetUserPassword: async (identifier: string, newPassword?: string): Promise<{ temporaryPassword?: string; mustChangePassword: boolean } | null> => {
    if (await checkBackend()) {
      const raw = await api.post<Record<string, unknown>>(`/api/users/${encodeURIComponent(identifier)}/password-reset`, {
        newPassword,
        mustChangePassword: true,
      });
      return {
        temporaryPassword: raw.temporaryPassword ? String(raw.temporaryPassword) : undefined,
        mustChangePassword: Boolean(raw.mustChangePassword),
      };
    }
    DataStorage.ensureUserAccounts();
    const accounts = DataStorage.get<UserAccount[]>(STORAGE_KEYS.USER_ACCOUNTS, []);
    const lookup = identifier.trim().toLowerCase();
    const index = accounts.findIndex(account =>
      account.id === identifier ||
      account.employeeRecordId === identifier ||
      account.userName.toLowerCase() === lookup ||
      account.employeeId.toLowerCase() === lookup ||
      account.email.toLowerCase() === lookup
    );
    if (index < 0) return null;
    const temporaryPassword = newPassword || generateTemporaryPassword();
    const nextHash = `sha256:${await sha256(temporaryPassword)}`;
    accounts[index] = { ...accounts[index], passwordHash: nextHash, mustChangePassword: true };
    DataStorage.set(STORAGE_KEYS.USER_ACCOUNTS, accounts);
    const u = actor();
    DataStorage.logAction(u.id, u.name, u.role, 'Reset Password', 'Admin', `Reset password for ${accounts[index].displayName}`, { entityType: 'User', entityId: accounts[index].id });
    return { temporaryPassword: newPassword ? undefined : temporaryPassword, mustChangePassword: true };
  },
  getPermissionConfig: async (): Promise<PermissionConfig> => {
    if (await checkBackend()) {
      return normalizePermissionConfig(await api.get<Record<string, unknown>>('/api/permissions/config'));
    }
    requireLocalPermissionManager();
    DataStorage.ensureUserAccounts();
    const rolePermissions = DataStorage.get<RolePermissionSetting[]>(
      STORAGE_KEYS.PERMISSION_ROLE_SETTINGS,
      buildDefaultRolePermissionSettings()
    );
    const accounts = DataStorage.get<UserAccount[]>(STORAGE_KEYS.USER_ACCOUNTS, []);
    return {
      permissions: PERMISSION_DEFINITIONS,
      rolePermissions,
      userGrants: DataStorage.get<UserPermissionGrant[]>(STORAGE_KEYS.PERMISSION_USER_GRANTS, []),
      users: accounts.map(account => ({
        id: account.employeeRecordId,
        employeeRecordId: account.employeeRecordId,
        employeeId: account.employeeId,
        userName: account.userName,
        displayName: account.displayName,
        email: account.email,
        roles: account.roles,
        status: account.status,
      })),
    };
  },
  setRolePermission: async (roleName: RolePermissionSetting['roleName'], permissionKey: PermissionKey, enabled: boolean): Promise<void> => {
    if (await checkBackend()) {
      await api.patch(`/api/permissions/roles/${roleName}`, { permissionKey, enabled });
      return;
    }
    requireLocalPermissionManager();
    const permission = PERMISSION_DEFINITIONS.find(item => item.key === permissionKey);
    if (permissionKey === 'audit.deployment.view' && enabled) {
      throw new Error('Deployment audit access can be granted only to individual users.');
    }
    if (permissionKey === 'audit.organization.view' && enabled) {
      throw new Error('Organization audit access must be designated for a specific organization.');
    }
    if (permission?.protected && roleName !== 'Admin') {
      throw new Error('Protected permissions can be assigned only to Admin.');
    }
    if (permissionKey === 'permissions.manage' && roleName === 'Admin' && !enabled) {
      throw new Error('Admin permission management cannot be disabled.');
    }
    const settings = DataStorage.get<RolePermissionSetting[]>(STORAGE_KEYS.PERMISSION_ROLE_SETTINGS, buildDefaultRolePermissionSettings());
    const next = settings.map(item =>
      item.roleName === roleName && item.permissionKey === permissionKey
        ? { ...item, enabled, updatedAt: new Date().toISOString() }
        : item
    );
    DataStorage.set(STORAGE_KEYS.PERMISSION_ROLE_SETTINGS, next);
    const u = actor();
    DataStorage.logAction(u.id, u.name, u.role, 'Update Role Permission', 'Permissions', `${enabled ? 'Enabled' : 'Disabled'} ${permissionKey} for ${roleName}`, { entityType: 'RolePermission', entityId: `${roleName}:${permissionKey}` });
    if (authService.getCurrentUser()?.role === roleName) {
      await authService.refreshSession();
    }
  },
  grantUserPermission: async (userId: string, permissionKey: PermissionKey): Promise<UserPermissionGrant> => {
    if (await checkBackend()) {
      const raw = await api.post<Record<string, unknown>>('/api/permissions/user-grants', { userId, permissionKey });
      return normalizePermissionConfig({ user_grants: [raw] }).userGrants[0];
    }
    requireLocalPermissionManager();
    const accounts = DataStorage.get<UserAccount[]>(STORAGE_KEYS.USER_ACCOUNTS, []);
    const account = accounts.find(item => item.employeeRecordId === userId || item.id === userId);
    const permission = PERMISSION_DEFINITIONS.find(item => item.key === permissionKey);
    if (!account) throw new Error('User was not found.');
    if (permissionKey === 'audit.deployment.view'
        && (account.status !== 'Active' || account.roles.length === 0
          || authService.getCurrentUser()?.id === account.employeeRecordId)) {
      throw new Error('Deployment audit access requires a different active user with an assigned role.');
    }
    if (permissionKey === 'audit.organization.view') {
      throw new Error('Organization audit access must be designated for a specific organization.');
    }
    if (permission?.protected && permissionKey !== 'audit.deployment.view' && !account.roles.includes('Admin')) {
      throw new Error('Protected permissions can be granted only to Admin users.');
    }
    const grants = DataStorage.get<UserPermissionGrant[]>(STORAGE_KEYS.PERMISSION_USER_GRANTS, []);
    const existing = grants.find(item => item.userId === account.employeeRecordId && item.permissionKey === permissionKey);
    if (existing) return existing;
    const u = actor();
    const grant: UserPermissionGrant = {
      id: crypto.randomUUID(),
      userId: account.employeeRecordId,
      employeeId: account.employeeId,
      userName: account.userName,
      displayName: account.displayName,
      permissionKey,
      grantedBy: u.name,
      createdAt: new Date().toISOString(),
    };
    DataStorage.set(STORAGE_KEYS.PERMISSION_USER_GRANTS, [grant, ...grants]);
    DataStorage.logAction(u.id, u.name, u.role, 'Grant User Permission', 'Permissions', `Granted ${permissionKey} to ${account.displayName}`, { entityType: 'UserPermissionGrant', entityId: grant.id });
    if (authService.getCurrentUser()?.id === account.employeeRecordId) {
      await authService.refreshSession();
    }
    return grant;
  },
  deleteUserPermissionGrant: async (grantId: string): Promise<void> => {
    if (await checkBackend()) {
      await api.delete(`/api/permissions/user-grants/${grantId}`);
      return;
    }
    requireLocalPermissionManager();
    const grants = DataStorage.get<UserPermissionGrant[]>(STORAGE_KEYS.PERMISSION_USER_GRANTS, []);
    const grant = grants.find(item => item.id === grantId);
    DataStorage.set(STORAGE_KEYS.PERMISSION_USER_GRANTS, grants.filter(item => item.id !== grantId));
    if (grant) {
      const u = actor();
      DataStorage.logAction(u.id, u.name, u.role, 'Revoke User Permission', 'Permissions', `Revoked ${grant.permissionKey} from ${grant.displayName || grant.userName || grant.userId}`, { entityType: 'UserPermissionGrant', entityId: grant.id });
      if (authService.getCurrentUser()?.id === grant.userId) {
        await authService.refreshSession();
      }
    }
  },
  getOrganizationAuditGrantConfig: async (): Promise<OrganizationAuditGrantConfig> => {
    const raw = await api.get<Record<string, unknown>>('/api/permissions/organization-audit-grants');
    const eligibleUsers = Array.isArray(raw.eligibleUsers) ? raw.eligibleUsers as Record<string, unknown>[] : [];
    const grants = Array.isArray(raw.grants) ? raw.grants as Record<string, unknown>[] : [];
    return {
      organizationId: String(raw.organizationId || ''),
      eligibleUsers: eligibleUsers.map(row => ({
        id: String(row.id),
        userName: String(row.username || ''),
        employeeId: row.employee_id == null ? null : String(row.employee_id),
        displayName: String(row.display_name || row.username || ''),
        roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
      })),
      grants: grants.map(row => ({
        id: String(row.id),
        organizationId: String(row.organization_id),
        userId: String(row.user_id),
        grantedBy: row.granted_by == null ? null : String(row.granted_by),
        grantedByActiveRole: String(row.granted_by_active_role || ''),
        createdAt: String(row.created_at),
        userName: String(row.username || ''),
        employeeId: row.employee_id == null ? null : String(row.employee_id),
        displayName: String(row.display_name || row.username || ''),
      })),
    };
  },
  grantOrganizationAuditAccess: async (userId: string): Promise<OrganizationAuditGrant> => {
    const row = await api.post<Record<string, unknown>>('/api/permissions/organization-audit-grants', {userId});
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      userId: String(row.user_id),
      grantedBy: row.granted_by == null ? null : String(row.granted_by),
      grantedByActiveRole: String(row.granted_by_active_role || ''),
      createdAt: String(row.created_at),
      userName: '',
      displayName: '',
    };
  },
  revokeOrganizationAuditAccess: async (grantId: string): Promise<void> => {
    await api.delete(`/api/permissions/organization-audit-grants/${encodeURIComponent(grantId)}`);
  },
  getSettings: async (): Promise<SystemSettings> => {
    if (await checkBackend()) {
      const raw = await api.get<Array<{ key: string; value: unknown }>>('/api/settings');
      return normalizeSettings(raw);
    }
    return DataStorage.get<SystemSettings>(STORAGE_KEYS.SETTINGS, {
      utilizationThresholdHigh: 100, utilizationThresholdLow: 80,
      benchThreshold: 20, expectedWeeklyHours: 40,
      timesheetPolicyMaxHours: 40, blockOverAllocation: false,
      demoSubmissionMode: false, currency: 'GBP',
    });
  },
  saveSettings: async (settings: SystemSettings): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/settings', settings);
      return;
    }
    DataStorage.set(STORAGE_KEYS.SETTINGS, settings);
    DataStorage.recalculateUtilization();
  },
  getCountryDirectors: async (): Promise<CountryDirector[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/country-directors');
      return raw.map(normalizeCountryDirector);
    }
    return DataStorage.get<CountryDirector[]>(STORAGE_KEYS.CDS, []);
  },
  saveCountryDirector: async (director: CountryDirector): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/country-directors', director);
      return;
    }
    const list = DataStorage.get<CountryDirector[]>(STORAGE_KEYS.CDS, []);
    const idx = list.findIndex(d => d.id === director.id);
    const previous = idx >= 0 ? list[idx] : undefined;
    if (idx >= 0) list[idx] = director; else list.push(director);
    DataStorage.set(STORAGE_KEYS.CDS, list);
    const user = authService.getCurrentUser();
    DataStorage.logAction(
      user?.id || 'system',
      user?.name || 'System',
      user?.role || 'Admin',
      idx >= 0 ? `Update ${productConfig.terminology.regionalOwner}` : `Create ${productConfig.terminology.regionalOwner}`,
      `${productConfig.terminology.regionalOwner}`,
      `${idx >= 0 ? 'Updated' : 'Created'} ${productConfig.terminology.regionalOwner} ${director.name}`,
      { entityType: 'CountryDirector', entityId: director.id, oldValue: previous, newValue: director }
    );
  },
  deleteCountryDirector: async (id: string): Promise<boolean> => {
    if (await checkBackend()) {
      await api.delete(`/api/country-directors/${id}`);
      return true;
    }
    const list = DataStorage.get<CountryDirector[]>(STORAGE_KEYS.CDS, []);
    const director = list.find(d => d.id === id);
    const employees = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
    const clients = DataStorage.get<Client[]>(STORAGE_KEYS.CLIENTS, []);
    const employeeCount = employees.filter(employee =>
      employee.primaryCountryDirectorId === id || employee.mappedCountryDirectorIds.includes(id)
    ).length;
    const clientCount = clients.filter(client => client.countryDirectorIds.includes(id)).length;
    const user = authService.getCurrentUser();
    if (employeeCount > 0 || clientCount > 0) {
      DataStorage.logAction(
        user?.id || 'system',
        user?.name || 'System',
        user?.role || 'Admin',
        'Delete Blocked',
        `${productConfig.terminology.regionalOwner}`,
        `Blocked deletion of ${director?.name || id}; scope mappings still exist`,
        {
          entityType: 'CountryDirector',
          entityId: id,
          oldValue: director,
          reason: `${employeeCount} employee mapping(s), ${clientCount} client mapping(s)`,
        }
      );
      return false;
    }
    DataStorage.set(STORAGE_KEYS.CDS, list.filter(d => d.id !== id));
    DataStorage.logAction(
      user?.id || 'system',
      user?.name || 'System',
      user?.role || 'Admin',
      `Delete ${productConfig.terminology.regionalOwner}`,
      `${productConfig.terminology.regionalOwner}`,
      `Deleted ${productConfig.terminology.regionalOwner} ${director?.name || id}`,
      { entityType: 'CountryDirector', entityId: id, oldValue: director }
    );
    return true;
  },
  getRoleDefinitions: async (): Promise<RoleDefinition[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/role-definitions');
      return raw.map(normalizeRoleDefinition);
    }
    return DataStorage.get<RoleDefinition[]>(STORAGE_KEYS.ROLE_DEFINITIONS, []).filter(r => r.active !== false);
  },
  saveRoleDefinition: async (role: RoleDefinition): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/role-definitions', { id: role.id, name: role.name, department: role.department, description: role.description, active: role.active });
      return;
    }
    const list = DataStorage.get<RoleDefinition[]>(STORAGE_KEYS.ROLE_DEFINITIONS, []);
    const idx = list.findIndex(r => r.id === role.id);
    if (idx >= 0) list[idx] = role; else list.push(role);
    DataStorage.set(STORAGE_KEYS.ROLE_DEFINITIONS, list);
  },
  deleteRoleDefinition: async (id: string): Promise<boolean> => {
    if (await checkBackend()) {
      await api.delete(`/api/role-definitions/${id}`);
      return true;
    }
    const list = DataStorage.get<RoleDefinition[]>(STORAGE_KEYS.ROLE_DEFINITIONS, []);
    DataStorage.set(STORAGE_KEYS.ROLE_DEFINITIONS, list.map(r => r.id === id ? { ...r, active: false } : r));
    return true;
  },
  getDepartments: async (): Promise<CatalogItem[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/catalogs/departments');
      return raw.map(normalizeCatalogItem);
    }
    return DataStorage.get<CatalogItem[]>(STORAGE_KEYS.DEPARTMENT_CATALOG, []).filter(i => i.active !== false);
  },
  saveDepartment: async (item: CatalogItem): Promise<void> => {
    if (await checkBackend()) { await api.post('/api/catalogs/departments', { id: item.id, name: item.name, active: item.active }); return; }
    const list = DataStorage.get<CatalogItem[]>(STORAGE_KEYS.DEPARTMENT_CATALOG, []);
    const idx = list.findIndex(d => d.id === item.id);
    if (idx >= 0) list[idx] = item; else list.push(item);
    DataStorage.set(STORAGE_KEYS.DEPARTMENT_CATALOG, list);
  },
  deleteDepartment: async (id: string): Promise<boolean> => {
    if (await checkBackend()) { await api.delete(`/api/catalogs/departments/${id}`); return true; }
    const list = DataStorage.get<CatalogItem[]>(STORAGE_KEYS.DEPARTMENT_CATALOG, []);
    const item = list.find(d => d.id === id);
    if (!item) return false;
    const empsUsing = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []).filter(e => e.department === item.name);
    if (empsUsing.length > 0) return false;
    DataStorage.set(STORAGE_KEYS.DEPARTMENT_CATALOG, list.map(d => d.id === id ? { ...d, active: false } : d));
    return true;
  },
  getCountries: async (): Promise<CatalogItem[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/catalogs/countries');
      return raw.map(normalizeCatalogItem);
    }
    return DataStorage.get<CatalogItem[]>(STORAGE_KEYS.COUNTRY_CATALOG, []).filter(i => i.active !== false);
  },
  saveCountry: async (item: CatalogItem): Promise<void> => {
    if (await checkBackend()) { await api.post('/api/catalogs/countries', { id: item.id, name: item.name, active: item.active }); return; }
    const list = DataStorage.get<CatalogItem[]>(STORAGE_KEYS.COUNTRY_CATALOG, []);
    const idx = list.findIndex(c => c.id === item.id);
    if (idx >= 0) list[idx] = item; else list.push(item);
    DataStorage.set(STORAGE_KEYS.COUNTRY_CATALOG, list);
  },
  deleteCountry: async (id: string): Promise<boolean> => {
    if (await checkBackend()) { await api.delete(`/api/catalogs/countries/${id}`); return true; }
    const list = DataStorage.get<CatalogItem[]>(STORAGE_KEYS.COUNTRY_CATALOG, []);
    const item = list.find(c => c.id === id);
    if (!item) return false;
    const used = DataStorage.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, []).filter(e => e.country === item.name);
    if (used.length > 0) return false;
    DataStorage.set(STORAGE_KEYS.COUNTRY_CATALOG, list.map(c => c.id === id ? { ...c, active: false } : c));
    return true;
  },
  getIndustries: async (): Promise<CatalogItem[]> => {
    if (await checkBackend()) {
      const raw = await api.get<Record<string, unknown>[]>('/api/catalogs/industries');
      return raw.map(normalizeCatalogItem);
    }
    return DataStorage.get<CatalogItem[]>(STORAGE_KEYS.INDUSTRY_CATALOG, []).filter(i => i.active !== false);
  },
  saveIndustry: async (item: CatalogItem): Promise<void> => {
    if (await checkBackend()) { await api.post('/api/catalogs/industries', { id: item.id, name: item.name, active: item.active }); return; }
    const list = DataStorage.get<CatalogItem[]>(STORAGE_KEYS.INDUSTRY_CATALOG, []);
    const idx = list.findIndex(i => i.id === item.id);
    if (idx >= 0) list[idx] = item; else list.push(item);
    DataStorage.set(STORAGE_KEYS.INDUSTRY_CATALOG, list);
  },
  deleteIndustry: async (id: string): Promise<boolean> => {
    if (await checkBackend()) { await api.delete(`/api/catalogs/industries/${id}`); return true; }
    const list = DataStorage.get<CatalogItem[]>(STORAGE_KEYS.INDUSTRY_CATALOG, []);
    const item = list.find(i => i.id === id);
    if (!item) return false;
    const used = DataStorage.get<Client[]>(STORAGE_KEYS.CLIENTS, []).filter(c => c.industry === item.name);
    if (used.length > 0) return false;
    DataStorage.set(STORAGE_KEYS.INDUSTRY_CATALOG, list.map(i => i.id === id ? { ...i, active: false } : i));
    return true;
  },
  resetDemoData: () => { DataStorage.resetDemoData(); },
  logAction: async (action: string, module: string, details: string): Promise<void> => {
    if (await checkBackend()) {
      await api.post('/api/audit-events', {
        action,
        module,
        details,
      }).catch(() => {});
      return;
    }
    const s = authService.getCurrentUser();
    DataStorage.logAction(s?.id || 'sys', s?.name || 'System', s?.role || 'Admin', action, module, details);
  },
  getDataQualityReport: async (): Promise<DataQualityReport> => {
    if (await checkBackend()) {
      return normalizeDataQualityReport(await api.get<Record<string, unknown>>('/api/reports/data-quality'));
    }
    return buildLocalDataQualityReport();
  },
};

const buildLocalDataQualityReport = async (): Promise<DataQualityReport> => {
  const [employees, projects, allocations] = await Promise.all([
    employeeService.getAll(),
    projectService.getAll(),
    allocationService.getAll(),
  ]);
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const issues = [
    ...employees
      .filter(employee => employee.status === 'Active' && !employee.reportingManagerId)
      .map(employee => ({
        entityType: 'Employee',
        entityId: employee.id,
        entity: employee.name,
        issueType: 'Missing reporting manager',
        owner: employee.email || employee.employeeId,
        impact: 'Approval routing and team views may be unreliable.',
        suggestedAction: 'Assign a reporting manager in Employee Master.',
      })),
    ...employees
      .filter(employee => employee.status === 'Active' && (!employee.standardWeeklyHours || !employee.capacityType || !employee.contractType))
      .map(employee => ({
        entityType: 'Employee',
        entityId: employee.id,
        entity: employee.name,
        issueType: 'Missing capacity profile',
        owner: employee.email || employee.employeeId,
        impact: 'Availability and utilization handover checks cannot be fully trusted.',
        suggestedAction: 'Set standard weekly hours, capacity type, and contract type.',
      })),
    ...employees
      .filter(employee => employee.status === 'Active' && !employee.teamsUserId)
      .map(employee => ({
        entityType: 'Employee',
        entityId: employee.id,
        entity: employee.name,
        issueType: 'Missing Teams identity link',
        owner: employee.email || employee.employeeId,
        impact: 'Future Teams approvals and reminders cannot target this user.',
        suggestedAction: 'Capture the Teams user link during identity onboarding.',
      })),
    ...employees
      .filter(employee => employee.email.endsWith('.demo') || employee.email.includes('@example.test'))
      .map(employee => ({
        entityType: 'Employee',
        entityId: employee.id,
        entity: employee.name,
        issueType: 'Demo data remnant',
        owner: employee.email || employee.employeeId,
        impact: 'Production handover may still contain seeded demo records.',
        suggestedAction: 'Replace demo user and employee records with company-owned data.',
      })),
    ...allocations
      .filter(allocation => {
        const project = projectsById.get(allocation.projectId);
        return project && (allocation.startDate < project.startDate || allocation.endDate > project.endDate);
      })
      .map(allocation => ({
        entityType: 'Allocation',
        entityId: allocation.id,
        entity: allocation.projectName,
        issueType: 'Allocation outside project timeline',
        owner: allocation.employeeId,
        impact: 'Planned and forecast utilization can be incorrect for this assignment.',
        suggestedAction: 'Adjust allocation dates to fit within the project start and end dates.',
      })),
  ];
  const byType = issues.reduce<Record<string, number>>((acc, issue) => {
    acc[issue.issueType] = (acc[issue.issueType] || 0) + 1;
    return acc;
  }, {});
  const denominator = Math.max(employees.length * 4, 1);
  return {
    score: Math.max(0, Math.round(((denominator - issues.length) / denominator) * 100)),
    totalRecords: employees.length,
    issueCount: issues.length,
    byType,
    issues,
    generatedAt: new Date().toISOString(),
  };
};

const buildLocalUtilizationReport = async (mode: UtilizationReportMode, months = 3): Promise<UtilizationReport> => {
  const [employees, allocations, projects, timesheets, settings] = await Promise.all([
    employeeService.getAll(),
    allocationService.getAll(),
    projectService.getAll(),
    timesheetService.getAll(),
    adminService.getSettings(),
  ]);
  const sourceDate = todayIso();
  const targetDate = new Date(`${sourceDate}T00:00:00`);
  if (mode === 'forecast') targetDate.setMonth(targetDate.getMonth() + months);
  const asOfDate = targetDate.toISOString().slice(0, 10);
  const includeProposed = mode === 'forecast';
  const rows = getUtilizationEligibleEmployees(employees, allocations, projects, asOfDate, includeProposed).map(employee => ({
    ...employee,
    plannedUtilization: getAllocationLoad(employee.id, allocations, projects, asOfDate, asOfDate, includeProposed),
    actualUtilization: getLatestApprovedActualUtilization(employee.id, timesheets, settings),
    activeProjectCount: getActiveAllocationsForEmployee(employee.id, allocations, projects, asOfDate, asOfDate, includeProposed).length,
  }));
  return {
    mode,
    asOfDate,
    sourceDate,
    forecastMonths: mode === 'forecast' ? months : null,
    expectedWeeklyHours: settings.expectedWeeklyHours,
    thresholds: {
      high: settings.utilizationThresholdHigh,
      low: settings.utilizationThresholdLow,
      bench: settings.benchThreshold,
    },
    summary: {
      rows: rows.length,
      averagePlanned: rows.length ? Number((rows.reduce((sum, row) => sum + row.plannedUtilization, 0) / rows.length).toFixed(1)) : 0,
      averageActual: rows.length ? Number((rows.reduce((sum, row) => sum + row.actualUtilization, 0) / rows.length).toFixed(1)) : 0,
      overloaded: rows.filter(row => row.plannedUtilization > settings.utilizationThresholdHigh).length,
      underutilized: rows.filter(row => row.plannedUtilization < settings.utilizationThresholdLow && row.plannedUtilization > settings.benchThreshold).length,
      bench: rows.filter(row => row.plannedUtilization <= settings.benchThreshold).length,
    },
    rows,
  };
};

const getBackendUtilizationReport = async (path: string): Promise<UtilizationReport | null> => {
  if (!(await checkBackend())) return null;
  const raw = await api.get<Record<string, unknown>>(path);
  return normalizeUtilizationReport(raw);
};

export const utilizationReportService = {
  getPlanned: async (): Promise<UtilizationReport> => {
    return (await getBackendUtilizationReport('/api/reports/planned-utilization'))
      ?? buildLocalUtilizationReport('planned');
  },
  getActual: async (): Promise<UtilizationReport> => {
    return (await getBackendUtilizationReport('/api/reports/actual-utilization'))
      ?? buildLocalUtilizationReport('actual');
  },
  getForecast: async (months = 3): Promise<UtilizationReport> => {
    return (await getBackendUtilizationReport(`/api/reports/forecast-utilization?months=${encodeURIComponent(String(months))}`))
      ?? buildLocalUtilizationReport('forecast', months);
  },
};

export const dashboardService = {
  getKPIData: async () => [],
  getReport: async (): Promise<DashboardReport | null> => {
    if (!(await checkBackend())) return null;
    return normalizeDashboardReport(await api.get<Record<string, unknown>>('/api/reports/dashboard'));
  },
};

const buildLocalWorkforceCommandCenter = async (): Promise<WorkforceCommandCenterReport> => {
  const [planning, dataQuality, sla, notifications, integrationHealth] = await Promise.all([
    planningService.getResourcePlanning(),
    adminService.getDataQualityReport(),
    approvalService.getSlaReport(),
    notificationService.getDeliveryAttempts(),
    integrationService.getHealth(),
  ]);
  const [projects, allocations] = await Promise.all([projectService.getAll(), allocationService.getAll()]);
  const failedDeliveries = notifications.filter(attempt => attempt.status === 'Failed').length;
  const asOfDate = planning.asOfDate;
  const staffedProjectIds = new Set(allocations
    .filter(allocation => allocation.status === 'Active' && allocation.startDate <= asOfDate && allocation.endDate >= asOfDate)
    .map(allocation => allocation.projectId));
  const projectStaffingRisks = projects.filter(project =>
    (project.status === 'Active' || project.status === 'Proposed') &&
    project.startDate <= asOfDate &&
    project.endDate >= asOfDate &&
    !staffedProjectIds.has(project.id)
  ).length;
  const topRisks = [
    ...planning.rows
      .filter(row => row.overloaded)
      .slice(0, 4)
      .map(row => ({
        riskType: 'Overload',
        severity: 'Critical',
        description: `${row.employeeName} is planned at ${row.plannedUtilization}%.`,
        owner: row.department,
      })),
    ...planning.rows
      .filter(row => row.bench)
      .slice(0, 3)
      .map(row => ({
        riskType: 'Bench',
        severity: 'Warning',
        description: `${row.employeeName} has ${row.plannedUtilization}% planned load.`,
        owner: row.department,
      })),
  ];
  return {
    generatedAt: new Date().toISOString(),
    dataConfidenceScore: dataQuality.score,
    leaveAdjustedAvailabilityHours: planning.rows.reduce((sum, row) => sum + row.availabilityHours, 0),
    pendingApprovalLoad: sla.pendingCount,
    overdueApprovalLoad: sla.overdueCount,
    notificationDeliveryRisk: failedDeliveries,
    missingIdentityLinks: integrationHealth.missingIdentityLinks,
    missingTeamsLinks: integrationHealth.missingTeamsLinks,
    projectStaffingRisks,
    benchCount: planning.summary.benchCount,
    overloadedCount: planning.summary.overloadedCount,
    underloadedCount: planning.summary.underloadedCount,
    topRisks,
  };
};

export const planningService = {
  getResourcePlanning: async (): Promise<ResourcePlanningReport> => {
    if (await checkBackend()) {
      return normalizeResourcePlanningReport(await api.get<Record<string, unknown>>('/api/reports/resource-planning'));
    }
    const [employees, allocations, projects, availability, settings] = await Promise.all([
      employeeService.getAll(),
      allocationService.getAll(),
      projectService.getAll(),
      leaveService.getAvailability(),
      adminService.getSettings(),
    ]);
    return buildResourcePlanningReport({ employees, allocations, projects, availability, settings });
  },
  getAvailability: async (): Promise<LeaveAvailabilityEntry[]> => leaveService.getAvailability(),
  getWorkforceCommandCenter: async (): Promise<WorkforceCommandCenterReport> => {
    if (await checkBackend()) {
      return normalizeWorkforceCommandCenterReport(await api.get<Record<string, unknown>>('/api/reports/workforce-command-center'));
    }
    return buildLocalWorkforceCommandCenter();
  },
};
