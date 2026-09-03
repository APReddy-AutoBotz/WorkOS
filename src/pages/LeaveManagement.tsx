import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Target,
  TrendingUp,
  UserRound,
  XCircle,
} from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { authService } from '../services/authService';
import {
  adminService,
  allocationService,
  approvalService,
  employeeService,
  leaveService,
  notificationService,
  projectService,
  timesheetService,
} from '../services/api';
import { isEnterpriseFeatureEnabled } from '../config/featureFlags';
import { getLatestApprovedActualUtilization, isProjectAvailableForPlanning, overlapsDateRange } from '../services/calculations';
import type {
  Allocation,
  ApprovalRecord,
  CountryDirector,
  Employee,
  HolidayCalendar,
  LeaveAvailabilityEntry,
  LeaveBalance,
  LeavePolicy,
  LeaveRequest,
  LeaveType,
  NotificationEvent,
  Project,
  SystemSettings,
  TimesheetSummary,
} from '../types';
import { formatHours, formatPercent } from '../lib/format';
import { cn } from '../lib/utils';

import { productConfig } from '../config/productConfig';
type EssSection = 'overview' | 'work' | 'leave';
type EssActionSeverity = 'warning' | 'danger' | 'info';
type EssActionItem = {
  id: string;
  title: string;
  detail: string;
  href: string;
  severity: EssActionSeverity;
  tag: string;
};

type LeaveViewState = {
  employees: Employee[];
  directors: CountryDirector[];
  projects: Project[];
  allocations: Allocation[];
  timesheets: TimesheetSummary[];
  settings: SystemSettings;
  types: LeaveType[];
  policies: LeavePolicy[];
  calendars: HolidayCalendar[];
  balances: LeaveBalance[];
  requests: LeaveRequest[];
  availability: LeaveAvailabilityEntry[];
  approvals: ApprovalRecord[];
  notifications: NotificationEvent[];
};

const emptyState: LeaveViewState = {
  employees: [],
  directors: [],
  projects: [],
  allocations: [],
  timesheets: [],
  settings: {
    utilizationThresholdHigh: 100,
    utilizationThresholdLow: 80,
    timesheetPolicyMaxHours: 40,
    expectedWeeklyHours: 40,
    benchThreshold: 20,
    currency: 'GBP',
  },
  types: [],
  policies: [],
  calendars: [],
  balances: [],
  requests: [],
  availability: [],
  approvals: [],
  notifications: [],
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const getCurrentWeekEnding = () => {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() + (day === 0 ? -6 : 1 - day));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return friday.toISOString().slice(0, 10);
};

const leaveFeatureEnabled = () => isEnterpriseFeatureEnabled('leave');
const notificationsFeatureEnabled = () => isEnterpriseFeatureEnabled('notifications');
const identityFeatureEnabled = () => isEnterpriseFeatureEnabled('entra') || isEnterpriseFeatureEnabled('teams');

const loadLeaveViewState = async (): Promise<LeaveViewState> => {
  const leaveEnabled = leaveFeatureEnabled();
  const notificationsEnabled = notificationsFeatureEnabled();
  const [
    employees,
    directors,
    projects,
    allocations,
    timesheets,
    settings,
    types,
    policies,
    calendars,
    balances,
    requests,
    availability,
    approvals,
    notifications,
  ] = await Promise.all([
    employeeService.getAll(),
    adminService.getCountryDirectors(),
    projectService.getAll(),
    allocationService.getAll(),
    timesheetService.getAll(),
    adminService.getSettings(),
    leaveEnabled ? leaveService.getTypes().catch(() => []) : Promise.resolve([]),
    leaveEnabled ? leaveService.getPolicies().catch(() => []) : Promise.resolve([]),
    leaveEnabled ? leaveService.getHolidayCalendars().catch(() => []) : Promise.resolve([]),
    leaveEnabled ? leaveService.getBalances().catch(() => []) : Promise.resolve([]),
    leaveEnabled ? leaveService.getRequests().catch(() => []) : Promise.resolve([]),
    leaveEnabled ? leaveService.getAvailability().catch(() => []) : Promise.resolve([]),
    notificationsEnabled ? approvalService.getAll().catch(() => []) : Promise.resolve([]),
    notificationsEnabled ? notificationService.getAll().catch(() => []) : Promise.resolve([]),
  ]);
  return { employees, directors, projects, allocations, timesheets, settings, types, policies, calendars, balances, requests, availability, approvals, notifications };
};

const useLeaveViewState = () => {
  const [state, setState] = useState(emptyState);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      setState(await loadLeaveViewState());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { state, loading, notice, setNotice, refresh };
};

const getCurrentEmployee = (employees: Employee[]) => {
  const user = authService.getCurrentUser();
  return employees.find(employee =>
    employee.id === user?.id ||
    employee.id === user?.employeeId ||
    employee.employeeId === user?.employeeId
  );
};

const belongsToEmployee = (employee: Employee | undefined, value: string | undefined) =>
  Boolean(employee && value && [employee.id, employee.employeeId].includes(value));

