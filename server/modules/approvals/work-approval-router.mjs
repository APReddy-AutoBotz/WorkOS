import { registerPeriodNoticeRoutes } from '../notifications/work-period-notice-router.mjs';
import { periodNoticeInboxRows } from '../notifications/work-period-notice-service.mjs';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WORK_APPROVAL_VERSION, validWorkApprovalPolicy, approvalUuid, approvalHash } from '../../../shared/work-approval.mjs';
import { validCapabilityDate } from '../../../shared/workforce-capabilities.mjs';
import { lockWorkPolicy } from '../work-capture/assignment-work-policy.mjs';
import { workApprovalEnvelope, workApprovalOwner, workApprovalFail, workApprovalScope, setWorkApprovalContext, workApprovalActor, scopedWorkApproval, workApprovalView, decideWorkApproval } from './work-approval-service.mjs';
const uuid = z.string().uuid().refine(approvalUuid), hash = z.string().refine(approvalHash), date = z.string().refine(validCapabilityDate), reason = z.string().trim().min(1).max(1000);
const configPermissions = ['settings.manage', 'permissions.manage', 'notifications.manage', 'approvals.view'];
export const createWorkApprovalRouter = options => {
    const { pool, requireDatabase, requireAuth, requirePermission, buildEmployeeScopeWhere, audit } = options, router = Router();
    router.use(requireDatabase, requireAuth, requirePermission('employees.view'));
    const parse = (schema, v) => {
        const p = schema.safeParse(v);
        if (!p.success)
            workApprovalFail('WORK_APPROVAL_INVALID', 'Choose explicit valid policy, source, current-stage, account and request fields.', 400);
        return p.data;
    };
    const config = configPermissions.map(requirePermission), read = (req, res, next) => req.user.permissions.includes('timesheets.submit') ? next() : res.status(403).json({ error: 'Work approval access is unavailable.' });
    const handle = (write, fn, { sourceLock = false } = {}) => async (req, res) => {
        let c, begun = false, sessionLock = null, lifecycleLock = null, discard = false;
        try {
            if (write && req.body?.expectedOwnerKey !== workApprovalOwner(req))
                workApprovalFail('WORK_APPROVAL_OWNER_CHANGED', 'Account, active role or scope changed. Reload explicitly.');
            c = await pool.connect();
            if (write) {
                sessionLock = 'work-approval-scope:' + workApprovalScope(req).join(':');
                await c.query('select pg_advisory_lock(hashtextextended($1,0))', [sessionLock]);
            }
            if (write && sourceLock) {
                lifecycleLock = 'commercial-lifecycle:' + workApprovalScope(req).join(':');
                await c.query('select pg_advisory_lock(hashtextextended($1,0))', [lifecycleLock]);
            }
            await c.query('begin isolation level repeatable read');
            begun = true;
            const out = await fn(c, req);
            await c.query('commit');
            begun = false;
            res.status(out.status ?? 200).json({ ...workApprovalEnvelope(req), ...(out.body ?? out) });
        }
        catch (e) {
            if (begun)
                await c.query('rollback').catch(() => { });
            if (e.statusCode)
                res.status(e.statusCode).json({ error: e.message, code: e.code });
            else if (['WDN02', 'WDN03', '23505', '40001', 'WGA02', 'WGA03', 'WGA04', 'WGA05'].includes(e.code))
                res.status(409).json({ error: 'Work approval authority, source or current stage changed. Read history before retrying.', code: 'WORK_APPROVAL_CONFLICT' });
            else if (['WDN01', '23514', '23503', 'WGA01'].includes(e.code))
                res.status(422).json({ error: 'The scoped work approval configuration/evidence is invalid.', code: 'WORK_APPROVAL_AUTHORITY' });
            else {
                console.error('Work approval operation unavailable', e.code ?? 'UNKNOWN');
                res.status(503).json({ error: 'Work approval result could not be confirmed. Read history before retrying.', code: 'WORK_APPROVAL_UNAVAILABLE' });
            }
        }
        finally {
            if (c && lifecycleLock)
                try {
                    await c.query('select pg_advisory_unlock(hashtextextended($1,0))', [lifecycleLock]);
                }
                catch {
                    discard = true;
                }
            if (c && sessionLock)
                try {
                    await c.query('select pg_advisory_unlock(hashtextextended($1,0))', [sessionLock]);
                }
                catch {
                    discard = true;
                }
            c?.release(discard);
        }
    };
    const policyView = p => ({ id: p.id, sequence: p.sequence, effectiveFrom: p.effective_from, definition: p.definition, actorId: p.actor_id, activeRole: p.active_role, reason: p.reason, createdAt: p.created_at });
    router.get('/choices', ...config, handle(false, async (c, req) => {
        const q = parse(z.object({ afterWorker: z.string().min(1).max(200).optional(), afterUser: uuid.optional() }).strict(), req.query), p = [], where = buildEmployeeScopeWhere(req, p, 'e');
        p.push(q.afterWorker ?? null);
        const workers = (await c.query(`select e.id,e.employee_id code,e.name,e.status from employees e where ${where} and ($${p.length}::text is null or e.id collate "C">$${p.length} collate "C")order by e.id collate "C" limit 201`, p)).rows;
        const users = (await c.query("select u.id,u.username,coalesce(json_agg(distinct r.name)filter(where r.name is not null),'[]')roles from users u join user_organization_scopes s on s.user_id=u.id left join user_roles ur on ur.user_id=u.id left join roles r on r.id=ur.role_id where u.status='Active'and s.organization_id=$1 and s.legal_entity_id=$2 and s.active and($3::uuid is null or u.id>$3)group by u.id order by u.id limit 201", [...workApprovalScope(req), q.afterUser ?? null])).rows;
        const choices = [];
        for (const u of users.slice(0, 200)) {
            const roles = [];
            for (const role of u.roles.slice(0, 50)) {
                const p = await options.getEffectivePermissionsForUser(c, u.id, role);
                if (['timesheets.approve', 'timesheets.submit', 'projects.view', 'approvals.view', 'employees.view', 'notifications.view'].every(k => p.includes(k)))
                    roles.push(role);
            }
            choices.push({ id: u.id, username: u.username, roles: roles.sort() });
        }
        return { workers: workers.slice(0, 200), nextWorker: workers.length > 200 ? workers[199].id : null, users: choices, nextUser: users.length > 200 ? users[199].id : null, today: (await c.query("select to_char((clock_timestamp()at time zone'UTC')::date,'YYYY-MM-DD')d")).rows[0].d };
    }));
    router.get('/policies', ...config, handle(false, async (c, req) => { const q = parse(z.object({ before: z.coerce.number().int().min(1).max(2147483647).optional() }).strict(), req.query), rows = (await c.query('select *,effective_from::text from work_approval_policy_versions where organization_id=$1 and legal_entity_id=$2 and($3::integer is null or sequence<$3)order by sequence desc limit 11', [...workApprovalScope(req), q.before ?? null])).rows; return { policies: rows.slice(0, 10).map(policyView), nextBefore: rows.length > 10 ? rows[9].sequence : null }; }));
    router.post('/policies', ...config, handle(true, async (c, req) => {
        const d = parse(z.object({ expectedOwnerKey: hash, expectedLatestId: uuid.nullable(), effectiveFrom: date, definition: z.unknown().refine(validWorkApprovalPolicy), reason }).strict(), req.body);
        await lockWorkPolicy(c, req);
        const latest = (await c.query('select * from work_approval_policy_versions where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 1', workApprovalScope(req))).rows[0];
        if ((latest?.id ?? null) !== d.expectedLatestId)
            workApprovalFail('WORK_APPROVAL_POLICY_STALE', 'Policy changed. Reload its latest version.');
        const p = [], where = buildEmployeeScopeWhere(req, p, 'e');
        p.push(d.definition.workerIds);
        if ((await c.query(`select e.id from employees e where ${where} and  e.id=any($${p.length}::text[])`, p)).rowCount !== d.definition.workerIds.length)
            workApprovalFail('WORK_APPROVAL_POLICY_SCOPE', 'Every selected worker must be in the current authorized scope.', 403);
        for (const stage of d.definition.stages)
            await workApprovalActor(c, req, stage, null, options);
        await setWorkApprovalContext(c, req);
        const id = randomUUID(), saved = (await c.query("insert into work_approval_policy_versions(id,organization_id,legal_entity_id,sequence,effective_from,policy_version,definition,actor_id,active_role,reason)values($1,$2,$3,$4,$5,'work-approval/1',$6,$7,$8,$9)returning *,effective_from::text", [id, ...workApprovalScope(req), (latest?.sequence ?? 0) + 1, d.effectiveFrom, JSON.stringify(d.definition), req.user.sub, req.user.activeRole, d.reason])).rows[0];
        for (const t of d.definition.templates)
            await c.query('insert into work_approval_templates(id,policy_id,event_key,locale,subject,body)values($1,$2,$3,$4,$5,$6)', [randomUUID(), id, t.key, d.definition.locale, t.subject, t.body]);
        await audit(c, req, { module: 'Approvals', action: 'Adopt Work Approval Policy', entityType: 'WorkApprovalPolicy', entityId: id, oldValue: latest ? policyView(latest) : null, newValue: policyView(saved), reason: d.reason, details: 'Explicit prospective selected-worker stages and versioned canonical in-app templates; no new decision right, default, grant, external delivery or protected reopen.' });
        return { status: 201, body: { policy: policyView(saved) } };
    }));
    router.get('/instances', read, handle(false, async (c, req) => {
        const q = parse(z.object({ after: uuid.optional(), timesheetId: uuid.optional() }).strict(), req.query), p = [], where = buildEmployeeScopeWhere(req, p, 'e');
        p.push(q.after ?? null, q.timesheetId ?? null);
        const n = p.length, rows = (await c.query(`select i.id from work_approval_instances i join employees e on e.id=i.employee_id and e.organization_id=i.organization_id and e.legal_entity_id=i.legal_entity_id where ${where} and ($${n - 1}::uuid is null or i.id>$${n - 1})and($${n}::uuid is null or i.timesheet_id=$${n})order by i.id limit 21`, p)).rows, instances = [];
        for (const row of rows.slice(0, 20))
            instances.push(workApprovalView(await scopedWorkApproval(c, req, row.id, options)));
        return { instances, nextAfter: rows.length > 20 ? rows[19].id : null };
    }));
    router.get('/instances/:id', read, handle(false, async (c, req) => { parse(z.object({}).strict(), req.query); const id = parse(uuid, req.params.id); return { instance: workApprovalView(await scopedWorkApproval(c, req, id, options, false, true)) }; }));
    router.post('/instances/:id/decisions', requirePermission('approvals.view'), requirePermission('timesheets.approve'), handle(true, async (c, req) => { const id = parse(uuid, req.params.id), input = parse(z.object({ expectedOwnerKey: hash, expectedSourceToken: hash, expectedSequence: z.number().int().min(0).max(9), requestId: uuid, decision: z.enum(['Approved', 'Rejected']), reason }).strict(), req.body); const { expectedOwnerKey, ...command } = input; const out = await decideWorkApproval(c, req, id, command, options); return { status: out.replayed ? 200 : 201, body: out }; }));
    const inboxRows = async (c, req, { after = null, id = null } = {}) => { const p = [req.user.sub, ...workApprovalScope(req), after, id], where = buildEmployeeScopeWhere(req, p, 'e'); return (await c.query(`select r.id,r.event_id "eventId",w.id "instanceId",w.timesheet_id "timesheetId",w.submission_id "submissionId",ev.transition_sequence "transitionSequence",ev.event_key "eventKey",ev.policy_class "policyClass",ev.template_id "templateId",ev.operation_id "operationId",ev.locale,ev.title,ev.body,r.reasons,r.channel_decision "channelDecision",ev.created_at "createdAt",rd.read_at "readAt" from work_approval_recipients r join work_approval_events ev on ev.id=r.event_id join work_approval_instances w on w.id=ev.instance_id join employees e on e.id=w.employee_id and e.organization_id=w.organization_id and e.legal_entity_id=w.legal_entity_id left join work_approval_reads rd on rd.recipient_id=r.id and rd.user_id=r.user_id where r.user_id=$1 and w.organization_id=$2 and w.legal_entity_id=$3 and r.in_app and($4::uuid is null or r.id>$4)and($5::uuid is null or r.id=$5)and ${where} order by r.id limit 21`, p)).rows; };
    router.get('/inbox', requirePermission('notifications.view'), handle(false, async (c, req) => { const q = parse(z.object({ after: uuid.optional() }).strict(), req.query), legacy = await inboxRows(c, req, q), period = await periodNoticeInboxRows(c, req, options, q), rows = [...legacy, ...period].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); if (new Set(rows.map(x => x.id)).size !== rows.length)
        workApprovalFail('WORK_APPROVAL_INBOX_CONFLICT', 'Canonical notice identity requires explicit resolution.'); return { notifications: rows.slice(0, 20), nextAfter: rows.length > 20 ? rows[19].id : null }; }));
    router.post('/inbox/:id/read', requirePermission('notifications.view'), handle(true, async (c, req) => { parse(z.object({ expectedOwnerKey: hash }).strict(), req.body); const id = parse(uuid, req.params.id), legacy = await inboxRows(c, req, { id }), period = await periodNoticeInboxRows(c, req, options, { id }); if (legacy.length + period.length !== 1)
        workApprovalFail('WORK_APPROVAL_NOTIFICATION_NOT_FOUND', 'In-app notification is unavailable for the current recipient/scope.', 404); const row = [...legacy, ...period][0], table = period.length ? 'work_period_notice_reads' : 'work_approval_reads'; await setWorkApprovalContext(c, req); const saved = await c.query(`insert into ${table}(recipient_id,user_id)values($1,$2)on conflict do nothing returning *`, [id, req.user.sub]); if (saved.rowCount)
        await audit(c, req, { module: 'Notifications', action: period.length ? 'Read Work Period Notice' : 'Read Governed Approval Notification', entityType: period.length ? 'WorkPeriodNoticeNotification' : 'WorkApprovalNotification', entityId: id, newValue: { recipientId: id, eventId: row.eventId }, details: 'Acknowledged only this authenticated scoped recipient record.' }); return { notification: (period.length ? await periodNoticeInboxRows(c, req, options, { id }) : await inboxRows(c, req, { id }))[0] }; }));
    registerPeriodNoticeRoutes(router, options, { config, handle, parse, uuid, hash, date, reason });
    return router;
};
