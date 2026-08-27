import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, KeyRound, Link2, RefreshCw, ShieldCheck, UsersRound } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { employeeService, integrationService } from '../services/api';
import type { Employee, EntraRoleMapping, IdentityProviderLink, IntegrationEventLog, IntegrationHealthReport, TeamsActionToken, TeamsUserLink, UserRole } from '../types';

import { productConfig } from '../config/productConfig';
const roleOptions: UserRole[] = ['Employee', 'TeamLead', 'ProjectManager', 'CountryDirector', 'HR', 'Admin'];
const statusVariant = (status: string) => status === 'Linked' || status === 'Success' ? 'success' : status === 'Failed' ? 'danger' : 'warning';

const Metric = ({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub: string; icon: typeof Activity }) => (
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

const EventLogPanel = ({ events }: { events: IntegrationEventLog[] }) => (
  <Card title="Integration Event Logs">
    <div className="space-y-3">
      {events.slice(0, 12).map(event => (
        <div key={event.id} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-black text-heading">{event.eventType}</p>
            <Badge variant={statusVariant(event.status)}>{event.status}</Badge>
          </div>
          <p className="mt-1 text-xs font-bold text-body/60">{event.provider} | {event.entityType || 'Integration'} | {new Date(event.createdAt).toLocaleString()}</p>
        </div>
      ))}
      {events.length === 0 && <p className="py-8 text-center text-sm font-bold text-slate-400">No integration events recorded.</p>}
    </div>
  </Card>
);

const CredentialReadinessPanel = ({ health }: { health: IntegrationHealthReport | null }) => {
  const checks = health?.credentialChecks || [];
  if (checks.length === 0) return null;
  const readyCount = checks.filter(check => check.configured).length;
  return (
    <Card title="Credential Readiness">
      <div className="mb-4 flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm font-bold">
        <span>Configured values</span>
        <Badge variant={readyCount === checks.length ? 'success' : 'warning'}>{readyCount}/{checks.length}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {checks.map(check => (
          <div key={`${check.area}-${check.key}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs font-bold">
            <div>
              <p className="text-heading">{check.label}</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-widest text-slate-400">{check.area} | {check.key}{check.secret ? ' | secret' : ''}</p>
            </div>
            <Badge variant={check.configured ? 'success' : 'warning'}>{check.configured ? 'Ready' : 'Pending'}</Badge>
          </div>
        ))}
      </div>
    </Card>
  );
};

export const IdentityIntegration = () => {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [links, setLinks] = useState<IdentityProviderLink[]>([]);
  const [mappings, setMappings] = useState<EntraRoleMapping[]>([]);
  const [health, setHealth] = useState<IntegrationHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [providerSubject, setProviderSubject] = useState('');
  const [providerUpn, setProviderUpn] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [roleName, setRoleName] = useState<UserRole>('Employee');

  const refresh = async () => {
    setLoading(true);
    const [employeeRows, linkRows, mappingRows, healthReport] = await Promise.all([
      employeeService.getAll(),
      integrationService.getIdentityLinks(),
      integrationService.getEntraRoleMappings(),
      integrationService.getHealth(),
    ]);
    setEmployees(employeeRows);
    setLinks(linkRows);
    setMappings(mappingRows);
    setHealth(healthReport);
    setSelectedEmployeeId(current => current || employeeRows[0]?.id || '');
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const selectedEmployee = useMemo(() => employees.find(employee => employee.id === selectedEmployeeId), [employees, selectedEmployeeId]);

  const saveIdentityLink = async () => {
    if (!selectedEmployee || !providerSubject.trim()) return;
    await integrationService.saveIdentityLink({
      id: `identity-link-${selectedEmployee.id}`,
      employeeId: selectedEmployee.id,
      employeeName: selectedEmployee.name,
      provider: 'entra',
      providerSubject: providerSubject.trim(),
      providerUpn: providerUpn.trim() || selectedEmployee.email,
      status: 'Linked',
    });
    setNotice(`Linked ${selectedEmployee.name} to Entra subject.`);
    setProviderSubject('');
    setProviderUpn('');
    await refresh();
  };

  const saveRoleMapping = async () => {
    if (!groupId.trim() || !groupName.trim()) return;
    await integrationService.saveEntraRoleMapping({
      id: `entra-role-map-${groupId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      groupId: groupId.trim(),
      groupName: groupName.trim(),
      roleName,
      active: true,
    });
    setNotice(`Mapped ${groupName.trim()} to ${roleName}.`);
    setGroupId('');
    setGroupName('');
    await refresh();
  };

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Identity Mapping"
        subtitle="Entra-ready identity provider links, group-role mapping, and integration health."
        breadcrumb={['Workforce OS', 'Integrations', 'Identity']}
      />
      {notice && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{notice}</div>}
      {loading ? <Card>Loading identity integrations...</Card> : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <Metric label="Provider" value={health?.identityProvider || 'local'} sub="Adapter mode" icon={ShieldCheck} />
            <Metric label="Linked Identity" value={health?.linkedIdentityCount || 0} sub="Employees with provider links" icon={UsersRound} />
            <Metric label="Role Mappings" value={health?.activeRoleMappings || 0} sub="Active Entra group mappings" icon={KeyRound} />
            <Metric label="Missing Links" value={health?.missingIdentityLinks || 0} sub="Active employees still unmapped" icon={Activity} />
          </div>

          <CredentialReadinessPanel health={health} />

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1fr]">
            <Card title="Identity Provider Links">
              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
                <select className="input-field" value={selectedEmployeeId} onChange={event => setSelectedEmployeeId(event.target.value)}>
                  {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                </select>
                <input className="input-field" placeholder="Entra object ID" value={providerSubject} onChange={event => setProviderSubject(event.target.value)} />
                <input className="input-field" placeholder="UPN" value={providerUpn} onChange={event => setProviderUpn(event.target.value)} />
                <button type="button" onClick={saveIdentityLink} className="btn-primary px-4 py-2 text-sm">Link</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400">
                      <th className="py-3 pr-4">Employee</th>
                      <th className="py-3 pr-4">Provider</th>
                      <th className="py-3 pr-4">Subject</th>
                      <th className="py-3 pr-4">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map(link => (
                      <tr key={link.id} className="border-b border-slate-50">
                        <td className="py-3 pr-4 font-bold text-heading">{link.employeeName || link.employeeId}</td>
                        <td className="py-3 pr-4">{link.provider}</td>
                        <td className="max-w-64 truncate py-3 pr-4 text-body">{link.providerSubject}</td>
                        <td className="py-3 pr-4"><Badge variant={statusVariant(link.status)}>{link.status}</Badge></td>
                      </tr>
                    ))}
                    {links.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-sm font-bold text-slate-400">No identity links configured.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Entra Role Mapping">
              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_0.7fr_auto]">
                <input className="input-field" placeholder="Group ID" value={groupId} onChange={event => setGroupId(event.target.value)} />
                <input className="input-field" placeholder="Group name" value={groupName} onChange={event => setGroupName(event.target.value)} />
                <select className="input-field" value={roleName} onChange={event => setRoleName(event.target.value as UserRole)}>
                  {roleOptions.map(role => <option key={role} value={role}>{role}</option>)}
                </select>
                <button type="button" onClick={saveRoleMapping} className="btn-primary px-4 py-2 text-sm">Map</button>
              </div>
              <div className="space-y-3">
                {mappings.map(mapping => (
                  <div key={mapping.id} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-black text-heading">{mapping.groupName}</p>
                      <Badge variant={mapping.active ? 'success' : 'neutral'}>{mapping.roleName}</Badge>
                    </div>
                    <p className="mt-1 text-xs font-bold text-body/60">{mapping.groupId}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <EventLogPanel events={health?.events || []} />
        </>
      )}
    </div>
  );
};

export const TeamsIntegration = () => {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [links, setLinks] = useState<TeamsUserLink[]>([]);
  const [health, setHealth] = useState<IntegrationHealthReport | null>(null);
  const [events, setEvents] = useState<IntegrationEventLog[]>([]);
  const [lastToken, setLastToken] = useState<TeamsActionToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [teamsUserId, setTeamsUserId] = useState('');
  const [teamsUpn, setTeamsUpn] = useState('');
  const [teamsTenantId, setTeamsTenantId] = useState('');

  const refresh = async () => {
    setLoading(true);
    const [employeeRows, linkRows, healthReport, eventRows] = await Promise.all([
      employeeService.getAll(),
      integrationService.getTeamsUserLinks(),
      integrationService.getHealth(),
      integrationService.getIntegrationEvents(),
    ]);
    setEmployees(employeeRows);
    setLinks(linkRows);
    setHealth(healthReport);
    setEvents(eventRows);
    setSelectedEmployeeId(current => current || employeeRows[0]?.id || '');
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const selectedEmployee = useMemo(() => employees.find(employee => employee.id === selectedEmployeeId), [employees, selectedEmployeeId]);

  const saveTeamsLink = async () => {
    if (!selectedEmployee || !teamsUserId.trim()) return;
    await integrationService.saveTeamsUserLink({
      id: `teams-link-${selectedEmployee.id}`,
      employeeId: selectedEmployee.id,
      employeeName: selectedEmployee.name,
      teamsUserId: teamsUserId.trim(),
      teamsUpn: teamsUpn.trim() || selectedEmployee.email,
      teamsTenantId: teamsTenantId.trim() || undefined,
      status: 'Linked',
    });
    setNotice(`Linked ${selectedEmployee.name} to Teams.`);
    setTeamsUserId('');
    setTeamsUpn('');
    setTeamsTenantId('');
    await refresh();
  };

  const createPortalToken = async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const token = await integrationService.createTeamsActionToken({
      entityType: 'PortalLink',
      entityId: 'workforce-portal',
      action: 'open_portal',
      targetUrl: '/approvals',
      expiresAt,
    });
    setLastToken(token);
    setNotice('Created deterministic Teams portal action token.');
    await refresh();
  };

  const createAndSendPortalToken = async () => {
    if (!selectedEmployee) return;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const token = await integrationService.createTeamsActionToken({
      entityType: 'PortalLink',
      entityId: 'workforce-portal',
      action: 'open_portal',
      targetUrl: '/approvals',
      expiresAt,
    });
    const sent = await integrationService.sendTeamsActionNotification(
      token.token,
      selectedEmployee.id,
      `${productConfig.productName} action link`,
      'Open the portal to review pending workforce approvals and actions.',
    );
    setLastToken(sent);
    setNotice(`Created and sent a Teams action link to ${selectedEmployee.name}.`);
    await refresh();
  };

  const executeToken = async () => {
    if (!lastToken) return;
    const token = await integrationService.executeTeamsActionToken(lastToken.token);
    setLastToken(token);
    setNotice('Executed Teams action token and wrote audit/event logs.');
    await refresh();
  };

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Teams Mapping"
        subtitle="Teams-ready user links, deterministic action tokens, and mock action audit."
        breadcrumb={['Workforce OS', 'Integrations', 'Teams']}
      />
      {notice && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{notice}</div>}
      {loading ? <Card>Loading Teams integrations...</Card> : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <Metric label="Provider" value={health?.teamsProvider || 'mock'} sub="Teams adapter mode" icon={Link2} />
            <Metric label="Teams Links" value={health?.linkedTeamsCount || 0} sub="Employees with Teams links" icon={UsersRound} />
            <Metric label="Open Tokens" value={health?.openActionTokens || 0} sub="Unexpired deterministic actions" icon={KeyRound} />
            <Metric label="Missing Links" value={health?.missingTeamsLinks || 0} sub="Active employees still unmapped" icon={Activity} />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_0.8fr]">
            <Card title="Teams User Mapping">
              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                <select className="input-field" value={selectedEmployeeId} onChange={event => setSelectedEmployeeId(event.target.value)}>
                  {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                </select>
                <input className="input-field" placeholder="Teams user ID" value={teamsUserId} onChange={event => setTeamsUserId(event.target.value)} />
                <input className="input-field" placeholder="Teams UPN" value={teamsUpn} onChange={event => setTeamsUpn(event.target.value)} />
                <input className="input-field" placeholder="Tenant ID" value={teamsTenantId} onChange={event => setTeamsTenantId(event.target.value)} />
                <button type="button" onClick={saveTeamsLink} className="btn-primary px-4 py-2 text-sm">Link</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400">
                      <th className="py-3 pr-4">Employee</th>
                      <th className="py-3 pr-4">Teams User</th>
                      <th className="py-3 pr-4">UPN</th>
                      <th className="py-3 pr-4">Tenant</th>
                      <th className="py-3 pr-4">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map(link => (
                      <tr key={link.id} className="border-b border-slate-50">
                        <td className="py-3 pr-4 font-bold text-heading">{link.employeeName || link.employeeId}</td>
                        <td className="max-w-52 truncate py-3 pr-4">{link.teamsUserId}</td>
                        <td className="py-3 pr-4 text-body">{link.teamsUpn || '-'}</td>
                        <td className="max-w-40 truncate py-3 pr-4 text-body">{link.teamsTenantId || '-'}</td>
                        <td className="py-3 pr-4"><Badge variant={statusVariant(link.status)}>{link.status}</Badge></td>
                      </tr>
                    ))}
                    {links.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-sm font-bold text-slate-400">No Teams user links configured.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="space-y-6">
              <Card title="Teams Action Tokens">
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-3">
                    <button type="button" onClick={createPortalToken} className="btn-primary flex items-center gap-2 px-4 py-2 text-sm">
                      <KeyRound size={16} /> Create Portal Token
                    </button>
                    <button type="button" onClick={createAndSendPortalToken} disabled={!selectedEmployee} className="btn-secondary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50">
                      <Link2 size={16} /> Create & Send Link
                    </button>
                    <button type="button" onClick={executeToken} disabled={!lastToken || Boolean(lastToken.usedAt)} className="btn-secondary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50">
                      <CheckCircle2 size={16} /> Execute Token
                    </button>
                  </div>
                  {lastToken && (
                    <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                      <p className="text-sm font-black text-heading">{lastToken.action}</p>
                      <p className="mt-1 max-w-full truncate text-xs font-bold text-body/60">{lastToken.token}</p>
                      {lastToken.actionUrl && <p className="mt-2 max-w-full truncate text-xs font-bold text-primary">{lastToken.actionUrl}</p>}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant={lastToken.usedAt ? 'success' : 'warning'}>{lastToken.usedAt ? 'Used' : 'Open'}</Badge>
                        <Badge variant="info">{lastToken.entityType}</Badge>
                        {lastToken.notificationId && <Badge variant="success">Sent</Badge>}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
              <Card title="Integration Health">
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm font-bold">
                    <span>Email adapter</span><Badge variant="info">{health?.emailProvider || 'mock'}</Badge>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm font-bold">
                    <span>Graph credentials</span><Badge variant={health?.graphCredentialReady ? 'success' : 'warning'}>{health?.graphCredentialReady ? 'Ready' : 'Pending'}</Badge>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm font-bold">
                    <span>Teams activity</span><Badge variant={health?.teamsCredentialReady ? 'success' : 'warning'}>{health?.teamsActivityType || 'systemDefault'}</Badge>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm font-bold">
                    <span>Recent failures</span><Badge variant={health?.recentFailures ? 'danger' : 'success'}>{health?.recentFailures || 0}</Badge>
                  </div>
                  <button type="button" onClick={refresh} className="btn-secondary flex w-full items-center justify-center gap-2 px-4 py-2 text-sm">
                    <RefreshCw size={16} /> Refresh Health
                  </button>
                </div>
              </Card>
            </div>
          </div>

          <CredentialReadinessPanel health={health} />
          <EventLogPanel events={events} />
        </>
      )}
    </div>
  );
};
