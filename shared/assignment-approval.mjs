import { validWorkApprovalPolicy, approvalKeys, approvalText, approvalEventIdentity, renderApprovalTemplate } from './work-approval.mjs';
export const ASSIGNMENT_APPROVAL_VERSION = 'assignment-approval/1';
export const MATERIAL_ASSIGNMENT_FIELDS = ['billable', 'comment', 'endsOn', 'quantityExact', 'role', 'startsOn', 'status'];
export const validAssignmentApprovalPolicy = d => {
    if (!approvalKeys(d, ['entityType', 'workerIds', 'materialFields', 'stages', 'locale', 'templates', 'completionInApp']) || d.entityType !== 'Assignment' || !Array.isArray(d.materialFields) || !d.materialFields.length || d.materialFields.some((k, i) => !MATERIAL_ASSIGNMENT_FIELDS.includes(k) || (i && d.materialFields[i - 1] >= k)) || !approvalText(d.locale, 100))
        return false;
    const { materialFields: _fields, ...base } = d;
    return validWorkApprovalPolicy({ ...base, entityType: 'Timesheet' }) && d.templates.every(t => {
        const rendered = renderApprovalTemplate(t, { workerCode: 'w'.repeat(200), sourceRef: 's'.repeat(250), stageNumber: '10', decisionReason: 'r'.repeat(1000) });
        return rendered.title.length <= 1200 && rendered.body.length <= 12000;
    });
};
export const materialAssignmentFields = (before, after, fields) => fields.filter(k => before[k] !== after[k]);
export const assignmentApprovalIdentity = (...args) => approvalEventIdentity(...args).replace(/^work-approval\//, 'assignment-approval/');
