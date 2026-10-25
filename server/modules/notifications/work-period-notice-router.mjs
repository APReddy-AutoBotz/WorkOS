import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PERIOD_NOTICE_KEYS, validPeriodNoticeDefinition } from '../../../shared/work-period-notices.mjs';
import { workApprovalScope, workApprovalUser, workApprovalFail as fail, setWorkApprovalContext } from '../approvals/work-approval-service.mjs';
import { periodNoticePolicyView, periodNoticeWorker, periodNoticeRecipient, periodNoticePreview, periodNoticePreviewView, periodNoticeRunView, evaluatePeriodNotice } from './work-period-notice-service.mjs';
export const registerPeriodNoticeRoutes = (router, o, h) => {
    const { config, handle, parse, uuid, hash, date, reason } = h, text = z.string().trim().min(1).max(200);
    router.get('/deadlines/choices', ...config, handle(false, async (c, req) => {
        const q = parse(z.object({ afterWorker: text.optional(), afterUser: uuid.optional(), afterPeriod: text.optional() }).strict(), req.query), params = [], where = o.buildEmployeeScopeWhere(req, params, 'e');
        params.push(q.afterWorker ?? null);
        const workers = (await c.query(`select e.id,e.employee_id code,e.name,e.status from employees e where ${where} and ($${params.length}::text is null or e.id collate "C">$${params.length} collate "C")order by e.id collate "C" limit 201`, params)).rows;
        const users = (await c.query("select u.id,u.username,coalesce(json_agg(distinct r.name)filter(where r.name is not null),'[]')roles from users u join user_organization_scopes s on s.user_id=u.id left join user_roles ur on ur.user_id=u.id left join roles r on r.id=ur.role_id where u.status='Active'and s.organization_id=$1 and s.legal_entity_id=$2 and s.active and($3::uuid is null or u.id>$3)group by u.id order by u.id limit 201", [...workApprovalScope(req), q.afterUser ?? null])).rows, choices = [];
        for (const u of users.slice(0, 200)) {
            const roles = [];
            for (const role of u.roles.slice(0, 50)) {
                const p = await o.getEffectivePermissionsForUser(c, u.id, role);
                if (['employees.view', 'timesheets.submit', 'notifications.view'].every(k => p.includes(k)))
                    roles.push(role);
            }
            choices.push({ id: u.id, username: u.username, roles: roles.sort() });
        }
        const periods = (await c.query('select id,code,starts_on::text,ends_on::text,status,frequency from reporting_periods where organization_id=$1 and legal_entity_id=$2 and frequency=\'Weekly\'and($3::text is null or id collate "C">$3 collate "C")order by id collate "C" limit 201', [...workApprovalScope(req), q.afterPeriod ?? null])).rows;
        return { workers: workers.slice(0, 200), nextWorker: workers.length > 200 ? workers[199].id : null, users: choices, nextUser: users.length > 200 ? users[199].id : null, periods: periods.slice(0, 200), nextPeriod: periods.length > 200 ? periods[199].id : null, today: (await c.query("select to_char((clock_timestamp()at time zone'UTC')::date,'YYYY-MM-DD')d")).rows[0].d };
    }));
    router.get('/deadlines/policies', ...config, handle(false, async (c, req) => { const q = parse(z.object({ before: z.coerce.number().int().min(1).max(2147483647).optional() }).strict(), req.query), rows = (await c.query('select *,effective_from::text from work_period_notice_policies where organization_id=$1 and legal_entity_id=$2 and($3::integer is null or sequence<$3)order by sequence desc limit 11', [...workApprovalScope(req), q.before ?? null])).rows; return { policies: rows.slice(0, 10).map(periodNoticePolicyView), nextBefore: rows.length > 10 ? rows[9].sequence : null }; }));
    router.post('/deadlines/policies', ...config, handle(true, async (c, req) => {
        const d = parse(z.object({ expectedOwnerKey: hash, expectedLatestId: uuid.nullable(), effectiveFrom: date, definition: z.unknown().refine(validPeriodNoticeDefinition), reason }).strict(), req.body), latest = (await c.query('select * from work_period_notice_policies where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 1', workApprovalScope(req))).rows[0];
        if ((latest?.id ?? null) !== d.expectedLatestId)
            fail('PERIOD_NOTICE_POLICY_STALE', 'Notice policy changed. Reload its latest version.');
        const owner = await workApprovalUser(c, req, d.definition.escalationOwner.userId, o), ownerPermissions = await o.getEffectivePermissionsForUser(c, owner.id, d.definition.escalationOwner.role);
        if (!owner.roles.includes(d.definition.escalationOwner.role) || !['employees.view', 'notifications.view', 'timesheets.submit'].every(k => ownerPermissions.includes(k)))
            fail('PERIOD_NOTICE_OWNER_UNAVAILABLE', 'Select a current held role with existing scoped work-read/inbox rights.');
        for (const id of d.definition.workerIds) {
            const worker = await periodNoticeWorker(c, req, id, o);
            if (worker.status !== 'Active')
                fail('PERIOD_NOTICE_WORKER_UNAVAILABLE', 'Select existing active scoped workers.');
            await periodNoticeRecipient(c, req, d.definition.escalationOwner.userId, d.definition.escalationOwner.role, id, o);
        }
        await setWorkApprovalContext(c, req);
        const id = randomUUID(), saved = (await c.query('insert into work_period_notice_policies(id,organization_id,legal_entity_id,sequence,effective_from,definition,actor_id,active_role,reason)values($1,$2,$3,$4,$5,$6,$7,$8,$9)returning *,effective_from::text', [id, ...workApprovalScope(req), (latest?.sequence ?? 0) + 1, d.effectiveFrom, JSON.stringify(d.definition), req.user.sub, req.user.activeRole, d.reason])).rows[0];
        for (const t of d.definition.templates)
            await c.query('insert into work_period_notice_templates(id,policy_id,event_key,locale,subject,body)values($1,$2,$3,$4,$5,$6)', [randomUUID(), id, t.key, d.definition.locale, t.subject, t.body]);
        await o.audit(c, req, { module: 'Notifications', action: 'Adopt Work Period Notice Policy', entityType: 'WorkPeriodNoticePolicy', entityId: id, oldValue: latest ? periodNoticePolicyView(latest) : null, newValue: periodNoticePolicyView(saved), reason: d.reason, details: 'Explicit prospective selected-worker UTC reminder/overdue-owner/in-app templates; no default, schedule, grant or external delivery.' });
        return { status: 201, body: { policy: periodNoticePolicyView(saved) } };
    }, { sourceLock: true }));
    const selection = z.object({ employeeId: text, periodId: text }).strict();
    router.get('/deadlines/preview', ...config, o.requirePermission('timesheets.submit'), handle(false, async (c, req) => { const d = parse(selection, req.query); return { preview: periodNoticePreviewView(await periodNoticePreview(c, req, d.employeeId, d.periodId, o)) }; }));
    router.post('/deadlines/evaluate', ...config, o.requirePermission('timesheets.submit'), handle(true, async (c, req) => { const d = parse(selection.extend({ expectedOwnerKey: hash, expectedSourceToken: hash, expectedEventKey: z.enum(PERIOD_NOTICE_KEYS).nullable(), requestId: uuid, reason }).strict(), req.body), { expectedOwnerKey, ...command } = d, out = await evaluatePeriodNotice(c, req, command, o); return { status: out.replayed ? 200 : 201, body: out }; }, { sourceLock: true }));
    router.get('/deadlines/history', ...config, o.requirePermission('timesheets.submit'), handle(false, async (c, req) => { const d = parse(selection.extend({ before: z.coerce.number().int().min(1).max(2147483647).optional() }).strict(), req.query); await periodNoticeWorker(c, req, d.employeeId, o); const rows = (await c.query('select * from work_period_notice_runs where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 and period_id=$4 and($5::integer is null or sequence<$5)order by sequence desc limit 11', [...workApprovalScope(req), d.employeeId, d.periodId, d.before ?? null])).rows; return { employeeId: d.employeeId, periodId: d.periodId, receipts: rows.slice(0, 10).map(periodNoticeRunView), nextBefore: rows.length > 10 ? rows[9].sequence : null }; }));
};
