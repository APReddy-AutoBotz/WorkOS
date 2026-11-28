import { validWorkApprovalPolicy, approvalKeys, approvalText, approvalEventIdentity, renderApprovalTemplate } from './work-approval.mjs';
export const ASSIGNMENT_APPROVAL_VERSION = 'assignment-approval/1';
export const MATERIAL_ASSIGNMENT_FIELDS = ['billable', 'comment', 'endsOn', 'quantityExact', 'role', 'startsOn', 'status'];
export const validAssignmentApprovalPolicy = d => {
    const creation = Boolean(d && Object.hasOwn(d, 'creationRequired'));
    if (!approvalKeys(d, ['entityType', 'workerIds', 'materialFields', 'stages', 'locale', 'templates', 'completionInApp', ...['stageDueMinutes', 'reminderLeadMinutes', 'escalationUserId', 'overdueTemplate'].filter(key => d && Object.hasOwn(d, key)), ...(creation ? ['creationRequired'] : [])]) || (creation && typeof d.creationRequired !== 'boolean') || d.entityType !== 'Assignment' || !Array.isArray(d.materialFields) || (!d.materialFields.length && !creation) || d.materialFields.some((k, i) => !MATERIAL_ASSIGNMENT_FIELDS.includes(k) || (i && d.materialFields[i - 1] >= k)) || !approvalText(d.locale, 100))
        return false;
    const { materialFields: _fields, creationRequired: _creation, ...base } = d;
    return validWorkApprovalPolicy({ ...base, entityType: 'Timesheet' }) && [...d.templates,...(d.overdueTemplate ? [d.overdueTemplate] : [])].every(t => {
        const rendered = renderApprovalTemplate(t, { workerCode: 'w'.repeat(200), sourceRef: 's'.repeat(250), stageNumber: '10', decisionReason: t.key==='approval.overdue_or_escalated' ? '' : 'r'.repeat(1000) });
        const action = renderApprovalTemplate(t, { workerCode: 'w'.repeat(200), sourceRef: 's'.repeat(250), stageNumber: '10', decisionReason: ['approval.action_required','approval.overdue_or_escalated'].includes(t.key) ? '' : 'r' });
        return approvalText(rendered.title, 1200) && approvalText(rendered.body, 12000) && approvalText(action.title, 1200) && approvalText(action.body, 12000);
    });
};
export const materialAssignmentFields = (before, after, fields) => fields.filter(k => before[k] !== after[k] || (k === 'quantityExact' && before.quantityUnit !== after.quantityUnit));
export const assignmentApprovalIdentity = (...args) => approvalEventIdentity(...args).replace(/^work-approval\//, 'assignment-approval/');
