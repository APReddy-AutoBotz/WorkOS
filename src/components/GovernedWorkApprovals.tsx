import type { ReversalInspection } from '../services/reversalReviewDecisions';
import { useEffect, useRef, useState } from 'react';
import { APPROVAL_EVENT_KEYS, validWorkApprovalPolicy, approvalUuid } from '../../shared/work-approval.mjs';
import { compareCapabilityIds, validCapabilityDate } from '../../shared/workforce-capabilities.mjs';
import { ApiClientError } from '../services/apiClient';
import { workApprovals, captureWorkApprovalContext, isWorkApprovalContextCurrent, type WorkApprovalContext, type WorkApprovalDefinition, type WorkPolicy, type WorkApprovalInstance, type WorkApprovalPage, type WorkDecisionReceipt, type CanonicalWorkNotice } from '../services/workApprovals';
export const useApprovalLease = (reset: () => void) => {
    const generation = useRef(0), mounted = useRef(false), busy = useRef(false), owner = useRef<WorkApprovalContext | null>(null), resetRef = useRef(reset), [phase, setPhase] = useState<'idle' | 'loading' | 'saving' | 'ready' | 'blocked' | 'uncertain'>('idle'), [notice, setNotice] = useState('');
    resetRef.current = reset;
    const block = () => { ++generation.current; owner.current = null; busy.current = false; resetRef.current(); setPhase('blocked'); setNotice('Account, active role or scope changed. Reload explicitly.'); };
    useEffect(() => { mounted.current = true; const check = () => { if (owner.current && !isWorkApprovalContextCurrent(owner.current))
        block(); }; window.addEventListener('workos:organization-scope-switch-requested', block); window.addEventListener('workos:organization-scope-changed', block); window.addEventListener('focus', check); window.addEventListener('storage', check); return () => { mounted.current = false; ++generation.current; window.removeEventListener('workos:organization-scope-switch-requested', block); window.removeEventListener('workos:organization-scope-changed', block); window.removeEventListener('focus', check); window.removeEventListener('storage', check); }; }, []);
    const run = async (mode: WorkApprovalContext['mode'], write: boolean, action: (c: WorkApprovalContext | null, live: () => boolean) => Promise<void>) => { if (busy.current)
        return; const n = ++generation.current, c = captureWorkApprovalContext(mode, () => mounted.current && n === generation.current); owner.current = c; busy.current = true; setPhase(write ? 'saving' : 'loading'); setNotice(''); const live = () => Boolean(mounted.current && n === generation.current && c && isWorkApprovalContextCurrent(c)); try {
        await action(c, live);
        if (live())
            setPhase('ready');
    }
    catch (e) {
        if (mounted.current && n === generation.current) {
            if (!c || !isWorkApprovalContextCurrent(c)) {
                block();
                return;
            }
            setPhase(write ? 'uncertain' : 'blocked');
            setNotice(write ? 'Write not confirmed. Read current history before another attempt.' : e instanceof ApiClientError && [401, 403].includes(e.status) ? 'Current access could not be confirmed. Reload explicitly.' : 'Current source, policy or stage could not be confirmed. Reload explicitly.');
        }
    }
    finally {
        if (n === generation.current)
            busy.current = false;
    } };
    return { run, phase, notice, setNotice, waiting: phase === 'loading' || phase === 'saving', isOwned: () => Boolean(owner.current && isWorkApprovalContextCurrent(owner.current)) };
};
const labels: Record<string, string> = { 'approval.action_required': 'Action request', 'approval.rejected_or_correction_required': 'Correction', 'approval.completed': 'Completion' };
const blankTemplates = () => APPROVAL_EVENT_KEYS.map(key => ({ key, subject: '', body: '' }));
type Choices = Awaited<ReturnType<typeof workApprovals.choices>>;
export const WorkApprovalPolicyEditor = () => {
    const [dueSubject,setDueSubject]=useState(''),[dueBody,setDueBody]=useState('');
    const [escalationUserId,setEscalationUserId]=useState('');
    const [reminderLeadMinutes, setReminderLeadMinutes] = useState('');
    const [stageDueMinutes, setStageDueMinutes] = useState('');
    const [choices, setChoices] = useState<Choices | null>(null), [policies, setPolicies] = useState<WorkPolicy[]>([]), [latestId, setLatestId] = useState<string | null>(null), [nextBefore, setNextBefore] = useState<number | null>(null), [workerIds, setWorkerIds] = useState<string[]>([]), [stages, setStages] = useState([{ userId: '', role: '' }]), [locale, setLocale] = useState(''), [templates, setTemplates] = useState(blankTemplates), [completion, setCompletion] = useState(''), [effective, setEffective] = useState(''), [reason, setReason] = useState(''), [emptyConfirmed, setEmptyConfirmed] = useState(false);
    const lease = useApprovalLease(() => { setChoices(null); setPolicies([]); setLatestId(null); setNextBefore(null); setWorkerIds([]); setStages([{ userId: '', role: '' }]); setStageDueMinutes(''); setReminderLeadMinutes(''); setEscalationUserId(''); setDueSubject(''); setDueBody(''); setLocale(''); setTemplates(blankTemplates()); setCompletion(''); setEffective(''); setReason(''); setEmptyConfirmed(false); });
    const load = () => lease.run('configure', false, async (c, live) => { const [a, b] = await Promise.all([workApprovals.choices(null, null, c), workApprovals.policies(null, c)]); if (live()) {
        setChoices(a);
        setPolicies(b.policies);
        setLatestId(b.policies[0]?.id ?? null);
        setNextBefore(b.nextBefore);
    } });
    const moreChoices = (kind: 'worker' | 'user') => lease.run('configure', false, async (c, live) => { if (!choices)
        return; const out = await workApprovals.choices(kind === 'worker' ? choices.nextWorker : null, kind === 'user' ? choices.nextUser : null, c); if (live())
        setChoices({ ...out, workers: kind === 'worker' ? [...choices.workers, ...out.workers] : choices.workers, users: kind === 'user' ? [...choices.users, ...out.users] : choices.users, nextWorker: kind === 'worker' ? out.nextWorker : choices.nextWorker, nextUser: kind === 'user' ? out.nextUser : choices.nextUser }); });
    const older = () => lease.run('configure', false, async (c, live) => { const out = await workApprovals.policies(nextBefore, c); if (live()) {
        setPolicies(v => [...v, ...out.policies]);
        setNextBefore(out.nextBefore);
    } });
    const definition: WorkApprovalDefinition = { entityType: 'Timesheet', workerIds: [...workerIds].sort(compareCapabilityIds), stages, locale, templates, ...(stageDueMinutes === '' ? {} : {stageDueMinutes: Number(stageDueMinutes)}), ...(stageDueMinutes && reminderLeadMinutes ? {reminderLeadMinutes: Number(reminderLeadMinutes)} : {}), ...(stageDueMinutes && (dueSubject || dueBody) ? {overdueTemplate:{key:'approval.overdue_or_escalated',subject:dueSubject,body:dueBody}} : {}), ...(stageDueMinutes && escalationUserId ? {escalationUserId} : {}), completionInApp: completion === 'enabled' }, valid = Boolean(choices && validWorkApprovalPolicy(definition) && completion !== '' && validCapabilityDate(effective) && effective >= choices.today && (workerIds.length > 0 || emptyConfirmed) && reason.trim());
    const save = () => lease.run('configure', true, async (c, live) => { const out = await workApprovals.adopt(latestId, effective, definition, reason, c); if (live()) {
        setPolicies(v => [out, ...v]);
        setLatestId(out.id);
        setReason('');
        lease.setNotice('Prospective policy version recorded. Existing instances retain their policy and history.');
    } });
    const copy = (p: WorkPolicy) => { setWorkerIds(p.definition.workerIds); setStages(p.definition.stages.map(s => ({ ...s }))); setReminderLeadMinutes(String(p.definition.reminderLeadMinutes ?? '')); setStageDueMinutes(String(p.definition.stageDueMinutes ?? '')); setEscalationUserId(p.definition.escalationUserId ?? ''); setDueSubject(p.definition.overdueTemplate?.subject ?? ''); setDueBody(p.definition.overdueTemplate?.body ?? ''); setLocale(p.definition.locale); setTemplates(p.definition.templates.map(t => ({ ...t }))); setCompletion(p.definition.completionInApp ? 'enabled' : 'disabled'); setEffective(''); setEmptyConfirmed(false); };
    if (!captureWorkApprovalContext('configure'))
        return null;
    return <section aria-label="Staged work approval policy" className="my-4 rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Explicit work approval routing</h2><p>No routing is adopted until an authorized configuration is saved. Each stage names one existing account and role; it grants no decision rights. Empty future worker selection matches no new submissions. Existing instances keep their stages. External delivery, delegation, SLA and reopen are unavailable here.</p><button disabled={lease.waiting} onClick={() => void load()}>Load approval policy configuration</button>{choices?.nextWorker && <button disabled={lease.waiting} onClick={() => void moreChoices('worker')}>More policy workers</button>}{choices?.nextUser && <button disabled={lease.waiting} onClick={() => void moreChoices('user')}>More stage accounts</button>}{lease.notice && <p role="status">{lease.notice}</p>}{lease.waiting && <p role="status">{lease.phase === 'saving' ? 'Recording explicit approval policy…' : 'Loading scoped approval configuration…'}</p>}
 <form onSubmit={e => { e.preventDefault(); if (valid)
        void save(); }}><fieldset disabled={lease.waiting || !choices} className="space-y-3"><label className="block">Policy effective date<input aria-label="Policy effective date" type="date" value={effective} onChange={e => setEffective(e.target.value)}/></label><label className="block">Policy workers<select aria-label="Policy workers" multiple value={workerIds} onChange={e => { setWorkerIds(Array.from(e.currentTarget.selectedOptions, (o: HTMLOptionElement) => o.value)); setEmptyConfirmed(false); }}>{choices?.workers.map(w => <option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}</select></label>{workerIds.length === 0 && <label><input type="checkbox" checked={emptyConfirmed} onChange={e => setEmptyConfirmed(e.target.checked)}/>Confirm no future workers match this version</label>}
 {stages.map((stage, i) => <fieldset key={i} className="rounded border p-2"><legend>Stage {i + 1}</legend><label>Stage {i + 1} account<select aria-label={`Stage ${i + 1} account`} value={stage.userId} onChange={e => setStages(v => v.map((s, n) => n === i ? { userId: e.target.value, role: '' } : s))}><option value="">Select existing account</option>{choices?.users.filter(u => u.roles.length > 0).map(u => <option key={u.id} value={u.id}>{u.username}</option>)}</select></label><label>Stage {i + 1} role<select aria-label={`Stage ${i + 1} role`} value={stage.role} onChange={e => setStages(v => v.map((s, n) => n === i ? { ...s, role: e.target.value } : s))}><option value="">Select held decision role</option>{choices?.users.find(u => u.id === stage.userId)?.roles.map(role => <option key={role}>{role}</option>)}</select></label>{stages.length > 1 && <button type="button" onClick={() => setStages(v => v.filter((_, n) => n !== i))}>Remove stage {i + 1}</button>}</fieldset>)}<button type="button" disabled={stages.length >= 10} onClick={() => setStages(v => [...v, { userId: '', role: '' }])}>Add approval stage</button>
 <label className="block">Time allowed per approval stage (minutes, optional)<input type="number" min="1" step="1" value={stageDueMinutes} onChange={e => setStageDueMinutes(e.target.value)}/></label>
 {stageDueMinutes && <label className="block">Remind approver before deadline (minutes, optional)<input type="number" min="1" step="1" value={reminderLeadMinutes} onChange={e=>setReminderLeadMinutes(e.target.value)}/></label>}
 {stageDueMinutes && <label className="block">Escalation recipient (optional)<select value={escalationUserId} onChange={e=>setEscalationUserId(e.target.value)}><option value="">Choose a recipient</option>{choices?.users.map(u=><option key={u.id} value={u.id}>{u.username}</option>)}</select></label>}
 {stageDueMinutes && <fieldset><legend>Overdue notice</legend><p>Leave both fields blank to use the English system template.</p><label>Overdue title<input value={dueSubject} maxLength={200} onChange={e=>setDueSubject(e.target.value)}/></label><label>Overdue body<textarea value={dueBody} maxLength={8000} onChange={e=>setDueBody(e.target.value)}/></label></fieldset>}
 <label className="block">Template locale<input aria-label="Template locale" placeholder="e.g. en-GB" value={locale} onChange={e => setLocale(e.target.value)}/></label><p>Approved template variables: workerCode, sourceRef, stageNumber and decisionReason in double braces. Templates are plain in-app text and receive no financial fields or external address.</p>{templates.map((t, i) => <fieldset key={t.key} className="rounded border p-2"><legend>{labels[t.key]} template</legend><label>{labels[t.key]} title<input aria-label={`${labels[t.key]} title`} maxLength={200} value={t.subject} onChange={e => setTemplates(v => v.map((s, n) => n === i ? { ...s, subject: e.target.value } : s))}/></label><label>{labels[t.key]} body<textarea aria-label={`${labels[t.key]} body`} maxLength={8000} value={t.body} onChange={e => setTemplates(v => v.map((s, n) => n === i ? { ...s, body: e.target.value } : s))}/></label></fieldset>)}
 <label className="block">Informational completion in-app<select aria-label="Informational completion in-app" value={completion} onChange={e => setCompletion(e.target.value)}><option value="">Choose explicitly</option><option value="enabled">Enabled, subject to recipient preference</option><option value="disabled">Disabled by this policy</option></select></label><p>Action requests and correction notices are mandatory in-app and cannot be opted out. Email and collaboration delivery are not invoked.</p><label>Policy adoption reason<input aria-label="Policy adoption reason" required maxLength={1000} value={reason} onChange={e => setReason(e.target.value)}/></label><button disabled={!valid || lease.phase === 'uncertain'} type="submit">Record prospective work approval policy</button></fieldset></form>
 <section aria-label="Retained work approval policies">{policies.map(p => <article key={p.id} aria-label={`Work approval policy ${p.sequence}`} className="my-2 rounded border p-3"><p>Policy version {p.sequence} · From {p.effectiveFrom} · {p.definition.workerIds.length} selected workers · {p.definition.stages.length} stages · {p.definition.locale}{p.definition.stageDueMinutes != null && ' · ' + p.definition.stageDueMinutes + ' minutes per stage'}</p><p>{p.reason} · {p.activeRole} · {p.createdAt}</p><button disabled={lease.waiting} onClick={() => copy(p)}>Use policy {p.sequence} as draft</button></article>)}{nextBefore !== null && <button disabled={lease.waiting} onClick={() => void older()}>Older work approval policies</button>}</section></section>;
};
const WorkSource = ({ instance: v }: {
    instance: WorkApprovalInstance;
}) => v.source ? <section aria-label="Retained work for this approval"><h3 className="font-semibold">Retained work · Period ending {v.source.weekEnding}</h3><p>{v.source.totalHoursExact}h total · {v.source.billableHoursExact}h marked billable in the source. Billability is not financial treatment.</p><p>Current header: {v.source.currentHeaderStatus} · {v.source.isCurrentSubmission ? 'This is the current submitted version.' : 'This is an earlier retained version.'}</p><table className="w-full text-left"><caption>Exact retained entries for inspection before deciding</caption><thead><tr><th>Date</th><th>Work and context</th><th>Hours</th><th>Recorded notes and references</th></tr></thead><tbody>{v.source.entries.map(e => <tr key={e.id}><td>{e.date}</td><td>{e.workType} · {e.category ?? 'Legacy category'}{e.projectId && ' · Project ' + e.projectId}{e.clientName && ' · ' + e.clientName}</td><td>{e.hoursExact}h · {e.billable ? 'Billable in source' : 'Non-billable'}</td><td>{e.remark ?? 'No note'}{e.evidenceUrl && <> · <a href={e.evidenceUrl} target="_blank" rel="noopener noreferrer">Evidence reference</a></>}{e.workReference && ' · ' + e.workReference}</td></tr>)}</tbody></table></section> : null;
export const GovernedWorkApprovalInbox = () => {
    const [rows, setRows] = useState<WorkApprovalInstance[]>([]), [next, setNext] = useState<string | null>(null), [selected, setSelected] = useState(''), [page, setPage] = useState<WorkApprovalPage | null>(null), [reason, setReason] = useState(''), [receipt, setReceipt] = useState<WorkDecisionReceipt | null>(null);
    const lease = useApprovalLease(() => { setRows([]); setNext(null); setSelected(''); setPage(null); setReason(''); setReceipt(null); });
    const list = (after: string | null = null) => lease.run('read', false, async (c, live) => { setPage(null); setReceipt(null); const out = await workApprovals.list(after, c); if (live()) {
        setRows(v => after ? [...v, ...out.instances] : out.instances);
        setNext(out.nextAfter);
    } });
    const load = (id = selected) => lease.run('read', false, async (c, live) => { setPage(null); setReceipt(null); const out = await workApprovals.instance(id, c); if (live()) {
        setSelected(id);
        setPage(out);
    } });
    const decide = (decision: 'Approved' | 'Rejected') => { if (!page || !lease.isOwned())
        return; const captured = page, key = crypto.randomUUID(); void lease.run('decide', true, async (c, live) => { setPage(null); setReceipt(null); const out = await workApprovals.decide(captured, decision, reason, key, c); if (live()) {
        setReceipt(out.receipt);
        setReason('');
        lease.setNotice('Decision receipt recorded. Reload the instance for its current stage.');
    } }); };
    if (!captureWorkApprovalContext('read'))
        return null;
    const v = page?.instance, stage = v?.state.currentStage == null ? null : v.policy.stages[v.state.currentStage], canDecide = Boolean(v?.state.status === 'Pending' && v.source?.isCurrentSubmission && v.source.currentHeaderStatus === 'Submitted' && stage?.userId === page?.actorUserId && stage?.role === captureWorkApprovalContext('read')?.activeRole && captureWorkApprovalContext('decide'));
    return <section aria-label="Governed work approval inbox" className="my-4 rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Governed submitted-work approvals</h2><p>Only explicitly adopted new submissions appear here. Inspect the retained work before deciding. Each stage preserves existing permission, direct relationship, source and period checks; intermediate approval leaves work Submitted. Approved work cannot be reopened here.</p><button disabled={lease.waiting} onClick={() => void list()}>Load governed work approvals</button>{next && <button disabled={lease.waiting} onClick={() => void list(next)}>More governed work approvals</button>}<label className="block">Approval instance reference<input aria-label="Approval instance reference" disabled={lease.waiting} value={selected} onChange={e => { setSelected(e.target.value); setPage(null); setReceipt(null); }}/></label><button disabled={lease.waiting || !approvalUuid(selected)} onClick={() => void load()}>Load current work approval</button>{lease.waiting && <p role="status">{lease.phase === 'saving' ? 'Recording current-stage decision…' : 'Loading retained work approval…'}</p>}{lease.notice && <p role="status">{lease.notice}</p>}
 <div>{rows.map(r => <article key={r.id} aria-label={`Approval source ${r.id}`} className="border-t p-2"><p>{r.worker.name} · {r.worker.code} · Submission {r.submissionSequence} · {r.state.status}{r.state.currentStage !== null && ` · Stage ${r.state.currentStage + 1} of ${r.policy.stages.length}`}</p><button disabled={lease.waiting} onClick={() => void load(r.id)}>Inspect work approval {r.id}</button></article>)}</div>
 {page && v && <article aria-label="Current governed work approval" className="rounded border p-3 space-y-3"><h3>{v.worker.name} · Submission {v.submissionSequence} · {v.state.status}</h3><p>Policy version {v.policy.sequence} from {v.policy.effectiveFrom}. {stage ? `Current stage ${v.state.currentStage! + 1} of ${v.policy.stages.length}, configured role ${stage.role}.` : 'The retained instance is terminal.'}</p><WorkSource instance={v}/>{v.stageReminders?.map(r=><p key={r.stage}>Stage {r.stage+1} reminder delivered {r.deliveredAt}{r.readAt ? ` � Read ${r.readAt}` : ''}</p>)}{v.overdueDeliveries?.map(d=><p key={d.stage}>Overdue stage {d.stage+1} · Due {d.dueAt} · {d.status} · Delivery attempts {d.attempts}</p>)}{canDecide && <fieldset disabled={lease.waiting || lease.phase === 'uncertain'}><legend>Decision for your named current stage</legend><label>Work approval decision reason<input aria-label="Work approval decision reason" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)}/></label><button disabled={!reason.trim()} onClick={() => decide('Approved')}>Approve current work stage</button><button disabled={!reason.trim()} onClick={() => decide('Rejected')}>Reject current work stage</button></fieldset>}<section aria-label="Immutable work stage history">{v.transitions.map(t => <article key={t.id} aria-label={`Work stage decision ${t.sequence}`}><p>Stage {t.stage + 1} · {t.decision} · {t.activeRole} · {t.createdAt}</p><p>{t.reason} · Recorded outcome {t.outcome.status}</p></article>)}</section>{v.notificationFailures.map(f => <p key={f.sequence} role="status">Informational notification unavailable for decision {f.sequence}; the valid work outcome remains recorded. {f.code}</p>)}<details><summary>Audit references</summary><p>Instance {v.id} · Work {v.timesheetId} · Submission {v.submissionId} · Source {v.sourceToken} · Policy {v.policy.id}</p>{v.policy.stages.map((s, i) => <p key={i}>Stage {i + 1} · Named account {s.userId} · Role {s.role}</p>)}</details></article>}
 {receipt && <article aria-label="Recorded work stage receipt" className="rounded border p-3"><p>Decision {receipt.sequence} · Stage {receipt.stage + 1} · {receipt.decision} · Recorded outcome {receipt.outcome.status}</p><p>{receipt.reason} · {receipt.createdAt}</p><p>This is a retained receipt; reload for current state.</p></article>}</section>;
};
export const GovernedWorkApprovals = () => <><WorkApprovalPolicyEditor /><GovernedWorkApprovalInbox /></>;
export const CanonicalApprovalInbox = () => {
    const [rows, setRows] = useState<CanonicalWorkNotice[]>([]), [next, setNext] = useState<string | null>(null), lease = useApprovalLease(() => { setRows([]); setNext(null); });
    const load = (after: string | null = null) => lease.run('inbox', false, async (c, live) => { const out = await workApprovals.inbox(after, c); if (live()) {
        setRows(v => after ? [...v, ...out.notifications] : out.notifications);
        setNext(out.nextAfter);
    } });
    const read = (n: CanonicalWorkNotice) => lease.run('inbox', true, async (c, live) => { const out = await workApprovals.read(n, c); if (live()) {
        setRows(v => v.map(r => r.id === out.id ? out : r));
        lease.setNotice('Your in-app acknowledgement is recorded.');
    } });
    if (!captureWorkApprovalContext('inbox'))
        return null;
    return <section aria-label="Canonical work approval notifications" className="my-4 rounded-xl border p-4 space-y-3"><h2 className="font-semibold">My governed work notifications</h2><p>These are retained canonical in-app events addressed to your account in the current scope. A message is a retained observation; inspect the current work or approval source before acting. External delivery is not invoked.</p><button disabled={lease.waiting} onClick={() => void load()}>Load my governed notifications</button>{next && <button disabled={lease.waiting} onClick={() => void load(next)}>More governed notifications</button>}{lease.notice && <p role="status">{lease.notice}</p>}{rows.map(n => <article key={n.id} aria-label={`Governed notification ${n.id}`} className="rounded border p-3"><h3>{'reminder' in n && n.reminder ? 'Reminder - ' : ''}{n.title}</h3><p>{n.body}</p><p>{n.eventKey} · {n.policyClass} · {n.locale} · {n.createdAt}</p><p>Recipient reasons: {n.reasons.join(', ')} · In-app {n.channelDecision} · {n.readAt ? 'Read ' + n.readAt : 'Unread'}</p>{'kind'in n&&n.kind==='milestone-billing-eligibility'?<p>Milestone {n.milestoneId} · Approval instance {n.instanceId} · Delivery {n.deliveryStatus}</p>:'kind'in n&&n.kind==='invoice-action'?<p>Invoice batch {n.batchId} · Action required</p>:'kind'in n&&n.kind==='retainer-risk'?<p>Retainer version {n.versionId} · {n.startsOn} through {n.endsOn} · {n.metric}</p>:'kind'in n&&n.kind==='purchase-order-risk'?<p>Purchase order {n.orderId} · {n.metric}</p>:'kind'in n&&n.kind==='monthly-margin-risk'?<p>Engagement {n.engagementId} · {n.monthStart.slice(0,7)} · Margin below approved threshold</p>:'kind'in n&&n.kind==='fixed-fee-risk'?<p>Engagement {n.engagementId} · {n.metric==='effort'?'Delivery hours':'Labor cost'} warning</p>:'kind'in n&&n.kind==='invoice-export'?<p>Invoice batch {n.batchId} · Delivery {n.deliveryStatus}</p>:'kind'in n&&n.kind==='invoice-reversal-decision'&&n.reasons.every(reason=>reason==='affected_worker')?<p>Invoice correction review {n.instanceId}</p>:'kind'in n&&(n.kind==='invoice-reversal-review'||n.kind==='invoice-reversal-decision')?<ReversalDecisionPanel id={n.instanceId} batchId={n.batchId}/>:'kind'in n&&n.kind==='invoice-batch-approval'?<p>Invoice batch {n.batchId} · Approval instance {n.instanceId}</p>:'kind'in n&&n.kind==='tm-billing-eligibility'?<p>Billing eligibility · Snapshot {n.snapshotId}</p>:'kind'in n&&n.kind==='commercial-candidate-approval'?<p>Commercial candidate {n.candidateId} · Approval instance {n.instanceId}</p>:'kind'in n&&n.kind==='assignment-approval'?<p>Assignment {n.assignmentId} · Approval instance {n.instanceId} · Accepted in-app delivery {n.deliveryStatus}</p>:'kind'in n?<p>Work period {n.periodId} · Accepted in-app delivery {n.deliveryStatus}</p>:<p>Approval instance {n.instanceId}</p>}{!n.readAt && <button disabled={lease.waiting || lease.phase === 'uncertain'} onClick={() => void read(n)}>Mark governed notification read {n.id}</button>}</article>)}</section>;
};


