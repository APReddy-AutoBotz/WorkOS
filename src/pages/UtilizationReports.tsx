import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Download, Loader2, PieChart, RefreshCw, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { utilizationReportService } from '../services/api';
import { ApiClientError, resetBackendCheck } from '../services/apiClient';
import type { UtilizationReport } from '../types';
import { formatPercent } from '../lib/format';
import { cn } from '../lib/utils';

type ReportLens = 'planned' | 'actual' | 'forecast';

const reportLenses: Array<{
  id: ReportLens;
  title: string;
  path: string;
  icon: typeof BarChart3;
  badge: string;
  metricLabel: string;
  exceptionLabel: string;
}> = [
  {
    id: 'planned',
    title: 'Planned',
    path: '/utilization/planned',
    icon: BarChart3,
    badge: 'Allocation',
    metricLabel: 'Avg planned',
    exceptionLabel: 'Overloaded',
  },
  {
    id: 'actual',
    title: 'Current',
    path: '/utilization/actual',
    icon: PieChart,
    badge: 'Timesheet',
    metricLabel: 'Avg actual',
    exceptionLabel: 'Under / bench',
  },
  {
    id: 'forecast',
    title: 'Forecast',
    path: '/utilization/forecast',
    icon: TrendingUp,
    badge: 'Outlook',
    metricLabel: 'Projected avg',
    exceptionLabel: 'Future pressure',
  },
];

const getPrimaryMetric = (lens: ReportLens, report?: UtilizationReport) => {
  if (!report || report.rows.length === 0) return '--';
  if (lens === 'actual') return report.summary.averageActual == null ? 'Unavailable' : formatPercent(report.summary.averageActual);
  return formatPercent(report.summary.averagePlanned);
};

const getExceptionCount = (lens: ReportLens, report?: UtilizationReport) => {
  if (!report || report.rows.length === 0) return '--';
  if (lens === 'actual') return report.summary.actualWorkerCount ? report.summary.actualBelowThreshold : 'Unavailable';
  return report.summary.overloaded;
};

type OverviewStatus = 'loading' | 'ready' | 'access' | 'unavailable' | 'error';
type OverviewResult = { status: OverviewStatus; reports: Partial<Record<ReportLens, UtilizationReport>> };

// Keep successful reports, normalizers and calculations on their existing service path.
export const readUtilizationOverview = async () => {
  // A retry must recheck availability after an earlier cached health failure.
  resetBackendCheck();
  const [planned, actual, forecast] = await Promise.all([
    utilizationReportService.getPlanned(),
    utilizationReportService.getActual(),
    utilizationReportService.getForecast(3),
  ]);
  if (!planned || !actual || !forecast) throw new TypeError('Report response unavailable');
  return { planned, actual, forecast };
};

export const UtilizationOverviewStatus = ({ status, retry }: {status: OverviewStatus; retry: () => void}) => {
  if (status === 'ready') return null;
  if (status === 'loading') return (
    <div role="status" className="flex items-center justify-center gap-3 rounded-2xl border border-border-light bg-white p-8">
      <Loader2 aria-hidden="true" className="animate-spin text-primary" size={24} />
      <p className="text-sm font-bold text-heading">Loading utilization reports…</p>
    </div>
  );
  const message = status === 'access' ? 'Access to utilization reports could not be confirmed.'
    : status === 'unavailable' ? 'Utilization reports are unavailable.'
    : 'Utilization reports could not be loaded.';
  return (
    <div role="alert" className="space-y-3 rounded-2xl border border-orange-200 bg-orange-50 p-5 text-heading">
      <p className="text-sm font-bold">{message}</p>
      <p className="text-sm">{status === 'access'
        ? 'Check your sign-in and report access, then retry.'
        : 'Check your connection and retry. If the problem continues, contact your administrator.'}</p>
      <button type="button" onClick={retry} className="btn-secondary px-4 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        Retry utilization reports
      </button>
    </div>
  );
};