const getUtilLabel = (planned: number, settings: SystemSettings) => {
  if (planned > settings.utilizationThresholdHigh) return { label: 'Overloaded', variant: 'danger' as const };
  if (planned <= settings.benchThreshold) return { label: 'Bench', variant: 'neutral' as const };
  if (planned < settings.utilizationThresholdLow) return { label: 'Underutilized', variant: 'warning' as const };
  return { label: 'Balanced', variant: 'success' as const };
};

const daysUntil = (dateIso: string) => {
  const today = new Date(todayIso()).getTime();
  const target = new Date(dateIso).getTime();
  return Math.ceil((target - today) / 86400000);
};

const formatDate = (dateIso?: string) => dateIso || 'Not set';

const actionStyles: Record<EssActionSeverity, { wrapper: string; icon: string; tag: string }> = {
  warning: {
    wrapper: 'border-amber-100 bg-amber-50 hover:border-amber-200',
    icon: 'text-amber-600',
    tag: 'bg-amber-100 text-amber-800',
  },
  danger: {
    wrapper: 'border-red-100 bg-red-50 hover:border-red-200',
    icon: 'text-red-600',
    tag: 'bg-red-100 text-red-800',
  },
  info: {
    wrapper: 'border-blue-100 bg-blue-50 hover:border-blue-200',
    icon: 'text-blue-600',
    tag: 'bg-blue-100 text-blue-800',
  },
};

const statusVariant = (status: LeaveRequest['status']) => {
  if (status === 'Approved') return 'success';
  if (status === 'Rejected' || status === 'Cancelled') return 'danger';
  if (status === 'Submitted') return 'warning';
  return 'neutral';
};

const SummaryTile = ({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub: string; icon: typeof CalendarDays }) => (
  <Card className="p-0">
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
        <p className="mt-2 text-2xl font-black text-heading">{value}</p>
        <p className="mt-1 text-xs font-bold text-body/60">{sub}</p>
      </div>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-primary">
        <Icon size={21} />
      </div>
    </div>
  </Card>
);

