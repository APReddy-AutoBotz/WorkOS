import { PERIOD_NOTICE_KEYS, validPeriodNoticeDefinition, periodNoticePhase, periodNoticeIdentity } from '../../shared/work-period-notices.mjs';
import { approvalUuid, approvalHash, approvalKeys, approvalText } from '../../shared/work-approval.mjs';
import { validCapabilityDate, compareCapabilityIds } from '../../shared/workforce-capabilities.mjs';
import { ApiClientError } from './apiClient';
import type { WorkApprovalContext } from './workApprovals';
export type PeriodNoticeDefinition = {
    workerIds: string[];
    reminderMinutesBeforeDeadline: number;
    overdueBoundary: 'deadline' | 'grace-end';
    escalationOwner: {
        userId: string;
        role: string;
    };
    locale: string;
    templates: Array<{
        key: string;
        subject: string;
        body: string;
    }>;
};
export type PeriodNoticePolicy = {
    id: string;
    sequence: number;
    effectiveFrom: string;
    definition: PeriodNoticeDefinition;
    actorId: string;
    activeRole: string;
    reason: string;
    createdAt: string;
};
export type NoticePeriod = {
    id: string;
    code: string;
    starts_on: string;
    ends_on: string;
    status: string;
    frequency: 'Weekly';
};
export type PeriodNoticePreview = {
    organizationId: string;
    legalEntityId: string;
    worker: {
        id: string;
        code: string;
        name: string;
        status: string;
        joining_date: string | null;
        exit_date: string | null;
    };
    period: NoticePeriod;
    policy: PeriodNoticePolicy | null;
    capturePolicyId: string | null;
    deadlineAt: string | null;
    graceEndsAt: string | null;
    state: 'unconfigured' | 'not_due' | 'due' | 'overdue' | 'accepted' | 'unavailable';
    unavailableReason: string | null;
    eventKey: string | null;
    reminderAt: string | null;
    overdueAt: string | null;
    existingEvent: string | null;
    sourceVersion: string;
    sourceToken: string;
    checkedAt: string;
    sourceSummary: Array<{
        id: string;
        status: string;
        submissionId: string | null;
        pendingApproval: boolean;
    }>;
    recipientReasons: Array<{
        userId: string;
        reasons: string[];
    }>;
};
export type PeriodNoticeReceipt = {
    id: string;
    sequence: number;
    employeeId: string;
    periodId: string;
    policyId: string | null;
    requestId: string;
    actorId: string;
    activeRole: string;
    reason: string;
    operationId: string;
    correlationId: string;
    sourceToken: string;
    sourceVersion: string;
    outcome: {
        state: string;
        disposition: 'Emitted' | 'Existing' | 'NoEvent';
        eventKey: string | null;
        eventId: string | null;
        checkedAt: string;
        sourceToken: string;
        sourceVersion: string;
    };
    createdAt: string;
};
export type PeriodNotice = {
    kind: 'work-period';
    id: string;
    eventId: string;
    runId: string;
    employeeId: string;
    periodId: string;
    policyId: string;
    sourceVersion: string;
    eventKey: string;
    policyClass: 'ACTION_REQUIRED' | 'CONTROL_MANDATORY';
    templateId: string;
    operationId: string;
    correlationId: string;
    locale: string;
    title: string;
    body: string;
    reasons: string[];
    channelDecision: 'Required';
    deliveryId: string;
    deliveryStatus: 'Delivered';
    createdAt: string;
    readAt: string | null;
};
const fail = (): never => { throw new ApiClientError('Deadline notice acknowledgement is unavailable. Read current source/history before retrying.', { status: 503 }); }, obj = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v)), text = (v: unknown, max = 200): v is string => approvalText(v, max), uuid = (v: unknown): v is string => approvalUuid(v), hash = (v: unknown): v is string => approvalHash(v), instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && /(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)), integer = (v: unknown, min = 0) => Number.isInteger(v) && Number(v) >= min && Number(v) <= 2147483647, keys = (v: unknown, k: string[]) => approvalKeys(v, k), nullable = (v: unknown) => v === null || text(v), canon = (x: unknown) => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const period = (v: unknown): v is NoticePeriod => obj(v) && keys(v, ['id', 'code', 'starts_on', 'ends_on', 'status', 'frequency']) && text(v.id) && text(v.code) && validCapabilityDate(v.starts_on) && validCapabilityDate(v.ends_on) && String(v.starts_on) <= String(v.ends_on) && text(v.status) && v.frequency === 'Weekly';
export const decodePeriodNoticePolicy = (v: unknown): PeriodNoticePolicy => { if (!obj(v) || !keys(v, ['id', 'sequence', 'effectiveFrom', 'definition', 'actorId', 'activeRole', 'reason', 'createdAt']) || !uuid(v.id) || !integer(v.sequence, 1) || !validCapabilityDate(v.effectiveFrom) || !validPeriodNoticeDefinition(v.definition) || !uuid(v.actorId) || !text(v.activeRole, 100) || !text(v.reason, 1000) || !instant(v.createdAt))
    return fail(); return v as PeriodNoticePolicy; };
