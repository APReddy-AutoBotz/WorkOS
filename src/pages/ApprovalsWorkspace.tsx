import { ReviewedApprovalBatch } from '../components/ReviewedApprovalBatch';
import { AssignmentCreationApprovals } from '../components/AssignmentCreationApprovals';
import {MaterialAssignmentApprovals} from '../components/MaterialAssignmentApprovals';
import {WorkPeriodNoticeProducer} from '../components/WorkPeriodNoticeProducer';
import {GovernedWorkApprovals} from '../components/GovernedWorkApprovals';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, History, ShieldCheck, XCircle } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { allocationService, approvalService, employeeService, leaveService, projectService } from '../services/api';
import { authService } from '../services/authService';
import { filterEmployeesByOrgVisibility } from '../services/orgChart';
import type { Allocation, ApprovalDelegation, ApprovalRecord, Employee, LeaveRequest, Project } from '../types';

const statusVariant = (status: ApprovalRecord['status']) => {
  if (status === 'Approved') return 'success';
  if (status === 'Rejected' || status === 'Cancelled') return 'danger';
  if (status === 'Pending') return 'warning';
  return 'neutral';
};

const formatDateTime = (value?: string) => value ? new Date(value).toLocaleString(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}) : '-';

const Metric = ({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub: string; icon: typeof Clock }) => (
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

const ApprovalTable = ({
  title,
  rows,
  onDecide,
  leaveRequestsById,
}: {
  title: string;
  rows: ApprovalRecord[];
  onDecide?: (record: ApprovalRecord, status: 'Approved' | 'Rejected') => void;
  leaveRequestsById?: Map<string, LeaveRequest>;
}) => (
  <Card title={title}>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400">
            <th className="py-3 pr-4">Item</th>
            <th className="py-3 pr-4">Employee</th>
            <th className="py-3 pr-4">Submitted</th>
            <th className="py-3 pr-4">Due</th>
            <th className="py-3 pr-4">Status</th>
            {onDecide && <th className="py-3 text-right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(record => {
            const leaveRequest = record.entityType === 'LeaveRequest' ? leaveRequestsById?.get(record.entityId) : undefined;
            return (
              <tr key={record.id} className="border-b border-slate-50">
                <td className="py-3 pr-4">
                  <p className="font-black text-heading">{record.entityType}</p>
                  {leaveRequest ? (
                    <div className="mt-1 space-y-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                      <p>{leaveRequest.leaveTypeName || leaveRequest.leaveTypeId}</p>
                      <p>{leaveRequest.startDate} to {leaveRequest.endDate}</p>
                      <p>{leaveRequest.totalDays.toFixed(1)} day(s)</p>
                    </div>
                  ) : (
                    <p className="mt-1 max-w-52 truncate text-[10px] font-bold text-slate-400">{record.entityId}</p>
                  )}
                </td>
              <td className="py-3 pr-4 font-bold text-heading">{record.subjectEmployeeName || record.subjectEmployeeId || '-'}</td>
              <td className="py-3 pr-4 text-body">{formatDateTime(record.createdAt)}</td>
              <td className="py-3 pr-4 text-body">{formatDateTime(record.dueAt)}</td>
              <td className="py-3 pr-4"><Badge variant={statusVariant(record.status)}>{record.status}</Badge></td>
              {onDecide && (
                <td className="py-3 text-right">
                  {record.status === 'Pending' && (
                    <div className="flex justify-end gap-2">
                      <button className="rounded-lg border border-green-200 bg-green-50 p-2 text-green-700" title="Approve" onClick={() => onDecide(record, 'Approved')}>
                        <CheckCircle2 size={16} />
                      </button>
                      <button className="rounded-lg border border-red-200 bg-red-50 p-2 text-red-700" title="Reject" onClick={() => onDecide(record, 'Rejected')}>
                        <XCircle size={16} />
                      </button>
                    </div>
                  )}
                </td>
              )}
            </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td className="py-8 text-center text-sm font-bold text-slate-400" colSpan={onDecide ? 6 : 5}>No approval records in this scope.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  </Card>
);

export const ApprovalsWorkspace = () => {
  const user = authService.getCurrentUser();
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [delegations, setDelegations] = useState<ApprovalDelegation[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [delegatorId, setDelegatorId] = useState('');
  const [delegateId, setDelegateId] = useState('');
  const [delegationRole, setDelegationRole] = useState('ProjectManager');
  const [delegationStartDate, setDelegationStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [delegationEndDate, setDelegationEndDate] = useState(() => {
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    return nextWeek.toISOString().slice(0, 10);
  });
  const [delegationReason, setDelegationReason] = useState('');

  const refresh = async () => {
    setLoading(true);
    const [approvalRows, delegationRows, employeeRows, allocationRows, projectRows, leaveRequestRows] = await Promise.all([
      approvalService.getAll(),
      approvalService.getDelegations(),
      employeeService.getAll(),
      allocationService.getAll(),
      projectService.getAll(),
      leaveService.getRequests().catch(() => []),
    ]);
    setApprovals(approvalRows);
    setDelegations(delegationRows);
    setEmployees(employeeRows);
    setAllocations(allocationRows);
    setProjects(projectRows);
    setLeaveRequests(leaveRequestRows);
    setDelegatorId(current => current || (['Admin', 'HR'].includes(user?.role || '') ? employeeRows.find(employee => employee.status === 'Active')?.id : user?.id) || '');
    setDelegateId(current => current || employeeRows.find(employee => employee.status === 'Active' && employee.id !== (user?.id || ''))?.id || '');
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const scopedEmployeeIds = useMemo(() => new Set(filterEmployeesByOrgVisibility({
    user,
    employees,
    allocations,
    projects,
  }).map(employee => employee.id)), [user, employees, allocations, projects]);

  const visibleApprovals = useMemo(() => {
    if (!user) return [];
    if (user.role === 'Admin' || user.role === 'HR') return approvals;
    return approvals.filter(record =>
      record.requesterId === user.id ||
      record.approverId === user.id ||
      record.subjectEmployeeId === user.id ||
      Boolean(record.subjectEmployeeId && scopedEmployeeIds.has(record.subjectEmployeeId))
    );
  }, [approvals, scopedEmployeeIds, user]);

  const visibleDelegations = useMemo(() => {
    if (!user) return [];
    if (user.role === 'Admin' || user.role === 'HR') return delegations;
    return delegations.filter(item => item.delegatorId === user.id || item.delegateId === user.id);
  }, [delegations, user]);

  const activeEmployees = useMemo(() => employees.filter(employee => employee.status === 'Active'), [employees]);
  const delegatorOptions = useMemo(() => {
    if (!user) return [];
    if (user.role === 'Admin' || user.role === 'HR') return activeEmployees;
    return activeEmployees.filter(employee => employee.id === user.id);
  }, [activeEmployees, user]);
  const delegateOptions = useMemo(() => activeEmployees.filter(employee => employee.id !== delegatorId), [activeEmployees, delegatorId]);

  const pending = useMemo(() => visibleApprovals.filter(record => record.status === 'Pending'), [visibleApprovals]);
  const history = useMemo(() => visibleApprovals.filter(record => record.status !== 'Pending'), [visibleApprovals]);
  const leaveRequestsById = useMemo(() => new Map(leaveRequests.map(request => [request.id, request])), [leaveRequests]);
  const overdueCount = useMemo(() => {
    const now = Date.now();
    return pending.filter(record => record.dueAt && new Date(record.dueAt).getTime() < now).length;
  }, [pending]);
  const averageAgeHours = useMemo(() => {
    if (pending.length === 0) return 0;
    const now = Date.now();
    const total = pending.reduce((sum, record) => sum + Math.max(0, (now - new Date(record.createdAt).getTime()) / 36e5), 0);
    return Number((total / pending.length).toFixed(1));
  }, [pending]);

  const decide = async (record: ApprovalRecord, status: 'Approved' | 'Rejected') => {
    const comments = status === 'Rejected' ? 'Rejected from shared approval workspace.' : undefined;
    try {
      await approvalService.decide(record.id, status, comments);
      setNotice(`${status} ${record.entityType} approval.`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${record.entityType} approval decision failed.`);
    }
  };

  const saveDelegation = async () => {
    if (!delegatorId || !delegateId) return;
    await approvalService.saveDelegation({
      id: '',
      delegatorId,
      delegateId,
      role: delegationRole,
      startDate: delegationStartDate,
      endDate: delegationEndDate,
      status: 'Active',
      reason: delegationReason.trim() || undefined,
    });
    const delegate = employees.find(employee => employee.id === delegateId);
    setNotice(`Created approval delegation${delegate ? ` to ${delegate.name}` : ''}.`);
    setDelegationReason('');
    await refresh();
  };

  return (
    <div className="space-y-6 pb-12">
      <ReviewedApprovalBatch/><MaterialAssignmentApprovals/><AssignmentCreationApprovals/><GovernedWorkApprovals/><WorkPeriodNoticeProducer/>
      <PageHeader
        title="Approvals Inbox"
        subtitle="Shared approval inbox, approval history, delegations, and SLA governance."
        breadcrumb={['Workforce OS', 'Approvals']}
      />
      {notice && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{notice}</div>}
      {loading ? <Card>Loading approval workspace...</Card> : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <Metric label="Pending" value={pending.length} sub="Open approval records" icon={Clock} />
            <Metric label="Overdue" value={overdueCount} sub="Past configured SLA" icon={ShieldCheck} />
            <Metric label="Avg Age" value={`${averageAgeHours}h`} sub="Pending approval age" icon={History} />
            <Metric label="Delegations" value={visibleDelegations.filter(item => item.status === 'Active').length} sub="Active delegation rows" icon={CheckCircle2} />
          </div>
          <ApprovalTable title="Approval Inbox" rows={pending} onDecide={decide} leaveRequestsById={leaveRequestsById} />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <ApprovalTable title="Approval History" rows={history.slice(0, 20)} leaveRequestsById={leaveRequestsById} />
            <Card title="Approval Delegations">
              <div className="mb-5 rounded-xl border border-slate-100 bg-slate-50 p-4">
                <div className="grid grid-cols-1 gap-3">
                  <select className="input-field" value={delegatorId} onChange={event => setDelegatorId(event.target.value)}>
                    {delegatorOptions.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                  </select>
                  <select className="input-field" value={delegateId} onChange={event => setDelegateId(event.target.value)}>
                    {delegateOptions.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                  </select>
                  <select className="input-field" value={delegationRole} onChange={event => setDelegationRole(event.target.value)}>
                    {['ProjectManager', 'TeamLead', 'CountryDirector', 'HR', 'Admin'].map(role => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <input type="date" className="input-field" value={delegationStartDate} onChange={event => setDelegationStartDate(event.target.value)} />
                    <input type="date" className="input-field" value={delegationEndDate} onChange={event => setDelegationEndDate(event.target.value)} />
                  </div>
                  <textarea
                    className="input-field min-h-20 resize-none"
                    value={delegationReason}
                    onChange={event => setDelegationReason(event.target.value)}
                    placeholder="Reason for delegation"
                  />
                  <button
                    type="button"
                    onClick={saveDelegation}
                    disabled={!delegatorId || !delegateId || delegationEndDate < delegationStartDate}
                    className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
                  >
                    Create Delegation
                  </button>
                </div>
              </div>
              <div className="space-y-3">
                {visibleDelegations.map(delegation => (
                  <div key={delegation.id} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-black text-heading">{delegation.delegatorName || delegation.delegatorId} to {delegation.delegateName || delegation.delegateId}</p>
                      <Badge variant={delegation.status === 'Active' ? 'success' : 'neutral'}>{delegation.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs font-bold text-body/60">{delegation.role} | {delegation.startDate} to {delegation.endDate}</p>
                  </div>
                ))}
                {visibleDelegations.length === 0 && <p className="py-8 text-center text-sm font-bold text-slate-400">No approval delegations configured in this scope.</p>}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
};
