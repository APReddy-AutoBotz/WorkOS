import { validCapabilityDate, compareCapabilityIds } from './workforce-capabilities.mjs';
export const WORK_APPROVAL_VERSION = 'work-approval/1';
export const APPROVAL_EVENT_KEYS = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
export const APPROVAL_TEMPLATE_VARIABLES = ['workerCode', 'sourceRef', 'stageNumber', 'decisionReason'];
export const approvalObject = v => Boolean(v && typeof v === 'object' && !Array.isArray(v));
export const approvalKeys = (v, keys) => approvalObject(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const approvalUuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export const approvalHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const approvalText = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v);
export const validApprovalTemplate = t => approvalKeys(t, ['key', 'subject', 'body']) && APPROVAL_EVENT_KEYS.includes(t.key) && approvalText(t.subject, 200) && approvalText(t.body, 8000) && [t.subject, t.body].every(s => { const stripped = s.replace(/\{\{([a-zA-Z]+)\}\}/g, (_m, k) => APPROVAL_TEMPLATE_VARIABLES.includes(k) ? '' : 'INVALID_TEMPLATE_VARIABLE'); return !/[{}]/.test(stripped) && !stripped.includes('INVALID_TEMPLATE_VARIABLE'); });
export const validWorkApprovalPolicy = d => {
    try {
        return approvalKeys(d, ['entityType', 'workerIds', 'stages', 'locale', 'templates', 'completionInApp']) && d.entityType === 'Timesheet' && Array.isArray(d.workerIds) && d.workerIds.length >= 0 && d.workerIds.length <= 200 && d.workerIds.every((v, i) => approvalText(v) && (!i || compareCapabilityIds(d.workerIds[i - 1], v) < 0)) && Array.isArray(d.stages) && d.stages.length >= 1 && d.stages.length <= 10 && d.stages.every(s => approvalKeys(s, ['userId', 'role']) && approvalUuid(s.userId) && approvalText(s.role, 100)) && typeof d.locale === 'string' && Intl.getCanonicalLocales(d.locale)[0] === d.locale && Array.isArray(d.templates) && d.templates.length === 3 && d.templates.every(validApprovalTemplate) && new Set(d.templates.map(t => t.key)).size === 3 && typeof d.completionInApp === 'boolean';
    }
    catch {
        return false;
    }
};
export const approvalState = (stages, transitions) => { let stage = 0; for (const [t, i] of transitions.map((t, i) => [t, i])) {
    if (t.sequence !== i + 1 || t.stage !== stage || !['Approved', 'Rejected'].includes(t.decision) || stage >= stages.length || i && transitions[i - 1].decision === 'Rejected')
        throw TypeError('Approval stage history is invalid.');
    if (t.decision === 'Rejected' && i !== transitions.length - 1)
        throw TypeError('A terminal rejection cannot advance.');
    if (t.decision === 'Rejected')
        return { status: 'Rejected', sequence: i + 1, currentStage: null };
    stage++;
} return { status: stage === stages.length ? 'Approved' : 'Pending', sequence: transitions.length, currentStage: stage === stages.length ? null : stage }; };
export const approvalEventIdentity = (instance, sequence, key, operationId) => { if (!approvalUuid(instance) || !Number.isInteger(sequence) || sequence < 0 || sequence > 10 || !APPROVAL_EVENT_KEYS.includes(key) || !approvalText(operationId, 200))
    throw TypeError('Invalid approval event identity.'); return `work-approval/${instance}/${sequence}/${key}/${encodeURIComponent(operationId)}`; };
export const approvalRecipients = rows => {
    const map = new Map();
    for (const r of rows) {
        if (!approvalUuid(r.userId) || !['current_stage_approver', 'requester', 'affected_worker'].includes(r.reason))
            throw TypeError('Invalid approval recipient authority.');
        const reasons = map.get(r.userId) ?? [];
        if (!reasons.includes(r.reason))
            reasons.push(r.reason);
        map.set(r.userId, reasons);
    }
    return [...map].sort(([a], [b]) => compareCapabilityIds(a, b)).map(([userId, reasons]) => ({ userId, reasons: reasons.sort() }));
};
export const renderApprovalTemplate = (template, context) => { if (!validApprovalTemplate(template) || !approvalKeys(context, APPROVAL_TEMPLATE_VARIABLES))
    throw TypeError('Invalid approval template/context.'); const render = s => s.replace(/\{\{([a-zA-Z]+)\}\}/g, (_m, k) => String(context[k])); return { title: render(template.subject), body: render(template.body) }; };
