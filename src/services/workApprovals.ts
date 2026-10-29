import {createApprovalReminderClient,decodeReminderNotice,type ReminderNotice} from './approvalReminders';
import {createCanonicalDelegationClient,validInstanceDelegations,validStageReceipt,type DelegationBinding} from './canonicalDelegations';
import {createLeaveApprovalClient,decodeLeaveNotice,type LeaveApprovalNotice} from './leaveApprovals';
import { createApprovalDueClient, decodeDueNotice, type DueNotice } from './approvalDue';
import {createAssignmentApprovalClient,decodeAssignmentApprovalNotice,type AssignmentApprovalNotice} from './assignmentApprovals';
import {createPeriodNoticeClient,decodePeriodNotice,type PeriodNotice} from './workPeriodNotices';
import { WORK_APPROVAL_VERSION, APPROVAL_EVENT_KEYS, approvalKeys, approvalUuid, approvalHash, approvalText, approvalState, approvalEventIdentity, validWorkApprovalPolicy } from '../../shared/work-approval.mjs';
import { canonicalHours, sumHours } from '../../shared/work-hours.mjs';
import { evidenceUrlIsValid } from '../../shared/work-evidence.mjs';
import { validCapabilityDate, compareCapabilityIds } from '../../shared/workforce-capabilities.mjs';
import { api, ApiClientError, getOrganizationScope, getToken, type ApiRequestContext } from './apiClient';
import { authService } from './authService';
import { getEffectivePermissions } from './permissions';
export type WorkStage = {
    userId: string;
    role: string;
};
export type WorkApprovalDefinition = {
    entityType: 'Timesheet';
    workerIds: string[];
    stages: WorkStage[];
    locale: string;
    completionInApp: boolean;
    templates: Array<{
        key: string;
        subject: string;
        body: string;
    }>;
};
export type WorkPolicy = {
    id: string;
    sequence: number;
    effectiveFrom: string;
    definition: WorkApprovalDefinition;
    actorId: string;
    activeRole: string;
    reason: string;
    createdAt: string;
};
export type WorkStageState = {
    status: 'Pending' | 'Approved' | 'Rejected';
    sequence: number;
    currentStage: number | null;
};
export type WorkDecisionReceipt = {
    delegationBindingId?: string;
    id: string;
    instanceId: string;
    sequence: number;
    stage: number;
    decision: 'Approved' | 'Rejected';
    actorId: string;
    activeRole: string;
    requestId: string;
    operationId: string;
    reason: string;
    outcome: WorkStageState;
    createdAt: string;
};
export type WorkApprovalSource = {
    weekEnding: string;
    totalHoursExact: string;
    billableHoursExact: string;
    currentHeaderStatus: string;
    isCurrentSubmission: boolean;
    entries: Array<{
        id: string;
        date: string;
        workType: string;
        projectId: string | null;
        clientName: string | null;
        category: string | null;
        categoryCode: string | null;
        hoursExact: string;
        billable: boolean;
        remark: string | null;
        evidenceUrl: string | null;
        workReference: string | null;
    }>;
};
export type WorkApprovalInstance = {
    delegations?: DelegationBinding[];
    id: string;
    timesheetId: string;
    submissionId: string;
    submissionSequence: number;
    sourceToken: string;
    requesterUserId: string;
    worker: {
        id: string;
        code: string;
        name: string;
    };
    createdAt: string;
    policy: {
        id: string;
        sequence: number;
        effectiveFrom: string;
        stages: WorkStage[];
    };
    state: WorkStageState;
    transitions: WorkDecisionReceipt[];
    notificationFailures: Array<{
        sequence: number;
        code: 'INFORMATIONAL_NOTIFICATION_UNAVAILABLE';
        createdAt: string;
    }>;
    source: WorkApprovalSource | null;
};
export type WorkApprovalPage = {
    instance: WorkApprovalInstance;
    actorUserId: string;
    ownerKey: string;
};
export type WorkApprovalNotification = {
    id: string;
    eventId: string;
    instanceId: string;
    timesheetId: string;
    submissionId: string;
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
    createdAt: string;
    readAt: string | null;
};
export type CommercialCandidateNotice={kind:'commercial-candidate-approval';id:string;eventId:string;instanceId:string;candidateId:string;transitionSequence:number;eventKey:string;policyClass:'ACTION_REQUIRED'|'INFORMATIONAL';templateId:string;operationId:string;locale:string;title:string;body:string;reasons:string[];channelDecision:'Required'|'Enabled';deliveryId:string;deliveryStatus:'Delivered';createdAt:string;readAt:string|null};
export type TmBillingNotice=Omit<CommercialCandidateNotice,'kind'|'candidateId'>&{kind:'tm-billing-eligibility';snapshotId:string};
export type MilestoneBillingNotice=Omit<CommercialCandidateNotice,'kind'|'candidateId'>&{kind:'milestone-billing-eligibility';milestoneId:string};
export type InvoiceBatchNotice=Omit<CommercialCandidateNotice,'kind'|'candidateId'>&{kind:'invoice-batch-approval';batchId:string};
export type InvoiceExportNotice=Omit<CommercialCandidateNotice,'kind'|'candidateId'|'instanceId'|'transitionSequence'|'policyClass'>&{kind:'invoice-export';batchId:string;policyClass:'INFORMATIONAL'|'OPERATIONAL_CRITICAL'};
export type CanonicalWorkNotice=WorkApprovalNotification|PeriodNotice|AssignmentApprovalNotice|DueNotice|LeaveApprovalNotice|ReminderNotice|CommercialCandidateNotice|TmBillingNotice|MilestoneBillingNotice|InvoiceBatchNotice|InvoiceExportNotice;
export type WorkApprovalContext = ApiRequestContext & {
    mode: 'read' | 'configure' | 'decide' | 'inbox' | 'assignment' | 'assignment-decide' | 'leave' | 'leave-decide' | 'delegation';
    identityKey: string;
    username: string;
    accountIdentity: string;
    activeRole: string;
    actorId?: string;
    isCurrent: () => boolean;
};
const roles = ['settings.manage', 'permissions.manage', 'notifications.manage', 'approvals.view', 'employees.view'];
const identity = () => { const u = authService.getCurrentUser(); return u && JSON.stringify([u.id, u.employeeId, u.userName, u.role, u.permissionRole, u.cdId, [...getEffectivePermissions(u)].sort()]); };
export const captureWorkApprovalContext = (mode: WorkApprovalContext['mode'] = 'read', isCurrent = () => true): WorkApprovalContext | null => { const u = authService.getCurrentUser(), scope = getOrganizationScope(), p = getEffectivePermissions(u); if (!u?.id || !u.userName || !scope?.organizationId || !scope.legalEntityId || !p.includes('employees.view') || mode === 'configure' && !roles.every(k => p.includes(k)) || mode === 'decide' && !['timesheets.approve', 'timesheets.submit', 'projects.view', 'approvals.view', 'notifications.view'].every(k => p.includes(k)) || mode === 'assignment' && !['allocations.manage','allocations.view','projects.view'].every(k=>p.includes(k)) || mode === 'assignment-decide' && !['allocations.manage','allocations.view','projects.view','approvals.view','notifications.view'].every(k=>p.includes(k)) || mode === 'leave' && !p.includes('leave.self_service') || mode === 'leave-decide' && !['leave.self_service','leave.approve','approvals.view','notifications.view'].every(k=>p.includes(k)) || mode === 'read' && !p.includes('timesheets.submit') || mode === 'delegation' && !['approvals.view','notifications.view'].every(k=>p.includes(k)) || mode === 'inbox' && !p.includes('notifications.view'))
    return null; return { mode, scope: { ...scope }, token: getToken(), identityKey: identity()!, username: u.userName, accountIdentity: u.id, activeRole: u.role, isCurrent }; };
