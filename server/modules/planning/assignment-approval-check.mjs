import { WorkPolicyError } from '../work-capture/assignment-work-policy.mjs';
// Preview the same material selection enforced by the all-writer SQL guard.
// This is a denial/preflight only; it never authorizes final application.
export const assertAssignmentMaterialWrite = async (c, req, previous, next) => {
    if (!previous)
        return;
    const p = (await c.query('select p.* from assignment_material_policy($1,$2,$3)p where p.id is not null', [req.organizationScope.organizationId, req.organizationScope.legalEntityId, previous.employee_id])).rows[0];
    const incoming = previous.employee_id !== next.employee_id ? (await c.query('select p.id from assignment_material_policy($1,$2,$3)p where p.id is not null', [req.organizationScope.organizationId, req.organizationScope.legalEntityId, next.employee_id])).rowCount : 0;
    if ((p || incoming) && (previous.employee_id !== next.employee_id || previous.project_id !== next.project_id))
        throw new WorkPolicyError('ASSIGNMENT_APPROVAL_IDENTITY_UNAVAILABLE', 'Selected assignment identity transfers have no governed source transition.', 409);
    if (!p)
        return;
    const after = { role: next.role_on_project, quantityExact: String(next.percentage), startsOn: next.start_date, endsOn: next.end_date, billable: next.billable, status: next.status, comment: next.comments };
    const required = (await c.query('select assignment_requires_approval(assignment_version_snapshot(a),$2::jsonb,$3::jsonb)required from project_allocations a where id=$1', [previous.id, after, p.definition])).rows[0]?.required;
    if (required)
        throw new WorkPolicyError('ASSIGNMENT_APPROVAL_REQUIRED', 'Configured material change requires an exact proposal and final named-stage approval.', 409);
};
