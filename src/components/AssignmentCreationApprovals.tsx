import {OverdueDeliveryHistory,StageDeadline} from './StageDeadline';
import {canActAtStage} from '../services/canonicalDelegations';
import {CanonicalDelegationEvidence} from './CanonicalDelegationEvidence';
import { useState } from 'react';
import { workApprovals, captureWorkApprovalContext, type WorkDecisionReceipt } from '../services/workApprovals';
import type { AssignmentApprovalPolicy, AssignmentCreationPage, AssignmentCreationInstance } from '../services/assignmentApprovals';
import type { AssignmentDefinition } from '../services/assignmentVersions';
import { validPlannedAssignment } from '../../shared/assignment-version.mjs';
import { useApprovalLease } from './GovernedWorkApprovals';
const service = workApprovals.assignments;

export const AssignmentCreationRequest = ({ workerId, projectId, definition }: { workerId: string; projectId: string; definition: AssignmentDefinition }) => {
  const [policy, setPolicy] = useState<AssignmentApprovalPolicy | null>(null), [loaded, setLoaded] = useState(false), [reason, setReason] = useState(''), [recorded, setRecorded] = useState<AssignmentCreationPage | null>(null);
  const lease = useApprovalLease(() => { setPolicy(null); setLoaded(false); setRecorded(null); setReason(''); });
  return <section aria-label="Configured assignment creation request" className="rounded border p-3 space-y-2">
    <h3>Request assignment creation approval</h3>
    <p>This request creates no allocation and reserves no capacity. Only the final configured approval can make the reviewed assignment effective.</p>
    <p>Worker {workerId} · Project {projectId} · {definition.role ?? 'No role'} · {definition.quantityExact}{definition.quantityUnit==='hours'?'h total':'%'} · {definition.startsOn}–{definition.endsOn} · {definition.status} · {definition.billable ? 'Billable within source authority' : 'Non-billable'}</p>
    <button type="button" disabled={lease.waiting || !workerId || !projectId} onClick={() => void lease.run('assignment', false, async (c, live) => { const p = await service.creationPolicy(workerId, projectId, c); if (live()) { setPolicy(p); setLoaded(true); setRecorded(null); } })}>Load creation approval policy</button>
    {loaded && !policy && <p>No creation approval policy is currently adopted for this worker. The ordinary allocation command retains its existing rules.</p>}
    {policy && <><p>Policy {policy.sequence} · {policy.definition.stages.length} named stages. Review every assignment field before requesting.</p><label>Creation request reason<input aria-label="Creation request reason" value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} /></label><button type="button" disabled={lease.waiting || lease.phase === 'uncertain' || !reason.trim() || !validPlannedAssignment(definition)} onClick={() => void lease.run('assignment', true, async (c, live) => { const r = await service.requestCreation(workerId, projectId, policy, definition, reason, crypto.randomUUID(), c); if (live()) setRecorded(r); })}>Submit configured creation request</button></>}
    {lease.notice && <p role="status">{lease.notice}</p>}
    {recorded && <article aria-label="Recorded assignment creation request"><p>Request {recorded.instance.id} · {recorded.instance.state.status}. This acknowledgement is retained history; inspect current approval state before acting.</p><p>Reserved assignment {recorded.instance.assignmentId}. Pending or rejected requests have no effective allocation.</p></article>}
  </section>;
};