export const isWorkApprovalContextCurrent = (c: WorkApprovalContext) => { const n = captureWorkApprovalContext(c.mode); return Boolean(c.isCurrent() && n && n.identityKey === c.identityKey && n.token === c.token && n.scope.organizationId === c.scope.organizationId && n.scope.legalEntityId === c.scope.legalEntityId); };
const owner = (c: WorkApprovalContext | null) => { if (!c || !isWorkApprovalContextCurrent(c))
    throw new ApiClientError('Work approval account, active role or scope changed. Reload explicitly.', { status: 403 }); return c; };
const invalid = (): never => { throw new ApiClientError('Work approval acknowledgement could not be confirmed. Read current history before retrying.', { status: 503 }); };
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v)), keys = (v: unknown, k: string[]) => approvalKeys(v, k), text = (v: unknown, max = 200) => approvalText(v, max), uuid = (v: unknown): v is string => approvalUuid(v), hash = (v: unknown): v is string => approvalHash(v), integer = (v: unknown, min = 0, max = 2147483647) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max, instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(v) && !Number.isNaN(Date.parse(v));
const digest = async (v: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))).map(n => n.toString(16).padStart(2, '0')).join('');
const ownerKey = (c: WorkApprovalContext) => digest(JSON.stringify([c.username, c.accountIdentity, c.activeRole, c.scope.organizationId, c.scope.legalEntityId]));
const stages = (v: unknown): v is WorkStage[] => Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every(s => keys(s, ['userId', 'role']) && uuid(s.userId) && text(s.role, 100));
const state = (v: unknown): v is WorkStageState => object(v) && keys(v, ['status', 'sequence', 'currentStage']) && ['Pending', 'Approved', 'Rejected'].includes(String(v.status)) && integer(v.sequence, 0, 10) && (v.currentStage === null || integer(v.currentStage, 0, 9));
const sameState = (a: {
    status: string;
    sequence: number;
    currentStage: number | null;
}, b: {
    status: string;
    sequence: number;
    currentStage: number | null;
}) => a.status === b.status && a.sequence === b.sequence && a.currentStage === b.currentStage;
export const decodeWorkDecision = (v: unknown, instance?: string): WorkDecisionReceipt => { if (!object(v) || !keys(v, ['id', 'instanceId', 'sequence', 'stage', 'decision', 'actorId', 'activeRole', 'requestId', 'operationId', 'reason', 'outcome', 'createdAt',...('delegationBindingId' in v?['delegationBindingId']:[])]) || 'delegationBindingId' in v&&!uuid(v.delegationBindingId) || !uuid(v.id) || !uuid(v.instanceId) || instance !== undefined && v.instanceId !== instance || !integer(v.sequence, 1, 10) || !integer(v.stage, 0, 9) || !['Approved', 'Rejected'].includes(String(v.decision)) || !uuid(v.actorId) || !text(v.activeRole, 100) || !uuid(v.requestId) || !text(v.operationId) || !text(v.reason, 1000) || !state(v.outcome) || v.outcome.sequence !== v.sequence || !instant(v.createdAt))
    return invalid(); return v as WorkDecisionReceipt; };