function ReversalDecisionPanel({id,batchId}:{id:string;batchId:string}) {
  const [source,setSource]=useState<ReversalInspection|null>(null);
  const [choice,setChoice]=useState<'Approved'|'Rejected'|''>('');
  const [reason,setReason]=useState('');
  const clear=()=>{setSource(null);setReason('');setChoice('');};
  const lease=useApprovalLease(clear);
  const inspect=()=>lease.run('inbox',false,async(c,live)=>{
    clear();
    const result=await workApprovals.reversalReview(id,batchId,c);
    if(live())setSource(result);
  });
  const decide=()=>source?.canDecide && choice && reason.trim().length>=3 && lease.run('inbox',true,async(c,live)=>{
    const input={source,decision:choice,reason:reason.trim()};
    clear();
    const result=await workApprovals.reversalReview(id,batchId,c,input);
    if(live())setSource(result);
  });
  return <section aria-label="Reversal review evidence">
    <p>{source?.kind ?? 'Invoice correction'} review {id} · Invoice batch {batchId}</p>
    <button type="button" disabled={lease.waiting} onClick={()=>void inspect()}>Inspect reversal evidence</button>
    {lease.notice && <p role="status">{lease.notice}</p>}
    {source && <div>
      <p>Requested {source.kind ?? 'full reversal'} of {source.currency} {source.amount} · {source.requestReason}</p>
      <p>Line {source.lineId} · Original export {source.artifactId} · SHA-256 {source.sha256}</p>
      <p>{source.externalReference ? 'Downstream confirmation '+source.externalReference : 'Awaiting downstream confirmation'}</p>
      <p>Policy {source.policyId} · Review {source.status} · {source.decisions.length} of {source.stageCount} decisions recorded</p>
      <ol>{source.decisions.map(d=><li key={d.id}>Stage {d.sequence} · {d.decision} · {d.activeRole} {d.actorId} · {d.reason}</li>)}</ol>
      {source.canDecide && <fieldset disabled={lease.waiting}>
        <label>Reversal decision <select aria-label="Reversal decision" value={choice} onChange={e=>setChoice(e.target.value as typeof choice)}>
          <option value="">Choose a decision</option><option>Approved</option><option>Rejected</option>
        </select></label>
        <label>Reversal decision reason <input aria-label="Reversal decision reason" value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
        <button type="button" disabled={!choice||reason.trim().length<3} onClick={()=>void decide()}>Record reversal decision</button>
      </fieldset>}
    </div>}
  </section>;
}