export const decodePeriodNotice = (v: unknown): PeriodNotice => { if (!obj(v) || !keys(v, ['kind', 'id', 'eventId', 'runId', 'employeeId', 'periodId', 'policyId', 'sourceVersion', 'eventKey', 'policyClass', 'templateId', 'operationId', 'correlationId', 'locale', 'title', 'body', 'reasons', 'channelDecision', 'deliveryId', 'deliveryStatus', 'createdAt', 'readAt']) || v.kind !== 'work-period' || !uuid(v.id) || !uuid(v.runId) || !text(v.employeeId) || !text(v.periodId) || !uuid(v.policyId) || !hash(v.sourceVersion) || !PERIOD_NOTICE_KEYS.includes(v.eventKey as string) || !uuid(v.templateId) || !text(v.operationId) || !text(v.correlationId) || v.eventId !== periodNoticeIdentity(v.sourceVersion, v.eventKey, v.operationId) || v.policyClass !== (v.eventKey === PERIOD_NOTICE_KEYS[0] ? 'ACTION_REQUIRED' : 'CONTROL_MANDATORY') || !text(v.locale, 100) || !text(v.title, 1200) || !text(v.body, 12000) || !Array.isArray(v.reasons) || v.reasons.length < 1 || v.reasons.length > 2 || v.reasons.some(r => !['affected_worker', 'configured_escalation_owner'].includes(r)) || v.reasons.join(',') !== [...new Set(v.reasons)].sort().join(',') || v.eventKey === PERIOD_NOTICE_KEYS[0] && v.reasons.join(',') !== 'affected_worker' || v.channelDecision !== 'Required' || !uuid(v.deliveryId) || v.deliveryStatus !== 'Delivered' || !instant(v.createdAt) || v.readAt !== null && !instant(v.readAt))
    return fail(); return v as PeriodNotice; };