export const decodeWorkApprovalInstance = (v: unknown, id?: string): WorkApprovalInstance => {
    if (!object(v) || !keys(v, ['id', 'timesheetId', 'submissionId', 'submissionSequence', 'sourceToken', 'requesterUserId', 'worker', 'createdAt', 'policy', 'state', 'transitions', 'notificationFailures', 'source',...('delegations' in v?['delegations']:[])]) || !uuid(v.id) || id !== undefined && v.id !== id || !uuid(v.timesheetId) || !text(v.submissionId) || !integer(v.submissionSequence, 1) || !hash(v.sourceToken) || !uuid(v.requesterUserId) || !object(v.worker) || !keys(v.worker, ['id', 'code', 'name']) || !text(v.worker.id) || !text(v.worker.code) || !text(v.worker.name, 2000) || !instant(v.createdAt) || !object(v.policy) || !keys(v.policy, ['id', 'sequence', 'effectiveFrom', 'stages']) || !uuid(v.policy.id) || !integer(v.policy.sequence, 1) || !validCapabilityDate(v.policy.effectiveFrom) || !stages(v.policy.stages) || !Array.isArray(v.transitions) || v.transitions.length > 10 || !state(v.state) || !Array.isArray(v.notificationFailures) || v.notificationFailures.length > 10)
        return invalid();
    const quantity = (q: unknown) => { try {
        return typeof q === 'string' && q.length <= 200 && canonicalHours(q) === q;
    }
    catch {
        return false;
    } };
    if (v.source !== null) {
        const s = v.source;
        if (!object(s) || !keys(s, ['weekEnding', 'totalHoursExact', 'billableHoursExact', 'currentHeaderStatus', 'isCurrentSubmission', 'entries']) || !validCapabilityDate(s.weekEnding) || !quantity(s.totalHoursExact) || !quantity(s.billableHoursExact) || !['Draft', 'Submitted', 'Approved', 'Rejected'].includes(String(s.currentHeaderStatus)) || typeof s.isCurrentSubmission !== 'boolean' || !Array.isArray(s.entries) || s.entries.length < 1 || s.entries.length > 100)
            return invalid();
        for (const e of s.entries) {
            if (!keys(e, ['id', 'date', 'workType', 'projectId', 'clientName', 'category', 'categoryCode', 'hoursExact', 'billable', 'remark', 'evidenceUrl', 'workReference']) || !uuid(e.id) || !validCapabilityDate(e.date) || !text(e.workType) || !quantity(e.hoursExact) || typeof e.billable !== 'boolean' || ['projectId', 'clientName', 'category', 'categoryCode', 'remark', 'workReference'].some(k => e[k] !== null && !text(e[k], 10000)) || !evidenceUrlIsValid(e.evidenceUrl))
                return invalid();
        }
        if (new Set(s.entries.map(e => e.id)).size !== s.entries.length || sumHours(s.entries.map(e => e.hoursExact)) !== s.totalHoursExact || sumHours(s.entries.filter(e => e.billable).map(e => e.hoursExact)) !== s.billableHoursExact)
            return invalid();
    }
    if(!validInstanceDelegations(v,v.policy.stages as WorkStage[]))return invalid();
    const row = v as unknown as WorkApprovalInstance, receipts = row.transitions.map(t => decodeWorkDecision(t, row.id));
    try {
        const actual = approvalState(row.policy.stages, receipts);
        if (!sameState(actual, row.state))
            return invalid();
        for (const [t, i] of receipts.map((t, i) => [t, i] as const)) {
            if (!validStageReceipt(row.policy.stages,row.delegations,t) || t.actorId === row.requesterUserId || !sameState(t.outcome, approvalState(row.policy.stages, receipts.slice(0, i + 1))))
                return invalid();
        }
    }
    catch {
        return invalid();
    }
    if (new Set(receipts.map(t => t.requestId)).size !== receipts.length || new Set(row.notificationFailures.map(f => f.sequence)).size !== row.notificationFailures.length || row.notificationFailures.some(f => !keys(f, ['sequence', 'code', 'createdAt']) || f.code !== 'INFORMATIONAL_NOTIFICATION_UNAVAILABLE' || !instant(f.createdAt) || !receipts.some(t => t.sequence === f.sequence && t.outcome.status === 'Approved')))
        return invalid();
    return row;
};
const policy = (v: unknown): WorkPolicy => { if (!object(v) || !keys(v, ['id', 'sequence', 'effectiveFrom', 'definition', 'actorId', 'activeRole', 'reason', 'createdAt']) || !uuid(v.id) || !integer(v.sequence, 1) || !validCapabilityDate(v.effectiveFrom) || !validWorkApprovalPolicy(v.definition) || !uuid(v.actorId) || !text(v.activeRole) || !text(v.reason, 1000) || !instant(v.createdAt))
    return invalid(); return v as WorkPolicy; };
