import {GovernedActualWork} from '../components/GovernedActualWork';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { KPIStrip } from '../components/ui/KPIStrip';
import { Badge } from '../components/ui/Badge';
import { timesheetService, adminService, utilizationReportService } from '../services/api';
import type { Employee, TimesheetSummary, KPIData, SystemSettings } from '../types';
import { ApiClientError, resetBackendCheck } from '../services/apiClient';
import {
  Download,
  Filter,
  Calendar,
  Search,
  Clock,
  CheckCircle2,
  ArrowUpRight,
  BarChart3,
  Loader2,
  RefreshCw
} from 'lucide-react';
import { cn } from '../lib/utils';
import { getUtilizationEligibleEmployees } from '../services/calculations';
import { formatHours, formatPercent, roundMetric } from '../lib/format';
import { downloadAuditedCsv } from '../lib/reportExport';

function approvedPercent(hours: number, count: number, weeklyHours: number | undefined) {
  if (!weeklyHours || !Number.isFinite(weeklyHours) || weeklyHours <= 0 || count <= 0 || !Number.isFinite(hours)) return null;
  return hours / (count * weeklyHours) * 100;
}
function logPercent(sheet: TimesheetSummary, weeklyHours: number | undefined) {
  return sheet.status === 'Approved' ? approvedPercent(sheet.billableHours, 1, weeklyHours) : null;
}
function logPercentLabel(sheet: TimesheetSummary, actual: number | null) {
  if (sheet.status !== 'Approved') return 'Not approved';
  return actual === null ? 'Unavailable' : formatPercent(actual);
}

function MissingLogWorkers({ workers }: { workers: Employee[] }) {
  const [page, setPage] = useState<number | null>(null);
  const pageSize = 25;
  if (!workers.length) return null;
  return <section aria-label="Workers without logs" className="mb-6">
    <button type="button" className="btn-secondary" aria-expanded={page !== null}
      onClick={() => setPage(page === null ? 0 : null)}>Review workers without logs ({workers.length})</button>
    {page !== null && <div className="mt-3 rounded-xl border border-border-light p-4">
      <p>Eligible workers with no timesheet in the selected period, across all review statuses.</p>
      <ul className="my-3">{workers.slice(page * pageSize, (page + 1) * pageSize).map(worker =>
        <li key={worker.id}>{worker.name}</li>)}</ul>
      {workers.length > pageSize && <div className="flex items-center gap-3">
        <button type="button" className="btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous workers</button>
        <span aria-live="polite">Page {page + 1} of {Math.ceil(workers.length / pageSize)}</span>
        <button type="button" className="btn-secondary" disabled={(page + 1) * pageSize >= workers.length} onClick={() => setPage(page + 1)}>Next workers</button>
      </div>}
    </div>}
  </section>;
}

type ActualStatus = 'loading' | 'ready' | 'access' | 'unavailable' | 'error';
type ActualSnapshot = { employees: Employee[]; timesheets: TimesheetSummary[]; settings: SystemSettings };
type ActualResult = {
  generation: number;
} & ({ status: 'ready'; snapshot: ActualSnapshot } | { status: Exclude<ActualStatus, 'ready'>; snapshot: null });

// Keep the existing report, timesheet (including employee names) and settings readers.
export const readActualUtilization = async (): Promise<ActualSnapshot> => {
  // Retry must recover a cached failed backend availability check as well.
  resetBackendCheck();
  const [report, timesheets, settings] = await Promise.all([
    utilizationReportService.getActual(),
    timesheetService.getAll(),
    adminService.getSettings(),
  ]);
  if (!report || !Array.isArray(report.rows) || !Array.isArray(timesheets) || !settings) {
    throw new TypeError('Report response unavailable');
  }
  return { employees: report.rows, timesheets, settings };
};