export const ESSHome = ({ initialSection = 'overview' }: { initialSection?: EssSection } = {}) => {
  const { state, loading, notice, setNotice, refresh } = useLeaveViewState();
  const [activeSection, setActiveSection] = useState<EssSection>(initialSection);
  const employee = getCurrentEmployee(state.employees);
  const manager = state.employees.find(row => row.id === employee?.reportingManagerId || row.employeeId === employee?.reportingManagerId);
  const directorById = useMemo(() => new Map(state.directors.map(director => [director.id, director])), [state.directors]);
  const primaryDirector = employee?.primaryCountryDirectorId ? directorById.get(employee.primaryCountryDirectorId) : undefined;
  const mappedDirectors = (employee?.mappedCountryDirectorIds || [])
    .map(id => directorById.get(id))
    .filter(Boolean) as CountryDirector[];
  const projectById = useMemo(() => new Map(state.projects.map(project => [project.id, project])), [state.projects]);
  const currentDate = todayIso();
  const currentWeekEnding = getCurrentWeekEnding();
  const employeeAllocations = state.allocations.filter(allocation => belongsToEmployee(employee, allocation.employeeId));
  const employeeTimesheets = state.timesheets.filter(timesheet => belongsToEmployee(employee, timesheet.employeeId));
  const balances = state.balances.filter(balance => balance.employeeId === employee?.id);
  const requests = state.requests.filter(request => request.employeeId === employee?.id);
  const availability = state.availability.find(row => row.employeeId === employee?.id);
  const approvals = state.approvals.filter(record =>
    belongsToEmployee(employee, record.subjectEmployeeId) ||
    belongsToEmployee(employee, record.requesterId)
  );
  const notifications = state.notifications.filter(event => belongsToEmployee(employee, event.recipientEmployeeId));
  const unreadNotifications = notifications.filter(event => !event.readAt);
  const currentTimesheet = employeeTimesheets.find(timesheet => timesheet.weekEnding === currentWeekEnding);

  const currentAllocations = employeeAllocations
    .filter(allocation => {
      const project = projectById.get(allocation.projectId);
      return allocation.status === 'Active' &&
        Boolean(project) &&
        isProjectAvailableForPlanning(project!, currentDate, currentDate) &&
        overlapsDateRange(allocation.startDate, allocation.endDate, currentDate, currentDate);
    })
    .sort((a, b) => b.percentage - a.percentage || a.projectName.localeCompare(b.projectName));

  const upcomingAllocations = employeeAllocations
    .filter(allocation => allocation.status === 'Active' && daysUntil(allocation.endDate) >= 0)
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())
    .slice(0, 4);

  const plannedUtilization = currentAllocations.reduce((sum, allocation) => sum + allocation.percentage, 0);
  const actualUtilization = employee ? getLatestApprovedActualUtilization(employee.id, employeeTimesheets, state.settings) : 0;
  const utilStatus = getUtilLabel(plannedUtilization, state.settings);
  const currentHours = currentTimesheet?.totalHours ?? 0;
  const availableLeaveDays = balances.reduce((sum, balance) => sum + balance.availableDays, 0);
  const actionItems: EssActionItem[] = [
    !currentTimesheet || currentTimesheet.status === 'Draft' ? {
      id: 'timesheet-submit',
      title: 'Submit this week timesheet',
      detail: `Week ending ${currentWeekEnding} is ${currentTimesheet?.status || 'not started'}.`,
      href: '/timesheets',
      severity: 'warning',
      tag: 'Timesheet',
    } : null,
    currentTimesheet?.status === 'Rejected' ? {
      id: 'timesheet-rejected',
      title: 'Correct rejected timesheet',
      detail: currentTimesheet.rejectionReason || currentTimesheet.rejectionNote || `Week ending ${currentWeekEnding} needs correction.`,
      href: '/timesheets',
      severity: 'danger',
      tag: 'Timesheet',
    } : null,
    ...requests.filter(request => request.status === 'Rejected').slice(0, 2).map(request => ({
      id: `leave-${request.id}`,
      title: `Review rejected ${request.leaveTypeName || 'leave'} request`,
      detail: `${request.startDate} to ${request.endDate}${request.comments ? ` - ${request.comments}` : ''}`,
      href: '/leave/my',
      severity: 'danger' as const,
      tag: 'Leave',
    })),
    ...approvals.filter(record => record.status === 'Pending').slice(0, 2).map(record => ({
      id: `approval-${record.id}`,
      title: `${record.entityType} approval pending`,
      detail: record.dueAt ? `Due ${record.dueAt}` : 'Open approval item awaiting a decision.',
      href: notificationsFeatureEnabled() ? '/approvals' : '/ess',
      severity: 'warning' as const,
      tag: 'Approval',
    })),
    ...unreadNotifications.slice(0, 2).map(event => ({
      id: `notification-${event.id}`,
      title: event.title,
      detail: event.body,
      href: notificationsFeatureEnabled() ? '/notifications' : '/ess',
      severity: event.severity === 'Critical' ? 'danger' as const : event.severity === 'Warning' ? 'warning' as const : 'info' as const,
      tag: 'Notification',
    })),
    identityFeatureEnabled() && (!employee?.entraObjectId || !employee?.teamsUserId) ? {
      id: 'identity-readiness',
      title: 'Identity or Teams mapping incomplete',
      detail: `${employee?.entraObjectId ? 'Entra linked' : 'Entra not linked'} | ${employee?.teamsUserId ? 'Teams linked' : 'Teams not linked'}`,
      href: '/ess',
      severity: 'info',
      tag: 'Identity',
    } : null,
  ].filter(Boolean) as EssActionItem[];
  const sections: Array<{ id: EssSection; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'work', label: 'Work & Utilization' },
    ...(leaveFeatureEnabled() ? [{ id: 'leave' as EssSection, label: 'Leave' }] : []),
  ];

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title={`My ${productConfig.productName} Hub`}
        subtitle="Your profile, assignments, utilization, timesheets, leave, and workforce actions in one place."
        breadcrumb={['Self Service', employee?.employeeId || 'ESS']}
        actions={(
          <Link to="/timesheets" className="btn-primary flex items-center gap-2 px-5 py-2.5">
            <Clock size={14} /> Open Timesheet
          </Link>
        )}
      />
      {loading ? <Card>Loading employee self-service data...</Card> : !employee ? (
        <Card>
          <div className="py-8 text-center">
            <p className="text-base font-black text-heading">Self-service profile unavailable</p>
            <p className="mt-2 text-sm font-bold text-body/60">The current login is not linked to an employee master record.</p>
          </div>
        </Card>
      ) : (
        <>
          {notice && <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-bold text-green-700">{notice}</div>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
            <SummaryTile label="Planned Load" value={formatPercent(plannedUtilization)} sub="Active allocations" icon={Target} />
            <SummaryTile label="Actual Utilization" value={formatPercent(actualUtilization)} sub="Latest approved week" icon={TrendingUp} />
            <SummaryTile label="This Week" value={formatHours(currentHours)} sub={currentTimesheet?.status || 'Not started'} icon={Clock} />
            {leaveFeatureEnabled() && <SummaryTile label="Available Leave" value={availableLeaveDays.toFixed(1)} sub="Days across balances" icon={CalendarDays} />}
            {leaveFeatureEnabled() && <SummaryTile label="Availability" value={availability ? formatHours(availability.availabilityHours) : '-'} sub="Leave/holiday adjusted" icon={ShieldCheck} />}
            <SummaryTile label="Actions" value={actionItems.length} sub="Personal follow-ups" icon={Bell} />
          </div>

          <div className="flex flex-wrap gap-2 rounded-2xl border border-border-light bg-white p-2 shadow-sm">
            {sections.map(section => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  'rounded-xl px-4 py-2 text-xs font-black uppercase tracking-widest transition-colors',
                  activeSection === section.id ? 'bg-primary text-white shadow-lg shadow-orange-100' : 'text-slate-500 hover:bg-slate-50 hover:text-heading'
                )}
              >
                {section.label}
              </button>
            ))}
          </div>

          {activeSection === 'overview' && (
            <EssOverview
              employee={employee}
              managerName={manager?.name}
              primaryDirector={primaryDirector}
              mappedDirectors={mappedDirectors}
              currentAllocations={currentAllocations}
              upcomingAllocations={upcomingAllocations}
              projectById={projectById}
              plannedUtilization={plannedUtilization}
              actualUtilization={actualUtilization}
              utilStatus={utilStatus}
              actionItems={actionItems}
            />
          )}

          {activeSection === 'work' && (
            <EssWorkPanel
              employee={employee}
              employeeTimesheets={employeeTimesheets}
              upcomingAllocations={upcomingAllocations}
              plannedUtilization={plannedUtilization}
              actualUtilization={actualUtilization}
              utilStatus={utilStatus}
              currentTimesheet={currentTimesheet}
              currentWeekEnding={currentWeekEnding}
              currentHours={currentHours}
            />
          )}

          {activeSection === 'leave' && leaveFeatureEnabled() && (
            <EmployeeLeavePanel
              employee={employee}
              balances={balances}
              requests={requests}
              types={state.types}
              availability={availability}
              setNotice={setNotice}
              refresh={refresh}
            />
          )}
        </>
      )}
    </div>
  );
};

