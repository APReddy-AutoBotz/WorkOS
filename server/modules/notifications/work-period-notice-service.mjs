import { randomUUID } from 'node:crypto';
import { PERIOD_NOTICE_KEYS, periodNoticePhase, periodNoticeRecipients, periodNoticeIdentity, renderPeriodNotice, validPeriodNoticeDefinition } from '../../../shared/work-period-notices.mjs';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { workApprovalScope, workApprovalUser, workApprovalFail as fail, setWorkApprovalContext } from '../approvals/work-approval-service.mjs';
const iso = x => x instanceof Date ? x.toISOString() : x;
export const periodNoticePolicyView = p => ({ id: p.id, sequence: p.sequence, effectiveFrom: p.effective_from, definition: p.definition, actorId: p.actor_id, activeRole: p.active_role, reason: p.reason, createdAt: p.created_at });
export const periodNoticeWorker = async (c, req, id, o) => { const params = [id], where = o.buildEmployeeScopeWhere(req, params, 'e'), w = (await c.query(`select e.id,e.employee_id code,e.name,e.status,e.joining_date::text,e.exit_date::text from employees e where e.id=$1 and ${where}`, params)).rows[0]; if (!w)
    fail('PERIOD_NOTICE_NOT_FOUND', 'Worker/period is unavailable in current scope.', 404); return w; };
