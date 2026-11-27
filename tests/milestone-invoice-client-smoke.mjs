import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { milestoneInvoiceCsvArtifact } from '../server/modules/invoice-export/milestone-csv.mjs';

// Every request is intercepted by this in-memory double; the fixed token is
// a placeholder and is not a credential for a running service.
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const storage = new Map();
globalThis.sessionStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {
  localStorage,
  location: { pathname: '/commercial-drafting', href: '/commercial-drafting' },
  dispatchEvent: () => true,
};
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  scope = { organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal' },
  actor = id(1),
  user = {
    id: actor,
    employeeId: actor,
    userName: 'synthetic',
    role: 'Admin',
    permissionRole: 'Admin',
    permissions: [
      'commercial.contracts.view',
      'commercial.tm_billing.view',
      'commercial.milestone_billing.view',
      'commercial.invoice_drafts.view',
      'commercial.invoice_drafts.prepare',
      'commercial.invoice_drafts.cancel',
      'commercial.invoice_approval.manage',
      'commercial.invoice_approval.decide',
      'approvals.view',
      'commercial.invoice_export.view',
      'commercial.invoice_export.create',
      'commercial.invoice_batch.confirm',
      'employees.view',
      'notifications.view',
    ],
  };
storage.set('workos_session', JSON.stringify(user));
storage.set('workos_organization_scope', JSON.stringify(scope));
storage.set('workos_api_token', 'synthetic-token');
const ownerKey = createHash('sha256')
    .update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId]))
    .digest('hex'),
  envelope = { ...scope, ownerKey, actorUserId: actor, activeRole: 'Admin', serverDate: '2026-10-29' },
  createdAt = '2026-10-29T01:00:00Z';
const evidence = {
  milestoneId: 'synthetic-milestone',
  sourceVersion: 1,
  engagementId: 'engagement',
  contractVersionId: 'version',
  engagementLifecycleId: 'eng-lifecycle',
  contractLifecycleId: 'contract-lifecycle',
  dueOn: '2026-10-28',
  evidence: [
    { kind: 'INTERNAL_ASSERTION', reference: 'Synthetic acceptance', url: 'https://example.test/proof' },
  ],
  ownerUserId: id(2),
  ownerRole: 'Admin',
  policyId: id(3),
  decisionId: id(4),
  currency: 'USD',
  amount: '125.15',
};
const batch = {
  id: id(5),
  sourceType: 'MILESTONE_ACCEPTANCE',
  clientId: 'client',
  contractId: 'contract',
  engagementId: 'engagement',
  currency: 'USD',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  periodBasis: 'ELIGIBLE_DATE',
  ownerUserId: id(2),
  ownerRole: 'Admin',
  preparerUserId: actor,
  preparerRole: 'Admin',
  requestId: id(6),
  reason: 'Synthetic draft',
  createdAt,
  ownerCurrent: true,
  state: 'Draft',
};
const line = {
  id: id(7),
  batchId: batch.id,
  sequence: 1,
  itemId: id(8),
  itemVersion: 1,
  eventId: id(9),
  snapshotId: null,
  sourceType: 'MILESTONE_ACCEPTANCE',
  currency: 'USD',
  amount: '125.15',
  evidence,
  actorId: actor,
  activeRole: 'Admin',
  requestId: id(10),
  reason: 'Synthetic reserve',
  createdAt,
};
let raw = {
    ...envelope,
    batch,
    lines: [line],
    total: { lineCount: 1, amount: '125.15' },
    cancellation: null,
  },
  lastBody = null;
