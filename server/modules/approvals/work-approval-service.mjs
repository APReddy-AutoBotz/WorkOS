import { randomUUID } from 'node:crypto';
import { WORK_APPROVAL_VERSION, APPROVAL_EVENT_KEYS, approvalState, approvalEventIdentity, approvalRecipients, renderApprovalTemplate, validWorkApprovalPolicy } from '../../../shared/work-approval.mjs';
import { canonicalHours } from '../../../shared/work-hours.mjs';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { WorkPolicyError, lockWorkPolicy } from '../work-capture/assignment-work-policy.mjs';
export const workApprovalFail = (code, message, status = 409) => { throw new WorkPolicyError(code, message, status); };
export const workApprovalScope = req => [req.organizationScope.organizationId, req.organizationScope.legalEntityId];
export const setWorkApprovalContext = async (c, req, instanceId = null) => c.query("select set_config('workos.work_approval_context',$1,true)", [JSON.stringify({ actorId: req.user.sub, activeRole: req.user.activeRole, operationId: req.operationId, organizationId: req.organizationScope.organizationId, legalEntityId: req.organizationScope.legalEntityId, instanceId })]);
export const workApprovalOwner = req => capacityHash([req.user.username, req.user.employeeRecordId || req.user.employeeId || req.user.sub, req.user.activeRole, ...workApprovalScope(req)]);
export const workApprovalEnvelope = req => ({ contractVersion: WORK_APPROVAL_VERSION, organizationId: req.organizationScope.organizationId, legalEntityId: req.organizationScope.legalEntityId, ownerKey: workApprovalOwner(req), actorUserId: req.user.sub });
const sourceHeader = async (c, req, id, lock = false) => {
    const t = (await c.query(`select t.*,t.week_ending::text from timesheets t where t.id=$1 and t.organization_id=$2 and t.legal_entity_id=$3 ${lock ? 'for update' : ''}`, [id, ...workApprovalScope(req)])).rows[0];
    if (!t)
        workApprovalFail('WORK_APPROVAL_NOT_FOUND', 'Submitted work is unavailable in this scope.', 404);
    return t;
};
const submission = async (c, req, id) => (await c.query('select * from work_submission_evidence where timesheet_id=$1 and organization_id=$2 and legal_entity_id=$3 order by sequence desc limit 1', [id, ...workApprovalScope(req)])).rows[0];
export const workApprovalSourceToken = (t, s) => capacityHash({ version: WORK_APPROVAL_VERSION, header: { id: t.id, employeeId: t.employee_id, weekEnding: t.week_ending, totalHours: t.total_hours, billableHours: t.billable_hours }, submission: s });
export const workApprovalUser = async (c, req, id, o) => {
    const user = await o.fetchUserAuthRowByWhere(c, 'where u.id=$1', [id]);
    if (!user || user.status !== 'Active' || !(await c.query('select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active', [id, ...workApprovalScope(req)])).rowCount)
        workApprovalFail('WORK_APPROVAL_RELATIONSHIP_UNAVAILABLE', 'A required current account relationship is unavailable in this scope.');
    return user;
};
export const workApprovalActor = async (c, req, stage, t, o) => {
    const u = await workApprovalUser(c, req, stage.userId, o);
    if (!u.roles.includes(stage.role))
        workApprovalFail('WORK_APPROVAL_ACTOR_UNAVAILABLE', 'The configured stage role is no longer held by its named approver.');
    const permissions = await o.getEffectivePermissionsForUser(c, u.id, stage.role);
    if (!['timesheets.approve', 'timesheets.submit', 'projects.view', 'approvals.view', 'employees.view', 'notifications.view'].every(k => permissions.includes(k)))
        workApprovalFail('WORK_APPROVAL_ACTOR_UNAVAILABLE', 'The named approver lacks existing work decision/inbox permission.');
    const actor = { ...req, user: { sub: u.id, username: u.username, activeRole: stage.role, employeeRecordId: u.employee_record_id, employeeId: u.employee_id, countryDirectorId: u.country_director_id, permissions } };
    if (t) {
        const p = [t.employee_id], where = o.buildEmployeeScopeWhere(actor, p, 'e');
        if (!(await c.query(`select 1 from employees e where e.id=$1 and ${where}`, p)).rowCount)
            workApprovalFail('WORK_APPROVAL_ACTOR_UNAVAILABLE', 'The named approver has no current direct worker data scope.');
        if (stage.role === 'TeamLead' && !(await c.query('select 1 from employees where id=$1 and reporting_manager_id=any($2::text[])', [t.employee_id, [u.employee_record_id, u.employee_id].filter(Boolean)])).rowCount)
            workApprovalFail('WORK_APPROVAL_ACTOR_UNAVAILABLE', 'A Team Lead stage requires its existing direct-report relationship.');
        if (stage.role === 'ProjectManager' && !(await c.query('select 1 from timesheet_entries e join projects p on p.id=e.project_id where e.timesheet_id=$1 and p.organization_id=$2 and p.legal_entity_id=$3 and p.manager_id=any($4::text[])limit 1', [t.id, ...workApprovalScope(req), [u.employee_record_id, u.employee_id].filter(Boolean)])).rowCount)
            workApprovalFail('WORK_APPROVAL_ACTOR_UNAVAILABLE', 'A project manager stage requires an existing project in this submitted work.');
    }
    return actor;
};
export const scopedWorkApproval = async (c, req, id, o, lock = false, includeSource = false) => {
    const i = (await c.query(`select * from work_approval_instances where id=$1 and organization_id=$2 and legal_entity_id=$3 ${lock ? 'for update' : ''}`, [id, ...workApprovalScope(req)])).rows[0];
    if (!i)
        workApprovalFail('WORK_APPROVAL_NOT_FOUND', 'Approval instance is unavailable in this scope.', 404);
    const p = [i.employee_id], where = o.buildEmployeeScopeWhere(req, p, 'e'), worker = (await c.query(`select e.id,e.employee_id code,e.name from employees e where e.id=$1 and ${where}`, p)).rows[0];
    if (!worker)
        workApprovalFail('WORK_APPROVAL_NOT_FOUND', 'Approval instance is unavailable in current worker scope.', 404);
    const policy = (await c.query('select *,effective_from::text from work_approval_policy_versions where id=$1 and organization_id=$2 and legal_entity_id=$3', [i.policy_id, ...workApprovalScope(req)])).rows[0], transitions = (await c.query('select * from work_approval_transitions where instance_id=$1 order by sequence', [i.id])).rows;
    if (!policy || !validWorkApprovalPolicy(policy.definition))
        workApprovalFail('WORK_APPROVAL_SOURCE_UNAVAILABLE', 'Retained approval policy authority is unavailable.');
    const notificationFailures = (await c.query('select transition_sequence sequence,code,created_at "createdAt" from work_approval_notification_failures where instance_id=$1 order by transition_sequence', [i.id])).rows;
    let source = null;
    if (includeSource) {
        const captured = JSON.parse(i.source_canonical), header = await sourceHeader(c, req, i.timesheet_id), latest = await submission(c, req, i.timesheet_id);
        if (captured.header?.id !== i.timesheet_id || captured.submission?.id !== i.submission_id)
            workApprovalFail('WORK_APPROVAL_SOURCE_UNAVAILABLE', 'Retained source identity does not match the instance.');
        source = { weekEnding: captured.header.weekEnding, totalHoursExact: canonicalHours(captured.header.totalHours), billableHoursExact: canonicalHours(captured.header.billableHours), currentHeaderStatus: header.status, isCurrentSubmission: latest?.id === i.submission_id, entries: captured.submission.entries.map(e => ({ id: e.entryId, date: e.workDate, workType: e.workType, projectId: e.projectId ?? null, clientName: e.clientName ?? null, category: e.category ?? null, categoryCode: e.categoryCode ?? null, hoursExact: canonicalHours(e.hours), billable: e.billable, remark: e.remark ?? null, evidenceUrl: e.evidenceUrl ?? null, workReference: e.workReference ?? null })) };
    }
    return { i, policy, transitions, state: approvalState(policy.definition.stages, transitions), worker, notificationFailures, source };
};
export const workApprovalReceipt = t => ({ id: t.id, instanceId: t.instance_id, sequence: t.sequence, stage: t.stage, decision: t.decision, actorId: t.actor_id, activeRole: t.active_role, requestId: t.request_id, operationId: t.operation_id, reason: t.reason, outcome: t.outcome, createdAt: t.created_at });
export const workApprovalView = v => ({ id: v.i.id, timesheetId: v.i.timesheet_id, submissionId: v.i.submission_id, submissionSequence: v.i.submission_sequence, sourceToken: v.i.source_token, requesterUserId: v.i.requester_user_id, worker: v.worker, createdAt: v.i.created_at, policy: { id: v.policy.id, sequence: v.policy.sequence, effectiveFrom: v.policy.effective_from, stages: v.policy.definition.stages }, state: v.state, transitions: v.transitions.map(workApprovalReceipt), notificationFailures: v.notificationFailures, source: v.source });
const recipientScope = async (c, req, id, workerId, o) => { const u = await workApprovalUser(c, req, id, o); for (const role of u.roles) {
    const permissions = await o.getEffectivePermissionsForUser(c, u.id, role);
    if (!['employees.view', 'notifications.view'].every(k => permissions.includes(k)))
        continue;
    const actor = { ...req, user: { sub: u.id, activeRole: role, employeeRecordId: u.employee_record_id, employeeId: u.employee_id, countryDirectorId: u.country_director_id, permissions } }, p = [workerId], where = o.buildEmployeeScopeWhere(actor, p, 'e');
    if ((await c.query(`select 1 from employees e where e.id=$1 and ${where}`, p)).rowCount)
        return;
} workApprovalFail('WORK_APPROVAL_RELATIONSHIP_UNAVAILABLE', 'A mandatory recipient no longer has an existing scoped in-app relationship.'); };
const requiredRecipients = async (c, req, v, key, stage, o) => {
    if (key === 'approval.action_required') {
        const actor = await workApprovalActor(c, req, v.policy.definition.stages[stage], await sourceHeader(c, req, v.i.timesheet_id), o);
        return approvalRecipients([{ userId: actor.user.sub, reason: 'current_stage_approver' }]);
    }
    await workApprovalUser(c, req, v.i.requester_user_id, o);
    const users = (await c.query('select u.id from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=$1 and u.status=\'Active\'and s.organization_id=$2 and s.legal_entity_id=$3 and s.active order by u.id limit 2', [v.i.employee_id, ...workApprovalScope(req)])).rows;
    if (users.length !== 1)
        workApprovalFail('WORK_APPROVAL_RELATIONSHIP_UNAVAILABLE', 'The affected worker must have one current scoped account; no recipient can be omitted or redirected.');
    await recipientScope(c, req, v.i.requester_user_id, v.i.employee_id, o);
    await recipientScope(c, req, users[0].id, v.i.employee_id, o);
    return approvalRecipients([{ userId: v.i.requester_user_id, reason: 'requester' }, { userId: users[0].id, reason: 'affected_worker' }]);
};
const emit = async (c, req, v, key, sequence, stage, operationId, reason, o) => {
    const recipients = await requiredRecipients(c, req, v, key, stage, o), template = (await c.query('select * from work_approval_templates where policy_id=$1 and event_key=$2', [v.policy.id, key])).rows[0];
    if (!template)
        workApprovalFail('WORK_APPROVAL_TEMPLATE_UNAVAILABLE', 'The retained canonical template is unavailable.');
    const rendered = renderApprovalTemplate({ key, subject: template.subject, body: template.body }, { workerCode: v.worker.code, sourceRef: 'timesheet/' + v.i.timesheet_id, stageNumber: String(stage + 1), decisionReason: reason ?? '' }), id = approvalEventIdentity(v.i.id, sequence, key, operationId), mandatory = key !== 'approval.completed';
    await c.query('insert into work_approval_events(id,instance_id,transition_sequence,stage,event_key,policy_class,template_id,operation_id,locale,title,body)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, v.i.id, sequence, stage, key, mandatory ? 'ACTION_REQUIRED' : 'INFORMATIONAL', template.id, operationId, template.locale, rendered.title, rendered.body]);
    for (const r of recipients) {
        const preference = (await c.query('select p.in_app from notification_preferences p join users u on u.employee_record_id=p.employee_id where u.id=$1 and p.event_type=$2', [r.userId, key])).rows[0], decision = mandatory ? 'Required' : !v.policy.definition.completionInApp ? 'SuppressedPolicy' : preference?.in_app === false ? 'SuppressedPreference' : 'Enabled';
        await c.query('insert into work_approval_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,$4,$5,$6)', [randomUUID(), id, r.userId, r.reasons, ['Required', 'Enabled'].includes(decision), decision]);
    }
    return id;
};
export const startWorkApproval = async (c, req, timesheetId, o) => {
    const t = await sourceHeader(c, req, timesheetId), s = await submission(c, req, timesheetId);
    if (!s)
        return false;
    const policy = (await c.query("select p.*,p.effective_from::text from work_approval_policy_versions p join work_submission_evidence s on s.id=$3 where p.organization_id=$1 and p.legal_entity_id=$2 and p.effective_from<=(s.created_at at time zone'UTC')::date and p.created_at<=s.created_at order by p.sequence desc limit 1", [...workApprovalScope(req), s.id])).rows[0];
    if (!policy)
        return false;
    if (!validWorkApprovalPolicy(policy.definition))
        workApprovalFail('WORK_APPROVAL_POLICY_UNAVAILABLE', 'Adopted work approval policy is invalid.');
    if (!policy.definition.workerIds.includes(t.employee_id))
        return false;
    if (s.actor_id !== req.user.sub || t.status !== 'Submitted')
        workApprovalFail('WORK_APPROVAL_SOURCE_UNAVAILABLE', 'An exact new retained submission is required.');
    for (const stage of policy.definition.stages) {
        const actor = await workApprovalActor(c, req, stage, t, o);
        if (actor.user.sub === s.actor_id || [actor.user.employeeRecordId, actor.user.employeeId].includes(t.employee_id))
            workApprovalFail('WORK_APPROVAL_SELF_DECISION', 'The requester/affected worker cannot be a decision stage.', 403);
    }
    if ((await c.query('select 1 from work_approval_instances where submission_id=$1', [s.id])).rowCount)
        return true;
    await setWorkApprovalContext(c, req);
    const id = randomUUID(), canonical = capacityCanonical({ version: WORK_APPROVAL_VERSION, header: { id: t.id, employeeId: t.employee_id, weekEnding: t.week_ending, totalHours: t.total_hours, billableHours: t.billable_hours }, submission: s });
    await c.query('insert into work_approval_instances(id,organization_id,legal_entity_id,timesheet_id,submission_id,submission_sequence,policy_id,employee_id,requester_user_id,source_token,source_canonical)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, ...workApprovalScope(req), t.id, s.id, s.sequence, policy.id, t.employee_id, s.actor_id, capacityHash(canonical), canonical]);
    const v = await scopedWorkApproval(c, req, id, o);
    await emit(c, req, v, 'approval.action_required', 0, 0, req.operationId, null, o);
    await c.query("update approval_records set due_at=null where entity_type='Timesheet'and entity_id=$1", [t.id]);
    await o.audit(c, req, { module: 'Approvals', action: 'Start Staged Work Approval', entityType: 'WorkApprovalInstance', entityId: id, newValue: { id, timesheetId: t.id, submissionId: s.id, policyId: policy.id, sourceToken: v.i.source_token }, details: 'Explicit adopted work policy; current named-stage authority and mandatory canonical in-app handoff; no default SLA or external delivery.' });
    return true;
};
export const assertLegacyWorkApproval = async (c, req, timesheetId) => { const t = await submission(c, req, timesheetId); if (t && (await c.query('select 1 from work_approval_instances where submission_id=$1', [t.id])).rowCount)
    workApprovalFail('WORK_APPROVAL_ENGINE_REQUIRED', 'This submission uses governed stages. Decide its exact current stage in the Approvals workspace.'); };
export const decideWorkApproval = async (c, req, id, input, o) => {
    await lockWorkPolicy(c, req);
    const v = await scopedWorkApproval(c, req, id, o, true), fingerprint = capacityHash({ instanceId: id, actorId: req.user.sub, activeRole: req.user.activeRole, ...input }), prior = (await c.query('select * from work_approval_transitions where instance_id=$1 and request_id=$2', [id, input.requestId])).rows[0];
    if (prior) {
        if (prior.request_fingerprint !== fingerprint)
            workApprovalFail('WORK_APPROVAL_REQUEST_CONFLICT', 'This decision request has different content. Read history.');
        return { receipt: workApprovalReceipt(prior), sourceToken: v.i.source_token, replayed: true };
    }
    if (v.state.status !== 'Pending' || v.state.sequence !== input.expectedSequence || v.i.source_token !== input.expectedSourceToken)
        workApprovalFail('WORK_APPROVAL_STALE', 'The source or current stage changed. Reload before deciding.');
    const stage = v.policy.definition.stages[v.state.currentStage];
    if (stage.userId !== req.user.sub || stage.role !== req.user.activeRole)
        workApprovalFail('WORK_APPROVAL_STAGE_DENIED', 'Only the named current-stage user in its configured existing role may decide.', 403);
    const t = await sourceHeader(c, req, v.i.timesheet_id, true), s = await submission(c, req, t.id);
    if (t.status !== 'Submitted' || s?.id !== v.i.submission_id || workApprovalSourceToken(t, s) !== v.i.source_token)
        workApprovalFail('WORK_APPROVAL_SOURCE_CHANGED', 'Submitted work no longer matches the retained instance.');
    await workApprovalActor(c, req, stage, t, o);
    if (req.user.sub === v.i.requester_user_id)
        workApprovalFail('WORK_APPROVAL_SELF_DECISION', 'Requesters cannot decide their own submission.', 403);
    await o.assertWorkDecisionAllowed(c, req, t);
    const sequence = v.state.sequence + 1, next = input.decision === 'Rejected' ? { status: 'Rejected', sequence, currentStage: null } : sequence === v.policy.definition.stages.length ? { status: 'Approved', sequence, currentStage: null } : { status: 'Pending', sequence, currentStage: sequence };
    await setWorkApprovalContext(c, req, id);
    const saved = (await c.query('insert into work_approval_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id,outcome)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)returning *', [randomUUID(), id, sequence, v.state.currentStage, input.decision, req.user.sub, req.user.activeRole, input.requestId, fingerprint, input.reason, req.operationId, JSON.stringify(next)])).rows[0];
    if (next.status !== 'Pending') {
        await c.query("update timesheets set status=$2,rejection_reason=case when $2='Rejected'then $3 else null end,approved_at=case when $2='Approved'then now()else approved_at end,approved_by=case when $2='Approved'then $4 else approved_by end,rejected_at=case when $2='Rejected'then now()else rejected_at end,rejected_by=case when $2='Rejected'then $4 else rejected_by end,updated_at=now()where id=$1", [t.id, next.status, input.reason, req.user.username]);
        await o.retainWorkDecision(c, req, t, next.status, input.reason, 'Governed approval workspace');
        await o.decideApprovalRecord(c, req, { entityType: 'Timesheet', entityId: t.id, status: next.status, comments: input.reason, suppressNotification: true });
    }
    if (next.status === 'Pending')
        await emit(c, req, v, 'approval.action_required', sequence, sequence, req.operationId, null, o);
    else if (next.status === 'Rejected')
        await emit(c, req, v, 'approval.rejected_or_correction_required', sequence, v.state.currentStage, req.operationId, input.reason, o);
    else {
        await c.query('savepoint optional_work_completion_notification');
        try {
            await emit(c, req, v, 'approval.completed', sequence, v.state.currentStage, req.operationId, input.reason, o);
            await c.query('release savepoint optional_work_completion_notification');
        }
        catch {
            await c.query('rollback to savepoint optional_work_completion_notification');
            await c.query('insert into work_approval_notification_failures(id,instance_id,transition_sequence,code)values($1,$2,$3,\'INFORMATIONAL_NOTIFICATION_UNAVAILABLE\')', [randomUUID(), id, sequence]);
        }
    }
    await o.audit(c, req, { module: 'Approvals', action: 'Record Staged Work Decision', entityType: 'WorkApprovalInstance', entityId: id, oldValue: { state: v.state, sourceToken: v.i.source_token }, newValue: { state: next, receipt: workApprovalReceipt(saved) }, reason: input.reason, details: 'Current-stage/source CAS; immutable stage and terminal work evidence; canonical in-app handoff; no external provider or protected reopen.' });
    return { receipt: workApprovalReceipt(saved), sourceToken: v.i.source_token, replayed: false };
};
