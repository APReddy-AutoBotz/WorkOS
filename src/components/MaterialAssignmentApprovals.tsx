import {OverdueDeliveryHistory,StageDeadline,StageDurationInput} from './StageDeadline';
import {canActAtStage} from '../services/canonicalDelegations';
import {CanonicalDelegationEvidence} from './CanonicalDelegationEvidence';
import { useState } from 'react';
import { MATERIAL_ASSIGNMENT_FIELDS, validAssignmentApprovalPolicy } from '../../shared/assignment-approval.mjs';
import { APPROVAL_EVENT_KEYS, approvalUuid } from '../../shared/work-approval.mjs';
import { validPlannedAssignment } from '../../shared/assignment-version.mjs';
import { validCapabilityDate, compareCapabilityIds } from '../../shared/workforce-capabilities.mjs';
import { workApprovals, captureWorkApprovalContext, type WorkStage, type WorkDecisionReceipt } from '../services/workApprovals';
import type { AssignmentApprovalDefinition, AssignmentApprovalPolicy, AssignmentApprovalSource, AssignmentApprovalPage, AssignmentApprovalInstance } from '../services/assignmentApprovals';
import type { AssignmentDefinition } from '../services/assignmentVersions';
import { useApprovalLease } from './GovernedWorkApprovals';
const service = workApprovals.assignments;
const plainDefinition = (s: AssignmentApprovalSource['snapshot']): AssignmentDefinition => ({ role: s.role, quantityUnit: s.quantityUnit, quantityExact: s.quantityExact, startsOn: s.startsOn, endsOn: s.endsOn, billable: s.billable, status: s.status, comment: s.comment });
const Policy = () => {
    const [choices, setChoices] = useState<Awaited<ReturnType<typeof service.choices>> | null>(null), [policies, setPolicies] = useState<AssignmentApprovalPolicy[]>([]), [next, setNext] = useState<number | null>(null), [workers, setWorkers] = useState<string[]>([]), [fields, setFields] = useState<string[]>([]), [stages, setStages] = useState<WorkStage[]>([{ userId: '', role: '' }]), [locale, setLocale] = useState(''), [templates, setTemplates] = useState(() => APPROVAL_EVENT_KEYS.map(key => ({ key, subject: '', body: '' }))), [completion, setCompletion] = useState(''), [effective, setEffective] = useState(''), [reason, setReason] = useState(''), [empty, setEmpty] = useState(false), [creation, setCreation] = useState('');
    const [escalation,setEscalation] = useState('');
    const [reminderLead,setReminderLead] = useState('');
    const [stageDuration,setStageDuration] = useState('');
    const lease = useApprovalLease(() => { setChoices(null); setPolicies([]); setNext(null); setWorkers([]); setFields([]); setStages([{ userId: '', role: '' }]); setStageDuration(''); setReminderLead(''); setEscalation(''); setLocale(''); setTemplates(APPROVAL_EVENT_KEYS.map(key => ({ key, subject: '', body: '' }))); setCompletion(''); setEffective(''); setReason(''); setEmpty(false); setCreation(''); });
    const load = () => lease.run('configure', false, async (c, live) => {
        const [a, b] = await Promise.all([service.choices(c), service.policies(c)]);
        if (live()) {
            setChoices(a);
            setPolicies(b.policies);
            setNext(b.nextBefore);
        }
    });
    const d: AssignmentApprovalDefinition = { entityType: 'Assignment', workerIds: [...workers].sort(compareCapabilityIds), materialFields: [...fields].sort(), stages, locale, templates, ...(stageDuration === '' ? {} : {stageDueMinutes:Number(stageDuration)}), ...(reminderLead === '' ? {} : {reminderLeadMinutes:Number(reminderLead)}), ...(stageDuration && escalation ? {escalationUserId:escalation} : {}), completionInApp: completion === 'enabled', ...(creation ? { creationRequired: creation === 'enabled' } : policies[0]?.definition.creationRequired !== undefined ? { creationRequired: policies[0].definition.creationRequired } : {}) }, valid = Boolean(choices && validAssignmentApprovalPolicy(d) && completion && validCapabilityDate(effective) && effective >= choices.today && (workers.length || empty) && reason.trim());
    if (!captureWorkApprovalContext('configure') || !captureWorkApprovalContext('assignment'))
        return null;
    return <section aria-label="Material assignment approval policy" className="my-4 rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Material assignment approval policy</h2><p>Explicit configuration controls selected material updates and optional creation approval for assignments. Each stage needs existing assignment-write rights and current source scope. No grants, conversions, identity transfers, external delivery or reopen are supplied.</p><button disabled={lease.waiting} onClick={() => void load()}>Load material assignment configuration</button>{lease.notice && <p role="status">{lease.notice}</p>}{choices && <><form onSubmit={e => {
                e.preventDefault();
                if (valid)
                    void lease.run('configure', true, async (c, live) => {
                        const p = await service.adopt(policies[0]?.id ?? null, effective, d, reason, c);
                        if (live()) {
                            setPolicies(v => [p, ...v]);
                            setReason('');
                            lease.setNotice('Prospective material-change policy recorded. Existing proposals retain their policy.');
                        }
                    });
            }}><fieldset disabled={lease.waiting || lease.phase === 'uncertain'} className="space-y-3"><label>Material policy effective date<input aria-label="Material policy effective date" type="date" value={effective} onChange={e => setEffective(e.target.value)}/></label><label>Material policy workers<select aria-label="Material policy workers" multiple value={workers} onChange={e => { setWorkers(Array.from(e.currentTarget.selectedOptions, (o: HTMLOptionElement) => o.value)); setEmpty(false); }}>{choices.workers.map(w => <option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}</select></label>{!workers.length && <label><input type="checkbox" checked={empty} onChange={e => setEmpty(e.target.checked)}/>Confirm no future workers match this policy</label>}<label>Fields requiring material approval<select aria-label="Fields requiring material approval" multiple value={fields} onChange={e => setFields(Array.from(e.currentTarget.selectedOptions, (o: HTMLOptionElement) => o.value))}>{MATERIAL_ASSIGNMENT_FIELDS.map(k => <option key={k}>{k}</option>)}</select></label>
 {stages.map((s, i) => <fieldset key={i}><legend>Assignment stage {i + 1}</legend><label>Assignment stage {i + 1} account<select aria-label={`Assignment stage ${i + 1} account`} value={s.userId} onChange={e => setStages(v => v.map((x, n) => n === i ? { userId: e.target.value, role: '' } : x))}><option value="">Select named account</option>{choices.users.filter(u => u.roles.length).map(u => <option key={u.id} value={u.id}>{u.username}</option>)}</select></label><label>Assignment stage {i + 1} role<select aria-label={`Assignment stage ${i + 1} role`} value={s.role} onChange={e => setStages(v => v.map((x, n) => n === i ? { ...x, role: e.target.value } : x))}><option value="">Select held role</option>{choices.users.find(u => u.id === s.userId)?.roles.map(role => <option key={role}>{role}</option>)}</select></label>{stages.length > 1 && <button type="button" onClick={() => setStages(v => v.filter((_, n) => n !== i))}>Remove assignment stage {i + 1}</button>}</fieldset>)}<button type="button" disabled={stages.length >= 10} onClick={() => setStages(v => [...v, { userId: '', role: '' }])}>Add assignment approval stage</button><StageDurationInput value={stageDuration} onChange={value=>{setStageDuration(value); if (!value) setEscalation('');}} reminderLead={reminderLead} onReminderChange={setReminderLead}/>
 <label>Escalation recipient (optional)<select value={stageDuration ? escalation : ''} disabled={!stageDuration}
 onChange={e=>setEscalation(e.target.value)}><option value="">Stage approvers only</option>{choices?.users.map(u=><option key={u.id} value={u.id}>{u.username}</option>)}</select></label><label>Assignment template locale<input aria-label="Assignment template locale" value={locale} onChange={e => setLocale(e.target.value)}/></label><p>Plain-text variables: workerCode, sourceRef, stageNumber, decisionReason in double braces. No external addresses or financial fields.</p>{templates.map((t, i) => <fieldset key={t.key}><legend>{t.key}</legend><label>Assignment {t.key} title<input aria-label={`Assignment ${t.key} title`} maxLength={200} value={t.subject} onChange={e => setTemplates(v => v.map((x, n) => n === i ? { ...x, subject: e.target.value } : x))}/></label><label>Assignment {t.key} body<textarea aria-label={`Assignment ${t.key} body`} maxLength={8000} value={t.body} onChange={e => setTemplates(v => v.map((x, n) => n === i ? { ...x, body: e.target.value } : x))}/></label></fieldset>)}<label>Assignment informational completion<select aria-label="Assignment informational completion" value={completion} onChange={e => setCompletion(e.target.value)}><option value="">Choose explicitly</option><option value="enabled">Enabled subject to preference</option><option value="disabled">Disabled</option></select></label><label>Require creation approval<select aria-label="Require creation approval" value={creation} onChange={e => setCreation(e.target.value)}><option value="">Keep adopted creation option unchanged</option><option value="enabled">Require creation approval for selected workers</option><option value="disabled">Do not require creation approval</option></select></label><label>Material policy reason<input aria-label="Material policy reason" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)}/></label><button type="submit" disabled={!valid}>Record material assignment policy</button></fieldset></form>
 {(['worker', 'user'] as const).map(kind => (kind === 'worker' ? choices.nextWorker : choices.nextUser) && <button key={kind} disabled={lease.waiting} onClick={() => void lease.run('configure', false, async (c, live) => {
                    const r = await service.choices(c, kind === 'worker' ? choices.nextWorker : null, kind === 'user' ? choices.nextUser : null);
                    if (live())
                        setChoices({ ...r, workers: kind === 'worker' ? [...choices.workers, ...r.workers] : choices.workers, users: kind === 'user' ? [...choices.users, ...r.users] : choices.users, nextWorker: kind === 'worker' ? r.nextWorker : choices.nextWorker, nextUser: kind === 'user' ? r.nextUser : choices.nextUser });
                })}>More assignment {kind} choices</button>)}</>}
 {policies.map(p => <article key={p.id} aria-label={`Material assignment policy ${p.sequence}`}><p>Version {p.sequence} · From {p.effectiveFrom} · {p.definition.workerIds.length} workers · Fields {p.definition.materialFields.join(', ')} · Creation approval {p.definition.creationRequired === undefined ? 'Not configured' : p.definition.creationRequired ? 'Required' : 'Not required'} · {p.definition.stages.length} named stages</p><p>{p.reason}</p><button disabled={lease.waiting} onClick={() => { setCreation(p.definition.creationRequired === undefined ? '' : p.definition.creationRequired ? 'enabled' : 'disabled'); setWorkers(p.definition.workerIds); setFields(p.definition.materialFields); setStages(p.definition.stages.map(s => ({ ...s }))); setStageDuration(String(p.definition.stageDueMinutes ?? '')); setReminderLead(String(p.definition.reminderLeadMinutes ?? '')); setEscalation(p.definition.escalationUserId ?? ''); setLocale(p.definition.locale); setTemplates(p.definition.templates.map(t => ({ ...t }))); setCompletion(p.definition.completionInApp ? 'enabled' : 'disabled'); setEffective(''); setEmpty(false); }}>Use material policy {p.sequence} as draft</button></article>)}{next !== null && <button disabled={lease.waiting} onClick={() => void lease.run('configure', false, async (c, live) => {
                const r = await service.policies(c, next);
                if (live()) {
                    setPolicies(v => [...v, ...r.policies]);
                    setNext(r.nextBefore);
                }
            })}>Older material policies</button>}</section>;
};
const Proposals = () => {
    const [overdue,setOverdue] = useState(false);
    const [id, setId] = useState(''), [source, setSource] = useState<AssignmentApprovalSource | null>(null), [draft, setDraft] = useState<AssignmentDefinition | null>(null), [reason, setReason] = useState(''), [page, setPage] = useState<AssignmentApprovalPage | null>(null), [rows, setRows] = useState<AssignmentApprovalInstance[]>([]), [next, setNext] = useState<string | null>(null), [decisionReason, setDecisionReason] = useState(''), [receipt, setReceipt] = useState<WorkDecisionReceipt | null>(null);
    const lease = useApprovalLease(() => { setId(''); setSource(null); setDraft(null); setReason(''); setPage(null); setOverdue(false);setRows([]); setNext(null); setDecisionReason(''); setReceipt(null); });
    const load = (selected = id) => lease.run('assignment', false, async (c, live) => {
        const s = await service.source(selected, c);
        if (live()) {
            setId(selected);
            setSource(s);
            setDraft(plainDefinition(s.snapshot));
            setPage(null);
            setReceipt(null);
            lease.setNotice('Current source loaded. A proposal does not change the effective assignment.');
        }
    });
    const inspect = (instanceId: string) => lease.run('assignment', false, async (c, live) => {
        const p = await service.instance(instanceId, c);
        if (live()) {
            setPage(p);
            setReceipt(null);
        }
    });
    const list = (after: string | null = null, overdueOnly = false) => lease.run('assignment', false, async (c, live) => {
        const r = await service.list(c, after, undefined, overdueOnly);
        if (live()) {
            setOverdue(overdueOnly); setRows(v => after ? [...v, ...r.instances] : r.instances);
            setNext(r.nextAfter);
        }
    });
    if (!captureWorkApprovalContext('assignment'))
        return null;
    const v = page?.instance, stage = v?.state.currentStage == null ? null : v.policy.definition.stages[v.state.currentStage], canDecide = Boolean(v && v.state.status === 'Pending' && v.sourceRevision === v.currentRevision && v.sourceVersionId === v.currentVersionId && v&&canActAtStage(v.policy.definition.stages,v.delegations,v.state.currentStage,page?.actorUserId,captureWorkApprovalContext('assignment-decide')?.activeRole));
    const decide = (decision: 'Approved' | 'Rejected') => {
        if (!page || !lease.isOwned())
            return;
        const p = page;
        void lease.run('assignment-decide', true, async (c, live) => {
            const r = await service.decide(p, decision, decisionReason, crypto.randomUUID(), c);
            if (live()) {
                setReceipt(r.receipt);
                setPage(null);
                setDecisionReason('');
                lease.setNotice('Stage receipt recorded. Reload proposal and effective assignment before another action.');
            }
        });
    };
    return <section aria-label="Material assignment proposals" className="my-4 rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Material assignment proposals</h2><p>Inspect exact before/after values. Pending and rejected proposals leave the effective source unchanged; final approval rechecks current source, permission, scope, dates and overlap before applying. Existing work and commercial evidence remains retained.</p><label>Assignment proposal source<input aria-label="Assignment proposal source" value={id} onChange={e => { setId(e.target.value); setSource(null); setDraft(null); setPage(null); }}/></label><button disabled={lease.waiting || !id.trim()} onClick={() => void load()}>Load assignment proposal source</button><button disabled={lease.waiting} onClick={() => void list()}>Load material assignment proposals</button><button disabled={lease.waiting} onClick={()=>void list(null,true)}>Show overdue material assignment proposals</button>{overdue && <p role="status">{rows.length ? "Showing overdue stages." : "No overdue stages in your current scope."}</p>}{next && <button disabled={lease.waiting} onClick={() => void list(next,overdue)}>More material assignment proposals</button>}{lease.notice && <p role="status">{lease.notice}</p>}{lease.waiting && <p role="status">Loading or recording material assignment evidence…</p>}
 {source && draft && <form onSubmit={e => {
                e.preventDefault();
                if (lease.phase === 'uncertain')
                    return;
                const captured = source;
                void lease.run('assignment', true, async (c, live) => {
                    const p = await service.propose(captured, draft, reason, crypto.randomUUID(), c);
                    if (live()) {
                        setPage(p);
                        setReason('');
                        lease.setNotice('Proposal recorded; effective assignment remains unchanged until final approval.');
                    }
                });
            }}><p>Current {source.snapshot.quantityExact}{source.snapshot.quantityUnit==='hours'?'h':'%'} · {source.snapshot.startsOn}–{source.snapshot.endsOn} · {source.snapshot.status} · {source.policy ? `Policy ${source.policy.sequence}, material fields: ${source.policy.definition.materialFields.join(', ')}` : 'No selected material-change policy.'}</p><fieldset disabled={lease.waiting || lease.phase === 'uncertain' || !source.policy}><legend>Complete proposed definition</legend><label>Proposed assignment unit<select value={draft.quantityUnit} onChange={e=>setDraft({...draft,quantityUnit:e.target.value as AssignmentDefinition['quantityUnit'],quantityExact:''})}><option value="percentage">Percentage</option><option value="hours">Fixed total hours</option></select></label><label>{draft.quantityUnit==='hours'?'Proposed assignment hours':'Proposed assignment percentage'}<input aria-label={draft.quantityUnit==='hours'?'Proposed assignment hours':'Proposed assignment percentage'} value={draft.quantityExact} onChange={e => setDraft({ ...draft, quantityExact: e.target.value })}/></label><label>Proposed assignment role<input aria-label="Proposed assignment role" value={draft.role ?? ''} onChange={e => setDraft({ ...draft, role: e.target.value || null })}/></label><label>Proposed assignment starts<input aria-label="Proposed assignment starts" type="date" value={draft.startsOn} onChange={e => setDraft({ ...draft, startsOn: e.target.value })}/></label><label>Proposed assignment ends<input aria-label="Proposed assignment ends" type="date" value={draft.endsOn} onChange={e => setDraft({ ...draft, endsOn: e.target.value })}/></label><label>Proposed assignment billability<select aria-label="Proposed assignment billability" value={String(draft.billable)} onChange={e => setDraft({ ...draft, billable: e.target.value === 'true' })}><option value="true">Billable within existing authority</option><option value="false">Non-billable</option></select></label><label>Proposed assignment status<select aria-label="Proposed assignment status" value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as AssignmentDefinition['status'] })}>{['Active', 'Paused', 'Completed'].map(s => <option key={s}>{s}</option>)}</select></label><label>Proposed assignment comment<textarea aria-label="Proposed assignment comment" value={draft.comment ?? ''} onChange={e => setDraft({ ...draft, comment: e.target.value || null })}/></label><label>Assignment proposal reason<input aria-label="Assignment proposal reason" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)}/></label><button disabled={!validPlannedAssignment(draft) || !reason.trim()} type="submit">Submit material assignment proposal</button></fieldset></form>}
 {rows.map(i => <article key={i.id}><p>{i.worker.name} · Assignment {i.assignmentId} · {i.state.status} · Proposed {i.proposed.quantityExact}{i.proposed.quantityUnit==='hours'?'h':'%'}</p><StageDeadline deadline={i.stageDeadline}/><button disabled={lease.waiting} onClick={() => void inspect(i.id)}>Inspect material proposal {i.id}</button></article>)}
 {v && <article aria-label="Current material assignment proposal" className="border p-3"><p>{v.worker.name} · {v.state.status} · Policy {v.policy.sequence}{stage && ` · Current stage ${v.state.currentStage! + 1} of ${v.policy.definition.stages.length}`}</p><StageDeadline deadline={v.stageDeadline}/><OverdueDeliveryHistory rows={v.overdueDeliveries}/><CanonicalDelegationEvidence bindings={v.delegations} transitions={v.transitions}/><p>{v.sourceRevision === v.currentRevision && v.sourceVersionId === v.currentVersionId ? 'Source matches retained proposal.' : 'Effective source/version has changed; pending decisions are unavailable.'}</p><table><caption>Exact retained assignment before and proposed after</caption><thead><tr><th>Field</th><th>Before</th><th>Proposed</th></tr></thead><tbody>{['role', 'quantityUnit', 'quantityExact', 'startsOn', 'endsOn', 'billable', 'status', 'comment'].map(k => <tr key={k}><td>{k}</td><td>{String(v.before[k as keyof AssignmentDefinition] ?? 'Not recorded')}</td><td>{String(v.proposed[k as keyof AssignmentDefinition] ?? 'Not recorded')}</td></tr>)}</tbody></table><p>Proposal reason: {v.reason}</p><button disabled={lease.waiting} onClick={() => void inspect(v.id)}>Reload current material proposal</button>{canDecide && <fieldset disabled={lease.waiting || lease.phase === 'uncertain'}><legend>Named current-stage decision</legend><label>Material assignment decision reason<input aria-label="Material assignment decision reason" maxLength={1000} value={decisionReason} onChange={e => setDecisionReason(e.target.value)}/></label><button disabled={!decisionReason.trim()} onClick={() => decide('Approved')}>Approve material assignment stage</button><button disabled={!decisionReason.trim()} onClick={() => decide('Rejected')}>Reject material assignment stage</button></fieldset>}<section aria-label="Immutable material assignment stage history">{v.transitions.map(t => <p key={t.id}>Stage {t.stage + 1} · {t.decision} · {t.reason} · Outcome {t.outcome.status} · {t.createdAt}</p>)}</section>{v.notificationFailures.map(f => <p key={f.sequence}>Informational completion unavailable for decision {f.sequence}; valid source outcome remains recorded.</p>)}<details><summary>Assignment approval evidence references</summary><p>Instance {v.id} · Assignment {v.assignmentId} · Policy {v.policy.id} · Source {v.sourceToken}</p></details></article>}
 {receipt && <article aria-label="Material assignment decision receipt"><p>Stage {receipt.stage + 1} · {receipt.decision} · Outcome {receipt.outcome.status} · {receipt.reason}</p><p>Retained receipt; reload source and proposal for current state.</p></article>}</section>;
};
export const MaterialAssignmentApprovals = () => <><Policy /><Proposals /></>;