globalThis.fetch = async (_url, init) => {
  lastBody = init?.body ? JSON.parse(init.body) : null;
  return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const { invoiceDrafts, captureRateContext: capture } = await import('../src/services/invoiceDrafts.ts'),
  { invoiceBatchApprovals } = await import('../src/services/invoiceBatchApprovals.ts'),
  { invoiceCsv } = await import('../src/services/invoiceCsv.ts');
assert.equal((await invoiceDrafts.inspect(batch.id, capture())).lines[0].snapshotId, null);
for (const changed of [
  { ...line, sourceType: 'TM_SNAPSHOT' },
  { ...line, snapshotId: id(11) },
  { ...line, evidence: { ...evidence, currency: 'EUR' } },
  { ...line, evidence: { ...evidence, decisionId: 'bad' } },
]) {
  raw = { ...raw, lines: [changed] };
  await assert.rejects(invoiceDrafts.inspect(batch.id, capture()), { status: 503 });
}
raw = {
  ...envelope,
  batch: { ...batch, sourceType: undefined },
  lines: [line],
  total: { lineCount: 1, amount: '125.15' },
  cancellation: null,
};
await assert.rejects(invoiceDrafts.inspect(batch.id, capture()), { status: 503 });
const cancellation = {
  id: id(12),
  batchId: batch.id,
  expectedLineCount: 1,
  actorId: actor,
  activeRole: 'Admin',
  requestId: id(13),
  reason: 'Synthetic cancellation',
  createdAt,
};
raw = {
  ...envelope,
  batch: { ...batch, state: 'Cancelled' },
  lines: [line],
  total: { lineCount: 1, amount: '125.15' },
  cancellation,
  replayed: false,
};
assert.equal(
  (
    await invoiceDrafts.run(
      {
        type: 'cancellation',
        batchId: batch.id,
        data: { requestId: cancellation.requestId, expectedLineCount: 1, reason: cancellation.reason },
      },
      capture(),
    )
  ).batch.state,
  'Cancelled',
);
const approvalLine = {
  id: line.id,
  sequence: 1,
  itemId: line.itemId,
  itemVersion: 1,
  eventId: line.eventId,
  snapshotId: null,
  sourceType: line.sourceType,
  currency: line.currency,
  amount: line.amount,
  evidence,
};
const approvalSource = {
  id: batch.id,
  sourceType: line.sourceType,
  state: 'Draft',
  current: true,
  currency: 'USD',
  clientId: 'client',
  contractId: 'contract',
  engagementId: 'engagement',
  periodStart: batch.periodStart,
  periodEnd: batch.periodEnd,
  periodBasis: 'ELIGIBLE_DATE',
  lineageHash: 'a'.repeat(64),
  lines: [approvalLine],
  total: '125.15',
  lineCount: 1,
};
raw = { ...envelope, batch: approvalSource };
assert.equal((await invoiceBatchApprovals.source(batch.id, capture())).sourceType, line.sourceType);
raw = { ...raw, batch: { ...approvalSource, sourceType: undefined } };
await assert.rejects(invoiceBatchApprovals.source(batch.id, capture()), { status: 503 });
const policy = {
  id: id(18),
  engagementId: 'engagement',
  sequence: 1,
  previousId: null,
  effectiveFrom: '2026-10-01',
  definition: {
    entityType: 'InvoiceBatch',
    engagementId: 'engagement',
    stages: [{ userId: id(2), role: 'Admin' }],
    locale: 'en-US',
    templates: [
      'approval.action_required',
      'approval.rejected_or_correction_required',
      'approval.completed',
    ].map((key) => ({ key, subject: 'Review {{sourceRef}}', body: 'Stage {{stageNumber}}' })),
    completionInApp: false,
  },
  actorId: actor,
  activeRole: 'Admin',
  reason: 'Synthetic policy',
  requestId: id(19),
  createdAt,
};
const approval = {
  id: id(20),
  batchId: batch.id,
  sequence: 1,
  ownerUserId: batch.ownerUserId,
  ownerRole: batch.ownerRole,
  preparerUserId: actor,
  preparerRole: 'Admin',
  requesterUserId: actor,
  activeRole: 'Admin',
  requestId: id(21),
  reason: 'Synthetic review',
  lineCount: 1,
  lineageHash: approvalSource.lineageHash,
  currency: 'USD',
  total: '125.15',
  createdAt,
  policy,
  state: { status: 'Pending', sequence: 0, currentStage: 0 },
  current: true,
  transitions: [],
  cancellation: null,
};
raw = { ...envelope, approval, replayed: false };
const request = {
  type: 'request',
  data: {
    requestId: approval.requestId,
    batchId: batch.id,
    expectedPolicyId: policy.id,
    expectedLineCount: 1,
    expectedLineageHash: approvalSource.lineageHash,
    reason: approval.reason,
  },
};
assert.equal((await invoiceBatchApprovals.run(request, 'engagement', capture())).id, approval.id);
raw = { ...envelope, approval: { ...approval, lineageHash: 'b'.repeat(64) }, replayed: false };
await assert.rejects(invoiceBatchApprovals.run(request, 'engagement', capture()), { status: 503 });
const csvLine = {
    lineId: line.id,
    sequence: 1,
    itemId: line.itemId,
    itemVersion: 1,
    eventId: line.eventId,
    sourceType: line.sourceType,
    currency: 'USD',
    amount: '125.15',
    eligibleDate: '2026-10-29',
    evidenceJson: JSON.stringify(evidence),
  },
  csvSource = {
    batchId: batch.id,
    clientId: 'client',
    contractId: 'contract',
    engagementId: 'engagement',
    currency: 'USD',
    periodStart: batch.periodStart,
    periodEnd: batch.periodEnd,
    periodBasis: 'ELIGIBLE_DATE',
    ownerUserId: batch.ownerUserId,
    ownerRole: batch.ownerRole,
    lines: [csvLine],
  },
  rendered = milestoneInvoiceCsvArtifact(csvSource);
const exportSource = {
  id: batch.id,
  sourceType: line.sourceType,
  state: 'Approved',
  clientId: 'client',
  contractId: 'contract',
  engagementId: 'engagement',
  currency: 'USD',
  periodStart: batch.periodStart,
  periodEnd: batch.periodEnd,
  periodBasis: 'ELIGIBLE_DATE',
  approvalId: id(15),
  finalTransitionId: id(16),
  lineageHash: 'a'.repeat(64),
  sourceCurrent: true,
  artifactId: null,
  lines: [
    {
      lineId: line.id,
      sequence: 1,
      itemId: line.itemId,
      itemVersion: 1,
      eventId: line.eventId,
      sourceType: line.sourceType,
      milestoneId: evidence.milestoneId,
      eligibleDate: '2026-10-29',
      currency: 'USD',
      amount: '125.15',
    },
  ],
  control: { lineCount: 1, currency: 'USD', total: '125.15' },
};
raw = { ...envelope, batch: exportSource };
assert.equal((await invoiceCsv.source(batch.id, capture())).sourceType, line.sourceType);
raw = { ...envelope, batch: { ...exportSource, sourceType: undefined } };
await assert.rejects(invoiceCsv.source(batch.id, capture()), { status: 503 });
const artifact = {
  id: id(14),
  batchId: batch.id,
  approvalId: id(15),
  finalTransitionId: id(16),
  lineageHash: 'a'.repeat(64),
  schemaVersion: rendered.schemaVersion,
  version: 1,
  sha256: rendered.sha256,
  lineCount: 1,
  currency: 'USD',
  total: '125.15',
  actorId: actor,
  activeRole: 'Admin',
  requestId: id(17),
  reason: 'Synthetic export',
  operationId: 'synthetic',
  generatedAt: createdAt,
  payloadBase64: rendered.bytes.toString('base64'),
};
raw = { ...envelope, artifact };
assert.deepEqual(Buffer.from((await invoiceCsv.artifact(artifact.id, capture())).bytes), rendered.bytes);
// The PostgreSQL milestone key is case-sensitive. UUID lineage is not.
const firstEvidence = {...evidence, milestoneId: 'Milestone-A'};
const secondEvidence = {...evidence, milestoneId: 'milestone-a', decisionId: id(73)};
const first = {...csvLine, evidenceJson: JSON.stringify(firstEvidence)};
const second = {...csvLine, sequence: 2, lineId: id(70), itemId: id(71), eventId: id(72),
  evidenceJson: JSON.stringify(secondEvidence)};
const pair = milestoneInvoiceCsvArtifact({...csvSource, lines: [first,second]});
async function readPair(bytes) {
  raw = {...envelope, artifact: {...artifact, lineCount: 2, total: pair.total,
    sha256: createHash('sha256').update(bytes).digest('hex'), payloadBase64: bytes.toString('base64')}};
  return invoiceCsv.artifact(artifact.id, capture());
}
assert.deepEqual(Buffer.from((await readPair(pair.bytes)).bytes),pair.bytes);
for (const [key,column] of [['milestoneId',8],['lineId',2],['itemId',4],['eventId',6]]) {
  const duplicate = {...second};
  const rows = pair.bytes.toString('utf8').split('\r\n');
  const original = rows[1].split(','), changed = rows[2].split(',');
  if (key === 'milestoneId') {
    duplicate.evidenceJson = JSON.stringify({...secondEvidence, milestoneId:firstEvidence.milestoneId});
    changed[8] = original[8];
    changed[9] = 'b64:'+Buffer.from(duplicate.evidenceJson).toString('base64');
  } else {
    duplicate[key] = first[key].toUpperCase();
    changed[column] = duplicate[key];
  }
  rows[2] = changed.join(',');
  await assert.rejects(readPair(Buffer.from(rows.join('\r\n'))),{status:503},key);
  assert.throws(()=>milestoneInvoiceCsvArtifact({...csvSource,lines:[first,duplicate]}),undefined,key);
}
raw = { ...envelope, artifact: { ...artifact, sha256: 'f'.repeat(64) } };
await assert.rejects(invoiceCsv.artifact(artifact.id, capture()), { status: 503 });
raw = { ...envelope, artifact: { ...artifact, total: '125.16' } };
await assert.rejects(invoiceCsv.artifact(artifact.id, capture()), { status: 503 });
raw = {
  ...envelope,
  status: {
    requestId: artifact.requestId,
    batchId: batch.id,
    eventId: id(22),
    eventKey: 'invoice_batch.exported_or_billed_confirmed',
    state: 'Recorded',
    alertOutbox: null,
  },
};
assert.equal((await invoiceCsv.notificationStatus(artifact.requestId, capture())).state, 'Recorded');
raw = { ...raw, status: { ...raw.status, requestId: id(23) } };
await assert.rejects(invoiceCsv.notificationStatus(artifact.requestId, capture()), { status: 503 });
const confirmationSource = {
  sourceType: 'MILESTONE_ACCEPTANCE',
  batchId: batch.id,
  state: 'Exported',
  artifactId: artifact.id,
  artifactVersion: 1,
  artifactSha256: artifact.sha256,
  currency: 'USD',
  total: '125.15',
};
const confirmation = {
  id: id(24),
  sourceType: 'MILESTONE_ACCEPTANCE',
  batchId: batch.id,
  artifactId: artifact.id,
  artifactVersion: 1,
  artifactSha256: artifact.sha256,
  currency: 'USD',
  total: '125.15',
  method: 'MANUAL_ATTESTATION',
  reference: 'Synthetic downstream reference',
  actorId: actor,
  activeRole: 'Admin',
  requestId: id(25),
  reason: 'Synthetic attestation',
  operationId: 'synthetic',
  confirmedAt: createdAt,
};
raw = { ...envelope, source: confirmationSource, confirmation: null };
assert.equal(
  (await invoiceCsv.confirmationSource(batch.id, capture())).source.sourceType,
  'MILESTONE_ACCEPTANCE',
);
const confirm = {
  sourceType: 'MILESTONE_ACCEPTANCE',
  requestId: confirmation.requestId,
  batchId: batch.id,
  artifactId: artifact.id,
  artifactVersion: 1,
  artifactSha256: artifact.sha256,
  currency: 'USD',
  total: '125.15',
  reference: confirmation.reference,
  reason: confirmation.reason,
};
raw = { ...envelope, confirmation, replayed: false };
assert.equal((await invoiceCsv.confirm(confirm, capture())).method, 'MANUAL_ATTESTATION');
assert(!('sourceType' in lastBody));
raw = { ...envelope, confirmation: { ...confirmation, sourceType: undefined }, replayed: false };
await assert.rejects(invoiceCsv.confirm(confirm, capture()), { status: 503 });
raw = {
  ...envelope,
  source: { ...confirmationSource, state: 'Billed/Confirmed' },
  confirmation: { ...confirmation, sourceType: undefined },
};
await assert.rejects(invoiceCsv.confirmationSource(batch.id, capture()), { status: 503 });
storage.set(
  'workos_session',
  JSON.stringify({
    ...user,
    permissions: user.permissions.filter((x) => x !== 'commercial.milestone_billing.view'),
  }),
);
raw = { ...envelope, batch, lines: [line], total: { lineCount: 1, amount: '125.15' }, cancellation: null };
await assert.rejects(invoiceDrafts.inspect(batch.id, capture()), { status: 503 });
console.log(
  'Milestone client source discrimination, cancellation, approval source and CSV verification passed.',
);