export const AssignmentCreationApprovals = () => {
  const [overdue,setOverdue] = useState(false);
  const [rows, setRows] = useState<AssignmentCreationInstance[]>([]), [next, setNext] = useState<string | null>(null), [reference, setReference] = useState(''), [page, setPage] = useState<AssignmentCreationPage | null>(null), [reason, setReason] = useState(''), [receipt, setReceipt] = useState<WorkDecisionReceipt | null>(null);
  const lease = useApprovalLease(() => { setOverdue(false);setRows([]); setNext(null); setReference(''); setPage(null); setReason(''); setReceipt(null); });
  const load = (after: string | null = null, overdueOnly = false) => lease.run('assignment', false, async (c, live) => { const r = await service.creations(c, after, overdueOnly); if (live()) { setOverdue(overdueOnly); setRows(v => after ? [...v, ...r.instances] : r.instances); setNext(r.nextAfter); } });
  const inspect = (id: string) => lease.run('assignment', false, async (c, live) => { const r = await service.creation(id, c); if (live()) { setPage(r); setReference(id); setReason(''); setReceipt(null); } });
  const v = page?.instance, stage = v?.state.currentStage === null || !v ? null : v.policy.definition.stages[v.state.currentStage], c = captureWorkApprovalContext('assignment-decide');
  const canDecide = Boolean(v?.state.status === 'Pending' && v&&canActAtStage(v.policy.definition.stages,v.delegations,v.state.currentStage,page?.actorUserId,c?.activeRole) && v.currentVersionId === null && v.currentRevision === v.sourceRevision);
  const decide = (decision: 'Approved' | 'Rejected') => { if (page) void lease.run('assignment-decide', true, async (context, live) => { const r = await service.decide(page, decision, reason, crypto.randomUUID(), context); if (live()) { setReceipt(r.receipt); setPage(null); setReason(''); } }); };
  return <section aria-label="Governed assignment creation approvals" className="my-4 rounded border p-4 space-y-2"><h2>Assignment creation requests</h2><p>Requests are separate from effective allocations. Pending stages and rejections reserve no capacity. Final approval rechecks current source permissions, relationships, dates and overlap.</p>
    <button disabled={lease.waiting} onClick={() => void load()}>Load assignment creation requests</button><button disabled={lease.waiting} onClick={()=>void load(null,true)}>Show overdue assignment creation requests</button>{overdue && <p role="status">{rows.length ? "Showing overdue stages." : "No overdue stages in your current scope."}</p>}{next && <button disabled={lease.waiting} onClick={() => void load(next,overdue)}>More creation requests</button>}
    <label>Creation approval reference<input aria-label="Creation approval reference" value={reference} onChange={e => setReference(e.target.value)} /></label><button disabled={lease.waiting || !reference} onClick={() => void inspect(reference)}>Load current creation approval</button>
    {rows.map(i => <article key={i.id}><p>{i.worker.name} · {i.proposed.quantityExact}{i.proposed.quantityUnit==='hours'?'h':'%'} · {i.state.status}</p><StageDeadline deadline={i.stageDeadline}/><button disabled={lease.waiting} onClick={() => void inspect(i.id)}>Inspect creation request {i.id}</button></article>)}
    {lease.notice && <p role="status">{lease.notice}</p>}
    {v && <article aria-label="Current assignment creation approval"><p>Request {v.id} · {v.state.status} · Worker {v.worker.name} · Project {v.projectId}</p><p>{v.proposed.role ?? 'No role'} · {v.proposed.quantityExact}{v.proposed.quantityUnit==='hours'?'h':'%'} · {v.proposed.startsOn}–{v.proposed.endsOn} · {v.proposed.status} · {v.proposed.billable ? 'Billable within source authority' : 'Non-billable'}</p><p>{v.proposed.comment}</p><p>{v.currentVersionId ? 'Effective assignment version exists; inspect the source for current planning.' : 'No effective assignment version exists for this request.'} Reserved identity {v.assignmentId}</p><p>Request reason: {v.reason}</p>
      <StageDeadline deadline={v.stageDeadline}/><OverdueDeliveryHistory rows={v.overdueDeliveries}/><CanonicalDelegationEvidence bindings={v.delegations} transitions={v.transitions}/>
      {canDecide && <fieldset disabled={lease.waiting || lease.phase === 'uncertain'}><legend>Named current creation stage</legend><label>Creation decision reason<input aria-label="Creation decision reason" value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} /></label><button disabled={!reason.trim()} onClick={() => decide('Approved')}>Approve assignment creation stage</button><button disabled={!reason.trim()} onClick={() => decide('Rejected')}>Reject assignment creation stage</button></fieldset>}
      <section aria-label="Immutable assignment creation stage history">{v.transitions.map(t => <p key={t.id}>Stage {t.stage + 1} · {t.decision} · {t.reason} · Outcome {t.outcome.status}</p>)}</section>{v.notificationFailures.map(f => <p key={f.sequence}>Informational completion unavailable for decision {f.sequence}; retained source outcome is unchanged.</p>)}
    </article>}
    {receipt && <article aria-label="Assignment creation decision receipt"><p>Stage {receipt.stage + 1} · {receipt.decision} · Outcome {receipt.outcome.status} · {receipt.reason}</p><p>Reload current approval/source before another action.</p></article>}
  </section>;
};
