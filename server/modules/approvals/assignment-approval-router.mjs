import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validAssignmentApprovalPolicy } from '../../../shared/assignment-approval.mjs';
import { validPlannedAssignment } from '../../../shared/assignment-version.mjs';
import { workApprovalRecipientScope, workApprovalScope as scope, workApprovalFail as fail } from './work-approval-service.mjs';
import { assignmentDecisionPermissions, assignmentApprovalSource, assignmentApprovalPolicy, assignmentApprovalActor, assignmentApprovalPolicyView, setAssignmentApprovalContext, scopedAssignmentApproval, assignmentApprovalView, proposeAssignmentApproval, decideAssignmentApproval, assignmentCreationSource, proposeAssignmentCreation } from './assignment-approval-service.mjs';
export const registerAssignmentApprovalRoutes = (router, o, { config, handle, parse, uuid, hash, date, reason }) => {
    const read = ['projects.view', 'allocations.view'].map(o.requirePermission), manage = o.requirePermission('allocations.manage'), decide = assignmentDecisionPermissions.map(o.requirePermission);
    router.get('/assignments/choices', ...config, manage, ...read, handle(false, async (c, req) => {
        const q = parse(z.object({ afterWorker: z.string().min(1).max(200).optional(), afterUser: uuid.optional() }).strict(), req.query), p = [], where = o.buildEmployeeScopeWhere(req, p, 'e');
        p.push(q.afterWorker ?? null);
        const workers = (await c.query(`select e.id,e.employee_id code,e.name,e.status from employees e where ${where} and($${p.length}::text is null or e.id collate "C">$${p.length} collate "C")order by e.id collate "C" limit 201`, p)).rows;
        const users = (await c.query("select u.id,u.username,coalesce(json_agg(distinct r.name)filter(where r.name is not null),'[]')roles from users u join user_organization_scopes s on s.user_id=u.id left join user_roles ur on ur.user_id=u.id left join roles r on r.id=ur.role_id where u.status='Active'and s.organization_id=$1 and s.legal_entity_id=$2 and s.active and($3::uuid is null or u.id>$3)group by u.id order by u.id limit 201", [...scope(req), q.afterUser ?? null])).rows, choices = [];
        for (const u of users.slice(0, 200)) {
            const roles = [];
            for (const role of u.roles.slice(0, 50)) {
                const permissions = await o.getEffectivePermissionsForUser(c, u.id, role);
                if (assignmentDecisionPermissions.every(k => permissions.includes(k)))
                    roles.push(role);
            }
            choices.push({ id: u.id, username: u.username, roles: roles.sort() });
        }
        return { workers: workers.slice(0, 200), nextWorker: workers.length > 200 ? workers[199].id : null, users: choices, nextUser: users.length > 200 ? users[199].id : null, today: (await c.query("select to_char((clock_timestamp()at time zone'UTC')::date,'YYYY-MM-DD')d")).rows[0].d };
    }));
    router.get('/assignments/policies', ...config, manage, ...read, handle(false, async (c, req) => { const q = parse(z.object({ before: z.coerce.number().int().min(1).max(2147483647).optional() }).strict(), req.query), rows = (await c.query('select *,effective_from::text from assignment_approval_policies where organization_id=$1 and legal_entity_id=$2 and($3::integer is null or sequence<$3)order by sequence desc limit 11', [...scope(req), q.before ?? null])).rows; return { policies: rows.slice(0, 10).map(assignmentApprovalPolicyView), nextBefore: rows.length > 10 ? rows[9].sequence : null }; }));
    router.post('/assignments/policies', ...config, manage, ...read, handle(true, async (c, req) => {
        const d = parse(z.object({ expectedOwnerKey: hash, expectedLatestId: uuid.nullable(), effectiveFrom: date, definition: z.record(z.string(), z.unknown()), reason }).strict(), req.body), latest = (await c.query('select * from assignment_approval_policies where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 1', scope(req))).rows[0];
        if ((latest?.id ?? null) !== d.expectedLatestId)
            fail('ASSIGNMENT_APPROVAL_POLICY_STALE', 'Policy changed. Reload before adopting.');
        if (!Object.hasOwn(d.definition, 'creationRequired') && Object.hasOwn(latest?.definition ?? {}, 'creationRequired'))
            d.definition = { ...d.definition, creationRequired: latest.definition.creationRequired };
        parse(z.unknown().refine(validAssignmentApprovalPolicy), d.definition);
        const p = [], where = o.buildEmployeeScopeWhere(req, p, 'e');
        p.push(d.definition.workerIds);
        if ((await c.query(`select e.id from employees e where ${where} and e.status='Active'and e.id=any($${p.length}::text[])`, p)).rowCount !== d.definition.workerIds.length)
            fail('ASSIGNMENT_APPROVAL_POLICY_SCOPE', 'Every selected worker must be currently active and scoped.', 403);
        if (d.definition.escalationUserId) await workApprovalRecipientScope(c,req,d.definition.escalationUserId,d.definition.workerIds,o);
  for (const stage of d.definition.stages)
            await assignmentApprovalActor(c, req, stage, null, o);
        await setAssignmentApprovalContext(c, req);
        const id = randomUUID(), saved = (await c.query('insert into assignment_approval_policies(id,organization_id,legal_entity_id,sequence,effective_from,definition,actor_id,active_role,reason)values($1,$2,$3,$4,$5,$6,$7,$8,$9)returning *,effective_from::text', [id, ...scope(req), (latest?.sequence ?? 0) + 1, d.effectiveFrom, d.definition, req.user.sub, req.user.activeRole, d.reason])).rows[0];
        for (const t of d.definition.templates)
            await c.query('insert into assignment_approval_templates(id,policy_id,event_key,locale,subject,body)values($1,$2,$3,$4,$5,$6)', [randomUUID(), id, t.key, d.definition.locale, t.subject, t.body]);
        await o.audit(c, req, { module: 'Approvals', action: 'Adopt Material Assignment Approval Policy', entityType: 'AssignmentApprovalPolicy', entityId: id, oldValue: latest ? assignmentApprovalPolicyView(latest) : null, newValue: assignmentApprovalPolicyView(saved), reason: d.reason, details: 'Explicit selected workers/material fields/named stages and optional creation requirement; omitted option preserves adopted value; no buyer defaults, grants, conversions or external delivery.' });
        return { status: 201, body: { policy: assignmentApprovalPolicyView(saved) } };
    }, { sourceLock: true }));
    router.get('/assignments/creation-policy', ...read, manage, handle(false, async (c, req) => {
        const q = parse(z.object({ employeeId: z.string().min(1).max(200), projectId: z.string().min(1).max(200) }).strict(), req.query);
        await assignmentCreationSource(c, req, q.employeeId, q.projectId, 'a-' + randomUUID(), o);
        const p = await assignmentApprovalPolicy(c, req, q.employeeId);
        return { employeeId: q.employeeId, projectId: q.projectId, policy: p?.definition.creationRequired === true ? assignmentApprovalPolicyView(p) : null };
    }));
    router.post('/assignments/creations', ...read, manage, handle(true, async (c, req) => {
        const d = parse(z.object({ expectedOwnerKey: hash, expectedPolicyId: uuid, employeeId: z.string().min(1).max(200), projectId: z.string().min(1).max(200), definition: z.unknown().refine(validPlannedAssignment), requestId: uuid, reason }).strict(), req.body), { expectedOwnerKey, ...input } = d;
        const out = await proposeAssignmentCreation(c, req, input, o);
        return { status: out.replayed ? 200 : 201, body: out };
    }, { sourceLock: true }));
    router.get('/assignments/creation-instances', ...read, handle(false, async (c, req) => {
        const q = parse(z.object({ timing: z.literal('overdue').optional(), after: uuid.optional() }).strict(), req.query), p = [], ew = o.buildEmployeeScopeWhere(req, p, 'e'), pw = o.buildProjectScopeWhere(req, p, 'p'); p.push(q.after ?? null);
        const rows = (await c.query(`select i.id from assignment_approval_instances i join employees e on e.id=i.employee_id and e.organization_id=i.organization_id and e.legal_entity_id=i.legal_entity_id join projects p on p.id=i.project_id and p.organization_id=i.organization_id and p.legal_entity_id=i.legal_entity_id where ${ew} and ${pw} and i.operation_kind='Creation' ${q.timing ? "and exists(select from assignment_leave_open_stage_clocks clock where clock.origin='Assignment' and clock.instance_id=i.id and clock.due_at<date_trunc('milliseconds',statement_timestamp()))" : ''} and($${p.length}::uuid is null or i.id>$${p.length})order by i.id limit 21`, p)).rows, instances = [];
        for (const row of rows.slice(0, 20)) instances.push(assignmentApprovalView(await scopedAssignmentApproval(c, req, row.id, o)));
        return { instances, nextAfter: rows.length > 20 ? rows[19].id : null };
    }));
    router.get('/assignments/creation-instances/:id', ...read, handle(false, async (c, req) => {
        parse(z.object({}).strict(), req.query); const v = await scopedAssignmentApproval(c, req, parse(uuid, req.params.id), o);
        if (v.i.operation_kind !== 'Creation') fail('ASSIGNMENT_APPROVAL_NOT_FOUND', 'Creation request is unavailable.', 404);
        return { instance: assignmentApprovalView(v) };
    }));
    router.get('/assignments/sources/:id', ...read, handle(false, async (c, req) => { parse(z.object({}).strict(), req.query); const { a, latestId } = await assignmentApprovalSource(c, req, req.params.id, o), p = await assignmentApprovalPolicy(c, req, a.employee_id); return { source: { assignmentId: a.id, revision: a.revision, versionId: latestId, snapshot: a.snapshot, policy: p ? assignmentApprovalPolicyView(p) : null } }; }));
    router.post('/assignments/sources/:id/proposals', ...read, manage, handle(true, async (c, req) => { const d = parse(z.object({ expectedOwnerKey: hash, expectedRevision: hash, expectedLatestId: uuid.nullable(), definition: z.unknown().refine(validPlannedAssignment), requestId: uuid, reason }).strict(), req.body), { expectedOwnerKey, ...input } = d, out = await proposeAssignmentApproval(c, req, req.params.id, input, o); return { status: out.replayed ? 200 : 201, body: out }; }, { sourceLock: true }));
    router.get('/assignments/instances', ...read, handle(false, async (c, req) => {
        const q = parse(z.object({ timing: z.literal('overdue').optional(), after: uuid.optional(), assignmentId: z.string().min(1).max(239).optional() }).strict(), req.query), p = [], ew = o.buildEmployeeScopeWhere(req, p, 'e'), pw = o.buildProjectScopeWhere(req, p, 'p');
        p.push(q.after ?? null, q.assignmentId ?? null);
        const n = p.length, rows = (await c.query(`select i.id from assignment_approval_instances i join employees e on e.id=i.employee_id and e.organization_id=i.organization_id and e.legal_entity_id=i.legal_entity_id join projects p on p.id=i.project_id and p.organization_id=i.organization_id and p.legal_entity_id=i.legal_entity_id where ${ew} and ${pw} and i.operation_kind='MaterialChange' ${q.timing ? "and exists(select from assignment_leave_open_stage_clocks clock where clock.origin='Assignment' and clock.instance_id=i.id and clock.due_at<date_trunc('milliseconds',statement_timestamp()))" : ''} and($${n - 1}::uuid is null or i.id>$${n - 1})and($${n}::text is null or i.assignment_id=$${n})order by i.id limit 21`, p)).rows, instances = [];
        for (const r of rows.slice(0, 20))
            instances.push(assignmentApprovalView(await scopedAssignmentApproval(c, req, r.id, o)));
        return { instances, nextAfter: rows.length > 20 ? rows[19].id : null };
    }));
    router.get('/assignments/instances/:id', ...read, handle(false, async (c, req) => { parse(z.object({}).strict(), req.query); const id = parse(uuid, req.params.id); return { instance: assignmentApprovalView(await scopedAssignmentApproval(c, req, id, o)) }; }));
    router.post('/assignments/instances/:id/decisions', ...decide, handle(true, async (c, req) => { const id = parse(uuid, req.params.id), d = parse(z.object({ expectedOwnerKey: hash, expectedSourceToken: hash, expectedSequence: z.number().int().min(0).max(9), requestId: uuid, decision: z.enum(['Approved', 'Rejected']), reason }).strict(), req.body), { expectedOwnerKey, ...input } = d, out = await decideAssignmentApproval(c, req, id, input, o); return { status: out.replayed ? 200 : 201, body: out }; }, { sourceLock: true }));
};