export const periodNoticeRecipient = async (c, req, userId, role, workerId, o) => { const u = await workApprovalUser(c, req, userId, o); for (const held of role ? [role] : u.roles) {
    if (!u.roles.includes(held))
        continue;
    const permissions = await o.getEffectivePermissionsForUser(c, u.id, held);
    if (!['employees.view', 'notifications.view', 'timesheets.submit'].every(k => permissions.includes(k)))
        continue;
    const actor = { ...req, user: { sub: u.id, activeRole: held, employeeRecordId: u.employee_record_id, employeeId: u.employee_id, countryDirectorId: u.country_director_id, permissions } }, params = [workerId], where = o.buildEmployeeScopeWhere(actor, params, 'e');
    if ((await c.query(`select 1 from employees e where e.id=$1 and ${where}`, params)).rowCount)
        return;
} fail('PERIOD_NOTICE_RELATIONSHIP_UNAVAILABLE', 'A required current recipient role/work-read/inbox relationship is unavailable in this scope.'); };
export const periodNoticePreview = async (c, req, employeeId, periodId, o) => {
    const worker = await periodNoticeWorker(c, req, employeeId, o), period = (await c.query("select id,code,starts_on::text,ends_on::text,status,frequency from reporting_periods where id=$1 and organization_id=$2 and legal_entity_id=$3 and frequency='Weekly'", [periodId, ...workApprovalScope(req)])).rows[0];
    if (!period)
        fail('PERIOD_NOTICE_NOT_FOUND', 'Worker/period is unavailable in current scope.', 404);
    const now = (await c.query('select clock_timestamp() now')).rows[0].now.toISOString(), policy = (await c.query('select *,effective_from::text from work_period_notice_policies where organization_id=$1 and legal_entity_id=$2 and effective_from<=$3 order by sequence desc limit 1', [...workApprovalScope(req), period.starts_on])).rows[0] ?? null;
    const checks = (await c.query('select work_submission_timing($1,$2,array[$3::date,$4::date],$5::timestamptz) checks', [...workApprovalScope(req), period.starts_on, period.ends_on, now])).rows[0].checks, timing = checks?.find(t => t.periodId === period.id) ?? null;
    const headers = (await c.query("select t.id,t.status,t.week_ending::text,t.updated_at,s.id submission_id,s.sequence,s.period_references,s.submission_timing,exists(select 1 from approval_records a where a.entity_type='Timesheet'and a.entity_id=t.id::text and a.status='Pending')pending_approval from timesheets t left join lateral(select * from work_submission_evidence where timesheet_id=t.id order by sequence desc limit 1)s on true where t.organization_id=$1 and t.legal_entity_id=$2 and t.employee_id=$3 and(t.week_ending between $4::date and $5::date or exists(select 1 from timesheet_entries e where e.timesheet_id=t.id and e.work_date between $4::date and $5::date))order by t.id", [...workApprovalScope(req), employeeId, period.starts_on, period.ends_on])).rows;
    const sourceVersion = capacityHash({ workerId: worker.id, period, noticePolicyId: policy?.id ?? null, capturePolicyId: timing?.policyId ?? null, deadlineAt: timing?.deadlineAt ?? null, graceEndsAt: timing?.graceEndsAt ?? null });
    let state = 'unconfigured', unavailableReason = null, eventKey = null, reminderAt = null, overdueAt = null, recipients = [], existingEvent = null;
    const unavailable = reason => { state = 'unavailable'; unavailableReason = reason; eventKey = null; };
    if (checks === null || checks.some(t => t.periodId !== period.id))
        unavailable('Unambiguous current Weekly authority is required.');
    else if (policy && !validPeriodNoticeDefinition(policy.definition))
        unavailable('Retained explicit notice policy is invalid.');
    else if (policy && timing && policy.definition.workerIds.includes(worker.id) && policy.effective_from <= now.slice(0, 10)) {
        const accepted = headers.some(h => ['Submitted', 'Approved'].includes(h.status) && h.submission_id && h.period_references?.some(p => p.id === period.id && p.frequency === 'Weekly') && h.submission_timing?.some(t => t.periodId === period.id && t.policyId === timing.policyId && Date.parse(t.deadlineAt) === Date.parse(timing.deadlineAt) && Date.parse(t.graceEndsAt) === Date.parse(timing.graceEndsAt)));
        if (accepted)
            state = 'accepted';
        else if (headers.some(h => h.status !== 'Draft' || h.submission_id || h.pending_approval))
            unavailable('Legacy accepted, pending, rejected/correction or changed retained period lineage requires source authority; it is not missing work.');
        else if (worker.status !== 'Active' || worker.joining_date && worker.joining_date > period.ends_on || worker.exit_date && worker.exit_date < period.starts_on)
            unavailable('Active affected worker authority for this period is unavailable.');
        else if (period.status !== 'Open')
            unavailable('This producer does not establish protected closed-period remediation or reopen authority.');
        else {
            const phase = periodNoticePhase(timing, policy.definition, period.starts_on, now);
            ({ state, eventKey, reminderAt, overdueAt } = phase);
            if (state === 'unavailable')
                unavailable('The configured reminder precedes the period start; no threshold is inferred.');
            const lineage=(await c.query('select e.source_version from work_period_notice_events e join work_period_notice_runs r on r.id=e.run_id where r.organization_id=$1 and r.legal_entity_id=$2 and r.employee_id=$3 and r.period_id=$4 order by e.created_at limit 1',[...workApprovalScope(req),worker.id,period.id])).rows[0];
            if(lineage&&lineage.source_version!==sourceVersion)unavailable('Previously emitted period/policy lineage changed; no historical phase is reissued.');
            if (eventKey) {
                const accounts = (await c.query("select u.id from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=$1 and u.status='Active'and s.organization_id=$2 and s.legal_entity_id=$3 and s.active order by u.id limit 2", [worker.id, ...workApprovalScope(req)])).rows;
                if (accounts.length !== 1)
                    fail('PERIOD_NOTICE_RELATIONSHIP_UNAVAILABLE', 'The affected worker must have exactly one current active scoped inbox account.');
                await periodNoticeRecipient(c, req, accounts[0].id, null, worker.id, o);
                const owner = policy.definition.escalationOwner;
                if (eventKey === PERIOD_NOTICE_KEYS[1])
                    await periodNoticeRecipient(c, req, owner.userId, owner.role, worker.id, o);
                recipients = periodNoticeRecipients(accounts[0].id, owner.userId, eventKey);
                const existing = (await c.query("select e.id,e.source_version from work_period_notice_events e join work_period_notice_runs r on r.id=e.run_id where r.organization_id=$1 and r.legal_entity_id=$2 and r.employee_id=$3 and r.period_id=$4 and r.policy_id=$5 and e.event_key=$6 order by e.created_at limit 1", [...workApprovalScope(req), worker.id, period.id, policy.id, eventKey])).rows[0];
                if (existing) {
                    existingEvent = existing.id;
                    const prior = (await c.query('select user_id "userId",reasons from work_period_notice_recipients where event_id=$1 order by user_id', [existing.id])).rows;
                    if (existing.source_version !== sourceVersion || capacityCanonical(prior) !== capacityCanonical(recipients))
                        unavailable('A previously emitted phase has changed source/recipient lineage; no historical delivery is redirected.');
                }
            }
        }
    }
    const source = { organizationId: req.organizationScope.organizationId, legalEntityId: req.organizationScope.legalEntityId, worker, period, policy: policy ? periodNoticePolicyView(policy) : null, capturePolicyId: timing?.policyId ?? null, deadlineAt: timing?.deadlineAt ?? null, graceEndsAt: timing?.graceEndsAt ?? null, headers: headers.map(h => ({ ...h, updated_at: iso(h.updated_at) })), state, unavailableReason, eventKey, reminderAt, overdueAt, recipients, existingEvent, sourceVersion }, canonical = capacityCanonical(source);
    return { ...source, sourceToken: capacityHash(canonical), checkedAt: now, sourceCanonical: canonical };
};
export const periodNoticePreviewView = v => { const { sourceCanonical, headers, recipients, ...out } = v; return { ...out, sourceSummary: headers.map(h => ({ id: h.id, status: h.status, submissionId: h.submission_id ?? null, pendingApproval: h.pending_approval })), recipientReasons: recipients }; };
export const periodNoticeRunView = r => ({ id: r.id, sequence: r.sequence, employeeId: r.employee_id, periodId: r.period_id, policyId: r.policy_id, requestId: r.request_id, actorId: r.actor_id, activeRole: r.active_role, reason: r.reason, operationId: r.operation_id, correlationId: r.correlation_id, sourceToken: r.source_token, sourceVersion: r.source_version, outcome: r.outcome, createdAt: r.created_at });
export const evaluatePeriodNotice = async (c, req, input, o) => {
    const fingerprint = capacityHash({ actorId: req.user.sub, role: req.user.activeRole, ...input }), prior = (await c.query('select * from work_period_notice_runs where organization_id=$1 and legal_entity_id=$2 and request_id=$3', [...workApprovalScope(req), input.requestId])).rows[0];
    if (prior) {
        await periodNoticeWorker(c, req, prior.employee_id, o);
        if (prior.request_fingerprint !== fingerprint)
            fail('PERIOD_NOTICE_REQUEST_CONFLICT', 'This request identity has different source or content. Read current history.');
        return { receipt: periodNoticeRunView(prior), replayed: true };
    }
    const v = await periodNoticePreview(c, req, input.employeeId, input.periodId, o);
    if (v.state === 'unavailable')
        fail('PERIOD_NOTICE_SOURCE_UNAVAILABLE', v.unavailableReason);
    if (v.sourceToken !== input.expectedSourceToken || v.eventKey !== input.expectedEventKey)
        fail('PERIOD_NOTICE_STALE', 'The source or eligible event changed. Reload before evaluating.');
    const sequence = (await c.query('select coalesce(max(sequence),0)+1 n from work_period_notice_runs where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 and period_id=$4', [...workApprovalScope(req), v.worker.id, v.period.id])).rows[0].n, id = randomUUID(), eventId = v.eventKey ? v.existingEvent ?? periodNoticeIdentity(v.sourceVersion, v.eventKey, req.operationId) : null, outcome = { state: v.state, disposition: v.eventKey ? v.existingEvent ? 'Existing' : 'Emitted' : 'NoEvent', eventKey: v.eventKey, eventId, checkedAt: v.checkedAt, sourceToken: v.sourceToken, sourceVersion: v.sourceVersion };
    await setWorkApprovalContext(c, req);
    const row = (await c.query('insert into work_period_notice_runs(id,organization_id,legal_entity_id,employee_id,period_id,sequence,policy_id,request_id,request_fingerprint,actor_id,active_role,reason,operation_id,correlation_id,source_token,source_version,source_canonical,outcome)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)returning *', [id, ...workApprovalScope(req), v.worker.id, v.period.id, sequence, v.policy?.id ?? null, input.requestId, fingerprint, req.user.sub, req.user.activeRole, input.reason, req.operationId, req.correlationId, v.sourceToken, v.sourceVersion, v.sourceCanonical, JSON.stringify(outcome)])).rows[0];
    if (outcome.disposition === 'Emitted') {
        const template = (await c.query('select * from work_period_notice_templates where policy_id=$1 and event_key=$2', [v.policy.id, v.eventKey])).rows[0];
        if (!template)
            fail('PERIOD_NOTICE_TEMPLATE_UNAVAILABLE', 'The retained canonical template is unavailable.');
        let rendered;try{
            rendered = renderPeriodNotice({ key: template.event_key, subject: template.subject, body: template.body }, { workerCode: v.worker.code, periodCode: v.period.code, deadlineAt: v.deadlineAt, graceEndsAt: v.graceEndsAt, reminderAt: v.reminderAt });
        }catch(e){if(e instanceof RangeError)fail('PERIOD_NOTICE_RENDER_LIMIT','Notice template/source expansion exceeds its supported in-app bounds.',422);throw e;}
        await c.query('insert into work_period_notice_events(id,run_id,source_version,event_key,policy_class,template_id,operation_id,correlation_id,locale,title,body,organization_id,legal_entity_id,employee_id,period_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [eventId, id, v.sourceVersion, v.eventKey, v.eventKey === PERIOD_NOTICE_KEYS[0] ? 'ACTION_REQUIRED' : 'CONTROL_MANDATORY', template.id, req.operationId, req.correlationId, template.locale, rendered.title, rendered.body,...workApprovalScope(req),v.worker.id,v.period.id]);
        for (const person of v.recipientReasons ?? v.recipients) {
            const recipientId = randomUUID();
            await c.query("insert into work_period_notice_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,$4,true,'Required')", [recipientId, eventId, person.userId, person.reasons]);
            await c.query("insert into work_period_notice_deliveries(id,recipient_id,channel,status,operation_id,correlation_id,attempt)values($1,$2,'InApp','Delivered',$3,$4,1)", [randomUUID(), recipientId, req.operationId, req.correlationId]);
        }
    }
    await o.audit(c, req, { module: 'Notifications', action: 'Evaluate Work Period Notice', entityType: 'WorkPeriodNoticeRun', entityId: id, newValue: periodNoticeRunView(row), reason: input.reason, details: 'Explicit real-clock source evaluation; canonical mandatory in-app atomic recipient/delivery evidence; no source mutation, default scheduler, grant or external adapter.' });
    return { receipt: periodNoticeRunView(row), replayed: false };
};
export const periodNoticeInboxRows = async (c, req, o, { after = null, id = null } = {}) => { const params = [req.user.sub, ...workApprovalScope(req), after, id], where = o.buildEmployeeScopeWhere(req, params, 'w'); return (await c.query(`select 'work-period'kind,n.id,e.id "eventId",r.id "runId",r.employee_id "employeeId",r.period_id "periodId",r.policy_id "policyId",r.source_version "sourceVersion",e.event_key "eventKey",e.policy_class "policyClass",e.template_id "templateId",e.operation_id "operationId",e.correlation_id "correlationId",e.locale,e.title,e.body,n.reasons,n.channel_decision "channelDecision",d.id "deliveryId",d.status "deliveryStatus",e.created_at "createdAt",rd.read_at "readAt" from work_period_notice_recipients n join work_period_notice_events e on e.id=n.event_id join work_period_notice_runs r on r.id=e.run_id join employees w on w.id=r.employee_id and w.organization_id=r.organization_id and w.legal_entity_id=r.legal_entity_id join work_period_notice_deliveries d on d.recipient_id=n.id left join work_period_notice_reads rd on rd.recipient_id=n.id and rd.user_id=n.user_id where n.user_id=$1 and r.organization_id=$2 and r.legal_entity_id=$3 and n.in_app and($4::uuid is null or n.id>$4)and($5::uuid is null or n.id=$5)and ${where} order by n.id limit 21`, params)).rows; };
