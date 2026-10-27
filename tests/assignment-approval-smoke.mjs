import assert from 'node:assert/strict';
import { validAssignmentApprovalPolicy, materialAssignmentFields, assignmentApprovalIdentity } from '../shared/assignment-approval.mjs';
import { approvalState, approvalRecipients } from '../shared/work-approval.mjs';
const userId = '11111111-1111-4111-8111-111111111111', d = { entityType: 'Assignment', workerIds: ['synthetic-worker'], materialFields: ['quantityExact', 'status'], stages: [{ userId, role: 'Synthetic existing role' }], locale: 'en-GB', completionInApp: false, templates: ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'].map(key => ({ key, subject: 'Review {{sourceRef}}', body: 'Worker {{workerCode}}, stage {{stageNumber}}, reason {{decisionReason}}.' })) };
assert(validAssignmentApprovalPolicy(d));
assert(validAssignmentApprovalPolicy({ ...d, workerIds: [] }));
for (const patch of [{ entityType: 'Timesheet' }, { materialFields: [] }, { materialFields: ['hours'] }, { materialFields: ['status', 'quantityExact'] }, { materialFields: ['quantityExact', 'quantityExact'] }, { workerIds: ['z', 'a'] }, { stages: [] }, { stages: [{ userId, role: 'Synthetic', recipient: 'redirect' }] }, { locale: 'x'.repeat(101) }, { completionInApp: 'false' }, { templates: d.templates.map(t => ({ ...t, body: '{{unapprovedAddress}}' })) }, { templates: d.templates.map(t => ({ ...t, body: Array(20).fill('{{decisionReason}}').join(' ') })) }, { templates: d.templates.map(t => ({ ...t, subject: Array(7).fill('{{workerCode}}').join(' ') })) }])
    assert.equal(validAssignmentApprovalPolicy({ ...d, ...patch }), false, JSON.stringify(patch));
assert.deepEqual(materialAssignmentFields({ quantityExact: '20', status: 'Active', comment: null }, { quantityExact: '20', status: 'Active', comment: 'Synthetic note' }, d.materialFields), []);
assert.deepEqual(materialAssignmentFields({ quantityExact: '20', status: 'Active' }, { quantityExact: '20.0000000000001', status: 'Paused' }, d.materialFields), ['quantityExact', 'status']);
assert.equal(assignmentApprovalIdentity(userId, 0, 'approval.action_required', 'synthetic/operation'), `assignment-approval/${userId}/0/approval.action_required/synthetic%2Foperation`);
assert.deepEqual(approvalState(d.stages, []), { status: 'Pending', sequence: 0, currentStage: 0 });
assert.deepEqual(approvalState(d.stages, [{ sequence: 1, stage: 0, decision: 'Approved' }]), { status: 'Approved', sequence: 1, currentStage: null });
assert.throws(() => approvalState(d.stages, [{ sequence: 2, stage: 0, decision: 'Approved' }]));
assert.deepEqual(approvalRecipients([{ userId, reason: 'requester' }, { userId, reason: 'affected_worker' }]), [{ userId, reasons: ['affected_worker', 'requester'] }]);
console.log('Material assignment explicit field/stage/locale/template/render limits, exact native quantity selection, state, canonical identity and recipient-reason dedup passed.');
assert.equal(validAssignmentApprovalPolicy({ ...d, templates: d.templates.map(t => ({ ...t, subject: 'Review {{decisionReason}}' })) }), false, 'Action-required blank reason must not create an unreadable trailing-space acknowledgement');

assert(validAssignmentApprovalPolicy({ ...d, creationRequired: true, materialFields: [] }));
assert(validAssignmentApprovalPolicy({ ...d, creationRequired: false }));
for (const value of [null, 'true', 1, {}, []]) assert.equal(validAssignmentApprovalPolicy({ ...d, creationRequired: value }), false);
assert(validAssignmentApprovalPolicy({ ...d, creationRequired: false, materialFields: [] }), 'Explicit creation-only retirement needs no invented material field');
console.log('Explicit creation-only/mixed policy, absent legacy option and invalid option contracts passed.');

// Configured prospective due handoff is part of this required gate.
await import('./approval-due-smoke.mjs');

// Configured canonical leave approval is part of this required gate.
await import('./leave-approval-smoke.mjs');

// Prospective configured canonical delegation is part of this required gate.
await import('./canonical-delegation-smoke.mjs');

// Configured prospective reminders reuse the required approval gate.
await import('./approval-reminder-smoke.mjs');

// Scoped operational-control workflow retains the original per-item approval gates.
await import('./operational-control-smoke.mjs');

// Canonical own workspace retains the original per-item source gates.
await import('./own-workspace-smoke.mjs');

// Scoped directory relationship/handoff workflow is part of this required gate.
await import('./workforce-directory-smoke.mjs');

// Explicit prospective legal-entity calendar authoring and connected capacity workflow.
await import('./calendar-authoring-smoke.mjs');

// Explicit country/group authoring and original native capacity precedence.
await import('./calendar-scope-smoke.mjs');

// Six-family business structure, retained sources and unused-node retirement.
await import('./business-structure-smoke.mjs');

// Explicit catalog-to-workforce classification and historical source preservation.
await import('./workforce-classification-smoke.mjs');
