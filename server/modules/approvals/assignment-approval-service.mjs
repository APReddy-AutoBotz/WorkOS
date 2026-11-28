import {currentStageDeadline} from '../../../shared/approval-stage-deadline.mjs';
import {assignmentPlannedPercentage} from '../planning/assignment-planned-load.mjs';
import {delegationBindings,delegationReceiptProof,assertCanonicalActor,canonicalStageRecipients} from './canonical-delegation-service.mjs';
import { randomUUID } from 'node:crypto';
import { validPlannedAssignment } from '../../../shared/assignment-version.mjs';
import { validAssignmentApprovalPolicy, materialAssignmentFields, assignmentApprovalIdentity } from '../../../shared/assignment-approval.mjs';
import { approvalState, approvalRecipients, renderApprovalTemplate, approvalText } from '../../../shared/work-approval.mjs';
import { capacityHash, capacityCanonical } from '../planning/worker-capacity-service.mjs';
import { workApprovalScope as scope, workApprovalUser, workApprovalFail as fail } from './work-approval-service.mjs';
import { validateAssignmentPolicy } from '../work-capture/assignment-work-policy.mjs';
import { setAssignmentVersionContext } from '../planning/assignment-version-context.mjs';
export const assignmentDecisionPermissions = ['allocations.manage', 'allocations.view', 'projects.view', 'employees.view', 'approvals.view', 'notifications.view'];
export const setAssignmentApprovalContext = (c, req, instanceId = null) => c.query("select set_config('workos.assignment_approval_context',$1,true)", [JSON.stringify({ actorId: req.user.sub, activeRole: req.user.activeRole, operationId: req.operationId, organizationId: req.organizationScope.organizationId, legalEntityId: req.organizationScope.legalEntityId, instanceId })]);
export const assignmentApprovalPolicyView = p => ({ id: p.id, sequence: p.sequence, effectiveFrom: p.effective_from, definition: p.definition, actorId: p.actor_id, activeRole: p.active_role, reason: p.reason, createdAt: p.created_at });
export const assignmentApprovalSource = async (c, req, id, o, lock = false) => {
    const p = [], ew = o.buildEmployeeScopeWhere(req, p, 'e'), pw = o.buildProjectScopeWhere(req, p, 'p');
    p.push(id);
    const a = (await c.query(`select a.*,resource_assignment_revision(a) revision,assignment_version_snapshot(a) snapshot,e.employee_id worker_code,e.name worker_name from project_allocations a join employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.legal_entity_id=a.legal_entity_id join projects p on p.id=a.project_id and p.organization_id=a.organization_id and p.legal_entity_id=a.legal_entity_id where ${ew} and ${pw} and a.id=$${p.length} ${lock ? 'for update of a' : ''}`, p)).rows[0];
    if (!a)
        fail('ASSIGNMENT_APPROVAL_NOT_FOUND', 'Assignment is unavailable in current worker/project scope.', 404);
    const latest = (await c.query('select id,source_revision from assignment_versions where assignment_id=$1 and organization_id=$2 and legal_entity_id=$3 order by sequence desc limit 1', [id, ...scope(req)])).rows[0];
    if (latest && latest.source_revision !== a.revision)
        fail('ASSIGNMENT_APPROVAL_SOURCE_UNAVAILABLE', 'Source and version ledger do not agree.');
    return { a, latestId: latest?.id ?? null };
};
export const assignmentApprovalActor = async (c, req, stage, source, o) => {
    const u = await workApprovalUser(c, req, stage.userId, o), permissions = await o.getEffectivePermissionsForUser(c, u.id, stage.role);
    if (!u.roles.includes(stage.role) || !assignmentDecisionPermissions.every(k => permissions.includes(k)))
        fail('ASSIGNMENT_APPROVAL_ACTOR_UNAVAILABLE', 'Named stage must retain existing assignment-write, scope and inbox rights.');
    const actor = { ...req, user: { sub: u.id, username: u.username, activeRole: stage.role, employeeRecordId: u.employee_record_id, employeeId: u.employee_id, countryDirectorId: u.country_director_id, permissions } };
    if (source) {
        if ([u.employee_record_id, u.employee_id].includes(source.employee_id))
            fail('ASSIGNMENT_APPROVAL_SELF_DECISION', 'The affected worker cannot receive or decide an approval stage for this assignment.', 403);
        if (source.creation)
            await assignmentCreationSource(c, actor, source.employee_id, source.project_id, source.id, o);
        else await assignmentApprovalSource(c, actor, source.id, o);
    }
    return actor;
};
export const assignmentApprovalPolicy = async (c, req, workerId) => (await c.query('select p.*,p.effective_from::text from assignment_material_policy($1,$2,$3)p where p.id is not null', [...scope(req), workerId])).rows[0] ?? null;
export const assertAssignmentProposalDefinition = async (c, req, source, d, o) => {
    if (!validPlannedAssignment(d))
        fail('ASSIGNMENT_APPROVAL_INVALID', 'Supply a complete valid exact percentage definition.', 400);
    const percentage=await assignmentPlannedPercentage(c,req,source.employee_id,d,o.buildEmployeeScopeWhere);
    await validateAssignmentPolicy(c, req, { employee_id: source.employee_id, project_id: source.project_id, role_on_project: d.role, percentage, start_date: d.startsOn, end_date: d.endsOn, billable: d.billable, status: d.status, comments: d.comment });
    if (await o.getSetting('blockOverAllocation', false) && d.status === 'Active') {
        const blocked = (await c.query("select coalesce(sum(percentage),0)+$1::numeric>100 blocked from project_allocations where employee_id=$2 and organization_id=$3 and legal_entity_id=$4 and id<>$5 and status='Active'and daterange(start_date,end_date,'[]')&&daterange($6::date,$7::date,'[]')", [percentage, source.employee_id, ...scope(req), source.id, d.startsOn, d.endsOn])).rows[0].blocked;
        if (blocked)
            fail('ASSIGNMENT_LEGACY_OVERLAP_BLOCKED', 'Existing legacy percentage guard rejects the proposed change.', 422);
    }
    return percentage;
};
const recipients = async (c, req, v, key, stage, o) => {
    if (key === 'approval.action_required') {
        return approvalRecipients(await canonicalStageRecipients(c,req,v,v.p.definition.stages,stage,v.a,assignmentApprovalActor,o));
    }
    const workers = (await c.query("select u.id from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=$1 and u.status='Active'and s.organization_id=$2 and s.legal_entity_id=$3 and s.active order by u.id limit 2", [v.i.employee_id, ...scope(req)])).rows;
    if (workers.length !== 1)
        fail('ASSIGNMENT_APPROVAL_RECIPIENT_UNAVAILABLE', 'Affected worker must have one existing scoped account.');
    const rows = approvalRecipients([{ userId: v.i.requester_user_id, reason: 'requester' }, { userId: workers[0].id, reason: 'affected_worker' }]);
    for (const r of rows) {
        const u = await workApprovalUser(c, req, r.userId, o);
        let valid = false;
        for (const role of u.roles) {
            const permissions = await o.getEffectivePermissionsForUser(c, u.id, role);
            if (!['employees.view', 'notifications.view'].every(k => permissions.includes(k)))
                continue;
            const actor = { ...req, user: { sub: u.id, activeRole: role, employeeRecordId: u.employee_record_id, employeeId: u.employee_id, countryDirectorId: u.country_director_id, permissions } }, p = [v.i.employee_id], where = o.buildEmployeeScopeWhere(actor, p, 'e');
            if ((await c.query(`select 1 from employees e where e.id=$1 and ${where}`, p)).rowCount) {
                valid = true;
                break;
            }
        }
        if (!valid)
            fail('ASSIGNMENT_APPROVAL_RECIPIENT_UNAVAILABLE', 'Every mandatory recipient must retain its scoped inbox relationship.');
    }
    return rows;
};
const emit = async (c, req, v, key, sequence, stage, reason, o) => {
    const resolved = await recipients(c, req, v, key, stage, o), t = (await c.query('select * from assignment_approval_templates where policy_id=$1 and event_key=$2', [v.p.id, key])).rows[0];
    if (!t || v.a.worker_code.length > 200 || v.i.assignment_id.length > 239)
        fail('ASSIGNMENT_APPROVAL_TEMPLATE_UNAVAILABLE', 'Source/template cannot be represented by the canonical inbox.', 422);
    const rendered = renderApprovalTemplate({ key, subject: t.subject, body: t.body }, { workerCode: v.a.worker_code, sourceRef: 'assignment/' + v.i.assignment_id, stageNumber: String(stage + 1), decisionReason: reason ?? '' });
    if (!approvalText(rendered.title, 1200) || !approvalText(rendered.body, 12000))
        fail('ASSIGNMENT_APPROVAL_TEMPLATE_UNAVAILABLE', 'Rendered text exceeds the canonical inbox contract.', 422);
    const id = assignmentApprovalIdentity(v.i.id, sequence, key, req.operationId), mandatory = key !== 'approval.completed';
    await c.query('insert into assignment_approval_events(id,instance_id,transition_sequence,stage,event_key,policy_class,template_id,operation_id,locale,title,body)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, v.i.id, sequence, stage, key, mandatory ? 'ACTION_REQUIRED' : 'INFORMATIONAL', t.id, req.operationId, t.locale, rendered.title, rendered.body]);
    for (const r of resolved) {
        const pref = (await c.query('select p.in_app from notification_preferences p join users u on u.employee_record_id=p.employee_id where u.id=$1 and p.event_type=$2', [r.userId, key])).rows[0];
        const decision = mandatory ? 'Required' : !v.p.definition.completionInApp ? 'SuppressedPolicy' : pref?.in_app === false ? 'SuppressedPreference' : 'Enabled', inApp = ['Required', 'Enabled'].includes(decision), rid = randomUUID();
        await c.query('insert into assignment_approval_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,$4,$5,$6)', [rid, id, r.userId, r.reasons, inApp, decision]);
        if (inApp)
            await c.query("insert into assignment_approval_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)", [randomUUID(), rid]);
    }
};
export const scopedAssignmentApproval = async (c, req, id, o) => {
    const i = (await c.query('select *,statement_timestamp() as observed_at from assignment_approval_instances where id=$1 and organization_id=$2 and legal_entity_id=$3', [id, ...scope(req)])).rows[0];
    if (!i)
        fail('ASSIGNMENT_APPROVAL_NOT_FOUND', 'Assignment proposal is unavailable.', 404);
    const { a, latestId } = i.operation_kind === 'Creation'
        ? await assignmentCreationSource(c, req, i.employee_id, i.project_id, i.assignment_id, o, i.source_revision)
        : await assignmentApprovalSource(c, req, i.assignment_id, o);
    if (a.employee_id !== i.employee_id || a.project_id !== i.project_id)
        fail('ASSIGNMENT_APPROVAL_SOURCE_CHANGED', 'Assignment identity no longer matches this proposal.');
    const p = (await c.query('select *,effective_from::text from assignment_approval_policies where id=$1 and organization_id=$2 and legal_entity_id=$3', [i.policy_id, ...scope(req)])).rows[0], transitions = (await c.query('select * from assignment_approval_transitions where instance_id=$1 order by sequence', [id])).rows;
    if (!p || !validAssignmentApprovalPolicy(p.definition))
        fail('ASSIGNMENT_APPROVAL_POLICY_UNAVAILABLE', 'Retained source policy is invalid.');
    const notificationFailures = (await c.query('select transition_sequence sequence,code,created_at "createdAt" from assignment_approval_notification_failures where instance_id=$1 order by transition_sequence', [id])).rows;
    await delegationReceiptProof(c,i.operation_kind==='Creation'?'Creation':'Material',transitions);const delegations=await delegationBindings(c,req,i.operation_kind==='Creation'?'Creation':'Material',id);
    return { i, p, a, latestId, transitions, delegations, state: approvalState(p.definition.stages, transitions), notificationFailures };
};
export const assignmentApprovalReceipt = t => ({ id: t.id, instanceId: t.instance_id, sequence: t.sequence, stage: t.stage, decision: t.decision, actorId: t.actor_id, activeRole: t.active_role, requestId: t.request_id, operationId: t.operation_id, reason: t.reason, outcome: t.outcome, createdAt: t.created_at,...(t.delegation_binding_id?{delegationBindingId:t.delegation_binding_id}:{}) });
export const assignmentApprovalView = v => {
 const transitions=v.transitions.map(assignmentApprovalReceipt);
 const stage=v.state.status==='Pending' && v.i.source_revision === v.a.revision && v.i.source_version_id === v.latestId ? v.state.currentStage : null;
 const deadline=currentStageDeadline(v.p.definition.stageDueMinutes,stage,v.i.created_at,transitions,v.i.observed_at);
 return {...(deadline ? {stageDeadline:deadline} : {}),...(v.delegations?.length?{delegations:v.delegations}:{}), ...(v.i.operation_kind === 'Creation' ? { operationKind: 'Creation' } : {}), id: v.i.id, assignmentId: v.i.assignment_id, employeeId: v.i.employee_id, projectId: v.i.project_id, sourceRevision: v.i.source_revision, sourceVersionId: v.i.source_version_id, sourceToken: v.i.source_token, requesterUserId: v.i.requester_user_id, requestId: v.i.request_id, reason: v.i.reason, createdAt: v.i.created_at, worker: { id: v.a.employee_id, code: v.a.worker_code, name: v.a.worker_name }, policy: assignmentApprovalPolicyView(v.p), before: v.i.before_snapshot, proposed: v.i.proposed_definition, currentRevision: v.a.revision, currentVersionId: v.latestId, state: v.state, transitions, notificationFailures: v.notificationFailures };
};

// A creation proposal is a scoped request, never an allocation/reservation. Its
// reserved identifier has no source row/version until the final atomic decision.
export const assignmentCreationSource = async (c, req, employeeId, projectId, id, o, absentRevision = capacityHash({ assignmentId: id, employeeId, projectId, absent: true })) => {
    const p = [], ew = o.buildEmployeeScopeWhere(req, p, 'e'), pw = o.buildProjectScopeWhere(req, p, 'p');
    p.push(employeeId, projectId);
    const pair = (await c.query(`select e.id employee_id,e.employee_id worker_code,e.name worker_name,p.id project_id from employees e cross join projects p where ${ew} and ${pw} and e.id=$${p.length - 1} and p.id=$${p.length} and e.organization_id=p.organization_id and e.legal_entity_id=p.legal_entity_id`, p)).rows[0];
    if (!pair) fail('ASSIGNMENT_APPROVAL_NOT_FOUND', 'Creation worker/project is unavailable in current scope.', 404);
    const existing = (await c.query('select * from project_allocations where id=$1', [id])).rows[0];
    if (existing) {
        const current = await assignmentApprovalSource(c, req, id, o);
        return { ...current, a: { ...current.a, creation: true } };
    }
    return { a: { ...pair, id, creation: true, revision: absentRevision, snapshot: null }, latestId: null };
};
export const proposeAssignmentCreation = async (c, req, input, o) => {
    const fingerprint = capacityHash({ kind: 'Creation', actorId: req.user.sub, activeRole: req.user.activeRole, ...input });
    const prior = (await c.query('select id,request_fingerprint,operation_kind from assignment_approval_instances where organization_id=$1 and legal_entity_id=$2 and requester_user_id=$3 and request_id=$4', [...scope(req), req.user.sub, input.requestId])).rows[0];
    if (prior) {
        if (prior.operation_kind !== 'Creation' || prior.request_fingerprint !== fingerprint) fail('ASSIGNMENT_APPROVAL_REQUEST_CONFLICT', 'This creation request has different content.');
        return { instance: assignmentApprovalView(await scopedAssignmentApproval(c, req, prior.id, o)), replayed: true };
    }
    const id = 'a-' + randomUUID(), { a } = await assignmentCreationSource(c, req, input.employeeId, input.projectId, id, o), p = await assignmentApprovalPolicy(c, req, input.employeeId);
    if (!p || p.id !== input.expectedPolicyId || p.definition.creationRequired !== true) fail('ASSIGNMENT_APPROVAL_POLICY_STALE', 'No matching creation policy is currently adopted. Reload configuration.');
    await assertAssignmentProposalDefinition(c, req, a, input.definition, o);
    for (const stage of p.definition.stages) {
        const actor = await assignmentApprovalActor(c, req, stage, a, o);
        if (actor.user.sub === req.user.sub || [actor.user.employeeRecordId, actor.user.employeeId].includes(a.employee_id)) fail('ASSIGNMENT_APPROVAL_SELF_DECISION', 'Requester and affected worker cannot be decision stages.', 403);
    }
    await setAssignmentApprovalContext(c, req);
    const iid = randomUUID(), canonical = capacityCanonical({ operationKind: 'Creation', assignmentId: id, employeeId: a.employee_id, projectId: a.project_id, before: null, sourceRevision: a.revision, sourceVersionId: null, policyId: p.id, definition: input.definition });
    await c.query("insert into assignment_approval_instances(id,organization_id,legal_entity_id,assignment_id,employee_id,project_id,policy_id,requester_user_id,active_role,request_id,request_fingerprint,source_revision,source_version_id,before_snapshot,proposed_definition,source_token,source_canonical,reason,operation_id,operation_kind)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,'null'::jsonb,$13,$14,$15,$16,$17,'Creation')", [iid, ...scope(req), id, a.employee_id, a.project_id, p.id, req.user.sub, req.user.activeRole, input.requestId, fingerprint, a.revision, input.definition, capacityHash(canonical), canonical, input.reason, req.operationId]);
    await c.query("insert into approval_records(entity_type,entity_id,subject_employee_id,requester_id,requester_name,active_role,status,comments,source)values('AssignmentProposal',$1,$2,$3,$4,$5,'Pending',$6,'Web')", [iid, a.employee_id, req.user.sub, req.user.username, req.user.activeRole, input.reason]);
    const v = await scopedAssignmentApproval(c, req, iid, o);
    await emit(c, req, v, 'approval.action_required', 0, 0, null, o);
    await o.audit(c, req, { module: 'Approvals', action: 'Request Assignment Creation', entityType: 'AssignmentProposal', entityId: iid, newValue: assignmentApprovalView(v), reason: input.reason, details: 'Explicit configured creation request; no allocation, version, capacity reservation or external delivery.' });
    return { instance: assignmentApprovalView(v), replayed: false };
};
export const proposeAssignmentApproval = async (c, req, id, input, o) => {
    const { a, latestId } = await assignmentApprovalSource(c, req, id, o, true), fingerprint = capacityHash({ assignmentId: id, actorId: req.user.sub, activeRole: req.user.activeRole, ...input }), prior = (await c.query('select id,request_fingerprint from assignment_approval_instances where organization_id=$1 and legal_entity_id=$2 and requester_user_id=$3 and request_id=$4', [...scope(req), req.user.sub, input.requestId])).rows[0];
    if (prior) {
        if (prior.request_fingerprint !== fingerprint)
            fail('ASSIGNMENT_APPROVAL_REQUEST_CONFLICT', 'This proposal request has different content.');
        return { instance: assignmentApprovalView(await scopedAssignmentApproval(c, req, prior.id, o)), replayed: true };
    }
    if (a.revision !== input.expectedRevision || latestId !== input.expectedLatestId)
        fail('ASSIGNMENT_APPROVAL_STALE', 'Assignment source/version changed. Reload before proposing.');
    const p = await assignmentApprovalPolicy(c, req, a.employee_id);
    if (!p || !validAssignmentApprovalPolicy(p.definition))
        fail('ASSIGNMENT_APPROVAL_NOT_CONFIGURED', 'No selected material-change policy is currently adopted.');
    if (!materialAssignmentFields(a.snapshot, input.definition, p.definition.materialFields).length)
        fail('ASSIGNMENT_APPROVAL_NOT_MATERIAL', 'This definition changes no selected material field.', 422);
    await assertAssignmentProposalDefinition(c, req, a, input.definition, o);
    for (const stage of p.definition.stages) {
        const actor = await assignmentApprovalActor(c, req, stage, a, o);
        if (actor.user.sub === req.user.sub)
            fail('ASSIGNMENT_APPROVAL_SELF_DECISION', 'Requester and affected worker cannot be decision stages.', 403);
    }
    await setAssignmentApprovalContext(c, req);
    const iid = randomUUID(), canonical = capacityCanonical({ assignmentId: id, before: a.snapshot, sourceRevision: a.revision, sourceVersionId: latestId, policyId: p.id, definition: input.definition });
    await c.query('insert into assignment_approval_instances(id,organization_id,legal_entity_id,assignment_id,employee_id,project_id,policy_id,requester_user_id,active_role,request_id,request_fingerprint,source_revision,source_version_id,before_snapshot,proposed_definition,source_token,source_canonical,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)', [iid, ...scope(req), id, a.employee_id, a.project_id, p.id, req.user.sub, req.user.activeRole, input.requestId, fingerprint, a.revision, latestId, a.snapshot, input.definition, capacityHash(canonical), canonical, input.reason, req.operationId]);
    await c.query("insert into approval_records(entity_type,entity_id,subject_employee_id,requester_id,requester_name,active_role,status,comments,source)values('AssignmentProposal',$1,$2,$3,$4,$5,'Pending',$6,'Web')", [iid, a.employee_id, req.user.sub, req.user.username, req.user.activeRole, input.reason]);
    const v = await scopedAssignmentApproval(c, req, iid, o);
    await emit(c, req, v, 'approval.action_required', 0, 0, null, o);
    await o.audit(c, req, { module: 'Approvals', action: 'Propose Material Assignment Change', entityType: 'AssignmentProposal', entityId: iid, newValue: assignmentApprovalView(v), reason: input.reason, details: 'Exact native-percentage before/after proposal; effective source unchanged; explicit scoped named stages and canonical in-app handoff.' });
    return { instance: assignmentApprovalView(v), replayed: false };
};
export const decideAssignmentApproval = async (c, req, id, input, o) => {
    const v = await scopedAssignmentApproval(c, req, id, o), fingerprint = capacityHash({ instanceId: id, actorId: req.user.sub, activeRole: req.user.activeRole, ...input }), prior = (await c.query('select * from assignment_approval_transitions where instance_id=$1 and request_id=$2', [id, input.requestId])).rows[0];
    await delegationReceiptProof(c,v.i.operation_kind==='Creation'?'Creation':'Material',prior?[prior]:[]);
    if (prior) {
        if (prior.request_fingerprint !== fingerprint)
            fail('ASSIGNMENT_APPROVAL_REQUEST_CONFLICT', 'Decision request has different content.');
        return { receipt: assignmentApprovalReceipt(prior), sourceToken: v.i.source_token, replayed: true };
    }
    if (v.state.status !== 'Pending' || v.state.sequence !== input.expectedSequence || v.i.source_token !== input.expectedSourceToken || v.a.revision !== v.i.source_revision || v.latestId !== v.i.source_version_id)
        fail('ASSIGNMENT_APPROVAL_STALE', 'Source version or current stage changed. Reload before deciding.');
    const stage = v.p.definition.stages[v.state.currentStage];
    await assertCanonicalActor(c,req,v.i.operation_kind==='Creation'?'Creation':'Material',v,v.p.definition.stages,v.a,assignmentApprovalActor,o);
    await assignmentApprovalActor(c, req, stage, v.a, o);
    if (req.user.sub === v.i.requester_user_id || [req.user.employeeRecordId, req.user.employeeId].includes(v.i.employee_id))
        fail('ASSIGNMENT_APPROVAL_SELF_DECISION', 'Requester/affected worker cannot decide this proposal.', 403);
    const sequence = v.state.sequence + 1, next = approvalState(v.p.definition.stages, [...v.transitions, { sequence, stage: v.state.currentStage, decision: input.decision }]);
    await setAssignmentApprovalContext(c, req, id);
    const t = (await c.query('insert into assignment_approval_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id,outcome)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)returning *', [randomUUID(), id, sequence, v.state.currentStage, input.decision, req.user.sub, req.user.activeRole, input.requestId, fingerprint, input.reason, req.operationId, next])).rows[0];
    await delegationReceiptProof(c,v.i.operation_kind==='Creation'?'Creation':'Material',[t]);
    if (next.status === 'Approved') {
        const percentage=await assertAssignmentProposalDefinition(c, req, v.a, v.i.proposed_definition, o);
        const d = v.i.proposed_definition;
        await setAssignmentVersionContext(c, req, { employeeId: v.i.employee_id, projectId: v.i.project_id, reason: v.i.reason });
        const values = [d.role, percentage, d.startsOn, d.endsOn, d.billable, d.status, d.comment, v.i.assignment_id, ...scope(req),d.quantityUnit==='hours'?d.quantityExact:null];
        const applied = v.i.operation_kind === 'Creation'
            ? (await c.query('insert into project_allocations(role_on_project,percentage,start_date,end_date,billable,status,comments,id,organization_id,legal_entity_id,fixed_hours,employee_id,project_id)values($1,$2::numeric,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13)returning *', [...values, v.i.employee_id, v.i.project_id])).rows[0]
            : (await c.query('update project_allocations set role_on_project=$1,percentage=$2::numeric,start_date=$3::date,end_date=$4::date,billable=$5,status=$6,comments=$7,fixed_hours=$11::numeric,updated_at=clock_timestamp()where id=$8 and organization_id=$9 and legal_entity_id=$10 returning *', values)).rows[0];
        await o.audit(c, req, { module: 'Allocations', action: v.i.operation_kind === 'Creation' ? 'Apply Approved Assignment Creation' : 'Apply Approved Material Assignment Change', entityType: 'Allocation', entityId: v.i.assignment_id, oldValue: v.i.before_snapshot, newValue: applied, reason: v.i.reason, details: 'Final named-stage decision applies exact approved source; existing dates/overlap/version guards retained; no historical work or financial rewrite.' });
    }
    if (next.status !== 'Pending')
        await o.decideApprovalRecord(c, req, { entityType: 'AssignmentProposal', entityId: id, status: next.status, comments: input.reason, suppressNotification: true });
    if (next.status === 'Pending')
        await emit(c, req, v, 'approval.action_required', sequence, sequence, null, o);
    else if (next.status === 'Rejected')
        await emit(c, req, v, 'approval.rejected_or_correction_required', sequence, v.state.currentStage, input.reason, o);
    else {
        await c.query('savepoint optional_assignment_completion');
        try {
            await emit(c, req, v, 'approval.completed', sequence, v.state.currentStage, input.reason, o);
            await c.query('release savepoint optional_assignment_completion');
        }
        catch {
            await c.query('rollback to savepoint optional_assignment_completion');
            await c.query("insert into assignment_approval_notification_failures(id,instance_id,transition_sequence,code)values($1,$2,$3,'INFORMATIONAL_NOTIFICATION_UNAVAILABLE')", [randomUUID(), id, sequence]);
        }
    }
    await o.audit(c, req, { module: 'Approvals', action: 'Record Material Assignment Stage Decision', entityType: 'AssignmentProposal', entityId: id, oldValue: v.state, newValue: { receipt: assignmentApprovalReceipt(t), sourceToken: v.i.source_token }, reason: input.reason, details: 'Current named stage and exact source CAS; complete mandatory in-app handoff; no external delivery or protected reopen.' });
    return { receipt: assignmentApprovalReceipt(t), sourceToken: v.i.source_token, replayed: false };
};
export const assignmentApprovalInboxRows = async (c, req, o, { after = null, id = null } = {}) => {
    const p = [req.user.sub, ...scope(req), after, id], where = o.buildEmployeeScopeWhere(req, p, 'e');
    return (await c.query(`select case when to_jsonb(i)->>'operation_kind'='Creation'then'assignment-creation-approval'else'assignment-approval'end kind,r.id,r.event_id "eventId",i.id "instanceId",i.assignment_id "assignmentId",i.source_token "sourceToken",ev.transition_sequence "transitionSequence",ev.event_key "eventKey",ev.policy_class "policyClass",ev.template_id "templateId",ev.operation_id "operationId",ev.locale,ev.title,ev.body,r.reasons,r.channel_decision "channelDecision",d.id "deliveryId",d.status "deliveryStatus",ev.created_at "createdAt",rd.read_at "readAt" from assignment_approval_recipients r join assignment_approval_events ev on ev.id=r.event_id join assignment_approval_instances i on i.id=ev.instance_id join employees e on e.id=i.employee_id and e.organization_id=i.organization_id and e.legal_entity_id=i.legal_entity_id join assignment_approval_deliveries d on d.recipient_id=r.id left join assignment_approval_reads rd on rd.recipient_id=r.id and rd.user_id=r.user_id where r.user_id=$1 and i.organization_id=$2 and i.legal_entity_id=$3 and r.in_app and($4::uuid is null or r.id>$4)and($5::uuid is null or r.id=$5)and ${where} order by r.id limit 21`, p)).rows;
};
