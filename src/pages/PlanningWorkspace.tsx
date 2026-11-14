import {CapabilityPlanner} from '../components/CapabilityPlanner';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Gauge, Layers3, ShieldCheck, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { planningService } from '../services/api';
import { authService } from '../services/authService';
import { canManageAllocations } from '../services/accessControl';
import { AllocationControlPanel, type AllocationControlFocus } from './AllocationManagement';
import type { ResourcePlanningReport, ResourcePlanningRow } from '../types';
import { cn } from '../lib/utils';

import { productConfig } from '../config/productConfig';
const bandForRow = (row: ResourcePlanningRow) => {
  if (row.overloaded) return { label: 'Overload', variant: 'danger' as const };
  if (row.bench) return { label: 'Bench', variant: 'warning' as const };
  if (row.underloaded) return { label: 'Underload', variant: 'info' as const };
  return { label: 'Balanced', variant: 'success' as const };
};

const Metric = ({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub: string; icon: typeof Gauge }) => (
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

interface ResourcePlanningSignalsProps {
  embedded?: boolean;
  onFocusAllocation?: (focus: Omit<AllocationControlFocus, 'token'>) => void;
}

export const ResourcePlanningSignals = ({ embedded = false, onFocusAllocation }: ResourcePlanningSignalsProps) => {
  const [report, setReport] = useState<ResourcePlanningReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [band, setBand] = useState('All');
  const [search, setSearch] = useState('');
  const canFocusAllocationControl = canManageAllocations(authService.getCurrentUser()) && Boolean(onFocusAllocation);

  const refresh = async () => {
    setLoading(true);
    setReport(await planningService.getResourcePlanning());
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const filteredRows = useMemo(() => {
    const rows = report?.rows || [];
    return rows.filter(row => {
      const matchesSearch = row.employeeName.toLowerCase().includes(search.toLowerCase()) || row.employeeCode.toLowerCase().includes(search.toLowerCase());
      const matchesBand =
        band === 'All' ||
        (band === 'Overload' && row.overloaded) ||
        (band === 'Bench' && row.bench) ||
        (band === 'Underload' && row.underloaded) ||
        (band === 'Roll-off' && row.rollOffDate);
      return matchesSearch && matchesBand;
    });
  }, [report, search, band]);

  const maxLoad = Math.max(...(report?.rows || []).map(row => row.plannedUtilization), 100);
  const rollOffRows = (report?.rows || []).filter(row => row.rollOffDate).slice(0, 8);
  const clientFootprint = useMemo(() => {
    const clients = new Map<string, { people: Set<string>; fte: number; projects: Set<string> }>();
    (report?.rows || []).forEach(row => {
      row.allocations.forEach(allocation => {
        const current = clients.get(allocation.client) || { people: new Set<string>(), fte: 0, projects: new Set<string>() };
        current.people.add(row.employeeId);
        current.projects.add(allocation.projectId);
        current.fte += allocation.percentage / 100;
        clients.set(allocation.client, current);
      });
    });
    return Array.from(clients.entries()).map(([client, value]) => ({
      client,
      people: value.people.size,
      projects: value.projects.size,
      fte: Number(value.fte.toFixed(1)),
    })).sort((a, b) => b.fte - a.fte).slice(0, 8);
  }, [report]);

  if (loading || !report) return <Card>Loading resource planning...</Card>;

  return (
    <div className={cn("space-y-6", embedded ? "" : "pb-12")}>
      {!embedded && (
        <PageHeader
          title="Planning Workspace"
          subtitle="Decision workspace for availability, bench, overload, roll-off, and staffing actions."
          breadcrumb={['Workforce OS', 'Planning']}
        />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-6">
        <Metric label="People" value={report.summary.people} sub="Planning population" icon={UsersRound} />
        <Metric label="Avg Planned" value={`${report.summary.averagePlanned}%`} sub="Allocation load" icon={Gauge} />
        <Metric label="Avail Cap" value={`${report.summary.averageAvailabilityAdjustedCapacity}%`} sub="Leave adjusted" icon={ShieldCheck} />
        <Metric label="Bench" value={report.summary.benchCount} sub="Low load" icon={Layers3} />
        <Metric label="Overload" value={report.summary.overloadedCount} sub="Above threshold" icon={AlertTriangle} />
        <Metric label="Roll-off" value={report.summary.rollOffSoonCount} sub="Next 45 days" icon={CalendarClock} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <Card title="Planning Actions" className="xl:sticky xl:top-24">
          <div className="space-y-3">
            {[
              { label: 'Overloaded resources', count: report.summary.overloadedCount, band: 'Overload', utilFilter: 'Over 100%' as const, tone: 'danger' as const },
              { label: 'Bench resources', count: report.summary.benchCount, band: 'Bench', utilFilter: 'Under 80%' as const, tone: 'warning' as const },
              { label: 'Underloaded resources', count: report.summary.underloadedCount, band: 'Underload', utilFilter: 'Under 80%' as const, tone: 'info' as const },
              { label: 'Roll-offs in 45 days', count: report.summary.rollOffSoonCount, band: 'Roll-off', utilFilter: 'Any' as const, tone: 'neutral' as const },
            ].map(action => (
              <button
                key={action.label}
                onClick={() => {
                  setBand(action.band);
                  onFocusAllocation?.({
                    label: action.label,
                    utilFilter: action.utilFilter,
                    view: 'employee',
                  });
                }}
                className="flex w-full items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-left transition-colors hover:border-primary/30 hover:bg-orange-50"
              >
                <span>
                  <span className="block text-sm font-black text-heading">{action.label}</span>
                  <span className="mt-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">Focus Allocation Control</span>
                </span>
                <Badge variant={action.tone}>{action.count}</Badge>
              </button>
            ))}
          </div>
        </Card>

        <Card
          title="Capacity Signals"
          headerAction={
            <div className="flex flex-wrap items-center gap-2">
              <input className="input-field h-9 w-52 text-xs" placeholder="Search resource" value={search} onChange={event => setSearch(event.target.value)} />
              <select className="input-field h-9 w-32 text-xs" value={band} onChange={event => setBand(event.target.value)}>
                {['All', 'Overload', 'Underload', 'Bench', 'Roll-off'].map(option => <option key={option}>{option}</option>)}
              </select>
            </div>
          }
        >
          <div className="divide-y divide-slate-100">
            {filteredRows.slice(0, 10).map(row => {
              const bandInfo = bandForRow(row);
              return (
                <div key={row.employeeId} className="grid grid-cols-1 gap-4 py-4 lg:grid-cols-[minmax(180px,1fr)_180px_120px_90px] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/employees/${row.employeeId}`} className="font-black text-heading hover:text-primary">{row.employeeName}</Link>
                      <Badge variant={bandInfo.variant}>{bandInfo.label}</Badge>
                      {row.rollOffDate && <Badge variant="neutral">Roll-off {row.rollOffDate}</Badge>}
                    </div>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{row.employeeCode} | {row.department} | {row.country}</p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-400">
                      <span>{row.plannedUtilization}% planned</span>
                      <span>{Math.round(row.availabilityHours)}h available</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-100">
                      <div
                        className={cn('h-full rounded-full', row.overloaded ? 'bg-danger' : row.bench || row.underloaded ? 'bg-warning' : 'bg-primary')}
                        style={{ width: `${Math.min(100, Math.round((row.plannedUtilization / maxLoad) * 100))}%` }}
                      />
                    </div>
                  </div>
                  <p className="text-xs font-black uppercase tracking-widest text-slate-400">{row.activeProjectCount} projects</p>
                  {canFocusAllocationControl && (
                    <button
                      onClick={() => onFocusAllocation?.({
                        label: `${row.employeeName} allocation plan`,
                        search: row.employeeName,
                        view: 'employee',
                      })}
                      className="text-right text-[10px] font-black uppercase tracking-widest text-primary hover:text-primary-dark"
                    >
                      Focus
                    </button>
                  )}
                </div>
              );
            })}
            {filteredRows.length === 0 && <p className="py-8 text-center text-sm font-bold text-slate-400">No capacity signals match the current filters.</p>}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Roll-Off and Bench Highlights">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {rollOffRows.map(row => (
              <button
                key={row.employeeId}
                onClick={() => onFocusAllocation?.({
                  label: `${row.employeeName} roll-off / bench review`,
                  search: row.employeeName,
                  view: 'employee',
                })}
                className="rounded-lg border border-slate-100 bg-slate-50 p-4 text-left transition-colors hover:border-primary/30 hover:bg-orange-50"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-black text-heading">{row.employeeName}</p>
                  <Badge variant={row.bench ? 'warning' : 'info'}>{row.rollOffDate || 'Bench'}</Badge>
                </div>
                <p className="mt-1 text-xs font-bold text-body/60">{row.plannedUtilization}% planned | {row.department}</p>
              </button>
            ))}
          </div>
        </Card>

        <Card title="Client Delivery Footprint">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {clientFootprint.map(client => (
              <div key={client.client} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-black text-heading">{client.client}</p>
                  <Badge variant="neutral">{client.fte} FTE</Badge>
                </div>
                <p className="mt-1 text-xs font-bold text-body/60">{client.people} people | {client.projects} projects</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

export const ResourcePlanningBoard = () => <ResourcePlanningSignals />;

export const PlanningWorkspace = () => {
  const user = authService.getCurrentUser();
  const canEditAllocations = canManageAllocations(user);
  const [allocationFocus, setAllocationFocus] = useState<AllocationControlFocus | null>(null);
  const focusAllocationControl = (focus: Omit<AllocationControlFocus, 'token'>) => {
    setAllocationFocus({ ...focus, token: Date.now() });
  };

  return (
    <div className="space-y-8 pb-12">
      <PageHeader
        title="Planning Workspace"
        subtitle="Review capacity signals and update allocation plans in one workspace. Allocation edits remain the source of record."
        breadcrumb={['Planning']}
      />

      <CapabilityPlanner/>

      <ResourcePlanningSignals embedded onFocusAllocation={canEditAllocations ? focusAllocationControl : undefined} />

      {canEditAllocations ? (
        <AllocationControlPanel embedded focus={allocationFocus} onClearFocus={() => setAllocationFocus(null)} />
      ) : (
        <Card title="Allocation Control">
          <p className="text-sm font-medium leading-relaxed text-body/70">{`
            Allocation edits are restricted to Admin, HR, ${productConfig.terminology.regionalOwner}, and Project Manager roles. Planning signals remain available here for review.
          `}</p>
        </Card>
      )}
    </div>
  );
};