export const UtilizationReports = () => {
  const [selectedLens, setSelectedLens] = useState<ReportLens>('planned');
  const [result, setResult] = useState<OverviewResult>({ status: 'loading', reports: {} });
  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const loadReports = useCallback(() => {
    const request = ++requestVersion.current;
    setResult({ status: 'loading', reports: {} });
    const current = () => mounted.current && request === requestVersion.current;
    void Promise.resolve().then(() => current() ? readUtilizationOverview() : null).then(reports => {
      if (current() && reports) setResult({ status: 'ready', reports });
    }).catch(error => {
      if (!current()) return;
      const status = error instanceof ApiClientError
        ? [401, 403].includes(error.status) ? 'access'
          : [404, 502, 503, 504].includes(error.status) ? 'unavailable' : 'error'
        : 'error';
      setResult({ status, reports: {} });
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadReports();
    return () => { mounted.current = false; requestVersion.current += 1; };
  }, [loadReports]);

  const { reports, status } = result;
  const selectedReport = status === 'ready' ? reports[selectedLens] : undefined;
  const selectedConfig = reportLenses.find(report => report.id === selectedLens) || reportLenses[0];
  const exceptionRows = useMemo(() => {
    if (!selectedReport) return [];
    if (selectedLens === 'actual') {
      return selectedReport.rows
        .filter(row => row.latestApprovedWeek && selectedReport.expectedWeeklyHours > 0 &&
          (row.actualUtilization < selectedReport.thresholds.low || row.actualUtilization <= selectedReport.thresholds.bench))
        .sort((a, b) => a.actualUtilization - b.actualUtilization)
        .slice(0, 5)
        .map(row => ({ ...row, value: row.actualUtilization }));
    }
    return selectedReport.rows
      .filter(row => row.plannedUtilization > selectedReport.thresholds.high)
      .sort((a, b) => b.plannedUtilization - a.plannedUtilization)
      .slice(0, 5)
      .map(row => ({ ...row, value: row.plannedUtilization }));
  }, [selectedLens, selectedReport]);

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Utilization Reports"
        subtitle="Planned, current, and forecast utilization in one reporting workspace."
        breadcrumb={['Reports', 'Utilization']}
        actions={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={loadReports} aria-label="Refresh utilization reports" className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
              <RefreshCw aria-hidden="true" size={14} /> Refresh
            </button>
            <Link to={selectedConfig.path} className="btn-primary flex items-center gap-2 px-5 py-2.5 text-xs">
              <Download aria-hidden="true" size={14} /> Open {selectedConfig.title}
            </Link>
          </div>
        }
      />

      <UtilizationOverviewStatus status={status} retry={loadReports} />

      {status === 'ready' && <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {reportLenses.map(report => {
          const Icon = report.icon;
          const data = reports[report.id];
          const isSelected = selectedLens === report.id;
          return (
            <button
              key={report.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setSelectedLens(report.id)}
              className={cn(
                'rounded-2xl border bg-white p-5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md',
                isSelected ? 'border-primary/40 ring-2 ring-primary/10' : 'border-border-light'
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-primary">
                  <Icon size={20} />
                </div>
                <Badge variant={isSelected ? 'info' : 'neutral'}>{report.badge}</Badge>
              </div>
              <div className="mt-5 flex items-end justify-between gap-4">
                <div>
                  <h2 className="text-base font-black text-heading">{report.title}</h2>
                  <p className="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-400">{report.metricLabel}</p>
                  <p className="mt-1 text-2xl font-black text-heading">{getPrimaryMetric(report.id, data)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{report.exceptionLabel}</p>
                  <p className="mt-1 text-2xl font-black text-heading">{getExceptionCount(report.id, data)}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>}

      {selectedReport?.rows.length === 0 && (
        <div role="status" className="rounded-2xl border border-border-light bg-white p-8 text-center text-sm font-bold text-slate-600">
          No utilization data was returned for the selected report.
        </div>
      )}

      {selectedReport && selectedReport.rows.length > 0 && <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card title={`${selectedConfig.title} Snapshot`}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              { label: 'Population', value: selectedReport.summary.rows },
              { label: 'Avg Planned', value: formatPercent(selectedReport.summary.averagePlanned) },
              { label: 'Avg Current', value: getPrimaryMetric('actual', selectedReport) },
              { label: 'Planned bench', value: selectedReport.summary.bench },
            ].map(item => (
              <div key={item.label} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{item.label}</p>
                <p className="mt-2 text-xl font-black text-heading">{item.value}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-slate-600">Current utilization uses the latest approved week through {selectedReport.sourceDate}. {selectedReport.summary.actualWorkerCount} of {selectedReport.summary.rows} workers contribute, using {selectedReport.expectedWeeklyHours} expected hours per week.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to={selectedConfig.path} className="btn-secondary px-4 py-2 text-[10px]">
              Open Detailed Report
            </Link>
            <Link to="/reports/center" className="btn-secondary px-4 py-2 text-[10px]">
              Reports Center
            </Link>
          </div>
        </Card>

        <Card title={`${selectedConfig.title} Exceptions`}>
          <div className="divide-y divide-slate-100">
            {exceptionRows.map(row => (
              <div key={row.id} className="grid grid-cols-[1fr_90px_90px] items-center gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-heading">{row.name}</p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{row.employeeId} | {row.department}</p>
                </div>
                <p className="text-right text-sm font-black text-heading">{formatPercent(row.value)}</p>
                <Link to={`/employees/${row.id}`} className="text-right text-[10px] font-black uppercase tracking-widest text-primary hover:text-primary-dark">
                  Profile
                </Link>
              </div>
            ))}
            {exceptionRows.length === 0 && (
              <p className="py-8 text-center text-sm font-bold text-slate-400">{selectedLens === 'actual' && !selectedReport.summary.actualWorkerCount ? 'Current exceptions are unavailable.' : 'No exceptions in the selected report.'}</p>
            )}
          </div>
        </Card>
      </div>}
    </div>
  );
};
