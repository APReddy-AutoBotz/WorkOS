import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, Loader2, PieChart, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { utilizationReportService } from '../services/api';
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
  if (!report) return '--';
  if (lens === 'actual') return formatPercent(report.summary.averageActual);
  return formatPercent(report.summary.averagePlanned);
};

const getExceptionCount = (lens: ReportLens, report?: UtilizationReport) => {
  if (!report) return '--';
  if (lens === 'actual') return report.summary.underutilized + report.summary.bench;
  return report.summary.overloaded;
};

export const UtilizationReports = () => {
  const [selectedLens, setSelectedLens] = useState<ReportLens>('planned');
  const [reports, setReports] = useState<Partial<Record<ReportLens, UtilizationReport>>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadReports = async () => {
      try {
        const [planned, actual, forecast] = await Promise.all([
          utilizationReportService.getPlanned(),
          utilizationReportService.getActual(),
          utilizationReportService.getForecast(3),
        ]);
        setReports({ planned, actual, forecast });
      } finally {
        setLoading(false);
      }
    };
    loadReports();
  }, []);

  const selectedReport = reports[selectedLens];
  const selectedConfig = reportLenses.find(report => report.id === selectedLens) || reportLenses[0];
  const exceptionRows = useMemo(() => {
    if (!selectedReport) return [];
    if (selectedLens === 'actual') {
      return selectedReport.rows
        .filter(row => row.actualUtilization < selectedReport.thresholds.low)
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

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Utilization Reports"
        subtitle="Planned, current, and forecast utilization in one reporting workspace."
        breadcrumb={['Reports', 'Utilization']}
        actions={
          <Link to={selectedConfig.path} className="btn-primary flex items-center gap-2 px-5 py-2.5 text-xs">
            <Download size={14} /> Open {selectedConfig.title}
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {reportLenses.map(report => {
          const Icon = report.icon;
          const data = reports[report.id];
          const isSelected = selectedLens === report.id;
          return (
            <button
              key={report.id}
              onClick={() => setSelectedLens(report.id)}
              className={cn(
                'rounded-2xl border bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md',
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
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card title={`${selectedConfig.title} Snapshot`}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              { label: 'Population', value: selectedReport?.summary.rows ?? 0 },
              { label: 'Avg Planned', value: selectedReport ? formatPercent(selectedReport.summary.averagePlanned) : '--' },
              { label: 'Avg Current', value: selectedReport ? formatPercent(selectedReport.summary.averageActual) : '--' },
              { label: 'Bench', value: selectedReport?.summary.bench ?? 0 },
            ].map(item => (
              <div key={item.label} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{item.label}</p>
                <p className="mt-2 text-xl font-black text-heading">{item.value}</p>
              </div>
            ))}
          </div>
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
              <p className="py-8 text-center text-sm font-bold text-slate-400">No exceptions in the selected report.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
