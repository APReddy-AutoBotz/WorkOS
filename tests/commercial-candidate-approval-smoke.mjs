import assert from 'node:assert/strict';
import {
  validCommercialCandidatePolicy,
  commercialApprovalState,
  commercialApprovalRecipients,
  renderCommercialApproval,
  commercialApprovalSourceCurrent,
  commercialApprovalActorAllowed,
} from '../shared/commercial-candidate-approval.mjs';
const id = '00000000-0000-4000-8000-000000000001',
  two = '00000000-0000-4000-8000-000000000002',
  keys = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
const policy = {
  entityType: 'CommercialCandidate',
  kind: 'cost',
  candidateId: id,
  stages: [
    { userId: id, role: 'Admin' },
    { userId: two, role: 'Admin' },
  ],
  locale: 'en-US',
  templates: keys.map((key) => ({ key, subject: 'Action {{stageNumber}}', body: 'Review {{sourceRef}}' })),
  completionInApp: false,
};
assert(validCommercialCandidatePolicy(policy));
assert(!validCommercialCandidatePolicy({ ...policy, extra: true }));
assert(
  !validCommercialCandidatePolicy({
    ...policy,
    templates: policy.templates.map((t) => ({ ...t, body: '{{decisionReason}}' })),
  }),
);
assert(
  !validCommercialCandidatePolicy({
    ...policy,
    templates: policy.templates.map((t) => ({ ...t, body: '{{workerCode}}' })),
  }),
);
assert(!validCommercialCandidatePolicy({ ...policy, candidateId: 'not-an-id' }));
assert.deepEqual(commercialApprovalState(policy, []), { status: 'Pending', sequence: 0, currentStage: 0 });
assert.deepEqual(commercialApprovalState(policy, [{ sequence: 1, stage: 0, decision: 'Approved' }]), {
  status: 'Pending',
  sequence: 1,
  currentStage: 1,
});
assert.equal(
  commercialApprovalState(policy, [{ sequence: 1, stage: 0, decision: 'Rejected' }]).status,
  'Rejected',
);
assert.equal(
  commercialApprovalState(policy, [
    { sequence: 1, stage: 0, decision: 'Approved' },
    { sequence: 2, stage: 1, decision: 'Approved' },
  ]).status,
  'Approved',
);
assert.throws(() => commercialApprovalState(policy, [{ sequence: 2, stage: 0, decision: 'Approved' }]));
assert.deepEqual(
  commercialApprovalRecipients([
    { userId: id, reason: 'requester' },
    { userId: id, reason: 'commercial_change_owner' },
    { userId: two, reason: 'affected_worker' },
    { userId: id, reason: 'requester' },
  ]),
  [
    { userId: id, reasons: ['commercial_change_owner', 'requester'] },
    { userId: two, reasons: ['affected_worker'] },
  ],
);
assert.throws(() => commercialApprovalRecipients([{ userId: id, reason: 'caller_selected' }]));
assert.deepEqual(renderCommercialApproval(policy.templates[0], id, 2), {
  title: 'Action 2',
  body: 'Review commercial-candidate/' + id,
});
assert.throws(() => renderCommercialApproval({ ...policy.templates[0], body: '{{decisionReason}}' }, id, 1));
const three = '00000000-0000-4000-8000-000000000003',
  pin = { candidateId: id, ownerEventId: two, policyId: three },
  current = { ...pin, ownerEligible: true };
assert(commercialApprovalSourceCurrent(pin, current));
for (const changed of [
  { candidateId: three },
  { ownerEventId: three },
  { policyId: two },
  { ownerEligible: false },
])
  assert.equal(commercialApprovalSourceCurrent(pin, { ...current, ...changed }), false);
assert.equal(commercialApprovalSourceCurrent(pin, { ...current, extra: true }), false);
const actor = {
  userId: id,
  role: 'Admin',
  active: true,
  heldRole: true,
  scopedSourceAccess: true,
  decisionPermission: true,
  inboxPermission: true,
};
assert(commercialApprovalActorAllowed(policy, [], true, actor, two));
for (const changed of [
  { active: false },
  { heldRole: false },
  { scopedSourceAccess: false },
  { decisionPermission: false },
  { inboxPermission: false },
  { role: 'Employee' },
  { userId: two },
])
  assert.equal(commercialApprovalActorAllowed(policy, [], true, { ...actor, ...changed }, three), false);
assert.equal(commercialApprovalActorAllowed(policy, [], false, actor, three), false);
assert.equal(commercialApprovalActorAllowed(policy, [], 'true', actor, three), false);
assert.equal(commercialApprovalActorAllowed(policy, [], true, actor, id), false);
assert.equal(commercialApprovalActorAllowed(policy, [], true, actor, three, id), false);
assert.equal(
  commercialApprovalActorAllowed(
    policy,
    [
      { sequence: 1, stage: 0, decision: 'Approved' },
      { sequence: 2, stage: 1, decision: 'Approved' },
    ],
    true,
    actor,
    three,
  ),
  false,
);
console.log(
  'Commercial approval strict policy, ordered stages, reason-preserving recipient deduplication and sanitized template contracts passed.',
);
