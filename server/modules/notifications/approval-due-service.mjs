import {canonicalStageRecipients} from '../approvals/canonical-delegation-service.mjs';
import {scopedLeaveApproval,leaveApprovalActor} from '../approvals/leave-approval-service.mjs';
import { randomUUID } from 'node:crypto';
import { APPROVAL_DUE_KEY, approvalDueRecipients, approvalDueIdentity, renderApprovalDue } from '../../../shared/approval-due.mjs';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { workApprovalScope as scope, workApprovalUser, workApprovalActor, scopedWorkApproval, workApprovalFail as fail, setWorkApprovalContext } from '../approvals/work-approval-service.mjs';
import { scopedAssignmentApproval, assignmentApprovalActor } from '../approvals/assignment-approval-service.mjs';
const iso = v => v instanceof Date ? v.toISOString() : v;
export const approvalDuePolicyView = p => ({ id: p.id, sequence: p.sequence, effectiveFrom: p.effective_from, definition: p.definition, actorId: p.actor_id, activeRole: p.active_role, reason: p.reason, createdAt: iso(p.created_at) });
export const approvalDueTarget = async (c, req, target, workerId, kinds, projectId, o) => {
  const u = await workApprovalUser(c, req, target.userId, o), permissions = await o.getEffectivePermissionsForUser(c, u.id, target.role);
  if (!u.roles.includes(target.role) || !['employees.view', 'notifications.view', ...(kinds.includes('Work') ? ['timesheets.submit'] : []), ...(kinds.includes('Leave') ? ['leave.self_service'] : []), ...(kinds.some(k => !['Work','Leave'].includes(k)) ? ['allocations.view', 'projects.view'] : [])].every(k => permissions.includes(k))) fail('APPROVAL_DUE_TARGET_UNAVAILABLE', 'The named target must retain its existing held role, source-read and inbox rights.');
  if (!workerId) return;
  const actor = { ...req, user: { sub: u.id, username: u.username, activeRole: target.role, employeeRecordId: u.employee_record_id, employeeId: u.employee_id, countryDirectorId: u.country_director_id, permissions } }, params = [workerId], ew = o.buildEmployeeScopeWhere(actor, params, 'e');
  if (!(await c.query(`select 1 from employees e where e.id=$1 and ${ew}`, params)).rowCount) fail('APPROVAL_DUE_TARGET_UNAVAILABLE', 'The named target has no current scoped worker-read relationship.');
  if (projectId) { const p = [projectId], pw = o.buildProjectScopeWhere(actor, p, 'p'); if (!(await c.query(`select 1 from projects p where p.id=$1 and ${pw}`, p)).rowCount) fail('APPROVAL_DUE_TARGET_UNAVAILABLE', 'The named target has no current project-read relationship.'); }
};
export const approvalDueSource = async (c, req, origin, instanceId, o) => {
  if (origin === 'Work') { const v = await scopedWorkApproval(c, req, instanceId, o, false, true); return { v, worker: { id: v.worker.id, code: v.worker.code, name: v.worker.name }, state: v.state, sourceToken: v.i.source_token, projectId: null }; }
  if(origin==='Leave'){const v=await scopedLeaveApproval(c,req,instanceId,o);return{v,worker:{id:v.i.employee_id,code:v.a.worker_code,name:v.a.worker_name},state:v.state,sourceToken:v.i.source_token,projectId:null};}
  const v = await scopedAssignmentApproval(c, req, instanceId, o);
  if ((v.i.operation_kind === 'Creation' ? 'Creation' : 'Material') !== origin) fail('APPROVAL_DUE_NOT_FOUND', 'The selected source kind does not match.', 404);
  return { v, worker: { id: v.i.employee_id, code: v.a.worker_code, name: v.a.worker_name }, state: v.state, sourceToken: v.i.source_token, projectId: v.i.project_id };
};
export const approvalDuePreview = async (c, req, origin, instanceId, stage, o) => {
  const source = await approvalDueSource(c, req, origin, instanceId, o), now = (await c.query('select clock_timestamp() now')).rows[0].now.toISOString();
  const row = (await c.query('select c.*,b.policy_id,p.definition,p.sequence policy_sequence,p.effective_from::text from approval_due_clocks c join approval_due_bindings b on b.origin=c.origin and b.instance_id=c.instance_id join approval_due_policies p on p.id=b.policy_id where c.origin=$1 and c.instance_id=$2 and c.stage=$3', [origin, instanceId, stage])).rows[0];
  const clock = row ? { id: row.id, policyId: row.policy_id, policySequence: row.policy_sequence, effectiveFrom: row.effective_from, stage: row.stage, sourceEventId: row.source_event_id, pendingAt: iso(row.activated_at), dueAt: iso(row.due_at), clockBasis: row.definition.clockBasis, cohort: row.definition.cohort, dueAfterMinutes: row.definition.dueAfterMinutes, approver: { userId: row.approver_user_id, role: row.approver_role }, target: row.definition.target, locale: row.definition.locale } : null;
  const current = (await c.query('select approval_due_current($1,$2,$3) current', [origin, instanceId, stage])).rows[0].current;
  const existing = row ? (await c.query('select id from approval_due_events where clock_id=$1', [row.id])).rows[0]?.id ?? null : null;
  const state = source.state.status !== 'Pending' ? 'Terminal' : source.state.currentStage !== stage || !current ? 'Stale' : !clock ? 'Unconfigured' : Date.parse(now) <= Date.parse(clock.dueAt) ? 'Waiting' : existing ? 'Notified' : 'Overdue';
  let recipients = [],delegatedApprover;
  if (state === 'Overdue') {
    if (origin === 'Work') await workApprovalActor(c, req, clock.approver, (await c.query('select * from timesheets where id=$1', [source.v.i.timesheet_id])).rows[0], o);
    else if(origin==='Leave')await leaveApprovalActor(c,req,clock.approver,source.v.a,o);
    else await assignmentApprovalActor(c, req, clock.approver, source.v.a, o);
    await approvalDueTarget(c, req, clock.target, source.worker.id, [origin], source.projectId, o);
    const v=source.v,stages=origin==='Work'?v.policy.definition.stages:v.p.definition.stages,validator=origin==='Work'?workApprovalActor:origin==='Leave'?leaveApprovalActor:assignmentApprovalActor,record=origin==='Work'?(await c.query('select * from timesheets where id=$1',[v.i.timesheet_id])).rows[0]:v.a;
    const actors=await canonicalStageRecipients(c,req,v,stages,stage,record,validator,o),binding=(v.delegations??[]).find(b=>b.stage===stage&&b.eligible);
    if(binding)delegatedApprover={bindingId:binding.id,delegationId:binding.delegationId,userId:binding.delegateUserId,role:binding.role};
    recipients = approvalDueRecipients(clock.approver.userId, clock.target.userId,actors.filter(a=>a.userId!==clock.approver.userId).map(a=>a.userId));
  }
  const view = { ...(delegatedApprover?{delegatedApprover}:{}),origin, instanceId, stage, worker: source.worker, sourceVersion: source.sourceToken, sourceState: source.state, clock, state, eventKey: state === 'Overdue' ? APPROVAL_DUE_KEY : null, existingEvent: existing, recipientReasons: recipients }, canonical = capacityCanonical(view);
  return { ...view, sourceToken: capacityHash(canonical), checkedAt: now, sourceCanonical: canonical };
};
export const approvalDuePreviewView = ({ sourceCanonical: _c, ...v }) => v;
export const approvalDueRunView = r => ({ id: r.id, sequence: r.sequence, origin: r.origin, instanceId: r.instance_id, stage: r.stage, clockId: r.clock_id, requestId: r.request_id, actorId: r.actor_id, activeRole: r.active_role, reason: r.reason, operationId: r.operation_id, correlationId: r.correlation_id, sourceToken: r.source_token, outcome: r.outcome, createdAt: iso(r.created_at) });
export const evaluateApprovalDue = async (c, req, input, o) => {
  const fingerprint = capacityHash({ actorId: req.user.sub, role: req.user.activeRole, ...input }), old = (await c.query('select * from approval_due_runs where organization_id=$1 and legal_entity_id=$2 and request_id=$3', [...scope(req), input.requestId])).rows[0];
  if (old) { await approvalDueSource(c, req, old.origin, old.instance_id, o); if (old.request_fingerprint !== fingerprint) fail('APPROVAL_DUE_REQUEST_CONFLICT', 'Request identity has different reviewed source/content.'); return { receipt: approvalDueRunView(old), replayed: true }; }
  const v = await approvalDuePreview(c, req, input.origin, input.instanceId, input.stage, o);
  if (v.sourceToken !== input.expectedSourceToken || v.eventKey !== input.expectedEventKey) fail('APPROVAL_DUE_STALE', 'Source, stage, phase or recipient authority changed. Inspect again.');
  const id = randomUUID(), seq = (await c.query('select coalesce(max(sequence),0)+1 n from approval_due_runs where origin=$1 and instance_id=$2', [input.origin, input.instanceId])).rows[0].n;
  const eventId = v.eventKey ? approvalDueIdentity(v.clock.id, req.operationId) : v.existingEvent;
  const outcome = { state: v.state, disposition: v.eventKey ? 'Emitted' : v.existingEvent ? 'Existing' : 'NoEvent', eventKey: v.eventKey, eventId, checkedAt: v.checkedAt, sourceToken: v.sourceToken };
  await setWorkApprovalContext(c, req);
  const saved = (await c.query('insert into approval_due_runs(id,organization_id,legal_entity_id,origin,instance_id,stage,clock_id,sequence,request_id,request_fingerprint,actor_id,active_role,reason,operation_id,correlation_id,source_token,source_canonical,outcome)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)returning *', [id, ...scope(req), input.origin, input.instanceId, input.stage, v.clock?.id ?? null, seq, input.requestId, fingerprint, req.user.sub, req.user.activeRole, input.reason, req.operationId, req.correlationId, v.sourceToken, v.sourceCanonical, outcome])).rows[0];
  if (v.eventKey) {
    const p = (await c.query('select p.definition,t.* from approval_due_policies p join approval_due_templates t on t.policy_id=p.id where p.id=$1', [v.clock.policyId])).rows[0]; if (!p) fail('APPROVAL_DUE_TEMPLATE_UNAVAILABLE', 'Retained template unavailable.');
    const rendered = renderApprovalDue({ key: p.event_key, subject: p.subject, body: p.body }, { workerCode: v.worker.code, sourceRef: `${v.origin.toLowerCase()}/${v.instanceId}`, stageNumber: String(v.stage + 1), pendingAt: v.clock.pendingAt, dueAt: v.clock.dueAt });
    await c.query('insert into approval_due_events(id,clock_id,run_id,event_key,policy_class,template_id,operation_id,correlation_id,locale,title,body)values($1,$2,$3,$4,\'CONTROL_MANDATORY\',$5,$6,$7,$8,$9,$10)', [eventId, v.clock.id, id, APPROVAL_DUE_KEY, p.id, req.operationId, req.correlationId, p.locale, rendered.title, rendered.body]);
    for (const recipient of v.recipientReasons) {
      const rid = randomUUID(); await c.query("insert into approval_due_recipients values($1,$2,$3,$4,true,'Required')", [rid, eventId, recipient.userId, recipient.reasons]);
      await c.query("insert into approval_due_deliveries(id,recipient_id,channel,status,operation_id,correlation_id,attempt)values($1,$2,'InApp','Delivered',$3,$4,1)", [randomUUID(), rid, req.operationId, req.correlationId]);
    }
  }
  await o.audit(c, req, { module: 'Approvals', action: 'Evaluate Retained Approval Stage Due Clock', entityType: 'ApprovalDueEvaluation', entityId: id, newValue: approvalDueRunView(saved), reason: input.reason, details: 'Authenticated on-demand explicit retained UTC stage clock; atomic mandatory in-app set, no decision, reassignment, schedule, grant or external delivery.' });
  return { receipt: approvalDueRunView(saved), replayed: false };
};
export const approvalDueInboxRows = async (c, req, o, { after = null, id = null } = {}) => {
  if (!(await c.query("select to_regclass('public.approval_due_recipients') t")).rows[0].t) return [];
  const p = [req.user.sub, ...scope(req), after, id], ew = o.buildEmployeeScopeWhere(req, p, 'w'), pw = o.buildProjectScopeWhere(req, p, 'p');
  return (await c.query(`select 'approval-overdue'kind,n.id,e.id "eventId",r.id "runId",r.origin,r.instance_id "instanceId",r.stage,e.clock_id "clockId",cl.activated_at "pendingAt",cl.due_at "dueAt",e.event_key "eventKey",e.policy_class "policyClass",e.template_id "templateId",e.operation_id "operationId",e.correlation_id "correlationId",e.locale,e.title,e.body,n.reasons,n.channel_decision "channelDecision",d.id "deliveryId",d.status "deliveryStatus",e.created_at "createdAt",rd.read_at "readAt" from approval_due_recipients n join approval_due_events e on e.id=n.event_id join approval_due_runs r on r.id=e.run_id join approval_due_clocks cl on cl.id=e.clock_id join approval_due_source_events se on se.origin=cl.origin and se.source_event_id=cl.source_event_id left join projects p on p.id=se.project_id join employees w on w.id=(r.source_canonical::jsonb->'worker'->>'id')and w.organization_id=r.organization_id and w.legal_entity_id=r.legal_entity_id join approval_due_deliveries d on d.recipient_id=n.id left join approval_due_reads rd on rd.recipient_id=n.id and rd.user_id=n.user_id where n.user_id=$1 and r.organization_id=$2 and r.legal_entity_id=$3 and n.in_app and($4::uuid is null or n.id>$4)and($5::uuid is null or n.id=$5)and ${ew} and(r.origin='Work'and ${req.user.permissions.includes('timesheets.submit')?'true':'false'} or r.origin='Leave'and ${req.user.permissions.includes('leave.self_service')?'true':'false'} or r.origin not in('Work','Leave')and ${['allocations.view','projects.view'].every(k=>req.user.permissions.includes(k))?'true':'false'} and ${pw})order by n.id limit 21`, p)).rows;
};
