import { CheckCircle2, Clock, MailCheck, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { authService } from '../services/authService';
import { ROUTE_ROLES, hasRouteRole } from '../services/accessControl';
import { isEnterpriseFeatureEnabled } from '../config/featureFlags';

const actionCards = [
  {
    title: 'My Timesheet',
    path: '/timesheets',
    badge: 'Time entry',
    icon: Clock,
    description: 'Enter or review weekly project time before approval and utilization reporting.',
    roles: ROUTE_ROLES.timesheets,
  },
  {
    title: 'Timesheet Governance',
    path: '/timesheets/approval',
    badge: 'Approval control',
    icon: TrendingUp,
    description: 'Approve, reject, and govern submitted timesheets in your active-role scope.',
    roles: ROUTE_ROLES.timesheetApproval,
  },
  {
    title: 'Approvals Inbox',
    path: '/approvals',
    badge: 'Workflow queue',
    icon: CheckCircle2,
    description: 'Review shared approvals for timesheets, leave, and future workflow items.',
    roles: ROUTE_ROLES.approvals,
    feature: 'notifications' as const,
  },
  {
    title: 'Notifications',
    path: '/notifications',
    badge: 'Message center',
    icon: MailCheck,
    description: 'View operational notifications, preferences, templates, and delivery status.',
    roles: ROUTE_ROLES.notifications,
    feature: 'notifications' as const,
  },
];

export const ActionCenterHub = () => {
  const user = authService.getCurrentUser();
  const cards = actionCards
    .filter(card => hasRouteRole(user, card.roles) && (!card.feature || isEnterpriseFeatureEnabled(card.feature)))
    .map(card => ({
      ...card,
      title: card.path === '/timesheets' && ['Admin', 'HR', 'CountryDirector'].includes(user?.role || '') ? 'Timesheet Review' : card.title,
    }));

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Action Center"
        subtitle="Time entry, approvals, governance actions, and operational notifications in one place."
        breadcrumb={['Action Center']}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {cards.map(card => (
          <Link key={card.path} to={card.path} className="block h-full">
            <Card className="h-full p-6 transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg">
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-50 text-primary">
                  <card.icon size={22} />
                </div>
                <Badge variant="neutral">{card.badge}</Badge>
              </div>
              <h2 className="mt-5 text-lg font-black text-heading">{card.title}</h2>
              <p className="mt-2 text-sm font-medium leading-relaxed text-body/70">{card.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
};
