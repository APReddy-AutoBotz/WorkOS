import {nativeCheckpoint} from '../../shared/native-forecast.mjs';
import {GovernedNativeForecast} from '../components/GovernedNativeForecast';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { KPIStrip } from '../components/ui/KPIStrip';
import { Badge } from '../components/ui/Badge';
import { employeeService, projectService, allocationService, adminService, utilizationReportService } from '../services/api';
import type { Allocation, Employee, Project, KPIData, SystemSettings } from '../types';
import { ApiClientError, resetBackendCheck } from '../services/apiClient';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend
} from 'recharts';
import {
  Download,
  Search,
  TrendingUp,
  AlertTriangle,
  Users,
  Briefcase,
  ChevronRight,
  ShieldAlert,
  Zap,
  Target,
  Loader2,
  Calendar,
  Info,
  RefreshCw
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Link } from 'react-router-dom';
import { getAllocationLoad, isProjectAvailableForPlanning, overlapsDateRange, isUtilizationEligibleEmployee } from '../services/calculations';
import { formatPercent, roundMetric } from '../lib/format';
import { downloadAuditedCsv } from '../lib/reportExport';

import { productConfig } from '../config/productConfig';
type ForecastStatus = 'loading' | 'ready' | 'access' | 'unavailable' | 'error';
type ForecastSnapshot = {
  employees: Employee[];
  projects: Project[];
  allocations: Allocation[];
  settings: SystemSettings;
  sourceDate: string;
  horizonDate: string;
  forecastReportEmployees: Employee[];
};
type ForecastResult = {
  generation: number;
  horizon: string;
} & ({ status: 'ready'; snapshot: ForecastSnapshot } | { status: Exclude<ForecastStatus, 'ready'>; snapshot: null });

// Preserve all five existing readers, including their nested and duplicate requests.
export const readForecastUtilization = async (horizonMonths: number): Promise<ForecastSnapshot> => {
  resetBackendCheck();
  const [employees, projects, allocations, settings, report] = await Promise.all([
    employeeService.getAll(),
    projectService.getAll(),
    allocationService.getAll(),
    adminService.getSettings(),
    utilizationReportService.getForecast(horizonMonths),
  ]);
  if (!Array.isArray(employees) || !Array.isArray(projects) || !Array.isArray(allocations)
    || !settings || !report || !Array.isArray(report.rows) || report.mode !== 'forecast' || report.forecastMonths !== horizonMonths
    || nativeCheckpoint(report.sourceDate, horizonMonths) !== report.asOfDate) {
    throw new TypeError('Report response unavailable');
  }
  return { employees, projects, allocations, settings, sourceDate: report.sourceDate, horizonDate: report.asOfDate, forecastReportEmployees: report.rows };
};

export const ForecastUtilizationStatus = ({ status, retry }: { status: ForecastStatus; retry: () => void }) => {
  if (status === 'ready') return null;
  if (status === 'loading') return (
    <div role="status" className="flex items-center justify-center gap-3 rounded-2xl border border-border-light bg-white p-8">
      <Loader2 aria-hidden="true" className="animate-spin text-primary" size={24} />
      <p className="text-sm font-bold text-heading">Loading forecast utilization…</p>
    </div>
  );
  const message = status === 'access' ? 'Access to forecast utilization could not be confirmed.'
    : status === 'unavailable' ? 'Forecast utilization is unavailable.'
    : 'Forecast utilization could not be loaded.';
  return (
    <div role="alert" className="space-y-3 rounded-2xl border border-orange-200 bg-orange-50 p-5 text-heading">
      <p className="text-sm font-bold">{message}</p>
      <p className="text-sm">{status === 'access'
        ? 'Check your sign-in and report access, then retry.'
        : 'Check your connection and retry. If the problem continues, contact your administrator.'}</p>
      <button type="button" onClick={retry} className="btn-secondary px-4 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        Retry forecast utilization
      </button>
    </div>
  );
};