export const decodePeriodPreview = (v: unknown, employeeId: string, periodId: string, scope: {
    organizationId: string;
    legalEntityId: string;
}): PeriodNoticePreview => {
    if (!obj(v) || !keys(v, ['organizationId', 'legalEntityId', 'worker', 'period', 'policy', 'capturePolicyId', 'deadlineAt', 'graceEndsAt', 'state', 'unavailableReason', 'eventKey', 'reminderAt', 'overdueAt', 'existingEvent', 'sourceVersion', 'sourceToken', 'checkedAt', 'sourceSummary', 'recipientReasons']) || v.organizationId !== scope.organizationId || v.legalEntityId !== scope.legalEntityId || !obj(v.worker) || !keys(v.worker, ['id', 'code', 'name', 'status', 'joining_date', 'exit_date']) || v.worker.id !== employeeId || !text(v.worker.code) || !text(v.worker.name, 2000) || !text(v.worker.status) || [v.worker.joining_date, v.worker.exit_date].some(d => d !== null && !validCapabilityDate(d)) || !period(v.period) || v.period.id !== periodId || !nullable(v.capturePolicyId) || [v.deadlineAt, v.graceEndsAt, v.reminderAt, v.overdueAt].some(d => d !== null && !instant(d)) || !['unconfigured', 'not_due', 'due', 'overdue', 'accepted', 'unavailable'].includes(String(v.state)) || !nullable(v.unavailableReason) || v.state === 'unavailable' && !text(v.unavailableReason, 2000) || v.eventKey !== null && !PERIOD_NOTICE_KEYS.includes(v.eventKey as string) || !nullable(v.existingEvent) || !hash(v.sourceVersion) || !hash(v.sourceToken) || !instant(v.checkedAt) || !Array.isArray(v.sourceSummary) || !Array.isArray(v.recipientReasons))
        return fail();
    const p = v as unknown as PeriodNoticePreview;
    if (p.policy !== null)
        decodePeriodNoticePolicy(p.policy);
    for (const h of p.sourceSummary)
        if (!keys(h, ['id', 'status', 'submissionId', 'pendingApproval']) || !uuid(h.id) || !['Draft', 'Submitted', 'Approved', 'Rejected'].includes(h.status) || !nullable(h.submissionId) || typeof h.pendingApproval !== 'boolean')
            return fail();
    let previous = '';
    for (const r of p.recipientReasons) {
        if (!keys(r, ['userId', 'reasons']) || !uuid(r.userId) || r.userId <= previous || !Array.isArray(r.reasons) || r.reasons.length < 1 || r.reasons.some(x => !['affected_worker', 'configured_escalation_owner'].includes(x)) || r.reasons.join(',') !== [...new Set(r.reasons)].sort().join(','))
            return fail();
        previous = r.userId;
    }
    if (p.state === 'accepted' && !p.sourceSummary.some(h => ['Submitted', 'Approved'].includes(h.status) && h.submissionId))
        return fail();
    if (['due', 'overdue', 'not_due'].includes(p.state)) {
        if (!p.policy || !p.deadlineAt || !p.graceEndsAt || !p.capturePolicyId)
            return fail();
        const phase = periodNoticePhase({ deadlineAt: p.deadlineAt, graceEndsAt: p.graceEndsAt }, p.policy.definition, p.period.starts_on, p.checkedAt);
        if (phase.state !== p.state || phase.eventKey !== p.eventKey || phase.reminderAt !== p.reminderAt || phase.overdueAt !== p.overdueAt)
            return fail();
        if (p.eventKey && (p.recipientReasons.length < 1 || p.eventKey === PERIOD_NOTICE_KEYS[0] && p.recipientReasons.some(r => r.reasons.join(',') !== 'affected_worker') || !p.recipientReasons.some(r => r.reasons.includes('affected_worker')) || p.eventKey === PERIOD_NOTICE_KEYS[1] && !p.recipientReasons.some(r => r.reasons.includes('configured_escalation_owner'))))
            return fail();
    }
    else if (p.eventKey !== null)
        return fail();
    return p;
};
export const decodePeriodNoticeReceipt = (v: unknown): PeriodNoticeReceipt => { if (!obj(v) || !keys(v, ['id', 'sequence', 'employeeId', 'periodId', 'policyId', 'requestId', 'actorId', 'activeRole', 'reason', 'operationId', 'correlationId', 'sourceToken', 'sourceVersion', 'outcome', 'createdAt']) || !uuid(v.id) || !integer(v.sequence, 1) || !text(v.employeeId) || !text(v.periodId) || v.policyId !== null && !uuid(v.policyId) || !uuid(v.requestId) || !uuid(v.actorId) || !text(v.activeRole, 100) || !text(v.reason, 1000) || !text(v.operationId) || !text(v.correlationId) || !hash(v.sourceToken) || !hash(v.sourceVersion) || !instant(v.createdAt) || !obj(v.outcome) || !keys(v.outcome, ['state', 'disposition', 'eventKey', 'eventId', 'checkedAt', 'sourceToken', 'sourceVersion']) || !['unconfigured', 'not_due', 'due', 'overdue', 'accepted'].includes(String(v.outcome.state)) || !['Emitted', 'Existing', 'NoEvent'].includes(String(v.outcome.disposition)) || !instant(v.outcome.checkedAt) || v.outcome.sourceToken !== v.sourceToken || v.outcome.sourceVersion !== v.sourceVersion)
    return fail(); const o = v.outcome; if (o.disposition === 'NoEvent') {
    if (o.eventId !== null || o.eventKey !== null || ['due', 'overdue'].includes(String(o.state)))
        return fail();
}
else if (!PERIOD_NOTICE_KEYS.includes(o.eventKey as string) || !text(o.eventId, 1000) || !['due', 'overdue'].includes(String(o.state)) || o.eventKey !== 'work_period.submission_' + o.state || !String(o.eventId).startsWith('work-period/' + v.sourceVersion + '/' + o.eventKey + '/') || o.disposition === 'Emitted' && o.eventId !== periodNoticeIdentity(v.sourceVersion, o.eventKey, v.operationId))
    return fail(); return v as unknown as PeriodNoticeReceipt; };
