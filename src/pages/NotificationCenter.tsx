import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, MailCheck, Send, Settings2, ShieldAlert } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { allocationService, employeeService, notificationService, projectService } from '../services/api';
import { authService } from '../services/authService';
import { canManageNotifications } from '../services/accessControl';
import { filterEmployeesByOrgVisibility } from '../services/orgChart';
import type { Allocation, Employee, NotificationDeliveryAttempt, NotificationEvent, NotificationPreference, NotificationTemplate, Project } from '../types';

const severityVariant = (severity: string) => {
  if (severity === 'Critical') return 'danger';
  if (severity === 'Warning') return 'warning';
  return 'info';
};

const Metric = ({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub: string; icon: typeof MailCheck }) => (
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

export const NotificationCenter = () => {
  const user = authService.getCurrentUser();
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [attempts, setAttempts] = useState<NotificationDeliveryAttempt[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [testEmployeeId, setTestEmployeeId] = useState('');
  const [preferenceEmployeeId, setPreferenceEmployeeId] = useState('');
  const [testChannels, setTestChannels] = useState<Array<'InApp' | 'Email' | 'Teams'>>(['InApp']);

  const refresh = async () => {
    setLoading(true);
    const [eventRows, templateRows, preferenceRows, attemptRows, employeeRows, allocationRows, projectRows] = await Promise.all([
      notificationService.getAll(),
      notificationService.getTemplates().catch(() => []),
      notificationService.getPreferences().catch(() => []),
      notificationService.getDeliveryAttempts().catch(() => []),
      employeeService.getAll(),
      allocationService.getAll(),
      projectService.getAll(),
    ]);
    setEvents(eventRows);
    setTemplates(templateRows);
    setPreferences(preferenceRows);
    setAttempts(attemptRows);
    setEmployees(employeeRows);
    setAllocations(allocationRows);
    setProjects(projectRows);
    setTestEmployeeId(current => current || employeeRows[0]?.id || '');
    setPreferenceEmployeeId(current => current || user?.id || employeeRows[0]?.id || '');
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const canManageNotificationOperations = canManageNotifications(user);
  const scopedEmployeeIds = useMemo(() => new Set(filterEmployeesByOrgVisibility({
    user,
    employees,
    allocations,
    projects,
  }).map(employee => employee.id)), [user, employees, allocations, projects]);

  const visibleEvents = useMemo(() => {
    if (!user) return [];
    if (canManageNotificationOperations) return events;
    return events.filter(event =>
      event.recipientEmployeeId === user.id ||
      Boolean(event.recipientEmployeeId && scopedEmployeeIds.has(event.recipientEmployeeId))
    );
  }, [canManageNotificationOperations, events, scopedEmployeeIds, user]);

  const visiblePreferences = useMemo(() => {
    if (!user) return [];
    if (canManageNotificationOperations) return preferences;
    return preferences.filter(preference => preference.employeeId === user.id);
  }, [canManageNotificationOperations, preferences, user]);

  const eventTypes = useMemo(() => {
    const fromTemplates = templates.map(template => template.eventType);
    return Array.from(new Set([...fromTemplates, 'ApprovalRequested', 'ApprovalDecided', 'TestDelivery'])).sort();
  }, [templates]);

  const preferenceEmployees = useMemo(() => {
    if (!user) return [];
    if (canManageNotificationOperations) return employees.filter(employee => employee.status === 'Active');
    return employees.filter(employee => employee.id === user.id);
  }, [canManageNotificationOperations, employees, user]);

  const preferenceRows = useMemo(() => eventTypes.map(eventType => {
    const existing = preferences.find(preference =>
      preference.employeeId === preferenceEmployeeId &&
      preference.eventType === eventType
    );
    const employee = employees.find(row => row.id === preferenceEmployeeId);
    return existing || {
      id: `notification-preference-${preferenceEmployeeId}-${eventType.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      employeeId: preferenceEmployeeId,
      employeeName: employee?.name,
      eventType,
      inApp: true,
      email: false,
      teams: false,
    };
  }).filter(preference => Boolean(preference.employeeId)), [employees, eventTypes, preferenceEmployeeId, preferences]);

  const unread = useMemo(() => visibleEvents.filter(event => !event.readAt), [visibleEvents]);
  const failedAttempts = useMemo(() => attempts.filter(attempt => attempt.status === 'Failed'), [attempts]);

  const markRead = async (event: NotificationEvent) => {
    await notificationService.markRead(event.id);
    setNotice(`Marked "${event.title}" as read.`);
    await refresh();
  };

  const toggleTemplate = async (template: NotificationTemplate) => {
    await notificationService.saveTemplate({ ...template, active: !template.active });
    setNotice(`${template.eventType} template ${template.active ? 'disabled' : 'enabled'}.`);
    await refresh();
  };

  const toggleTestChannel = (channel: 'InApp' | 'Email' | 'Teams') => {
    setTestChannels(current => current.includes(channel)
      ? current.filter(item => item !== channel)
      : [...current, channel]);
  };

  const togglePreference = async (preference: NotificationPreference, channel: 'inApp' | 'email' | 'teams') => {
    const next = { ...preference, [channel]: !preference[channel] };
    await notificationService.savePreference(next);
    setNotice(`${preference.eventType} ${channel === 'inApp' ? 'in-app' : channel} preference updated.`);
    await refresh();
  };

  const sendTestDelivery = async () => {
    if (!testEmployeeId || testChannels.length === 0) return;
    await notificationService.sendTestDelivery(testEmployeeId, testChannels);
    setNotice(`Sent test delivery through ${testChannels.join(', ')}.`);
    await refresh();
  };

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Notifications"
        subtitle="In-app notification inbox, preferences, templates, and delivery monitoring."
        breadcrumb={['Workforce OS', 'Notifications']}
      />
      {notice && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{notice}</div>}
      {loading ? <Card>Loading notification center...</Card> : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <Metric label="Unread" value={unread.length} sub="Open in-app events" icon={MailCheck} />
            {canManageNotificationOperations && <Metric label="Templates" value={templates.length} sub="Configured event templates" icon={Settings2} />}
            {canManageNotificationOperations && <Metric label="Delivery Risk" value={failedAttempts.length} sub="Failed delivery attempts" icon={ShieldAlert} />}
            <Metric label="Preferences" value={visiblePreferences.length || 'Default'} sub="User preference rows" icon={CheckCircle2} />
          </div>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <Card title="Notification Inbox">
              <div className="space-y-3">
                {visibleEvents.map(event => (
                  <div key={event.id} className="rounded-lg border border-slate-100 bg-white p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-black text-heading">{event.title}</p>
                          <Badge variant={severityVariant(event.severity)}>{event.severity}</Badge>
                          {!event.readAt && <Badge variant="warning">Unread</Badge>}
                        </div>
                        <p className="mt-2 text-sm font-medium leading-relaxed text-body/70">{event.body}</p>
                        <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">{event.eventType} | {new Date(event.createdAt).toLocaleString()}</p>
                      </div>
                      {!event.readAt && <button type="button" onClick={() => markRead(event)} className="btn-secondary whitespace-nowrap px-3 py-2 text-xs">Mark read</button>}
                    </div>
                  </div>
                ))}
                {visibleEvents.length === 0 && <p className="py-8 text-center text-sm font-bold text-slate-400">No notifications in this scope.</p>}
              </div>
            </Card>
            <div className="space-y-6">
              <Card title="Notification Preferences">
                <div className="space-y-3">
                  {canManageNotificationOperations && preferenceEmployees.length > 0 && (
                    <select className="input-field" value={preferenceEmployeeId} onChange={event => setPreferenceEmployeeId(event.target.value)}>
                      {preferenceEmployees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                    </select>
                  )}
                  {preferenceRows.map(preference => (
                    <div key={preference.id} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                      <p className="text-sm font-black text-heading">{preference.eventType}</p>
                      <p className="mt-1 text-xs font-bold text-body/60">{preference.employeeName || 'Current user'} delivery choices</p>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        {([
                          ['inApp', 'In-app'],
                          ['email', 'Email'],
                          ['teams', 'Teams'],
                        ] as const).map(([key, label]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => togglePreference(preference, key)}
                            className={`rounded-lg border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition ${
                              preference[key] ? 'border-green-200 bg-green-50 text-green-700' : 'border-slate-200 bg-white text-slate-500'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {preferenceRows.length === 0 && <p className="py-8 text-center text-sm font-bold text-slate-400">No preference events are configured.</p>}
                </div>
              </Card>
              {canManageNotificationOperations && (
                <Card title="Admin Notification Templates">
                  <div className="space-y-3">
                    {templates.map(template => (
                      <div key={template.id} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-black text-heading">{template.eventType}</p>
                          <button type="button" onClick={() => toggleTemplate(template)} className="btn-secondary px-3 py-2 text-xs">{template.active ? 'Disable' : 'Enable'}</button>
                        </div>
                        <p className="mt-1 text-xs font-bold text-body/60">{template.channel} | {template.subject}</p>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          </div>
          {canManageNotificationOperations && (
            <Card title="Delivery Monitoring">
              <div className="mb-5 rounded-xl border border-slate-100 bg-slate-50 p-4">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-center">
                  <select className="input-field" value={testEmployeeId} onChange={event => setTestEmployeeId(event.target.value)}>
                    {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-2">
                    {(['InApp', 'Email', 'Teams'] as const).map(channel => (
                      <button
                        key={channel}
                        type="button"
                        onClick={() => toggleTestChannel(channel)}
                        className={`rounded-lg border px-3 py-2 text-xs font-black uppercase tracking-widest ${testChannels.includes(channel) ? 'border-orange-300 bg-orange-50 text-primary' : 'border-slate-200 bg-white text-slate-500'}`}
                      >
                        {channel}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={sendTestDelivery} disabled={testChannels.length === 0} className="btn-primary flex items-center justify-center gap-2 px-4 py-2 text-sm disabled:opacity-50">
                    <Send size={16} /> Test Send
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400">
                      <th className="py-3 pr-4">Channel</th>
                      <th className="py-3 pr-4">Provider</th>
                      <th className="py-3 pr-4">Status</th>
                      <th className="py-3 pr-4">Attempted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map(attempt => (
                      <tr key={attempt.id} className="border-b border-slate-50">
                        <td className="py-3 pr-4 font-bold text-heading">{attempt.channel}</td>
                        <td className="py-3 pr-4">{attempt.provider}</td>
                        <td className="py-3 pr-4"><Badge variant={attempt.status === 'Delivered' ? 'success' : attempt.status === 'Failed' ? 'danger' : 'warning'}>{attempt.status}</Badge></td>
                        <td className="py-3 pr-4">{new Date(attempt.attemptedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                    {attempts.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-sm font-bold text-slate-400">No delivery attempts recorded.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
};