export const ForecastUtilization = () => {
  const [basis,setBasis]=useState<'compatibility'|'native'>('compatibility');
  const [horizon, setHorizon] = useState('3 Months');
  const [result, setResult] = useState<ForecastResult>({ status: 'loading', generation: 0, horizon: '3 Months', snapshot: null });
  const requestVersion = useRef(0);
  const selectedHorizon = useRef('3 Months');
  const mounted = useRef(false);
  const loadReport = useCallback((nextHorizon = selectedHorizon.current) => {
    if (!mounted.current) return;
    // Invalidate synchronously, before rerender, including previously captured exports.
    const generation = ++requestVersion.current;
    selectedHorizon.current = nextHorizon;
    setResult({ status: 'loading', generation, horizon: nextHorizon, snapshot: null });
    const current = () => mounted.current && generation === requestVersion.current && nextHorizon === selectedHorizon.current;
    void Promise.resolve().then(() => current() ? readForecastUtilization(Number(nextHorizon.split(' ')[0])) : null).then(snapshot => {
      if (current() && snapshot) setResult({ status: 'ready', generation, horizon: nextHorizon, snapshot });
    }).catch(error => {
      if (!current()) return;
      const status = error instanceof ApiClientError
        ? [401, 403].includes(error.status) ? 'access'
          : [404, 502, 503, 504].includes(error.status) ? 'unavailable' : 'error'
        : 'error';
      setResult({ status, generation, horizon: nextHorizon, snapshot: null });
    });
  }, []);
  const selectHorizon = (nextHorizon: string) => {
    if (!mounted.current || nextHorizon === selectedHorizon.current) return;
    loadReport(nextHorizon);
    setHorizon(nextHorizon);
  };
  const canExport = result.status === 'ready' && mounted.current && result.generation === requestVersion.current
    && result.horizon === horizon && result.horizon === selectedHorizon.current;
  const status = result.status === 'ready' && !canExport ? 'loading' : result.status;
  const snapshot = result.status === 'ready' && canExport ? result.snapshot : null;
  const employees = snapshot?.employees || [];
  const projects = snapshot?.projects || [];
  const allocations = snapshot?.allocations || [];
  const forecastReportEmployees = snapshot?.forecastReportEmployees || [];
  const settings = snapshot?.settings || { utilizationThresholdHigh: 100, utilizationThresholdLow: 70 };
  const hasData = status === 'ready' && (employees.length > 0 || projects.length > 0 || allocations.length > 0 || forecastReportEmployees.length > 0);
  const [searchQuery, setSearchQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('All Departments');

  const horizonMonths = useMemo(() => Number(horizon.split(' ')[0]), [horizon]);
  const sourceDate = snapshot?.sourceDate;
  const horizonDate = snapshot?.horizonDate;
  const forecastPoints = useMemo(() => {
    if (!sourceDate) return [];
    return Array.from({ length: horizonMonths + 1 }, (_, index) => {
      const iso = nativeCheckpoint(sourceDate, index);
      return { index, iso, label: index === 0 ? 'Now' : '+' + index + 'M', period: iso };
    });
  }, [sourceDate, horizonMonths]);

  const getEmployeeForecastAt = (employeeId: string, dateIso: string) => {
    return roundMetric(getAllocationLoad(employeeId, allocations, projects, dateIso, dateIso, true));
  };

  useEffect(() => {
    mounted.current = true;
    loadReport();
    return () => { mounted.current = false; requestVersion.current += 1; };
  }, [loadReport]);

  const forecastReportByEmployeeId = useMemo(() => {
    return new Map(forecastReportEmployees.map(employee => [employee.id, employee]));
  }, [forecastReportEmployees]);

  const supplyDemandData = useMemo(() => {
    if (employees.length === 0) return [];
    return forecastPoints.map(point => {
      const eligibleIds = new Set(employees.filter(employee =>
        isUtilizationEligibleEmployee(employee, allocations, projects, point.iso, true)
      ).map(employee => employee.id));
      const available = projects.filter(project => isProjectAvailableForPlanning(project, point.iso, point.iso, true));
      const projectLoads = new Map<string, number>(available.map(project => [project.id, 0] as const));
      let demand = 0;
      for (const allocation of allocations) {
        const load = projectLoads.get(allocation.projectId);
        if (load === undefined || !eligibleIds.has(allocation.employeeId) || allocation.status !== 'Active'
          || !overlapsDateRange(allocation.startDate, allocation.endDate, point.iso, point.iso)) continue;
        demand += allocation.percentage;
        projectLoads.set(allocation.projectId, load + allocation.percentage);
      }
      const capacity = eligibleIds.size * 100;
      return {
        period: point.period, capacity, demand,
        pressure: capacity > 0 ? demand / capacity * 100 : null,
        projectsBelowFullAllocation: [...projectLoads.values()].filter(load => load < 100).length,
      };
    });
  }, [employees, allocations, projects, forecastPoints]);

  const forecastRows = useMemo(() => {
    return employees
      .filter(emp => forecastPoints.some(point => isUtilizationEligibleEmployee(emp, allocations, projects, point.iso, true)))
      .map(emp => {
        const snapshots = forecastPoints.map(point => ({
          ...point,
          load: getEmployeeForecastAt(emp.id, point.iso),
        }));
        const futureSnapshots = snapshots.slice(1);
        const horizonLoad = forecastReportByEmployeeId.get(emp.id)?.plannedUtilization ?? snapshots.at(-1)?.load ?? 0;
        const peakLoad = Math.max(...snapshots.map(snapshot => snapshot.load), 0);
        const averageLoad = futureSnapshots.length
          ? futureSnapshots.reduce((sum, snapshot) => sum + snapshot.load, 0) / futureSnapshots.length
          : snapshots[0]?.load || 0;

        return {
          employee: emp,
          snapshots,
          horizonLoad,
          peakLoad,
          averageLoad: roundMetric(averageLoad),
          status: peakLoad > settings.utilizationThresholdHigh
            ? 'Overload'
            : horizonLoad === 0
              ? 'Future Bench'
              : averageLoad < settings.utilizationThresholdLow
                ? 'Low Demand'
                : 'Stable',
        };
      });
  }, [employees, forecastPoints, allocations, projects, settings, forecastReportByEmployeeId]);

  const filteredFuture = useMemo(() => {
    return forecastRows.filter(row => {
      const emp = row.employee;
      const matchesSearch = emp.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           emp.employeeId.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesDept = deptFilter === 'All Departments' || emp.department === deptFilter;
      return matchesSearch && matchesDept;
    });
  }, [forecastRows, searchQuery, deptFilter]);

  const highPressureMonth = useMemo(() => supplyDemandData
    .flatMap(point => point.pressure === null ? [] : [{ ...point, pressure: point.pressure }])
    .sort((a,b) => b.pressure - a.pressure)[0], [supplyDemandData]);

  const kpis = useMemo<KPIData[]>(() => {
    if (!horizonDate || employees.length === 0) return [];
    const horizonForecasts = forecastRows.map(row => row.horizonLoad);
    const peakForecasts = forecastRows.map(row => row.peakLoad);
    const projectedAvg = forecastRows.length > 0 ? roundMetric(horizonForecasts.reduce((sum, value) => sum + value, 0) / forecastRows.length) : 0;
    const futureBench = horizonForecasts.filter(value => value === 0).length;
    const horizonPoint = supplyDemandData.at(-1);
    return [
      { title: 'Projected Avg. Util.', value: forecastRows.length ? formatPercent(projectedAvg) : 'Unavailable', icon: 'TrendingUp' },
      { title: 'Projects below 100% allocation', value: horizonPoint?.capacity ? horizonPoint.projectsBelowFullAllocation : 'Unavailable', icon: 'Users' },
      { title: 'Overload Risk', value: peakForecasts.filter(value => value > settings.utilizationThresholdHigh).length, icon: 'AlertTriangle' },
      { title: 'Future Bench', value: futureBench, icon: 'Briefcase' },
      { title: 'Demand Pressure', value: !highPressureMonth ? 'Unavailable' : highPressureMonth.pressure > 90 ? 'Above threshold' : 'Within threshold', icon: 'Activity' },
      { title: 'Active Horizon', value: horizon, icon: 'Calendar' }
    ];
  }, [employees, horizon, horizonDate, forecastRows, supplyDemandData, settings, highPressureMonth]);

  const rollOffs = useMemo(() => {
    if (!sourceDate || !horizonDate) return [];
    return allocations
      .filter(a => {
        const end = a.endDate.slice(0,10);
        return a.status === 'Active' && end >= sourceDate && end <= horizonDate;
      })
      .map(a => {
        const employee = employees.find(e => e.id === a.employeeId);
        const project = projects.find(p => p.id === a.projectId);
        if (!employee || !project) return null;
        return {
          id: a.id,
          employeeId: employee.id,
          name: employee.name,
          project: a.projectName,
          client: project.client,
          load: a.percentage,
          endTime: new Date(a.endDate).getTime(),
          date: new Date(a.endDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
        };
      })
      .filter((item): item is {
        id: string;
        employeeId: string;
        name: string;
        project: string;
        client: string;
        load: number;
        endTime: number;
        date: string;
      } => Boolean(item))
      .sort((a, b) => a.endTime - b.endTime)
      .slice(0, 5);
  }, [employees, projects, allocations, sourceDate, horizonDate]);

  const futureBenchRows = useMemo(() => {
    return forecastRows
      .filter(row => row.horizonLoad === 0)
      .sort((a, b) => b.employee.plannedUtilization - a.employee.plannedUtilization)
      .slice(0, 5);
  }, [forecastRows]);
  const futureBenchCount = useMemo(() => forecastRows.filter(row => row.horizonLoad === 0).length, [forecastRows]);

  const handleExport = () => {
    if (!canExport || !mounted.current || result.generation !== requestVersion.current
      || result.horizon !== selectedHorizon.current || horizon !== selectedHorizon.current) return;
    void downloadAuditedCsv('forecast-utilization-export.csv', filteredFuture.map(row => ({
      employeeId: row.employee.employeeId,
      name: row.employee.name,
      department: row.employee.department,
      country: row.employee.country,
      currentPlannedUtilization: row.employee.plannedUtilization,
      averageFutureLoad: row.averageLoad,
      peakForecastLoad: row.peakLoad,
      horizonLoad: row.horizonLoad,
      status: row.status,
      ...Object.fromEntries(row.snapshots.map(snapshot => [snapshot.label, snapshot.load])),
      horizon, sourceDate, horizonDate,
    })), 'Forecast Utilization');
  };


  if(basis==='native')return <div><PageHeader title="Native percentage forecast" subtitle="Recorded assignments with explicit checkpoint and source authority." breadcrumb={['Reports','Forecast']}/><button onClick={()=>setBasis('compatibility')}>Use compatibility forecast</button><GovernedNativeForecast/></div>;
  return (
    <div className="animate-in fade-in duration-500 pb-12">
      <button onClick={()=>setBasis('native')}>Use native percentage forecast</button>
      <PageHeader
        title="Forecast Utilization"
        subtitle="Forward-looking capacity models analyzing potential demand and resource roll-off dynamics."
        breadcrumb={['Reports', 'Utilization']}
        actions={
          <div className="flex flex-wrap items-center gap-3">
             <button type="button" onClick={() => loadReport()} aria-label="Refresh forecast utilization" className="btn-secondary py-2.5 px-4 flex items-center gap-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                <RefreshCw aria-hidden="true" size={14} /> Refresh
             </button>
             <div className="group relative pr-4 border-r border-slate-200">
                <Info size={16} className="text-slate-300 cursor-help" />
                <div className="absolute right-0 bottom-full mb-2 w-64 p-2 bg-slate-800 text-white text-[10px] rounded shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-20 font-medium normal-case tracking-normal">{`
                   Employees with multiple ${productConfig.terminology.regionalOwner} mappings appear in each of their mapped views.
                `}</div>
             </div>
             <div className="flex items-center bg-white border border-border-light rounded-xl p-1 shadow-sm mr-2 text-[10px] font-bold uppercase tracking-widest text-heading overflow-hidden">
                {['1 Month', '2 Months', '3 Months'].map(h => (
                  <button
                    key={h}
                    type="button"
                    aria-pressed={horizon === h}
                    onClick={() => selectHorizon(h)}
                    className={cn(
                      "px-4 py-2 transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      horizon === h ? "bg-primary text-white" : "hover:bg-slate-50"
                    )}
                  >
                    {h}
                  </button>
                ))}
             </div>
             <button type="button" onClick={handleExport} disabled={!canExport} className="btn-secondary py-2.5 px-5 flex items-center gap-2 shadow-sm font-bold text-xs uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                <Download size={14} /> Forecast Report
             </button>
          </div>
        }
      />

      <ForecastUtilizationStatus status={status} retry={() => loadReport()} />
      {status === 'ready' && !hasData && (
        <div className="rounded-2xl border border-border-light bg-white p-8 text-center text-sm font-bold text-slate-600">
          <p role="status">No forecast utilization data was returned.</p>
        </div>
      )}
      {status === 'ready' && hasData && <>
      <KPIStrip kpis={kpis} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Forecast Projection Chart */}
        <div className="lg:col-span-2 bg-white border border-border-light rounded-3xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-sm font-bold text-heading">Capacity vs Demand Horizon</h3>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-1">Allocation checkpoints from {sourceDate} through {horizonDate} (UTC). Each eligible worker contributes 100 allocation points. Project counts include active and proposed projects in term at the horizon end.</p>
            </div>
            <div className="flex items-center gap-4">
               <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-dark"></div>
                  <span className="text-[9px] font-bold uppercase text-gray-400">Eligible capacity</span>
               </div>
               <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/40"></div>
                  <span className="text-[9px] font-bold uppercase text-gray-400">Allocated demand</span>
               </div>
            </div>
          </div>

          <div className="h-[300px] w-full">
            {supplyDemandData.length > 0 ? <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <BarChart data={supplyDemandData} margin={{ top: 20 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F1F5F9" />
                <XAxis
                  dataKey="period"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fontWeight: 700, fill: '#64748B' }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fontWeight: 700, fill: '#64748B' }}
                />
                <Tooltip
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontSize: '10px', fontWeight: 'bold' }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }} />
                <Bar name="System Capacity" dataKey="capacity" fill="#1E293B" radius={[4, 4, 0, 0]} barSize={40} />
                <Bar name="Resource demand" dataKey="demand" fill="#EF7D00" radius={[4, 4, 0, 0]} opacity={0.6} barSize={40} />
              </BarChart>
            </ResponsiveContainer> : (
              <div role="status" className="h-full flex items-center justify-center text-center text-xs font-bold text-slate-400">
                No capacity and demand checkpoints were returned for this horizon.
              </div>
            )}
          </div>
        </div>

        {/* Forecast Risks Case */}
        <div className="bg-white border border-border-light rounded-3xl p-6 shadow-sm flex flex-col">
          <div className="mb-6">
            <h3 className="text-sm font-bold text-heading">Horizon Risk Analysis</h3>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-1">Roll-off & Gap Detection</p>
          </div>

          <div className="space-y-6">
             <div className="p-4 bg-orange-50 border border-primary/20 rounded-2xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:scale-110 transition-transform">
                   <ShieldAlert size={48} className="text-primary" />
                </div>
                <h5 className="text-[10px] font-bold text-primary uppercase tracking-widest mb-1">
                  Peak Forecast Pressure
                </h5>
                <p className="text-xl font-bold text-heading">
                  {highPressureMonth ? `${formatPercent(highPressureMonth.pressure)} in ${highPressureMonth.period}` : 'Capacity unavailable'}
                </p>
                <p className="text-xs text-body/70 mt-2 font-medium">
                  {!highPressureMonth ? 'Pressure requires eligible workforce capacity.' : highPressureMonth.demand > highPressureMonth.capacity
                    ? `Allocations exceed capacity by ${roundMetric(highPressureMonth.demand - highPressureMonth.capacity, 4)} allocation percentage points at this checkpoint.`
                    : 'Allocated demand is within capacity at the measured checkpoints.'}
                </p>
             </div>

              <div className="space-y-4">
                 <h6 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-bold">Upcoming Roll-offs ({horizon})</h6>
                 <div className="space-y-2">
                    {rollOffs.map((r) => (
                       <div key={r.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-border-light/50 border-dashed">
                          <div>
                            <Link to={`/employees/${r.employeeId}`} className="text-xs font-bold text-heading hover:text-primary transition-colors">{r.name}</Link>
                            <p className="text-[9px] text-gray-400 font-bold uppercase">{r.client} | {r.project} | {r.load}%</p>
                          </div>
                          <Badge variant="neutral" className="text-[9px] font-mono">{r.date}</Badge>
                       </div>
                    ))}
                    {rollOffs.length === 0 && (
                      <div className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-center">
                        <p role="status" className="text-[10px] font-bold uppercase tracking-widest text-slate-400">No roll-offs inside this horizon</p>
                      </div>
                    )}
                 </div>
              </div>

              <div className="space-y-4">
                 <h6 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-bold">Future Bench Watch</h6>
                 <div className="space-y-2">
                    {futureBenchRows.map(row => (
                       <Link
                         key={row.employee.id}
                         to={`/employees/${row.employee.id}`}
                         className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-border-light/50 hover:border-primary/30 hover:bg-orange-50/40 transition-all"
                       >
                          <div>
                            <p className="text-xs font-bold text-heading">{row.employee.name}</p>
                            <p className="text-[9px] text-gray-400 font-bold uppercase">{row.employee.department}</p>
                          </div>
                          <Badge variant="warning" className="text-[9px]">0% at horizon</Badge>
                       </Link>
                    ))}
                    {futureBenchRows.length === 0 && (
                      <div className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-center">
                        <p role="status" className="text-[10px] font-bold uppercase tracking-widest text-slate-400">No future bench cases in this horizon</p>
                      </div>
                    )}
                 </div>
              </div>
           </div>
         </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
         <div className="bg-white border border-border-light rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
               <div className="flex items-center gap-2 text-primary">
                  <Zap size={16} />
                  <h4 className="text-[10px] font-bold text-heading uppercase tracking-widest">Hiring Trigger</h4>
               </div>
               <AlertTriangle size={14} className={!highPressureMonth ? "text-gray-400" : highPressureMonth.pressure > 90 ? "text-danger" : "text-success"} />
            </div>
            <p className="text-xs text-body font-medium">
              {!highPressureMonth ? 'No staffing signal is available without eligible capacity.' : highPressureMonth.pressure > 90
                ? `Peak demand reaches ${formatPercent(highPressureMonth.pressure)} of active capacity; review hiring or project start dates.`
                : 'Measured allocation pressure is within the 90% review threshold.'}
            </p>
         </div>

         <div className="bg-white border border-border-light rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4 text-orange-600">
               <Target size={16} />
               <h4 className="text-[10px] font-bold text-heading uppercase tracking-widest">Future Bench Pool</h4>
            </div>
            <div className="flex items-end justify-between">
               <p className="text-2xl font-bold text-heading leading-none">{futureBenchCount}</p>
               <span className="text-[10px] font-bold text-gray-400 uppercase">resources</span>
            </div>
         </div>

         <div className="lg:col-span-2 bg-slate-dark text-white rounded-2xl p-6 flex flex-col justify-between shadow-xl">
           <div className="flex items-center gap-3">
              <Briefcase size={18} className="text-primary" />
              <h4 className="text-sm font-bold tracking-tight">Future Planning Assumptions</h4>
            </div>
            <p className="text-xs text-white/50 mt-3 leading-relaxed font-medium">
              Forecasts are calculated from active allocation records and project/allocation date ranges at each monthly checkpoint.
              Proposed projects are included as committed planning demand; no static attrition or conversion assumptions are applied.
            </p>
         </div>
      </div>

      </>}

      {/* Keep both export destinations mounted; normal ledger evidence requires a complete snapshot. */}
      <div className={status === 'ready' && hasData ? "bg-white border border-border-light rounded-3xl overflow-hidden shadow-sm" : "mt-4 flex justify-end"}>
        <div className={status === 'ready' && hasData ? "p-6 border-b border-gray-50 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50" : "flex items-center"}>
           {status === 'ready' && hasData && <div className="flex flex-wrap items-center gap-4">
              <h3 className="text-sm font-bold text-heading">Resource Forecast Ledger</h3>
              <div className="relative">
                 <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={12} />
                 <input
                   type="text"
                   placeholder="Search forecast..."
                   aria-label="Search forecast resources"
                   value={searchQuery}
                   onChange={(e) => setSearchQuery(e.target.value)}
                   className="bg-white border border-border-light rounded-lg py-1.5 pl-8 pr-3 text-[10px] outline-none focus:border-primary w-48 font-bold"
                 />
              </div>
           </div>}
           <div className="flex items-center gap-3">
              {status === 'ready' && hasData && <select
                value={deptFilter}
                aria-label="Filter forecast department"
                onChange={(e) => setDeptFilter(e.target.value)}
                className="bg-white border border-border-light rounded-lg px-2 py-1.5 text-[10px] font-bold outline-none cursor-pointer"
              >
                <option>All Departments</option>
                {Array.from(new Set(employees.map(e => e.department))).map(d => <option key={d} value={d}>{d}</option>)}
              </select>}
              <button type="button" onClick={handleExport} disabled={!canExport} className="btn-secondary py-1.5 px-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                 <Download size={12} /> Forecast
              </button>
           </div>
        </div>

        {status === 'ready' && hasData && <div className="table-container shadow-none border-none">
          <table className="w-full text-left">
            <thead className="bg-white/50 border-b border-border-light">
              <tr>
                <th className="py-4 px-8 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Consultant</th>
                <th className="py-4 px-6 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Department</th>
                {forecastPoints.map(point => (
                  <th key={point.label} className="py-4 px-4 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">{point.label}</th>
                ))}
                <th className="py-4 px-6 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Peak</th>
                <th className="py-4 px-8 text-[10px] font-bold text-right uppercase tracking-widest">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light font-bold">
              {filteredFuture.map((row) => {
                const emp = row.employee;
                return (
                  <tr key={emp.id} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="py-5 px-8">
                       <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded bg-bg-secondary flex items-center justify-center font-bold text-xs text-primary shadow-sm border border-border-light/40">
                             {emp.name.split(' ').map(n => n[0]).join('')}
                          </div>
                          <div>
                            <p className="text-sm font-bold text-heading group-hover:text-primary transition-colors">{emp.name}</p>
                            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{emp.employeeId}</p>
                          </div>
                       </div>
                    </td>
                    <td className="py-5 px-6">
                      <p className="text-xs font-bold text-heading">{emp.department}</p>
                      <p className="text-[10px] text-gray-400 font-medium uppercase tracking-tight">{emp.country}</p>
                    </td>
                    {row.snapshots.map(snapshot => (
                      <td key={snapshot.label} className="py-5 px-4 text-center">
                        <div className="inline-flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-full border border-border-light/50">
                           <span className={cn(
                             "text-xs font-bold",
                             snapshot.load > 100 ? "text-danger" : snapshot.load === 0 ? "text-slate-400" : "text-heading"
                           )}>{formatPercent(snapshot.load)}</span>
                        </div>
                      </td>
                    ))}
                    <td className="py-5 px-6 text-center">
                      <span className={cn("text-xs font-black tabular-nums", row.peakLoad > 100 ? "text-danger" : "text-heading")}>{formatPercent(row.peakLoad)}</span>
                    </td>
                    <td className="py-5 px-8 text-right">
                       <Badge variant={row.status === 'Overload' ? 'danger' : row.status === 'Low Demand' ? 'warning' : 'neutral'}>
                          {row.status}
                       </Badge>
                       <Link to={`/employees/${emp.id}`} className="ml-3 p-1.5 inline-block text-gray-300 hover:text-primary hover:bg-orange-50 rounded transition-all">
                          <ChevronRight size={16} />
                       </Link>
                    </td>
                  </tr>
                );
              })}
              {filteredFuture.length === 0 && (
                <tr>
                   <td colSpan={forecastPoints.length + 4} className="py-12 text-center text-gray-400 font-bold uppercase tracking-widest text-xs"><span role="status">{forecastRows.length === 0 ? 'No resource forecasts were returned for this horizon.' : 'No resource forecasts match the selected filters.'}</span></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>}
      </div>
    </div>
  );
};
