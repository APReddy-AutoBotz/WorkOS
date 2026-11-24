import assert from 'node:assert/strict';
import { validWorkApprovalPolicy, approvalState, approvalRecipients, approvalEventIdentity, renderApprovalTemplate } from '../shared/work-approval.mjs';
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], stages = ids.map(userId => ({ userId, role: 'Admin' })), templates = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'].map(key => ({ key, subject: 'Work {{sourceRef}}', body: '{{workerCode}} {{stageNumber}} {{decisionReason}}' })), definition = { entityType: 'Timesheet', workerIds: ['synthetic-worker'], stages, locale: 'en-GB', templates, completionInApp: true };
assert(validWorkApprovalPolicy(definition));
for (const stageDueMinutes of [0, 1.5, '90', null, 2147483648])
    assert.equal(validWorkApprovalPolicy({...definition, stageDueMinutes}), false);
assert(validWorkApprovalPolicy({ ...definition, workerIds: [] }), 'explicit empty future selection retires adoption without changing existing instances');
for (const patch of [{ stages: [] }, { stages: [{ ...stages[0], userId: 'caller' }] }, { workerIds: ['b', 'a'] }, { workerIds: ['a', 'a'] }, { locale: '' }, { templates: [...templates.slice(0, 2), templates[0]] }, { templates: templates.map((t, i) => i ? t : { ...t, body: '{{email}}' }) }, { completionInApp: undefined }, { entityType: 'InvoiceBatch' }, { recipients: ids }])
    assert(!validWorkApprovalPolicy({ ...definition, ...patch }));
assert.deepEqual(approvalState(stages, []), { status: 'Pending', sequence: 0, currentStage: 0 });
const first = { sequence: 1, stage: 0, decision: 'Approved' };
assert.deepEqual(approvalState(stages, [first]), { status: 'Pending', sequence: 1, currentStage: 1 });
assert.deepEqual(approvalState(stages, [first, { sequence: 2, stage: 1, decision: 'Approved' }]), { status: 'Approved', sequence: 2, currentStage: null });
assert.equal(approvalState(stages, [{ ...first, decision: 'Rejected' }]).status, 'Rejected');
for (const rows of [[{ ...first, sequence: 2 }], [{ ...first, stage: 1 }], [{ ...first, decision: 'Rejected' }, { sequence: 2, stage: 1, decision: 'Approved' }]])
    assert.throws(() => approvalState(stages, rows));
assert.deepEqual(approvalRecipients([{ userId: ids[0], reason: 'requester' }, { userId: ids[0], reason: 'affected_worker' }, { userId: ids[0], reason: 'requester' }]), [{ userId: ids[0], reasons: ['affected_worker', 'requester'] }]);
assert.equal(approvalRecipients([{ userId: ids[0], reason: 'requester' }, { userId: ids[1], reason: 'affected_worker' }]).length, 2);
assert.throws(() => approvalRecipients([{ userId: ids[0], reason: 'finance_preparer' }]));
assert.match(approvalEventIdentity(ids[0], 0, templates[0].key, 'operation:synthetic'), /operation%3Asynthetic$/);
assert.throws(() => approvalEventIdentity(ids[0], 0, 'commercial.approval_required', 'op'));
assert.deepEqual(renderApprovalTemplate(templates[0], { workerCode: 'SYN-WORKER', sourceRef: 'timesheet/source', stageNumber: '1', decisionReason: 'Synthetic correction' }), { title: 'Work timesheet/source', body: 'SYN-WORKER 1 Synthetic correction' });
assert.throws(() => renderApprovalTemplate({ ...templates[0], body: '{{recipient}}' }, {}));
console.log('Staged work policy explicit configuration, bounded ordered stages, retirement selection, canonical template/variable/operation identity and deduplicated protected recipient reasons passed; no default, quorum, conversion, external channel or reopen authority inferred.');
assert.equal(validWorkApprovalPolicy({ ...definition, stages: [{ ...definition.stages[0], userId: 'ABCDEF01-1111-4111-8111-111111111111' }] }), false, 'Configuration requires the same canonical lowercase account identity emitted by the API');
