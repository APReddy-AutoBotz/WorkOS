import assert from 'node:assert/strict';
import {
  validInvoiceBatchApprovalPolicy,
  invoiceBatchApprovalState,
  invoiceBatchApprovalActorAllowed,
  renderInvoiceBatchApprovalNotice,
} from '../shared/invoice-batch-approval.mjs';
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
  entityType: 'InvoiceBatch',
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
assert.equal(validInvoiceBatchApprovalPolicy(policy), true);
assert.equal(validInvoiceBatchApprovalPolicy({ ...policy, fullLineReversals: true }), true);
for (const value of [false, null, 'true', 1])
  assert.equal(validInvoiceBatchApprovalPolicy({ ...policy, fullLineReversals: value }), false);
assert.equal(validInvoiceBatchApprovalPolicy({ ...policy, fullLineReversals: true, stages: [policy.stages[0], policy.stages[0]] }), false);

assert.equal(
  validInvoiceBatchApprovalPolicy({
    ...policy,
    templates: templates.map((t, i) => (i ? t : { ...t, body: '{{decisionReason}}' })),
  }),
  false,
);
assert.equal(validInvoiceBatchApprovalPolicy({ ...policy, extra: true }), false);
assert.deepEqual(invoiceBatchApprovalState(policy, []), { status: 'Pending', sequence: 0, currentStage: 0 });
assert.equal(invoiceBatchApprovalActorAllowed(policy, [], true, actor, requester), true);
assert.equal(invoiceBatchApprovalActorAllowed(policy, [], true, actor, first), false);
for (const k of ['active', 'heldRole', 'scopedSourceAccess', 'decisionPermission', 'inboxPermission'])
  assert.equal(
    invoiceBatchApprovalActorAllowed(policy, [], true, { ...actor, [k]: false }, requester),
    false,
    k,
  );
assert.equal(invoiceBatchApprovalActorAllowed(policy, [], false, actor, requester), false);
const intermediate = [{ sequence: 1, stage: 0, decision: 'Approved' }];
assert.equal(invoiceBatchApprovalActorAllowed(policy, intermediate, true, actor, requester), false);
assert.equal(
  invoiceBatchApprovalActorAllowed(
    policy,
    intermediate,
    true,
    { ...actor, userId: second, role: 'Finance' },
    requester,
  ),
  true,
);
assert.equal(
  invoiceBatchApprovalState(policy, [...intermediate, { sequence: 2, stage: 1, decision: 'Approved' }])
    .status,
  'Approved',
);
assert.equal(
  invoiceBatchApprovalState(policy, [{ sequence: 1, stage: 0, decision: 'Rejected' }]).status,
  'Rejected',
);
assert.throws(() => invoiceBatchApprovalState(policy, [{ sequence: 2, stage: 0, decision: 'Approved' }]));
const notice = renderInvoiceBatchApprovalNotice(templates[0], snapshot, 1);
assert.equal(notice.title, `Review invoice-batch/${snapshot}`);
assert.equal(notice.body, 'Stage 1');
assert.throws(() =>
  renderInvoiceBatchApprovalNotice({ ...templates[0], body: '{{workerCode}}' }, snapshot, 1),
);
console.log('Invoice batch explicit policy, named stages, actor fencing and minimal notice passed.');
const { invoiceBatchApprovalRecipients } = await import('../shared/invoice-batch-approval.mjs');
assert.deepEqual(
  invoiceBatchApprovalRecipients([
    { userId: first, reason: 'requester' },
    { userId: first, reason: 'invoice_batch_owner' },
    { userId: first, reason: 'finance_preparer' },
    { userId: second, reason: 'affected_worker' },
    { userId: second, reason: 'affected_worker' },
  ]),
  [
    { userId: first, reasons: ['finance_preparer', 'invoice_batch_owner', 'requester'] },
    { userId: second, reasons: ['affected_worker'] },
  ],
);
assert.throws(() => invoiceBatchApprovalRecipients([{ userId: first, reason: 'caller_redirect' }]));
assert.throws(() =>
  invoiceBatchApprovalRecipients([{ userId: first, reason: 'requester', email: 'outside@example.test' }]),
);
assert.throws(() => invoiceBatchApprovalRecipients([]));
console.log('Canonical invoice recipient reasons are deduplicated without caller redirection.');