const commercialNotice=(v:unknown):CommercialCandidateNotice=>{if(!object(v)||!keys(v,['kind','id','eventId','instanceId','candidateId','transitionSequence','eventKey','policyClass','templateId','operationId','locale','title','body','reasons','channelDecision','deliveryId','deliveryStatus','createdAt','readAt'])||v.kind!=='commercial-candidate-approval'||!uuid(v.id)||!uuid(v.instanceId)||!uuid(v.candidateId)||!integer(v.transitionSequence,0,10)||!APPROVAL_EVENT_KEYS.includes(v.eventKey as string)||!uuid(v.templateId)||!text(v.operationId)||v.eventId!==approvalEventIdentity(v.instanceId,v.transitionSequence,v.eventKey,v.operationId).replace(/^work-approval\//,'commercial-candidate-approval/')||!text(v.locale,100)||!text(v.title,1200)||!text(v.body,12000)||!Array.isArray(v.reasons)||v.reasons.length<1||v.reasons.some(r=>!['requester','commercial_change_owner','affected_worker','current_stage_approver'].includes(r))||v.reasons.join(',')!==[...new Set(v.reasons)].sort().join(',')||!uuid(v.deliveryId)||v.deliveryStatus!=='Delivered'||!instant(v.createdAt)||v.readAt!==null&&!instant(v.readAt)||(v.eventKey==='approval.completed'?v.policyClass!=='INFORMATIONAL'||v.channelDecision!=='Enabled':v.policyClass!=='ACTION_REQUIRED'||v.channelDecision!=='Required'))return invalid();return v as CommercialCandidateNotice;};
const tmBillingNotice=(v:unknown):TmBillingNotice=>{if(!object(v)||!keys(v,['kind','id','eventId','instanceId','snapshotId','transitionSequence','eventKey','policyClass','templateId','operationId','locale','title','body','reasons','channelDecision','deliveryId','deliveryStatus','createdAt','readAt'])||v.kind!=='tm-billing-eligibility'||!uuid(v.id)||!uuid(v.instanceId)||!uuid(v.snapshotId)||!integer(v.transitionSequence,0,10)||!APPROVAL_EVENT_KEYS.includes(v.eventKey as string)||!uuid(v.templateId)||!text(v.operationId)||v.eventId!==approvalEventIdentity(v.instanceId,v.transitionSequence,v.eventKey,v.operationId).replace(/^work-approval\//,'tm-billing-eligibility/')||!text(v.locale,100)||!text(v.title,1200)||!text(v.body,12000)||!Array.isArray(v.reasons)||v.reasons.length<1||v.reasons.some(r=>!['requester','commercial_change_owner','affected_worker','current_stage_approver'].includes(r))||v.reasons.join(',')!==[...new Set(v.reasons)].sort().join(',')||!uuid(v.deliveryId)||v.deliveryStatus!=='Delivered'||!instant(v.createdAt)||v.readAt!==null&&!instant(v.readAt)||(v.eventKey==='approval.completed'?v.policyClass!=='INFORMATIONAL'||v.channelDecision!=='Enabled':v.policyClass!=='ACTION_REQUIRED'||v.channelDecision!=='Required'))return invalid();return v as TmBillingNotice;};
const milestoneBillingNotice=(v:unknown):MilestoneBillingNotice=>{if(!object(v)||!keys(v,['kind','id','eventId','instanceId','milestoneId','transitionSequence','eventKey','policyClass','templateId','operationId','locale','title','body','reasons','channelDecision','deliveryId','deliveryStatus','createdAt','readAt'])||v.kind!=='milestone-billing-eligibility'||!uuid(v.id)||!uuid(v.instanceId)||!text(v.milestoneId)||!integer(v.transitionSequence,0,10)||!APPROVAL_EVENT_KEYS.includes(v.eventKey as string)||!uuid(v.templateId)||!text(v.operationId)||v.eventId!==approvalEventIdentity(v.instanceId,v.transitionSequence,v.eventKey,v.operationId).replace(/^work-approval\//,'milestone-billing-eligibility/')||!text(v.locale,100)||!text(v.title,1200)||!text(v.body,12000)||!Array.isArray(v.reasons)||v.reasons.length<1||v.reasons.some(r=>!['requester','commercial_change_owner','current_stage_approver'].includes(r))||v.reasons.join(',')!==[...new Set(v.reasons)].sort().join(',')||!uuid(v.deliveryId)||v.deliveryStatus!=='Delivered'||!instant(v.createdAt)||v.readAt!==null&&!instant(v.readAt)||(v.eventKey==='approval.completed'?v.policyClass!=='INFORMATIONAL'||v.channelDecision!=='Enabled':v.policyClass!=='ACTION_REQUIRED'||v.channelDecision!=='Required'))return invalid();return v as MilestoneBillingNotice;};
const invoiceBatchNotice=(v:unknown):InvoiceBatchNotice=>{if(!object(v)||!keys(v,['kind','id','eventId','instanceId','batchId','transitionSequence','eventKey','policyClass','templateId','operationId','locale','title','body','reasons','channelDecision','deliveryId','deliveryStatus','createdAt','readAt'])||v.kind!=='invoice-batch-approval'||!uuid(v.id)||!uuid(v.instanceId)||!uuid(v.batchId)||!integer(v.transitionSequence,0,10)||!APPROVAL_EVENT_KEYS.includes(v.eventKey as string)||!uuid(v.templateId)||!text(v.operationId)||v.eventId!==approvalEventIdentity(v.instanceId,v.transitionSequence,v.eventKey,v.operationId).replace(/^work-approval\//,'invoice-batch-approval/')||!text(v.locale,100)||!text(v.title,1200)||!text(v.body,12000)||!Array.isArray(v.reasons)||v.reasons.length<1||v.reasons.some(r=>!['requester','invoice_batch_owner','finance_preparer','affected_worker','current_stage_approver'].includes(r))||v.reasons.join(',')!==[...new Set(v.reasons)].sort().join(',')||!uuid(v.deliveryId)||v.deliveryStatus!=='Delivered'||!instant(v.createdAt)||v.readAt!==null&&!instant(v.readAt)||(v.eventKey==='approval.completed'?v.policyClass!=='INFORMATIONAL'||v.channelDecision!=='Enabled':v.policyClass!=='ACTION_REQUIRED'||v.channelDecision!=='Required'))return invalid();return v as InvoiceBatchNotice;};
const invoiceExportNotice=(v:unknown):InvoiceExportNotice=>{if(!object(v)||!keys(v,['kind','id','eventId','batchId','eventKey','policyClass','templateId','operationId','locale','title','body','reasons','channelDecision','deliveryId','deliveryStatus','createdAt','readAt'])||v.kind!=='invoice-export'||!uuid(v.id)||!uuid(v.eventId)||!uuid(v.batchId)||!uuid(v.templateId)||!text(v.operationId)||!text(v.locale,100)||!text(v.title,1200)||!text(v.body,12000)||!Array.isArray(v.reasons)||v.reasons.length<1||v.reasons.some(r=>!['invoice_batch_owner','finance_billing_owner','integration_administrator'].includes(r))||v.reasons.join(',')!==[...new Set(v.reasons)].sort().join(',')||!uuid(v.deliveryId)||v.deliveryStatus!=='Delivered'||!instant(v.createdAt)||v.readAt!==null&&!instant(v.readAt)||(v.eventKey==='invoice_batch.export_failed'?(v.policyClass!=='OPERATIONAL_CRITICAL'||v.channelDecision!=='Required'):v.eventKey==='invoice_batch.exported_or_billed_confirmed'?(v.policyClass!=='INFORMATIONAL'||v.channelDecision!=='Enabled'):true))return invalid();return v as InvoiceExportNotice;};
const notification = (v: unknown): CanonicalWorkNotice => {
    if(object(v)&&v.kind==='invoice-export')return invoiceExportNotice(v); if(object(v)&&v.kind==='invoice-batch-approval')return invoiceBatchNotice(v); if(object(v)&&v.kind==='tm-billing-eligibility')return tmBillingNotice(v); if(object(v)&&v.kind==='milestone-billing-eligibility')return milestoneBillingNotice(v); if(object(v)&&v.kind==='commercial-candidate-approval')return commercialNotice(v); if(object(v)&&v.kind==='approval-reminder')return decodeReminderNotice(v); if(object(v)&&v.kind==='leave-approval')return decodeLeaveNotice(v); if(object(v)&&v.kind==='approval-overdue')return decodeDueNotice(v); if(object(v)&&(v.kind==='assignment-approval'||v.kind==='assignment-creation-approval'))return decodeAssignmentApprovalNotice(v); if(object(v)&&v.kind==='work-period')return decodePeriodNotice(v); if (!object(v) || !keys(v, ['id', 'eventId', 'instanceId', 'timesheetId', 'submissionId', 'transitionSequence', 'eventKey', 'policyClass', 'templateId', 'operationId', 'locale', 'title', 'body', 'reasons', 'channelDecision', 'createdAt', 'readAt']) || !uuid(v.id) || !uuid(v.instanceId) || !uuid(v.timesheetId) || !text(v.submissionId) || !integer(v.transitionSequence, 0, 10) || !APPROVAL_EVENT_KEYS.includes(v.eventKey as string) || !uuid(v.templateId) || !text(v.operationId) || v.eventId !== approvalEventIdentity(v.instanceId, v.transitionSequence, v.eventKey, v.operationId) || !text(v.locale, 100) || !text(v.title, 1200) || !text(v.body, 12000) || !Array.isArray(v.reasons) || v.reasons.length < 1 || v.reasons.some(r => !['requester', 'affected_worker', 'current_stage_approver'].includes(r)) || v.reasons.join(',') !== [...new Set(v.reasons)].sort().join(',') || !instant(v.createdAt) || v.readAt !== null && !instant(v.readAt) || (v.eventKey === 'approval.completed' ? v.policyClass !== 'INFORMATIONAL' || v.channelDecision !== 'Enabled' : v.policyClass !== 'ACTION_REQUIRED' || v.channelDecision !== 'Required'))
    return invalid(); return v as WorkApprovalNotification; };
const request = async (method: 'GET' | 'POST', tail: string, c: WorkApprovalContext | null, body?: Record<string, unknown>) => { const captured = owner(c), expected = await ownerKey(captured); owner(captured); const raw = await api.requestWithContext<unknown>(method, '/api/v1/work-approvals' + tail, body ? { ...body, expectedOwnerKey: expected } : undefined, captured); owner(captured); if (!object(raw) || raw.contractVersion !== WORK_APPROVAL_VERSION || raw.organizationId !== captured.scope.organizationId || raw.legalEntityId !== captured.scope.legalEntityId || raw.ownerKey !== expected || !uuid(raw.actorUserId) || captured.actorId !== undefined && raw.actorUserId !== captured.actorId)
    return invalid(); captured.actorId = raw.actorUserId; return raw; };
export const workApprovals = {
    delegations:createCanonicalDelegationClient(request),
    leave:createLeaveApprovalClient(request),
    assignments:createAssignmentApprovalClient(request),
    due:createApprovalDueClient(request),
    reminders:createApprovalReminderClient(request),
    deadlines:createPeriodNoticeClient(request),
    choices: async (afterWorker: string | null, afterUser: string | null, c: WorkApprovalContext | null) => { const ctx = owner(c); if (ctx.mode !== 'configure')
        return invalid(); const q = new URLSearchParams({ ...afterWorker ? { afterWorker } : {}, ...afterUser ? { afterUser } : {} }), r = await request('GET', '/choices?' + q, ctx); if (!Array.isArray(r.workers) || r.workers.length > 200 || !Array.isArray(r.users) || r.users.length > 200 || !validCapabilityDate(r.today))
        return invalid(); let wp = afterWorker ?? '', up = afterUser ?? ''; for (const w of r.workers) {
        if (!keys(w, ['id', 'code', 'name', 'status']) || !text(w.id) || !text(w.code) || !text(w.name, 2000) || !text(w.status) || compareCapabilityIds(w.id, wp) <= 0)
            return invalid();
        wp = w.id;
    } for (const u of r.users) {
        if (!keys(u, ['id', 'username', 'roles']) || !uuid(u.id) || !text(u.username) || !Array.isArray(u.roles) || u.roles.length > 50 || u.roles.some(k => !text(k, 100)) || u.roles.join(',') !== [...new Set(u.roles)].sort().join(',') || compareCapabilityIds(u.id, up) <= 0)
            return invalid();
        up = u.id;
    } if (r.nextWorker !== null && (r.workers.length !== 200 || r.nextWorker !== wp) || r.nextUser !== null && (r.users.length !== 200 || r.nextUser !== up))
        return invalid(); return r as unknown as {
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
        nextWorker: string | null;
        nextUser: string | null;
        today: string;
    }; },
    policies: async (before: number | null, c: WorkApprovalContext | null) => { const ctx = owner(c); if (ctx.mode !== 'configure' || before !== null && !integer(before, 1))
        return invalid(); const r = await request('GET', '/policies' + (before ? '?before=' + before : ''), ctx); if (!Array.isArray(r.policies) || r.policies.length > 10)
        return invalid(); let seq = before ?? 2147483648; const rows = r.policies.map(v => { const p = policy(v); if (p.sequence >= seq)
        return invalid(); seq = p.sequence; return p; }); if (r.nextBefore !== null && (rows.length !== 10 || r.nextBefore !== seq))
        return invalid(); return { policies: rows, nextBefore: r.nextBefore as number | null }; },
    adopt: async (expectedLatestId: string | null, effectiveFrom: string, definition: WorkApprovalDefinition, reason: string, c: WorkApprovalContext | null) => { const ctx = owner(c); if (ctx.mode !== 'configure' || expectedLatestId !== null && !uuid(expectedLatestId) || !validCapabilityDate(effectiveFrom) || !validWorkApprovalPolicy(definition) || !text(reason.trim(), 1000))
        return invalid(); const r = await request('POST', '/policies', ctx, { expectedLatestId, effectiveFrom, definition, reason }), p = policy(r.policy); if (p.actorId !== r.actorUserId || p.activeRole !== ctx.activeRole || p.effectiveFrom !== effectiveFrom || p.reason !== reason.trim() || JSON.stringify(p.definition) !== JSON.stringify(definition)) {
        const canonical = (x: unknown) => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
        if (p.actorId !== r.actorUserId || p.activeRole !== ctx.activeRole || p.effectiveFrom !== effectiveFrom || p.reason !== reason.trim() || canonical(p.definition) !== canonical(definition))
            return invalid();
    } return p; },
    list: async (after: string | null, c: WorkApprovalContext | null, timesheetId?: string) => { const ctx = owner(c); if (after !== null && !uuid(after) || timesheetId !== undefined && !uuid(timesheetId))
        return invalid(); const q = new URLSearchParams({ ...after ? { after } : {}, ...timesheetId ? { timesheetId } : {} }), r = await request('GET', '/instances?' + q, ctx); if (!Array.isArray(r.instances) || r.instances.length > 20)
        return invalid(); let prior = after ?? ''; const rows = r.instances.map(v => { const p = decodeWorkApprovalInstance(v); if (compareCapabilityIds(p.id, prior) <= 0 || timesheetId && p.timesheetId !== timesheetId)
        return invalid(); prior = p.id; return p; }); if (r.nextAfter !== null && (rows.length !== 20 || r.nextAfter !== prior))
        return invalid(); return { instances: rows, nextAfter: r.nextAfter as string | null, actorUserId: r.actorUserId as string, ownerKey: r.ownerKey as string }; },
    instance: async (id: string, c: WorkApprovalContext | null): Promise<WorkApprovalPage> => { const ctx = owner(c); if (!uuid(id))
        return invalid(); const r = await request('GET', '/instances/' + encodeURIComponent(id), ctx); const decoded = decodeWorkApprovalInstance(r.instance, id); if (!decoded.source)
        return invalid(); return { instance: decoded, actorUserId: r.actorUserId as string, ownerKey: r.ownerKey as string }; },
    decide: async (page: WorkApprovalPage, decision: 'Approved' | 'Rejected', reason: string, requestId: string, c: WorkApprovalContext | null) => { const ctx = owner(c), v = page.instance; if (ctx.mode !== 'decide' || v.state.status !== 'Pending' || !uuid(requestId) || !text(reason.trim(), 1000) || page.ownerKey !== await ownerKey(ctx))
        return invalid(); const r = await request('POST', '/instances/' + encodeURIComponent(v.id) + '/decisions', ctx, { expectedSourceToken: v.sourceToken, expectedSequence: v.state.sequence, requestId, decision, reason }), receipt = decodeWorkDecision(r.receipt, v.id); if (typeof r.replayed !== 'boolean' || r.sourceToken !== v.sourceToken || r.actorUserId !== page.actorUserId || receipt.actorId !== page.actorUserId || receipt.activeRole !== ctx.activeRole || receipt.requestId !== requestId || receipt.decision !== decision || receipt.reason !== reason.trim() || receipt.sequence !== v.state.sequence + 1 || receipt.stage !== v.state.currentStage || !validStageReceipt(v.policy.stages,v.delegations,receipt) || !sameState(receipt.outcome, approvalState(v.policy.stages, [...v.transitions, receipt])))
        return invalid(); return { receipt, replayed: r.replayed as boolean, sourceToken: r.sourceToken as string }; },
    inbox: async (after: string | null, c: WorkApprovalContext | null) => { const ctx = owner(c); if (ctx.mode !== 'inbox' || after !== null && !uuid(after))
        return invalid(); const r = await request('GET', '/inbox' + (after ? '?after=' + after : ''), ctx); if (!Array.isArray(r.notifications) || r.notifications.length > 20)
        return invalid(); let prior = after ?? ''; const rows = r.notifications.map(v => { const n = notification(v); if (compareCapabilityIds(n.id, prior) <= 0)
        return invalid(); prior = n.id; return n; }); if (r.nextAfter !== null && (rows.length !== 20 || r.nextAfter !== prior))
        return invalid(); return { notifications: rows, nextAfter: r.nextAfter as string | null }; },
    read: async (n: CanonicalWorkNotice, c: WorkApprovalContext | null) => { const ctx = owner(c); if (ctx.mode !== 'inbox')
        return invalid(); const r = await request('POST', '/inbox/' + encodeURIComponent(n.id) + '/read', ctx, {}), out = notification(r.notification); if (Object.keys(n).some(k => k !== 'readAt' && JSON.stringify((out as unknown as Record<string,unknown>)[k]) !== JSON.stringify((n as unknown as Record<string,unknown>)[k])) || out.readAt === null || n.readAt && n.readAt !== out.readAt)
        return invalid(); return out; }
};