type Transport = (method: 'GET' | 'POST', path: string, c: WorkApprovalContext | null, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export const createPeriodNoticeClient = (request: Transport) => {
    const context = (c: WorkApprovalContext | null) => { if (!c || c.mode !== 'configure')
        throw new ApiClientError('Current notification governance access is required.', { status: 403 }); return c; };
    const path = '/deadlines';
    return {
        choices: async (after: {
            afterWorker?: string;
            afterUser?: string;
            afterPeriod?: string;
        }, c: WorkApprovalContext | null) => { const ctx = context(c), r = await request('GET', path + '/choices?' + new URLSearchParams(after), ctx); if (!Array.isArray(r.workers) || r.workers.length > 200 || !Array.isArray(r.users) || r.users.length > 200 || !Array.isArray(r.periods) || r.periods.length > 200 || !validCapabilityDate(r.today))
            return fail(); let w = after.afterWorker ?? '', u = after.afterUser ?? '', p = after.afterPeriod ?? ''; for (const x of r.workers) {
            if (!keys(x, ['id', 'code', 'name', 'status']) || !text(x.id) || !text(x.code) || !text(x.name, 2000) || !text(x.status) || compareCapabilityIds(x.id, w) <= 0)
                return fail();
            w = x.id;
        } for (const x of r.users) {
            if (!keys(x, ['id', 'username', 'roles']) || !uuid(x.id) || !text(x.username) || !Array.isArray(x.roles) || x.roles.some(k => !text(k, 100)) || x.roles.join(',') !== [...new Set(x.roles)].sort().join(',') || x.id <= u)
                return fail();
            u = x.id;
        } for (const x of r.periods) {
            if (!period(x) || compareCapabilityIds(x.id, p) <= 0)
                return fail();
            p = x.id;
        } if (r.nextWorker !== null && (r.workers.length !== 200 || r.nextWorker !== w) || r.nextUser !== null && (r.users.length !== 200 || r.nextUser !== u) || r.nextPeriod !== null && (r.periods.length !== 200 || r.nextPeriod !== p))
            return fail(); return r as unknown as {
            workers: Array<{
                id: string;
                code: string;
                name: string;
                status: string;
            }>;
            users: Array<{
                id: string;
                username: string;
                roles: string[];
            }>;
            periods: NoticePeriod[];
            today: string;
            nextWorker: string | null;
            nextUser: string | null;
            nextPeriod: string | null;
        }; },
        policies: async (before: number | null, c: WorkApprovalContext | null) => { const ctx = context(c), r = await request('GET', path + '/policies' + (before ? '?before=' + before : ''), ctx); if (!Array.isArray(r.policies) || r.policies.length > 10)
            return fail(); let seq = before ?? 2147483648; const rows = r.policies.map(v => { const p = decodePeriodNoticePolicy(v); if (p.sequence >= seq)
            return fail(); seq = p.sequence; return p; }); if (r.nextBefore !== null && (rows.length !== 10 || r.nextBefore !== seq))
            return fail(); return { policies: rows, nextBefore: r.nextBefore as number | null }; },
        adopt: async (expectedLatestId: string | null, effectiveFrom: string, definition: PeriodNoticeDefinition, reason: string, c: WorkApprovalContext | null) => { const ctx = context(c); if (expectedLatestId !== null && !uuid(expectedLatestId) || !validCapabilityDate(effectiveFrom) || !validPeriodNoticeDefinition(definition) || !text(reason.trim(), 1000))
            return fail(); const r = await request('POST', path + '/policies', ctx, { expectedLatestId, effectiveFrom, definition, reason }), p = decodePeriodNoticePolicy(r.policy); if (p.actorId !== r.actorUserId || p.activeRole !== ctx.activeRole || p.effectiveFrom !== effectiveFrom || p.reason !== reason.trim() || canon(p.definition) !== canon(definition))
            return fail(); return p; },
        preview: async (employeeId: string, periodId: string, c: WorkApprovalContext | null) => { const ctx = context(c); if (!text(employeeId) || !text(periodId))
            return fail(); const r = await request('GET', path + '/preview?' + new URLSearchParams({ employeeId, periodId }), ctx); return decodePeriodPreview(r.preview, employeeId, periodId, ctx.scope); },
        evaluate: async (v: PeriodNoticePreview, requestId: string, reason: string, c: WorkApprovalContext | null) => { const ctx = context(c); if (v.state === 'unavailable' || !uuid(requestId) || !text(reason.trim(), 1000))
            return fail(); const r = await request('POST', path + '/evaluate', ctx, { employeeId: v.worker.id, periodId: v.period.id, expectedSourceToken: v.sourceToken, expectedEventKey: v.eventKey, requestId, reason }), receipt = decodePeriodNoticeReceipt(r.receipt); if (typeof r.replayed !== 'boolean' || receipt.actorId !== r.actorUserId || receipt.activeRole !== ctx.activeRole || receipt.requestId !== requestId || receipt.employeeId !== v.worker.id || receipt.periodId !== v.period.id || receipt.policyId !== (v.policy?.id ?? null) || receipt.sourceToken !== v.sourceToken || receipt.sourceVersion !== v.sourceVersion || receipt.reason !== reason.trim() || receipt.outcome.eventKey !== v.eventKey || receipt.outcome.state !== v.state || receipt.outcome.disposition === 'Existing' && receipt.outcome.eventId !== v.existingEvent)
            return fail(); return { receipt, replayed: r.replayed as boolean }; },
        history: async (employeeId: string, periodId: string, before: number | null, c: WorkApprovalContext | null) => { const ctx = context(c); if (!text(employeeId) || !text(periodId) || before !== null && !integer(before, 1))
            return fail(); const r = await request('GET', path + '/history?' + new URLSearchParams({ employeeId, periodId, ...before ? { before: String(before) } : {} }), ctx); if (r.employeeId !== employeeId || r.periodId !== periodId || !Array.isArray(r.receipts) || r.receipts.length > 10)
            return fail(); let seq = before ?? 2147483648; const rows = r.receipts.map(v => { const p = decodePeriodNoticeReceipt(v); if (p.employeeId !== employeeId || p.periodId !== periodId || p.sequence >= seq)
            return fail(); seq = p.sequence; return p; }); if (r.nextBefore !== null && (rows.length !== 10 || r.nextBefore !== seq))
            return fail(); return { receipts: rows, nextBefore: r.nextBefore as number | null }; }
    };
};
