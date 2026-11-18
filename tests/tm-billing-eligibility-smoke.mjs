import assert from 'node:assert/strict';
import {
  validTmEligibilityPolicy,
  tmEligibilityState,
  tmEligibilityActorAllowed,
  renderTmEligibilityNotice,
} from '../shared/tm-billing-eligibility.mjs';
const first = '00000000-0000-4000-8000-000000000001',
  second = '00000000-0000-4000-8000-000000000002',
  requester = '00000000-0000-4000-8000-000000000003',
  snapshot = '00000000-0000-4000-8000-000000000004';
const templates = [
  'approval.action_required',
  'approval.rejected_or_correction_required',
  'approval.completed',
].map((key) => ({ key, subject: 'Review {{sourceRef}}', body: 'Stage {{stageNumber}}' }));
const policy = {
  entityType: 'TmBillingEligibility',
  engagementId: 'synthetic-engagement',
  stages: [
    { userId: first, role: 'Reviewer' },
    { userId: second, role: 'Finance' },
  ],
  locale: 'en-US',
  templates,
  completionInApp: false,
};
const actor = {
  userId: first,
  role: 'Reviewer',
  active: true,
  heldRole: true,
  scopedSourceAccess: true,
  decisionPermission: true,
  inboxPermission: true,
};
assert.equal(validTmEligibilityPolicy(policy), true);
assert.equal(
  validTmEligibilityPolicy({
    ...policy,
    templates: templates.map((t, i) => (i ? t : { ...t, body: '{{decisionReason}}' })),
  }),
  false,
);
assert.equal(validTmEligibilityPolicy({ ...policy, extra: true }), false);
assert.deepEqual(tmEligibilityState(policy, []), { status: 'Pending', sequence: 0, currentStage: 0 });
assert.equal(tmEligibilityActorAllowed(policy, [], true, actor, requester), true);
assert.equal(tmEligibilityActorAllowed(policy, [], true, actor, first), false);
assert.equal(tmEligibilityActorAllowed(policy, [], true, actor, requester, first), false);
for (const k of ['active', 'heldRole', 'scopedSourceAccess', 'decisionPermission', 'inboxPermission'])
  assert.equal(tmEligibilityActorAllowed(policy, [], true, { ...actor, [k]: false }, requester), false, k);
assert.equal(tmEligibilityActorAllowed(policy, [], false, actor, requester), false);
const intermediate = [{ sequence: 1, stage: 0, decision: 'Approved' }];
assert.equal(tmEligibilityActorAllowed(policy, intermediate, true, actor, requester), false);
assert.equal(
  tmEligibilityActorAllowed(
    policy,
    intermediate,
    true,
    { ...actor, userId: second, role: 'Finance' },
    requester,
  ),
  true,
);
assert.equal(
  tmEligibilityState(policy, [...intermediate, { sequence: 2, stage: 1, decision: 'Approved' }]).status,
  'Approved',
);
assert.equal(
  tmEligibilityState(policy, [{ sequence: 1, stage: 0, decision: 'Rejected' }]).status,
  'Rejected',
);
assert.throws(() => tmEligibilityState(policy, [{ sequence: 2, stage: 0, decision: 'Approved' }]));
const notice = renderTmEligibilityNotice(templates[0], snapshot, 1);
assert.equal(notice.title, `Review tm-eligibility/${snapshot}`);
assert.equal(notice.body, 'Stage 1');
assert.throws(() => renderTmEligibilityNotice({ ...templates[0], body: '{{workerCode}}' }, snapshot, 1));
console.log('T&M eligibility explicit policy, named stages, actor fencing and minimal notice passed.');
const { tmBillingEvidence } = await import('../shared/tm-billing-eligibility.mjs');
const input = {
  id: snapshot,
  engagementId: 'synthetic-engagement',
  policyId: first,
  submissionId: 'synthetic-submission',
  decisionId: 'synthetic-decision',
  entryId: second,
  billingAdoptionId: requester,
  costAdoptionId: 'confidential-cost-id',
  sourceEvidence: {
    submissionId: 'synthetic-submission',
    decisionId: 'synthetic-decision',
    entryId: second,
    policyId: first,
    billingAdoptionId: requester,
    costAdoptionId: 'confidential-cost-id',
    projectId: 'synthetic-project',
    bindingId: 'synthetic-binding',
    workDate: '2026-10-28',
    references: ['Project', 'Engagement', 'Contract'].map((entityType) => ({
      entityType,
      entityId:
        entityType === 'Project'
          ? 'synthetic-project'
          : entityType === 'Engagement'
            ? 'synthetic-engagement'
            : 'synthetic-contract',
      lifecycleEventId: 'synthetic-life',
      contractVersionId: 'synthetic-version',
      amendmentId: null,
    })),
    assignmentSnapshots: [{ privateCost: 'should not appear' }],
  },
  result: {
    version: 'governed-tm/1',
    currency: 'USD',
    unit: 'HOUR',
    billableValue: '125.15',
    costValue: '50.00',
    marginValue: '75.15',
    costRateExact: '40.0000',
  },
};
const projected = tmBillingEvidence(input);
assert.deepEqual(projected, {
  snapshotId: snapshot,
  engagementId: 'synthetic-engagement',
  policyId: first,
  submissionId: 'synthetic-submission',
  decisionId: 'synthetic-decision',
  entryId: second,
  billingAdoptionId: requester,
  projectId: 'synthetic-project',
  bindingId: 'synthetic-binding',
  workDate: '2026-10-28',
  references: ['Project', 'Engagement', 'Contract'].map((entityType) => ({
    entityType,
    entityId:
      entityType === 'Project'
        ? 'synthetic-project'
        : entityType === 'Engagement'
          ? 'synthetic-engagement'
          : 'synthetic-contract',
    lifecycleEventId: 'synthetic-life',
    contractVersionId: 'synthetic-version',
  })),
  currency: 'USD',
  amount: '125.15',
});
assert.doesNotMatch(JSON.stringify(projected), /confidential|cost|margin|50\.00|75\.15/iu);
assert.throws(() =>
  tmBillingEvidence({ ...input, sourceEvidence: { ...input.sourceEvidence, entryId: first } }),
);
assert.throws(() => tmBillingEvidence({ ...input, result: { ...input.result, billableValue: '0.00' } }));
assert.throws(() => tmBillingEvidence({ ...input, result: { ...input.result, currency: 'US' } }));
console.log('Billing-only evidence projection omits confidential cost and rejects mismatched sources.');
const { tmEligibilitySourceCurrent } = await import('../shared/tm-billing-eligibility.mjs');
const pin = { snapshotId: snapshot, policyId: first, ownerUserId: second, ownerRole: 'Finance' };
const current = { ...pin, sourceEligible: true, ownerEligible: true };
assert.equal(tmEligibilitySourceCurrent(pin, current), true);
assert.equal(tmEligibilitySourceCurrent(pin, { ...current, ownerEligible: false }), false);
assert.equal(tmEligibilitySourceCurrent(pin, { ...current, policyId: requester }), false);
assert.equal(tmEligibilitySourceCurrent(pin, { ...current, ownerUserId: requester }), false);
assert.equal(tmEligibilitySourceCurrent(pin, { ...current, sourceEligible: false }), false);
assert.equal(tmEligibilitySourceCurrent(pin, { ...current, ignored: true }), false);
console.log('Owner, source and effective-policy pins fail closed on stale observations.');
