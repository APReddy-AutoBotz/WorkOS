import { validAssignmentApprovalPolicy, assignmentApprovalIdentity, materialAssignmentFields } from '../../shared/assignment-approval.mjs';
import { validAssignmentDefinition } from '../../shared/assignment-version.mjs';
import { approvalKeys, approvalUuid, approvalHash, approvalText, approvalState, APPROVAL_EVENT_KEYS } from '../../shared/work-approval.mjs';
import { validCapabilityDate, compareCapabilityIds } from '../../shared/workforce-capabilities.mjs';
import { ApiClientError } from './apiClient';
import type { AssignmentDefinition, AssignmentSnapshot } from './assignmentVersions';
import type { WorkApprovalContext, WorkStage, WorkStageState, WorkDecisionReceipt } from './workApprovals';
export type AssignmentApprovalDefinition = {
    entityType: 'Assignment';
    workerIds: string[];
    materialFields: string[];
    stages: WorkStage[];
    locale: string;
    templates: {
        key: string;
        subject: string;
        body: string;
    }[];
    completionInApp: boolean;
    creationRequired?: boolean;
};
export type AssignmentApprovalPolicy = {
    id: string;
    sequence: number;
    effectiveFrom: string;
    definition: AssignmentApprovalDefinition;
    actorId: string;
    activeRole: string;
    reason: string;
    createdAt: string;
};
export type AssignmentApprovalSource = {
    assignmentId: string;
    revision: string;
    versionId: string | null;
    snapshot: AssignmentSnapshot;
    policy: AssignmentApprovalPolicy | null;
};
export type AssignmentApprovalInstance = {
    id: string;
    assignmentId: string;
    employeeId: string;
    projectId: string;
    sourceRevision: string;
    sourceVersionId: string | null;
    sourceToken: string;
    requesterUserId: string;
    requestId: string;
    reason: string;
    createdAt: string;
    worker: {
        id: string;
        code: string;
        name: string;
    };
    policy: AssignmentApprovalPolicy;
    before: AssignmentSnapshot;
    proposed: AssignmentDefinition;
    currentRevision: string;
    currentVersionId: string | null;
    state: WorkStageState;
    transitions: WorkDecisionReceipt[];
    notificationFailures: {
        sequence: number;
        code: 'INFORMATIONAL_NOTIFICATION_UNAVAILABLE';
        createdAt: string;
    }[];
};
export type AssignmentApprovalPage = {
    instance: AssignmentApprovalInstance;
    actorUserId: string;
    ownerKey: string;
};
export type AssignmentApprovalNotice = {
    kind: 'assignment-approval' | 'assignment-creation-approval';
    id: string;
    eventId: string;
    instanceId: string;
    assignmentId: string;
    sourceToken: string;
    transitionSequence: number;
    eventKey: string;
    policyClass: 'ACTION_REQUIRED' | 'INFORMATIONAL';
    templateId: string;
    operationId: string;
    locale: string;
    title: string;
    body: string;
    reasons: string[];
    channelDecision: 'Required' | 'Enabled';
    deliveryId: string;
    deliveryStatus: 'Delivered';
    createdAt: string;
    readAt: string | null;
};
const fail = (): never => { throw new ApiClientError('Assignment approval acknowledgement is unavailable. Read source/history before retrying.', { status: 503 }); };
const obj = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v)), keys = (v: unknown, k: string[]) => approvalKeys(v, k), uuid = (v: unknown): v is string => approvalUuid(v), hash = (v: unknown): v is string => approvalHash(v), text = (v: unknown, max = 200): v is string => approvalText(v, max), integer = (v: unknown, min = 0, max = 2147483647) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max, instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v)), nullableUuid = (v: unknown) => v === null || uuid(v), canon = (x: unknown) => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const snapshot = (v: unknown, id?: string): v is AssignmentSnapshot => {
    if (!obj(v) || !keys(v, ['assignmentId', 'employeeId', 'projectId', 'role', 'quantityUnit', 'quantityExact', 'startsOn', 'endsOn', 'billable', 'status', 'comment']) || !text(v.assignmentId, 239) || id !== undefined && v.assignmentId !== id || !text(v.employeeId) || !text(v.projectId))
        return false;
    const { assignmentId: _id, employeeId: _worker, projectId: _project, ...d } = v;
    return validAssignmentDefinition(d);
};
export const decodeAssignmentApprovalPolicy = (v: unknown): AssignmentApprovalPolicy => {
    if (!obj(v) || !keys(v, ['id', 'sequence', 'effectiveFrom', 'definition', 'actorId', 'activeRole', 'reason', 'createdAt']) || !uuid(v.id) || !integer(v.sequence, 1) || !validCapabilityDate(v.effectiveFrom) || !validAssignmentApprovalPolicy(v.definition) || !uuid(v.actorId) || !text(v.activeRole, 100) || !text(v.reason, 1000) || !instant(v.createdAt))
        return fail();
    return v as AssignmentApprovalPolicy;
};
const receipt = (v: unknown, id: string): WorkDecisionReceipt => {
    if (!obj(v) || !keys(v, ['id', 'instanceId', 'sequence', 'stage', 'decision', 'actorId', 'activeRole', 'requestId', 'operationId', 'reason', 'outcome', 'createdAt']) || !uuid(v.id) || v.instanceId !== id || !integer(v.sequence, 1, 10) || !integer(v.stage, 0, 9) || !['Approved', 'Rejected'].includes(String(v.decision)) || !uuid(v.actorId) || !text(v.activeRole, 100) || !uuid(v.requestId) || !text(v.operationId) || !text(v.reason, 1000) || !obj(v.outcome) || !keys(v.outcome, ['status', 'sequence', 'currentStage']) || v.outcome.sequence !== v.sequence || !instant(v.createdAt))
        return fail();
    return v as unknown as WorkDecisionReceipt;
};
export type AssignmentCreationInstance = Omit<AssignmentApprovalInstance, 'before'> & { operationKind: 'Creation'; before: null };
export type AssignmentCreationPage = { instance: AssignmentCreationInstance; actorUserId: string; ownerKey: string };
const decodeInstance = (v: unknown, id?: string, creation = false): AssignmentApprovalInstance | AssignmentCreationInstance => {
    if (!obj(v) || !keys(v, ['id', 'assignmentId', 'employeeId', 'projectId', 'sourceRevision', 'sourceVersionId', 'sourceToken', 'requesterUserId', 'requestId', 'reason', 'createdAt', 'worker', 'policy', 'before', 'proposed', 'currentRevision', 'currentVersionId', 'state', 'transitions', 'notificationFailures', ...(creation ? ['operationKind'] : [])]) || (creation && v.operationKind !== 'Creation') || !uuid(v.id) || id !== undefined && v.id !== id || !text(v.assignmentId, 239) || creation && (!v.assignmentId.startsWith('a-') || !uuid(v.assignmentId.slice(2))) || !text(v.employeeId) || !text(v.projectId) || !hash(v.sourceRevision) || !nullableUuid(v.sourceVersionId) || !hash(v.sourceToken) || !uuid(v.requesterUserId) || !uuid(v.requestId) || !text(v.reason, 1000) || !instant(v.createdAt) || !obj(v.worker) || !keys(v.worker, ['id', 'code', 'name']) || v.worker.id !== v.employeeId || !text(v.worker.code) || !text(v.worker.name, 2000) || (creation ? v.before !== null || v.sourceVersionId !== null : !snapshot(v.before, v.assignmentId) || v.before.employeeId !== v.employeeId || v.before.projectId !== v.projectId) || !validAssignmentDefinition(v.proposed) || !hash(v.currentRevision) || !nullableUuid(v.currentVersionId) || !Array.isArray(v.transitions) || v.transitions.length > 10 || !Array.isArray(v.notificationFailures))
        return fail();
    const p = decodeAssignmentApprovalPolicy(v.policy), r = v as unknown as AssignmentApprovalInstance;
    if (!p.definition.workerIds.includes(r.employeeId) || (creation ? p.definition.creationRequired !== true : !materialAssignmentFields(r.before, r.proposed, p.definition.materialFields).length))
        return fail();
    let state: WorkStageState;
    try {
        state = approvalState(p.definition.stages, r.transitions) as WorkStageState;
    }
    catch {
        return fail();
    }
    if (canon(state) !== canon(r.state))
        return fail();
    const requests = new Set<string>();
    for (const [t, i] of r.transitions.map((t, i) => [t, i] as const)) {
        receipt(t, r.id);
        if (requests.has(t.requestId) || t.actorId !== p.definition.stages[t.stage].userId || t.activeRole !== p.definition.stages[t.stage].role || t.actorId === r.requesterUserId || canon(t.outcome) !== canon(approvalState(p.definition.stages, r.transitions.slice(0, i + 1))))
            return fail();
        requests.add(t.requestId);
    }
    if (r.notificationFailures.some(f => !keys(f, ['sequence', 'code', 'createdAt']) || f.code !== 'INFORMATIONAL_NOTIFICATION_UNAVAILABLE' || !instant(f.createdAt) || !r.transitions.some(t => t.sequence === f.sequence && t.outcome.status === 'Approved')) || new Set(r.notificationFailures.map(f => f.sequence)).size !== r.notificationFailures.length)
        return fail();
    return r;
};
export const decodeAssignmentApprovalInstance = (v: unknown, id?: string): AssignmentApprovalInstance => decodeInstance(v, id) as AssignmentApprovalInstance;
export const decodeAssignmentCreationInstance = (v: unknown, id?: string): AssignmentCreationInstance => decodeInstance(v, id, true) as AssignmentCreationInstance;
export const decodeAssignmentApprovalNotice = (v: unknown): AssignmentApprovalNotice => {
    if (!obj(v) || !keys(v, ['kind', 'id', 'eventId', 'instanceId', 'assignmentId', 'sourceToken', 'transitionSequence', 'eventKey', 'policyClass', 'templateId', 'operationId', 'locale', 'title', 'body', 'reasons', 'channelDecision', 'deliveryId', 'deliveryStatus', 'createdAt', 'readAt']) || !['assignment-approval', 'assignment-creation-approval'].includes(String(v.kind)) || !uuid(v.id) || !uuid(v.instanceId) || !text(v.assignmentId, 239) || !hash(v.sourceToken) || !integer(v.transitionSequence, 0, 10) || !APPROVAL_EVENT_KEYS.includes(v.eventKey as string) || !text(v.operationId) || v.eventId !== assignmentApprovalIdentity(v.instanceId, v.transitionSequence, v.eventKey, v.operationId) || !uuid(v.templateId) || !text(v.locale, 100) || !text(v.title, 1200) || !text(v.body, 12000) || !Array.isArray(v.reasons) || !v.reasons.length || v.reasons.length > 3 || v.reasons.some(k => !['requester', 'affected_worker', 'current_stage_approver'].includes(k)) || v.reasons.join(',') !== [...new Set(v.reasons)].sort().join(',') || !uuid(v.deliveryId) || v.deliveryStatus !== 'Delivered' || !instant(v.createdAt) || v.readAt !== null && !instant(v.readAt) || (v.eventKey === 'approval.completed' ? v.policyClass !== 'INFORMATIONAL' || v.channelDecision !== 'Enabled' : v.policyClass !== 'ACTION_REQUIRED' || v.channelDecision !== 'Required'))
        return fail();
    return v as AssignmentApprovalNotice;
};
type Transport = (method: 'GET' | 'POST', tail: string, c: WorkApprovalContext | null, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export const createAssignmentApprovalClient = (request: Transport) => {
    const call = (method: 'GET' | 'POST', tail: string, c: WorkApprovalContext | null, body?: Record<string, unknown>) => {
        if (!c || !['configure', 'assignment', 'assignment-decide'].includes(c.mode))
            return fail();
        return request(method, '/assignments' + tail, c, body);
    };
    const page = (r: Record<string, unknown>, id?: string): AssignmentApprovalPage => ({ instance: decodeAssignmentApprovalInstance(r.instance, id), actorUserId: r.actorUserId as string, ownerKey: r.ownerKey as string });
    return {
        choices: async (c: WorkApprovalContext | null, afterWorker: string | null = null, afterUser: string | null = null) => {
            if (c?.mode !== 'configure' || afterWorker !== null && !text(afterWorker) || afterUser !== null && !uuid(afterUser))
                return fail();
            const r = await call('GET', '/choices?' + new URLSearchParams({ ...afterWorker ? { afterWorker } : {}, ...afterUser ? { afterUser } : {} }), c);
            if (!Array.isArray(r.workers) || r.workers.length > 200 || !Array.isArray(r.users) || r.users.length > 200 || !validCapabilityDate(r.today))
                return fail();
            let w = afterWorker ?? '', u = afterUser ?? '';
            for (const x of r.workers) {
                if (!obj(x) || !keys(x, ['id', 'code', 'name', 'status']) || !text(x.id) || compareCapabilityIds(x.id, w) <= 0 || !text(x.code) || !text(x.name, 2000) || !text(x.status))
                    return fail();
                w = x.id;
            }
            for (const x of r.users) {
                if (!obj(x) || !keys(x, ['id', 'username', 'roles']) || !uuid(x.id) || x.id <= u || !text(x.username) || !Array.isArray(x.roles) || x.roles.length > 50 || x.roles.some(k => !text(k, 100)) || x.roles.join(',') !== [...new Set(x.roles)].sort().join(','))
                    return fail();
                u = x.id;
            }
            if (r.nextWorker !== null && (r.workers.length !== 200 || r.nextWorker !== w) || r.nextUser !== null && (r.users.length !== 200 || r.nextUser !== u))
                return fail();
            return r as unknown as {
                workers: {
                    id: string;
                    code: string;
                    name: string;
                    status: string;
                }[];
                users: {
                    id: string;
                    username: string;
                    roles: string[];
                }[];
                nextWorker: string | null;
                nextUser: string | null;
                today: string;
            };
        },
        policies: async (c: WorkApprovalContext | null, before: number | null = null) => {
            if (c?.mode !== 'configure' || before !== null && !integer(before, 1))
                return fail();
            const r = await call('GET', '/policies' + (before ? '?before=' + before : ''), c);
            if (!Array.isArray(r.policies) || r.policies.length > 10)
                return fail();
            let seq = before ?? 2147483648;
            const policies = r.policies.map(v => {
                const p = decodeAssignmentApprovalPolicy(v);
                if (p.sequence >= seq)
                    return fail();
                seq = p.sequence;
                return p;
            });
            if (r.nextBefore !== null && (policies.length !== 10 || r.nextBefore !== seq))
                return fail();
            return { policies, nextBefore: r.nextBefore as number | null };
        },
        adopt: async (latest: string | null, effectiveFrom: string, definition: AssignmentApprovalDefinition, reason: string, c: WorkApprovalContext | null) => {
            if (c?.mode !== 'configure' || !nullableUuid(latest) || !validCapabilityDate(effectiveFrom) || !validAssignmentApprovalPolicy(definition) || !text(reason.trim(), 1000))
                return fail();
            const r = await call('POST', '/policies', c, { expectedLatestId: latest, effectiveFrom, definition, reason: reason.trim() }), p = decodeAssignmentApprovalPolicy(r.policy);
            if (p.actorId !== r.actorUserId || p.activeRole !== c.activeRole || p.effectiveFrom !== effectiveFrom || p.reason !== reason.trim() || canon(p.definition) !== canon(definition))
                return fail();
            return p;
        },
        source: async (id: string, c: WorkApprovalContext | null): Promise<AssignmentApprovalSource> => {
            if (!text(id, 239))
                return fail();
            const r = await call('GET', '/sources/' + encodeURIComponent(id), c), s = r.source;
            if (!obj(s) || !keys(s, ['assignmentId', 'revision', 'versionId', 'snapshot', 'policy']) || s.assignmentId !== id || !hash(s.revision) || !nullableUuid(s.versionId) || !snapshot(s.snapshot, id))
                return fail();
            if (s.policy !== null)
                decodeAssignmentApprovalPolicy(s.policy);
            return s as AssignmentApprovalSource;
        },
        propose: async (source: AssignmentApprovalSource, definition: AssignmentDefinition, reason: string, requestId: string, c: WorkApprovalContext | null) => {
            if (c?.mode !== 'assignment' || !uuid(requestId) || !validAssignmentDefinition(definition) || !text(reason.trim(), 1000) || !source.policy)
                return fail();
            const r = await call('POST', '/sources/' + encodeURIComponent(source.assignmentId) + '/proposals', c, { expectedRevision: source.revision, expectedLatestId: source.versionId, definition, reason: reason.trim(), requestId }), p = page(r);
            if (typeof r.replayed !== 'boolean' || p.instance.assignmentId !== source.assignmentId || p.instance.requestId !== requestId || p.instance.requesterUserId !== r.actorUserId || p.instance.sourceRevision !== source.revision || p.instance.sourceVersionId !== source.versionId || p.instance.reason !== reason.trim() || canon(p.instance.before) !== canon(source.snapshot) || canon(p.instance.proposed) !== canon(definition) || p.instance.policy.id !== source.policy.id)
                return fail();
            return { ...p, replayed: r.replayed };
        },
        list: async (c: WorkApprovalContext | null, after: string | null = null, assignmentId?: string) => {
            if (after !== null && !uuid(after) || assignmentId !== undefined && !text(assignmentId, 239))
                return fail();
            const r = await call('GET', '/instances?' + new URLSearchParams({ ...after ? { after } : {}, ...assignmentId ? { assignmentId } : {} }), c);
            if (!Array.isArray(r.instances) || r.instances.length > 20)
                return fail();
            let previous = after ?? '';
            const instances = r.instances.map(v => {
                const i = decodeAssignmentApprovalInstance(v);
                if (i.id <= previous || assignmentId && i.assignmentId !== assignmentId)
                    return fail();
                previous = i.id;
                return i;
            });
            if (r.nextAfter !== null && (instances.length !== 20 || r.nextAfter !== previous))
                return fail();
            return { instances, nextAfter: r.nextAfter as string | null };
        },
        instance: async (id: string, c: WorkApprovalContext | null) => {
            if (!uuid(id))
                return fail();
            return page(await call('GET', '/instances/' + id, c), id);
        },
        creationPolicy: async (employeeId: string, projectId: string, c: WorkApprovalContext | null) => {
            if (c?.mode !== 'assignment' || !text(employeeId) || !text(projectId)) return fail();
            const r = await call('GET', '/creation-policy?' + new URLSearchParams({ employeeId, projectId }), c);
            if (r.employeeId !== employeeId || r.projectId !== projectId) return fail();
            const p = r.policy === null ? null : decodeAssignmentApprovalPolicy(r.policy);
            if (p && (p.definition.creationRequired !== true || !p.definition.workerIds.includes(employeeId))) return fail();
            return p;
        },
        requestCreation: async (employeeId: string, projectId: string, policy: AssignmentApprovalPolicy, definition: AssignmentDefinition, reason: string, requestId: string, c: WorkApprovalContext | null) => {
            if (c?.mode !== 'assignment' || !text(employeeId) || !text(projectId) || !uuid(requestId) || policy.definition.creationRequired !== true || !validAssignmentDefinition(definition) || !text(reason.trim(), 1000)) return fail();
            const r = await call('POST', '/creations', c, { employeeId, projectId, expectedPolicyId: policy.id, definition, reason: reason.trim(), requestId });
            const i = decodeAssignmentCreationInstance(r.instance);
            if (typeof r.replayed !== 'boolean' || i.employeeId !== employeeId || i.projectId !== projectId || i.policy.id !== policy.id || i.requestId !== requestId || i.requesterUserId !== r.actorUserId || i.reason !== reason.trim() || canon(i.proposed) !== canon(definition)) return fail();
            return { instance: i, actorUserId: r.actorUserId as string, ownerKey: r.ownerKey as string, replayed: r.replayed };
        },
        creation: async (id: string, c: WorkApprovalContext | null): Promise<AssignmentCreationPage> => {
            if (!uuid(id)) return fail();
            const r = await call('GET', '/creation-instances/' + id, c);
            return { instance: decodeAssignmentCreationInstance(r.instance, id), actorUserId: r.actorUserId as string, ownerKey: r.ownerKey as string };
        },
        creations: async (c: WorkApprovalContext | null, after: string | null = null) => {
            if (after !== null && !uuid(after)) return fail();
            const r = await call('GET', '/creation-instances' + (after ? '?after=' + after : ''), c);
            if (!Array.isArray(r.instances) || r.instances.length > 20) return fail();
            let previous = after ?? '';
            const instances = r.instances.map(v => { const i = decodeAssignmentCreationInstance(v); if (i.id <= previous) return fail(); previous = i.id; return i; });
            if (r.nextAfter !== null && (instances.length !== 20 || r.nextAfter !== previous)) return fail();
            return { instances, nextAfter: r.nextAfter as string | null };
        },
        decide: async (p: AssignmentApprovalPage | AssignmentCreationPage, decision: 'Approved' | 'Rejected', reason: string, requestId: string, c: WorkApprovalContext | null) => {
            const i = p.instance;
            if (c?.mode !== 'assignment-decide' || i.state.status !== 'Pending' || !uuid(requestId) || !['Approved', 'Rejected'].includes(decision) || !text(reason.trim(), 1000))
                return fail();
            const r = await call('POST', '/instances/' + i.id + '/decisions', c, { expectedSourceToken: i.sourceToken, expectedSequence: i.state.sequence, decision, reason: reason.trim(), requestId }), t = receipt(r.receipt, i.id);
            if (typeof r.replayed !== 'boolean' || r.ownerKey !== p.ownerKey || r.actorUserId !== p.actorUserId || t.actorId !== p.actorUserId || t.activeRole !== c.activeRole || t.requestId !== requestId || t.decision !== decision || t.reason !== reason.trim() || t.stage !== i.state.currentStage || t.sequence !== i.state.sequence + 1 || r.sourceToken !== i.sourceToken || canon(t.outcome) !== canon(approvalState(i.policy.definition.stages, [...i.transitions, t])))
                return fail();
            return { receipt: t, replayed: r.replayed };
        }
    };
};