export const ActualUtilizationStatus = ({ status, retry }: { status: ActualStatus; retry: () => void }) => {
  if (status === 'ready') return null;
  if (status === 'loading') return (
    <div role="status" className="flex items-center justify-center gap-3 rounded-2xl border border-border-light bg-white p-8">
      <Loader2 aria-hidden="true" className="animate-spin text-primary" size={24} />
      <p className="text-sm font-bold text-heading">Loading actual utilization…</p>
    </div>
  );
  const message = status === 'access' ? 'Access to actual utilization could not be confirmed.'
    : status === 'unavailable' ? 'Actual utilization is unavailable.'
    : 'Actual utilization could not be loaded.';
  return (
    <div role="alert" className="space-y-3 rounded-2xl border border-orange-200 bg-orange-50 p-5 text-heading">
      <p className="text-sm font-bold">{message}</p>
      <p className="text-sm">{status === 'access'
        ? 'Check your sign-in and report access, then retry.'
        : 'Check your connection and retry. If the problem continues, contact your administrator.'}</p>
      <button type="button" onClick={retry} className="btn-secondary px-4 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        Retry actual utilization
      </button>
    </div>
  );
};

export const ActualUtilization = () => {
  const [basis,setBasis]=useState<'compatibility'|'governed'>('compatibility');
  const [result, setResult] = useState<ActualResult>({ status: 'loading', generation: 0, snapshot: null });
  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const loadReport = useCallback(() => {
    // Invalidate before rerender so previously captured export callbacks also fail closed.
    const generation = ++requestVersion.current;
    setResult({ status: 'loading', generation, snapshot: null });
    const current = () => mounted.current && generation === requestVersion.current;
    void Promise.resolve().then(() => current() ? readActualUtilization() : null).then(snapshot => {
      if (current() && snapshot) setResult({ status: 'ready', generation, snapshot });
    }).catch(error => {
      if (!current()) return;
      const status = error instanceof ApiClientError
        ? [401, 403].includes(error.status) ? 'access'
          : [404, 502, 503, 504].includes(error.status) ? 'unavailable' : 'error'
        : 'error';
      setResult({ status, generation, snapshot: null });
    });
  }, []);
  const { status } = result;
  const snapshot = status === 'ready' ? result.snapshot : null;
  const employees = snapshot?.employees || [];
  const timesheets = snapshot?.timesheets || [];
  const settings = snapshot?.settings || null;
  const hasData = status === 'ready' && (employees.length > 0 || timesheets.length > 0);
  const canExport = status === 'ready' && mounted.current && result.generation === requestVersion.current;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [statusFilter, setStatusFilter] = useState<'Consolidated' | 'Approved Only' | 'Pending Review'>('Consolidated');

  useEffect(() => {
    mounted.current = true;
    loadReport();
    return () => { mounted.current = false; requestVersion.current += 1; };
  }, [loadReport]);

  const monthOptions = useMemo(() => {
    return Array.from(new Set<string>(timesheets.map(timesheet => timesheet.weekEnding.slice(0, 7))))
      .sort((a, b) => b.localeCompare(a))
      .map(value => ({
        value,
        label: new Date(`${value}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      }));
  }, [timesheets]);

  useEffect(() => {
    if (monthOptions.length > 0 && selectedMonth !== 'all' && !monthOptions.some(option => option.value === selectedMonth)) {
      setSelectedMonth(monthOptions[0].value);
    }
  }, [monthOptions, selectedMonth]);

  const periodTimesheets = useMemo(() => selectedMonth === 'all' ? timesheets :
    timesheets.filter(sheet => sheet.weekEnding.startsWith(selectedMonth)), [timesheets, selectedMonth]);
  const eligibleWorkers = useMemo(() => getUtilizationEligibleEmployees(employees), [employees]);
  const missingWorkers = useMemo(() => {
    const logged = new Set(periodTimesheets.map(sheet => sheet.employeeId));
    return eligibleWorkers.filter(worker => !logged.has(worker.id)).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [eligibleWorkers, periodTimesheets]);
  const scopedTimesheets = useMemo(() => periodTimesheets.filter(sheet => statusFilter === 'Consolidated'
    || (statusFilter === 'Approved Only' && sheet.status === 'Approved')
    || (statusFilter === 'Pending Review' && sheet.status === 'Submitted')), [periodTimesheets, statusFilter]);

  const filteredLogs = useMemo(() => {
    return scopedTimesheets.filter(ts => ts.employeeName.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [scopedTimesheets, searchQuery]);

  const kpis = useMemo<KPIData[]>(() => {
    if (employees.length === 0) return [];

    const active = eligibleWorkers;

    // Average actual utilization across approved timesheets in the current scope
    const approvedTimesheets = scopedTimesheets.filter(timesheet => timesheet.status === 'Approved');
    const totalBillableHours = approvedTimesheets.reduce((sum, ts) => sum + ts.billableHours, 0);
    const avgActual = approvedPercent(totalBillableHours, approvedTimesheets.length, settings?.expectedWeeklyHours);

    const pendingReview = scopedTimesheets.filter(t => t.status === 'Submitted').length;
    const approved = scopedTimesheets.filter(t => t.status === 'Approved').length;
    const total = scopedTimesheets.length;
    const submissionRate = total > 0 ? ((approved + pendingReview) / total * 100) : 0;
    const latestApprovedByEmployee = new Map<string, TimesheetSummary>();
    approvedTimesheets
      .sort((a, b) => new Date(a.weekEnding).getTime() - new Date(b.weekEnding).getTime())
      .forEach(timesheet => latestApprovedByEmployee.set(timesheet.employeeId, timesheet));
    const employeesWithApprovedScope = active.filter(employee => latestApprovedByEmployee.has(employee.id));
    const variances = employeesWithApprovedScope.flatMap(employee => {
      const actual = logPercent(latestApprovedByEmployee.get(employee.id)!, settings?.expectedWeeklyHours);
      return actual === null ? [] : [Math.abs(employee.plannedUtilization - roundMetric(actual))];
    });
    const loggingVariance = variances.length ? variances.reduce((sum, gap) => sum + gap, 0) / variances.length : null;

    return [
      { title: 'Avg. Actual Util.', value: avgActual === null ? 'Unavailable' : formatPercent(avgActual), icon: 'Zap' },
      { title: 'Submission Rate', value: formatPercent(submissionRate), icon: 'CheckCircle2' },
      { title: 'Pending Review', value: pendingReview, icon: 'Timer' },
      { title: 'Approved Logs', value: approved, icon: 'FileCheck' },
      { title: 'Logging Variance', value: loggingVariance === null ? 'Unavailable' : formatPercent(loggingVariance), icon: 'AlertTriangle' },
      { title: 'Workers Without Logs', value: missingWorkers.length, icon: 'Clock' }
    ];
  }, [employees, eligibleWorkers, missingWorkers, scopedTimesheets, settings]);

  const weeklyReconciliation = useMemo(() => {
    const active = eligibleWorkers;
    const activeById = new Map(active.map(employee => [employee.id, employee]));
    const weeks = Array.from(new Set<string>(scopedTimesheets.map(timesheet => timesheet.weekEnding)))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
      .slice(0, 6);

    return weeks.map(weekEnding => {
      const weekSheets = scopedTimesheets.filter(timesheet => timesheet.weekEnding === weekEnding);
      const submittedSheets = periodTimesheets.filter(sheet => sheet.weekEnding === weekEnding && sheet.status !== 'Draft' && activeById.has(sheet.employeeId));
      const approvedSheets = weekSheets.filter(timesheet => timesheet.status === 'Approved');
      const submittedEmployeeIds = new Set<string>(submittedSheets.map(timesheet => timesheet.employeeId));
      const approvedEmployeeIds = new Set<string>(approvedSheets.map(timesheet => timesheet.employeeId));
      const plannedEmployees = Array.from(approvedEmployeeIds)
        .map(employeeId => activeById.get(employeeId))
        .filter(Boolean) as Employee[];
      const planned = plannedEmployees.length > 0 && plannedEmployees.length === approvedEmployeeIds.size
        ? plannedEmployees.reduce((sum, employee) => sum + employee.plannedUtilization, 0) / plannedEmployees.length
        : null;
      const actualHours = approvedSheets.reduce((sum, timesheet) => sum + timesheet.billableHours, 0);
      const actual = approvedPercent(actualHours, approvedEmployeeIds.size, settings?.expectedWeeklyHours);

      return {
        weekEnding,
        weekLabel: new Date(`${weekEnding}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        planned: planned === null ? null : Math.round(planned),
        actual: actual === null ? null : Math.round(actual),
        gap: actual === null || planned === null ? null : Math.round(actual - planned),
        coverage: active.length ? Math.round((submittedEmployeeIds.size / active.length) * 100) : null,
        pending: weekSheets.filter(timesheet => timesheet.status === 'Submitted').length,
      };
    });
  }, [eligibleWorkers, periodTimesheets, scopedTimesheets, settings]);

  const varianceWatchlist = useMemo(() => {
    const expectedWeeklyHours = settings?.expectedWeeklyHours;
    return employees
      .filter(employee => getUtilizationEligibleEmployees([employee]).length > 0)
      .map(employee => {
        const latestApproved = scopedTimesheets
          .filter(timesheet => timesheet.employeeId === employee.id && timesheet.status === 'Approved')
          .sort((a, b) => new Date(a.weekEnding).getTime() - new Date(b.weekEnding).getTime())
          .at(-1);
        if (!latestApproved) return null;
        const percentage = logPercent(latestApproved, expectedWeeklyHours);
        if (percentage === null) return null;
        const actual = roundMetric(percentage);
        const planned = Math.round(employee.plannedUtilization);
        return {
          employee,
          planned,
          actual,
          gap: actual - planned,
          weekEnding: latestApproved.weekEnding,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
      .slice(0, 5);
  }, [employees, scopedTimesheets, settings]);

  const submittedTimesheets = scopedTimesheets.filter(timesheet => timesheet.status !== 'Draft');
  const approvalRate = submittedTimesheets.length > 0
    ? (scopedTimesheets.filter(timesheet => timesheet.status === 'Approved').length / submittedTimesheets.length) * 100
    : 0;

  const exportActualRows = (fileName: string, rows: object[]) => {
    if (status !== 'ready' || !mounted.current || result.generation !== requestVersion.current) return;
    void downloadAuditedCsv(fileName, rows, 'Actual Utilization');
  };

  const handleGlobalReport = () => {
    if (status !== 'ready' || !mounted.current || result.generation !== requestVersion.current) return;
    exportActualRows(
      'actual-utilization-global-report.csv',
      scopedTimesheets.map(timesheet => ({
        employeeId: timesheet.employeeId,
        employeeName: timesheet.employeeName,
        weekEnding: timesheet.weekEnding,
        totalHours: timesheet.totalHours,
        billableHours: timesheet.billableHours,
        actualUtilization: logPercentLabel(timesheet, logPercent(timesheet, settings?.expectedWeeklyHours)),
        status: timesheet.status,
        submittedAt: timesheet.submittedAt || '',
        approvedAt: timesheet.approvedAt || '',
        rejectedAt: timesheet.rejectedAt || '',
        rejectionReason: timesheet.rejectionReason || '',
      }))
    );
  };

  const handleAuditExport = () => {
    if (status !== 'ready' || !mounted.current || result.generation !== requestVersion.current) return;
    exportActualRows(
      'actual-utilization-visible-logs.csv',
      filteredLogs.map(timesheet => ({
        employeeId: timesheet.employeeId,
        employeeName: timesheet.employeeName,
        weekEnding: timesheet.weekEnding,
        totalHours: timesheet.totalHours,
        billableHours: timesheet.billableHours,
        status: timesheet.status,
        entries: JSON.stringify(timesheet.entries),
      }))
    );
  };

  if(basis==='governed')return <div><PageHeader title="Governed actual utilization" subtitle="Approved included work divided by effective eligible available capacity." breadcrumb={['Reports','Actual utilization']}/><button className="rounded border p-2" onClick={()=>setBasis('compatibility')}>Use compatibility report</button><GovernedActualWork mode="report"/></div>;
  return (
    <div className="animate-in fade-in duration-500 pb-12">
      <PageHeader
        title="Actual Utilization"
        subtitle="Average actual utilization divides approved billable hours by configured weekly hours per approved log."
        breadcrumb={['Reports', 'Utilization']}
        actions={
          <div className="flex flex-wrap items-center gap-3">
             <button type="button" onClick={loadReport} aria-label="Refresh actual utilization" className="btn-secondary py-2.5 px-4 flex items-center gap-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                <RefreshCw aria-hidden="true" size={14} /> Refresh
             </button>
             <div className="flex items-center bg-white border border-border-light rounded-xl p-1 shadow-sm mr-2 font-bold uppercase tracking-widest text-[10px]">
                <label className="px-4 flex items-center gap-2 border-r border-gray-100 h-full py-1.5 cursor-pointer hover:bg-slate-50 transition-colors rounded-l-lg">
                   <Calendar size={14} className="text-primary" />
                   <select
                     value={selectedMonth}
                     onChange={(event) => setSelectedMonth(event.target.value)}
                     className="bg-transparent text-heading outline-none cursor-pointer uppercase tracking-widest font-bold"
                     aria-label="Select actual utilization period"
                   >
                     <option value="all">All Periods</option>
                     {monthOptions.map(option => (
                       <option key={option.value} value={option.value}>{option.label}</option>
                     ))}
                   </select>
                </label>
                <label className="px-4 flex items-center gap-2 h-full py-1.5 cursor-pointer hover:bg-slate-50 transition-colors rounded-r-lg">
                   <Filter size={14} className="text-primary" />
                   <select
                     value={statusFilter}
                     onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
                     className="bg-transparent text-heading outline-none cursor-pointer uppercase tracking-widest font-bold"
                     aria-label="Filter actual utilization logs"
                   >
                     <option>Consolidated</option>
                     <option>Approved Only</option>
                     <option>Pending Review</option>
                   </select>
                </label>
             </div>
             <button
               type="button"
               onClick={handleGlobalReport}
               disabled={!canExport}
               className="btn-secondary py-2.5 px-5 flex items-center gap-2 shadow-sm font-bold text-xs uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
             >
                <Download size={14} /> Global Report
             </button>
          </div>
        }
      />

      <p>Compatibility report: retained legacy billable/global-hours figures. The governed selected-period calculation is separate.</p><button className="rounded border p-2" onClick={()=>setBasis('governed')}>Use governed period</button>
      <ActualUtilizationStatus status={status} retry={loadReport} />
      {status === 'ready' && !hasData && (
        <div className="space-y-4 rounded-2xl border border-border-light bg-white p-8 text-center text-sm font-bold text-slate-600">
          <p role="status">No actual utilization data was returned.</p>
          <button
            type="button"
            onClick={handleAuditExport}
            disabled={!canExport}
            className="btn-secondary mx-auto py-1.5 px-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Download size={12} /> Audit Trail
          </button>
        </div>
      )}

      {hasData && <>
      <KPIStrip kpis={kpis} />
      <div key={selectedMonth + result.generation}><MissingLogWorkers workers={missingWorkers} /></div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="lg:col-span-2 bg-white border border-border-light rounded-3xl p-6 shadow-sm">
          <div className="flex items-start justify-between gap-6 mb-6">
            <div>
              <h3 className="text-sm font-bold text-heading">Actual vs Planned Reconciliation</h3>
              <p className="text-xs text-gray-600">Weekly actual uses approved billable hours divided by configured weekly hours per approved worker. A gap requires planned utilization for the same workers. Coverage counts eligible workers with a non-draft log that week across all statuses.</p>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-1">Approved effort compared with allocation plan by week</p>
            </div>
            <div className="hidden sm:flex items-center gap-4 text-[9px] font-bold uppercase tracking-widest text-gray-400">
               <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-primary" />
                  <span>Actual</span>
               </div>
               <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-slate-300" />
                  <span>Planned</span>
               </div>
            </div>
          </div>

          <div className="space-y-4">
            {weeklyReconciliation.map(row => {
              const varianceTone = row.gap === null ? 'text-gray-500' : Math.abs(row.gap) >= 20 ? 'text-danger' : Math.abs(row.gap) >= 10 ? 'text-primary' : 'text-success';
              return (
                <div key={row.weekEnding} className="grid grid-cols-1 xl:grid-cols-[92px_1fr_220px] gap-4 items-center p-4 bg-slate-50/60 rounded-2xl border border-slate-100">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Week Ending</p>
                    <p className="text-sm font-bold text-heading mt-1">{row.weekLabel}</p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <span className="w-14 text-[10px] font-bold uppercase tracking-widest text-gray-400">Actual</span>
                      <div className="flex-1 h-3 bg-white border border-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${Math.min(row.actual ?? 0, 100)}%` }} />
                      </div>
                      <span className="w-12 text-right text-xs font-bold text-heading">{row.actual === null ? 'N/A' : formatPercent(row.actual)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="w-14 text-[10px] font-bold uppercase tracking-widest text-gray-400">Planned</span>
                      <div className="flex-1 h-3 bg-white border border-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-slate-300 rounded-full" style={{ width: `${Math.min(row.planned ?? 0, 100)}%` }} />
                      </div>
                      <span className="w-12 text-right text-xs font-bold text-heading">{row.planned === null ? 'N/A' : formatPercent(row.planned)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-white rounded-xl border border-slate-100 p-3">
                      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Gap</p>
                      <p className={cn("text-sm font-bold mt-1", varianceTone)}>{row.gap === null ? 'N/A' : (row.gap > 0 ? '+' : '') + formatPercent(row.gap)}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-100 p-3">
                      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Coverage</p>
                      <p className="text-sm font-bold text-heading mt-1">{row.coverage === null ? 'N/A' : formatPercent(row.coverage)}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-100 p-3">
                      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Review</p>
                      <p className="text-sm font-bold text-heading mt-1">{row.pending}</p>
                    </div>
                  </div>
                </div>
              );
            })}
            {weeklyReconciliation.length === 0 && (
              <div className="h-[260px] flex items-center justify-center bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                <p role="status" className="text-xs font-bold text-gray-400 uppercase tracking-widest">No weekly utilization logs available</p>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white border border-border-light rounded-3xl p-6 shadow-sm flex flex-col">
          <div className="mb-6">
            <h3 className="text-sm font-bold text-heading">Variance Watchlist</h3>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-1">Largest actual vs planned gaps</p>
          </div>

          <div className="space-y-3">
            {varianceWatchlist.map(item => (
              <div key={item.employee.id} className="p-4 bg-slate-50/60 rounded-2xl border border-slate-100">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-heading truncate">{item.employee.name}</p>
                    <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mt-1">{item.employee.department}</p>
                  </div>
                  <Badge variant={Math.abs(item.gap) >= 20 ? 'danger' : 'warning'}>
                    {item.gap > 0 ? '+' : ''}{formatPercent(item.gap)}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <div className="bg-white border border-slate-100 rounded-xl p-3">
                    <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Planned</p>
                    <p className="text-sm font-bold text-heading mt-1">{item.planned}%</p>
                  </div>
                  <div className="bg-white border border-slate-100 rounded-xl p-3">
                    <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Actual</p>
                    <p className="text-sm font-bold text-primary mt-1">{formatPercent(item.actual)}</p>
                  </div>
                </div>
              </div>
            ))}
            {varianceWatchlist.length === 0 && (
              <div className="h-full min-h-[260px] flex items-center justify-center bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                <p role="status" className="text-xs font-bold text-gray-400 uppercase tracking-widest text-center">No approved variance data yet</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="bg-white border border-border-light rounded-2xl p-5 shadow-sm hover:shadow-md transition-all group">
           <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                 <span className="w-8 h-8 rounded-xl bg-bg-secondary text-primary flex items-center justify-center group-hover:bg-primary group-hover:text-white transition-colors">
                   <Clock size={16} />
                 </span>
                 <h4 className="text-[10px] font-bold text-heading uppercase tracking-widest">Pending Logs</h4>
              </div>
              <ArrowUpRight size={14} className="text-gray-400" />
           </div>
           <div className="space-y-3">
              <div className="flex items-center justify-between">
                 <span className="text-xs font-bold text-heading">Current Cycle</span>
                 <Badge variant="neutral">{scopedTimesheets.filter(t => t.status === 'Submitted').length} Pending</Badge>
              </div>
              <p className="text-[10px] text-gray-500 font-medium leading-relaxed">System audit flags variations in submission rate for distributed units.</p>
           </div>
        </div>

        <div className="bg-white border border-border-light rounded-2xl p-5 shadow-sm hover:shadow-md transition-all group">
           <div className="flex items-center gap-2 mb-4">
              <span className="w-8 h-8 rounded-xl bg-bg-secondary text-primary flex items-center justify-center group-hover:bg-primary group-hover:text-white transition-colors">
                <CheckCircle2 size={16} />
              </span>
              <h4 className="text-[10px] font-bold text-heading uppercase tracking-widest">Approval Health</h4>
           </div>
           <p className="text-xs text-body/70 font-medium mb-3 leading-relaxed">Most submitted effort has been vetted and processed for the current cycle.</p>
           <div className="w-full h-1 bg-gray-100 rounded-full overflow-hidden mt-auto">
              <div className="h-full bg-success" style={{ width: `${Math.min(approvalRate, 100)}%` }}></div>
           </div>
        </div>

        <div className="lg:col-span-2 bg-slate-dark text-white rounded-2xl p-6 flex flex-col justify-between shadow-xl">
           <div className="flex items-center gap-3">
              <BarChart3 size={18} className="text-primary" />
              <h4 className="text-sm font-bold tracking-tight">Timesheet Integrity Metric</h4>
           </div>
           <p className="text-xs text-white/50 mt-3 leading-relaxed font-medium line-clamp-2">
             Actual utilization calculations rely on 'Approved' timesheet signatures. Variances between logged and planned
             effort are audited for invoicing integrity.
           </p>
        </div>
      </div>

      {/* Drill Down Table */}
      <div className="bg-white border border-border-light rounded-3xl overflow-hidden shadow-sm">
        <div className="p-6 border-b border-gray-50 flex items-center justify-between bg-slate-50/50">
           <div className="flex items-center gap-4">
              <h3 className="text-sm font-bold text-heading">Service Delivery Logs</h3>
              <div className="relative">
                 <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={12} />
                 <input
                   type="text"
                   placeholder="Search consultant..."
                   value={searchQuery}
                   onChange={(e) => setSearchQuery(e.target.value)}
                   className="bg-white border border-border-light rounded-lg py-1.5 pl-8 pr-3 text-[10px] outline-none focus:border-primary w-48 font-bold shadow-sm"
                 />
              </div>
           </div>
           <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAuditExport}
                disabled={!canExport}
                className="btn-secondary py-1.5 px-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                 <Download size={12} /> Audit Trail
              </button>
           </div>
        </div>

        <div className="table-container shadow-none border-none">
          <table className="w-full text-left">
            <thead className="bg-white/50 border-b border-border-light">
              <tr>
                <th className="py-4 px-8 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Consultant</th>
                <th className="py-4 px-6 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Week Ending</th>
                <th className="py-4 px-6 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Total Hours</th>
                <th className="py-4 px-6 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Billable %</th>
                <th className="py-4 px-6 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Actual Util.</th>
                <th className="py-4 px-8 text-[10px] font-bold text-right uppercase tracking-widest">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light font-bold">
              {filteredLogs.map((ts, idx) => {
                const util = logPercent(ts, settings?.expectedWeeklyHours);
                const billableP = ts.totalHours > 0 ? (ts.billableHours / ts.totalHours) * 100 : 0;

                return (
                  <tr key={idx} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="py-5 px-8">
                       <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded bg-bg-secondary flex items-center justify-center font-bold text-xs text-primary shadow-sm border border-border-light/40">
                             {ts.employeeName.split(' ').map(n => n[0]).join('')}
                          </div>
                          <div>
                            <p className="text-sm font-bold text-heading group-hover:text-primary transition-colors">{ts.employeeName}</p>
                            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Consultant Log</p>
                          </div>
                       </div>
                    </td>
                    <td className="py-5 px-6 font-mono text-xs text-gray-500 font-bold">{ts.weekEnding}</td>
                    <td className="py-5 px-6 text-center">
                       <span className="text-sm font-bold text-heading">{formatHours(ts.totalHours)}</span>
                    </td>
                    <td className="py-5 px-6 text-center">
                       <span className={cn(
                         "text-[10px] font-bold px-2 py-1 rounded-md",
                         billableP > 80 ? "text-success bg-green-50" : "text-gray-500 bg-gray-50"
                       )}>{formatPercent(billableP, 0)}</span>
                    </td>
                    <td className="py-5 px-6 text-center">
                       <div className="flex flex-col items-center">
                          <span className={cn(
                             "text-sm font-bold",
                             util === null ? "text-gray-500" : util > 100 ? "text-danger" : util >= 80 ? "text-heading" : "text-primary"
                          )}>{logPercentLabel(ts, util)}</span>
                          {util !== null && <div className="w-20 h-1 bg-gray-100 rounded-full mt-1 overflow-hidden">
                             <div className={cn("h-full transition-all duration-500", util > 100 ? "bg-danger" : "bg-primary")} style={{ width: `${Math.min(util, 100)}%` }} />
                          </div>}
                       </div>
                    </td>
                    <td className="py-5 px-8 text-right">
                       <Badge variant={ts.status === 'Approved' ? 'success' : ts.status === 'Submitted' ? 'warning' : 'neutral'}>
                          {ts.status}
                       </Badge>
                    </td>
                  </tr>
                );
              })}
              {filteredLogs.length === 0 && (
                <tr>
                   <td colSpan={6} className="py-12 text-center text-gray-400 font-bold uppercase tracking-widest text-xs">
                     <p role="status">{timesheets.length === 0 ? 'No service delivery logs recorded' : 'No service delivery logs match the selected filters.'}</p>
                   </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>}
    </div>
  );
};