const EssOverview = ({
  employee,
  managerName,
  primaryDirector,
  mappedDirectors,
  currentAllocations,
  upcomingAllocations,
  projectById,
  plannedUtilization,
  actualUtilization,
  utilStatus,
  actionItems,
}: {
  employee: Employee;
  managerName?: string;
  primaryDirector?: CountryDirector;
  mappedDirectors: CountryDirector[];
  currentAllocations: Allocation[];
  upcomingAllocations: Allocation[];
  projectById: Map<string, Project>;
  plannedUtilization: number;
  actualUtilization: number;
  utilStatus: ReturnType<typeof getUtilLabel>;
  actionItems: EssActionItem[];
}) => (
  <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
    <div className="space-y-6">
      <Card title="Today at a Glance" subtitle="Allocation, timesheet, and availability signals derived from the source records." headerVariant="secondary">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Utilization State</p>
              <Badge variant={utilStatus.variant}>{utilStatus.label}</Badge>
            </div>
            <div className="mt-5 space-y-4">
              {[['Planned', plannedUtilization, 'bg-primary'], ['Actual', actualUtilization, 'bg-heading/60']].map(([label, value, color]) => (
                <div key={String(label)}>
                  <div className="mb-1.5 flex justify-between text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    <span>{label}</span>
                    <span>{formatPercent(Number(value))}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white">
                    <div className={cn('h-full rounded-full transition-all', String(color))} style={{ width: `${Math.min(Number(value), 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Current Assignment</p>
            <p className="mt-3 text-2xl font-black text-heading">{currentAllocations.length}</p>
            <p className="mt-1 text-xs font-bold text-body/60">Active project{currentAllocations.length === 1 ? '' : 's'} today</p>
            <p className="mt-4 text-xs font-bold text-primary">{upcomingAllocations[0] ? `Next roll-off: ${upcomingAllocations[0].endDate}` : 'No active roll-off date'}</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Action Queue</p>
            <p className="mt-3 text-2xl font-black text-heading">{actionItems.length}</p>
            <p className="mt-1 text-xs font-bold text-body/60">Items needing attention</p>
            <Link to={actionItems[0]?.href || '/ess'} className="mt-4 inline-flex items-center gap-1 text-xs font-black text-primary">
              Review actions <ArrowUpRight size={13} />
            </Link>
          </div>
        </div>
      </Card>

      <Card title="Current Work" subtitle="The projects below come directly from Allocation Control." headerVariant="secondary">
        <div className="space-y-3">
          {currentAllocations.map(allocation => {
            const project = projectById.get(allocation.projectId);
            return (
              <Link
                key={allocation.id}
                to={`/projects/${allocation.projectId}`}
                className="flex items-center justify-between gap-4 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 transition-all hover:border-primary/30 hover:bg-orange-50/60"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-heading">{allocation.projectName}</p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    {project?.client || 'Client'} | {allocation.roleOnProject || employee.designation}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-lg font-black text-primary tabular-nums">{allocation.percentage}%</p>
                  <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{allocation.billable ? 'Billable' : 'Internal'}</p>
                </div>
              </Link>
            );
          })}
          {currentAllocations.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center">
              <Briefcase className="mx-auto text-slate-300" size={28} />
              <p className="mt-3 text-sm font-bold text-heading">No current active project allocation</p>
              <p className="mt-2 text-xs text-slate-400">Assignments will appear after Allocation Control has active plans for today.</p>
            </div>
          )}
        </div>
      </Card>
    </div>

    <div className="space-y-6">
      <Card title="Personal Actions" subtitle="Actionable timesheet, leave, approval, notification, and identity follow-ups." headerVariant="secondary">
        <div className="space-y-3">
          {actionItems.slice(0, 6).map(action => {
            const style = actionStyles[action.severity];
            return (
              <Link
                key={action.id}
                to={action.href}
                className={cn('flex items-start gap-3 rounded-2xl border px-4 py-3 transition-colors', style.wrapper)}
              >
                <AlertTriangle className={cn('mt-0.5 shrink-0', style.icon)} size={16} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-sm font-black text-heading">{action.title}</span>
                    <span className={cn('shrink-0 rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-widest', style.tag)}>{action.tag}</span>
                  </span>
                  <span className="mt-1 block text-xs font-semibold leading-relaxed text-body/60">{action.detail}</span>
                </span>
                <ArrowUpRight className="mt-0.5 shrink-0 text-slate-300" size={14} />
              </Link>
            );
          })}
          {actionItems.length === 0 && (
            <div className="rounded-2xl border border-green-100 bg-green-50 px-4 py-5 text-center">
              <CheckCircle2 className="mx-auto text-green-600" size={24} />
              <p className="mt-2 text-sm font-black text-green-800">No personal follow-ups right now.</p>
            </div>
          )}
        </div>
      </Card>

      <Card title="Profile & Identity" headerVariant="secondary">
        <div className="grid grid-cols-1 gap-3">
          {[
            ['Employee', `${employee.name} (${employee.employeeId})`],
            ['Manager', managerName || 'Not mapped'],
            ['Primary CD', primaryDirector ? `${primaryDirector.name} (${primaryDirector.region})` : 'Not mapped'],
            ['Mapped CDs', mappedDirectors.length > 0 ? mappedDirectors.map(director => director.name).join(', ') : 'Not mapped'],
            ['Department', employee.department],
            ['Country', employee.country],
            ['Employment', `${employee.contractType || 'Not set'} | Joined ${formatDate(employee.joiningDate)}`],
            ['Exit Date', formatDate(employee.exitDate)],
            ['Capacity', `${employee.capacityType || 'Delivery'} | ${employee.standardWeeklyHours || 40}h/week | ${employee.utilizationEligible === false ? 'Not utilization eligible' : 'Utilization eligible'}`],
            ['Leave Policy', employee.leavePolicyId || 'Not mapped'],
            ...(identityFeatureEnabled() ? [
              ['Entra', employee.entraObjectId ? 'Linked' : 'Not linked'],
              ['Teams', employee.teamsUserId ? 'Linked' : 'Not linked'],
            ] : []),
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
              <p className="mt-1 text-sm font-bold text-heading">{value}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  </div>
);

const EssWorkPanel = ({
  employee,
  employeeTimesheets,
  upcomingAllocations,
  plannedUtilization,
  actualUtilization,
  utilStatus,
  currentTimesheet,
  currentWeekEnding,
  currentHours,
}: {
  employee: Employee;
  employeeTimesheets: TimesheetSummary[];
  upcomingAllocations: Allocation[];
  plannedUtilization: number;
  actualUtilization: number;
  utilStatus: ReturnType<typeof getUtilLabel>;
  currentTimesheet?: TimesheetSummary;
  currentWeekEnding: string;
  currentHours: number;
}) => (
  <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.85fr_1.15fr]">
    <div className="space-y-6">
      <Card title="Utilization Snapshot" subtitle="Planned is allocation load; actual is approved timesheet effort." headerVariant="secondary">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Current Role</p>
              <p className="mt-1 text-sm font-bold text-heading">{employee.designation}</p>
            </div>
            <Badge variant={utilStatus.variant}>{utilStatus.label}</Badge>
          </div>
          {[['Planned', plannedUtilization, 'bg-primary'], ['Actual', actualUtilization, 'bg-heading/50']].map(([label, value, color]) => (
            <div key={String(label)}>
              <div className="mb-1.5 flex justify-between text-[10px] font-bold uppercase tracking-widest text-slate-400">
                <span>{label}</span>
                <span>{formatPercent(Number(value))}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                <div className={cn('h-full rounded-full transition-all', String(color))} style={{ width: `${Math.min(Number(value), 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="This Week Timesheet" headerVariant="secondary">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Badge variant={currentTimesheet?.status === 'Approved' ? 'success' : currentTimesheet?.status === 'Rejected' ? 'danger' : currentTimesheet?.status === 'Submitted' ? 'warning' : 'neutral'}>
              {currentTimesheet?.status || 'Not Started'}
            </Badge>
            <p className="mt-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Week ending {currentWeekEnding}</p>
            <p className="mt-2 text-2xl font-black text-heading tabular-nums">{formatHours(currentHours)}</p>
          </div>
          <Link to="/timesheets" className="btn-secondary px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest">
            Continue
          </Link>
        </div>
      </Card>
    </div>

    <div className="space-y-6">
      <Card title="Allocation Timeline" subtitle="Nearest active assignment end dates." headerVariant="secondary">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {upcomingAllocations.map(allocation => (
            <div key={allocation.id} className="rounded-2xl border border-border-light bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-heading">{allocation.projectName}</p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{allocation.startDate} to {allocation.endDate}</p>
                  <p className="mt-2 text-xs font-bold text-body/60">{Math.max(daysUntil(allocation.endDate), 0)} days to roll-off</p>
                </div>
                <Badge variant={allocation.status === 'Active' ? 'success' : 'neutral'}>{allocation.percentage}%</Badge>
              </div>
            </div>
          ))}
          {upcomingAllocations.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center md:col-span-2">
              <CalendarDays className="mx-auto text-slate-300" size={28} />
              <p className="mt-3 text-xs font-bold text-slate-400">No active allocation timeline to show.</p>
            </div>
          )}
        </div>
      </Card>

      <Card title="Recent Timesheets" subtitle="Approved weeks drive actual utilization." headerVariant="secondary">
        <div className="space-y-3">
          {employeeTimesheets.slice().sort((a, b) => b.weekEnding.localeCompare(a.weekEnding)).slice(0, 5).map(timesheet => (
            <div key={timesheet.id || `${timesheet.employeeId}-${timesheet.weekEnding}`} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
              <div>
                <p className="text-sm font-black text-heading">Week ending {timesheet.weekEnding}</p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{formatHours(timesheet.totalHours)} total | {formatHours(timesheet.billableHours)} billable</p>
              </div>
              <Badge variant={timesheet.status === 'Approved' ? 'success' : timesheet.status === 'Rejected' ? 'danger' : timesheet.status === 'Submitted' ? 'warning' : 'neutral'}>{timesheet.status}</Badge>
            </div>
          ))}
          {employeeTimesheets.length === 0 && <p className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm font-bold text-slate-400">No timesheets available yet.</p>}
        </div>
      </Card>
    </div>
  </div>
);

const EmployeeLeavePanel = ({
  employee,
  balances,
  requests,
  types,
  availability,
  setNotice,
  refresh,
}: {
  employee: Employee;
  balances: LeaveBalance[];
  requests: LeaveRequest[];
  types: LeaveType[];
  availability?: LeaveAvailabilityEntry;
  setNotice: (notice: string) => void;
  refresh: () => Promise<void>;
}) => {
  const defaultType = types.find(type => type.active);
  const [form, setForm] = useState({
    leaveTypeId: defaultType?.id || '',
    startDate: todayIso(),
    endDate: todayIso(),
    reason: '',
  });
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);

  useEffect(() => {
    if (!form.leaveTypeId && defaultType) {
      setForm(current => ({ ...current, leaveTypeId: defaultType.id }));
    }
  }, [defaultType, form.leaveTypeId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!employee || !form.leaveTypeId) return;
    try {
      if (editingRequestId) {
        await leaveService.updateRequest(editingRequestId, {
          leaveTypeId: form.leaveTypeId,
          startDate: form.startDate,
          endDate: form.endDate,
          reason: form.reason,
        });
        setNotice('Leave request updated.');
      } else {
        await leaveService.submitRequest({
          id: '',
          employeeId: employee.id,
          leaveTypeId: form.leaveTypeId,
          startDate: form.startDate,
          endDate: form.endDate,
          totalDays: 0,
          status: 'Submitted',
          reason: form.reason,
        });
        setNotice('Leave request submitted for approval.');
      }
      setForm(current => ({ ...current, reason: '' }));
      setEditingRequestId(null);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Leave request could not be submitted.');
    }
  };

  const editRequest = (request: LeaveRequest) => {
    setEditingRequestId(request.id);
    setForm({
      leaveTypeId: request.leaveTypeId,
      startDate: request.startDate,
      endDate: request.endDate,
      reason: request.reason || '',
    });
  };

  const cancelEdit = () => {
    setEditingRequestId(null);
    setForm({
      leaveTypeId: defaultType?.id || '',
      startDate: todayIso(),
      endDate: todayIso(),
      reason: '',
    });
  };

  const cancelRequest = async (request: LeaveRequest) => {
    try {
      await leaveService.updateRequestStatus(request.id, 'Cancelled', request.status === 'Approved' ? 'Cancelled after approval.' : 'Cancelled before approval.');
      setNotice('Leave request cancelled.');
      if (editingRequestId === request.id) cancelEdit();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Leave request could not be cancelled.');
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.85fr_1.15fr]">
      <div className="space-y-6">
        <Card title="Leave Balance" subtitle={availability ? `${formatHours(availability.availabilityHours)} availability after approved leave and holidays` : 'Balances by leave type'} headerVariant="secondary">
          <div className="space-y-3">
            {balances.map(balance => (
              <div key={balance.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-black text-heading">{balance.leaveTypeName}</p>
                  <Badge variant="info">{balance.year}</Badge>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                  <div><p className="text-xl font-black text-heading">{balance.availableDays.toFixed(1)}</p><p className="text-[10px] font-bold uppercase text-slate-400">Available</p></div>
                  <div><p className="text-xl font-black text-heading">{balance.usedDays.toFixed(1)}</p><p className="text-[10px] font-bold uppercase text-slate-400">Used</p></div>
                  <div><p className="text-xl font-black text-heading">{balance.pendingDays.toFixed(1)}</p><p className="text-[10px] font-bold uppercase text-slate-400">Pending</p></div>
                </div>
              </div>
            ))}
            {balances.length === 0 && <p className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm font-bold text-slate-400">No leave balances configured for your profile.</p>}
          </div>
        </Card>

        <Card title={editingRequestId ? 'Edit Leave Request' : 'New Leave Request'} headerVariant="secondary">
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Leave Type</span>
              <select value={form.leaveTypeId} onChange={event => setForm({ ...form, leaveTypeId: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold">
                {types.filter(type => type.active).map(type => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Start</span>
                <input type="date" value={form.startDate} onChange={event => setForm({ ...form, startDate: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold" />
              </label>
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">End</span>
                <input type="date" value={form.endDate} onChange={event => setForm({ ...form, endDate: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold" />
              </label>
            </div>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Reason</span>
              <textarea value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} className="mt-2 min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium" />
            </label>
            <div className="flex gap-2">
              {editingRequestId && (
                <button className="btn-secondary flex-1 py-2.5" type="button" onClick={cancelEdit}>Discard</button>
              )}
              <button className="btn-primary flex-1 py-2.5" type="submit">{editingRequestId ? 'Save Changes' : 'Submit Request'}</button>
            </div>
          </form>
        </Card>
      </div>
      <LeaveRequestTable requests={requests} onEdit={editRequest} onCancel={cancelRequest} />
    </div>
  );
};

export const MyLeave = () => <ESSHome initialSection="leave" />;

const LeaveRequestTable = ({
  requests,
  onApprove,
  onReject,
  onEdit,
  onCancel,
}: {
  requests: LeaveRequest[];
  onApprove?: (request: LeaveRequest) => void;
  onReject?: (request: LeaveRequest) => void;
  onEdit?: (request: LeaveRequest) => void;
  onCancel?: (request: LeaveRequest) => void;
}) => {
  const hasActions = Boolean(onApprove || onReject || onEdit || onCancel);
  return (
  <Card title="Leave Requests" headerVariant="secondary">
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400">
            <th className="py-3 pr-4">Employee</th>
            <th className="py-3 pr-4">Type</th>
            <th className="py-3 pr-4">Dates</th>
            <th className="py-3 pr-4">Days</th>
            <th className="py-3 pr-4">Status</th>
            {hasActions && <th className="py-3 text-right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {requests.map(request => {
            const canDecide = request.status === 'Submitted';
            const canEdit = request.status === 'Submitted';
            const canCancel = request.status === 'Submitted' || request.status === 'Approved';
            return (
              <tr key={request.id} className="border-b border-slate-50">
                <td className="py-3 pr-4 font-bold text-heading">{request.employeeName || request.employeeId}</td>
                <td className="py-3 pr-4 text-body">{request.leaveTypeName || request.leaveTypeId}</td>
                <td className="py-3 pr-4 text-body">{request.startDate} to {request.endDate}</td>
                <td className="py-3 pr-4 font-black text-heading">{request.totalDays.toFixed(1)}</td>
                <td className="py-3 pr-4"><Badge variant={statusVariant(request.status)}>{request.status}</Badge></td>
                {hasActions && (
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {onEdit && canEdit && (
                        <button type="button" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-600" onClick={() => onEdit(request)}>Edit</button>
                      )}
                      {onApprove && canDecide && (
                        <button type="button" className="rounded-lg border border-green-200 bg-green-50 p-2 text-green-700" title="Approve" onClick={() => onApprove(request)}><CheckCircle2 size={16} /></button>
                      )}
                      {onReject && canDecide && (
                        <button type="button" className="rounded-lg border border-red-200 bg-red-50 p-2 text-red-700" title="Reject" onClick={() => onReject(request)}><XCircle size={16} /></button>
                      )}
                      {onCancel && canCancel && (
                        <button type="button" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-700" onClick={() => onCancel(request)}>Cancel</button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
          {requests.length === 0 && (
            <tr><td className="py-8 text-center text-sm font-bold text-slate-400" colSpan={hasActions ? 6 : 5}>No leave requests in this scope.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  </Card>
  );
};

export const TeamLeaveCalendar = () => {
  const { state, loading, notice, setNotice, refresh } = useLeaveViewState();

  const decide = async (request: LeaveRequest, status: 'Approved' | 'Rejected') => {
    try {
      await leaveService.updateRequestStatus(request.id, status, status === 'Rejected' ? 'Rejected from team calendar.' : undefined);
      setNotice(`${status} leave request for ${request.employeeName || request.employeeId}.`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Leave request decision failed.');
    }
  };

  const cancelRequest = async (request: LeaveRequest) => {
    try {
      await leaveService.updateRequestStatus(request.id, 'Cancelled', 'Cancelled from team calendar.');
      setNotice(`Cancelled leave request for ${request.employeeName || request.employeeId}.`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Leave request cancellation failed.');
    }
  };

  const approved = state.requests.filter(request => request.status === 'Approved');

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Team Leave Calendar"
        subtitle="Scoped leave requests, approved absences, and leave-adjusted availability."
        breadcrumb={['Workforce OS', 'Leave', 'Team Calendar']}
      />
      {notice && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{notice}</div>}
      {loading ? <Card>Loading team leave calendar...</Card> : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <SummaryTile label="Pending Approval" value={state.requests.filter(request => request.status === 'Submitted').length} sub="Requests requiring decision" icon={Clock} />
            <SummaryTile label="Approved Leave" value={approved.length} sub="Approved requests in scope" icon={CheckCircle2} />
            <SummaryTile label="Availability Rows" value={state.availability.length} sub="Employees with capacity view" icon={CalendarDays} />
          </div>
          <LeaveRequestTable requests={state.requests} onApprove={request => decide(request, 'Approved')} onReject={request => decide(request, 'Rejected')} onCancel={cancelRequest} />
          <Card title="Availability Timeline" headerVariant="secondary">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {state.availability.slice(0, 12).map(row => (
                <div key={row.employeeId} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-black text-heading">{row.employeeName}</p>
                    <Badge variant={row.approvedLeaveDays > 0 ? 'warning' : 'success'}>{formatHours(row.availabilityHours)}</Badge>
                  </div>
                  <p className="mt-2 text-xs font-bold text-body/60">{row.approvedLeaveDays} leave days, {row.holidayDays} holidays, {row.standardWeeklyHours}h standard week</p>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
};

export const LeaveAdmin = () => {
  const { state, loading, notice, setNotice, refresh } = useLeaveViewState();
  const [policyName, setPolicyName] = useState('Regional Leave Policy');
  const [country, setCountry] = useState('Global');
  const [allowance, setAllowance] = useState(24);

  const savePolicy = async () => {
    await leaveService.savePolicy({
      id: `leave-policy-${country.toLowerCase().replace(/[^a-z0-9]+/g, '-') || crypto.randomUUID()}`,
      name: policyName,
      country,
      annualAllowanceDays: allowance,
      carryForwardDays: 5,
      accrualMethod: 'Annual',
      status: 'Active',
      leaveTypeIds: state.types.filter(type => type.active).map(type => type.id),
    });
    setNotice('Leave policy saved with audit coverage.');
    await refresh();
  };

  const balanceRows = useMemo(() => state.balances.slice(0, 20), [state.balances]);

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Leave Administration"
        subtitle="Policies, leave types, balances, holiday calendars, and leave reporting."
        breadcrumb={['Workforce OS', 'Leave', 'Administration']}
      />
      {notice && <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-bold text-green-700">{notice}</div>}
      {loading ? <Card>Loading leave administration...</Card> : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-6">
            <Card title="Policy Setup" headerVariant="secondary">
              <div className="space-y-4">
                <input value={policyName} onChange={event => setPolicyName(event.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold" />
                <div className="grid grid-cols-2 gap-3">
                  <input value={country} onChange={event => setCountry(event.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold" />
                  <input type="number" value={allowance} onChange={event => setAllowance(Number(event.target.value))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold" />
                </div>
                <button type="button" onClick={savePolicy} className="btn-primary w-full py-2.5">Save Policy</button>
              </div>
            </Card>
            <Card title="Holiday Calendars" headerVariant="secondary">
              <div className="space-y-3">
                {state.calendars.map(calendar => (
                  <div key={calendar.id} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-black text-heading">{calendar.name}</p>
                      <Badge variant={calendar.status === 'Active' ? 'success' : 'neutral'}>{calendar.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs font-bold text-body/60">{calendar.country} | {calendar.year} | {calendar.holidays.length} holidays</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <div className="space-y-6">
            <Card title="Leave Policies" headerVariant="secondary">
              <div className="space-y-3">
                {state.policies.map(policy => (
                  <div key={policy.id} className="rounded-lg border border-slate-100 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-black text-heading">{policy.name}</p>
                      <Badge variant={policy.status === 'Active' ? 'success' : 'neutral'}>{policy.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs font-bold text-body/60">{policy.country} | {policy.annualAllowanceDays} days | carry forward {policy.carryForwardDays}</p>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Leave Reports" headerVariant="secondary">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400">
                      <th className="py-3 pr-4">Employee</th>
                      <th className="py-3 pr-4">Type</th>
                      <th className="py-3 pr-4">Available</th>
                      <th className="py-3 pr-4">Used</th>
                      <th className="py-3 pr-4">Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balanceRows.map(balance => (
                      <tr key={balance.id} className="border-b border-slate-50">
                        <td className="py-3 pr-4 font-bold text-heading">{balance.employeeName || balance.employeeId}</td>
                        <td className="py-3 pr-4">{balance.leaveTypeName || balance.leaveTypeId}</td>
                        <td className="py-3 pr-4 font-black">{balance.availableDays.toFixed(1)}</td>
                        <td className="py-3 pr-4">{balance.usedDays.toFixed(1)}</td>
                        <td className="py-3 pr-4">{balance.pendingDays.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
};
