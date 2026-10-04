import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type BreadcrumbItem = string | {
  label: string;
  to?: string;
};

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumb?: BreadcrumbItem[];
  actions?: ReactNode;
}

const breadcrumbRouteMap: Record<string, string> = {
  'Action Center': '/action-center',
  'Allocation Control': '/allocations',
  'Approvals': '/approvals',
  'BRD Traceability': '/governance/brd-traceability',
  'Client Scope': '/clients',
  'Data Management': '/import-export',
  'Data Quality': '/reports/data-quality',
  'Downloads': '/reports/center',
  'Employee Master': '/employees',
  'Governance': '/governance/brd-traceability',
  'Identity': '/integrations/identity',
  'Integrations': '/integrations/identity',
  'Leave': '/leave/my',
  'Master Data': '/employees',
  'Notifications': '/notifications',
  'Operations': '/employees',
  'Planning': '/planning',
  'Profile': '/ess',
  'Project Master': '/projects',
  'Reports': '/reports/utilization',
  'Self Service': '/ess',
  'System': '/admin',
  'Teams': '/integrations/teams',
  'Team Calendar': '/leave/team-calendar',
  'Traceability': '/audit-trail',
  'Timesheets': '/timesheets',
  'Allocations & Timesheets': '/timesheets/approval',
  'Utilization': '/reports/utilization',
  'Workforce OS': '/action-center',
};

const getBreadcrumbLabel = (item: BreadcrumbItem) => typeof item === 'string' ? item : item.label;
const getBreadcrumbRoute = (item: BreadcrumbItem) => typeof item === 'string' ? breadcrumbRouteMap[item] : item.to;

export const PageHeader = ({ title, subtitle, breadcrumb, actions }: PageHeaderProps) => {
  return (
    <div className="flex flex-col md:flex-row md:items-start justify-between gap-6 mb-8 pt-2">
      <div className="space-y-1">
        {breadcrumb && (
          <div className="flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em] mb-1">
            {breadcrumb.map((item, idx) => {
              const label = getBreadcrumbLabel(item);
              const route = idx < breadcrumb.length - 1 ? getBreadcrumbRoute(item) : undefined;
              return (
                <div key={`${label}-${idx}`} className="flex items-center gap-2">
                  {route ? (
                    <Link to={route} className="transition-colors hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30">
                      {label}
                    </Link>
                  ) : (
                    <span>{label}</span>
                  )}
                  {idx < breadcrumb.length - 1 && <span className="opacity-30">/</span>}
                </div>
              );
            })}
          </div>
        )}
        <h1 className="text-3xl font-bold text-heading tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm font-medium text-body/70 max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-3 shrink-0">{actions}</div>}
    </div>
  );
};
