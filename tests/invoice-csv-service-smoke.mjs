import assert from 'node:assert/strict';
import { randomUUID, createHash, webcrypto } from 'node:crypto';
import { invoiceCsvArtifact } from '../server/modules/invoice-export/csv.mjs';
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
globalThis.crypto ??= webcrypto;
const store = new Map(),
  calls = [];
globalThis.sessionStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.localStorage = Object.fromEntries(
  ['getItem', 'setItem', 'removeItem', 'clear'].map((k) => [
    k,
    () => {
      throw Error('No fallback');
    },
  ]),
);
globalThis.window = {
  localStorage,
  location: { pathname: '/commercial-drafting', href: '/commercial-drafting' },
  dispatchEvent: () => true,
};
const actor = randomUUID(),
  scope = { organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal' },
  user = {
    id: actor,
    employeeId: 'SYN-ACTOR',
    userName: 'synthetic-actor',
    role: 'Admin',
    permissionRole: 'Admin',
    permissions: [
      'commercial.contracts.view',
      'commercial.tm_billing.view',
      'commercial.invoice_drafts.view',
      'commercial.invoice_export.view',
      'commercial.invoice_export.create',
      'employees.view',
      'notifications.view',
    ],
  },
  reset = () => {
    store.set('workos_session', JSON.stringify(user));
    store.set('workos_organization_scope', JSON.stringify(scope));
    store.set('workos_api_token', 'synthetic-token');
  };
reset();
const { invoiceCsv, captureRateContext: capture } = await import('../src/services/invoiceCsv.ts');
const ownerKey = createHash('sha256')
    .update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId]))
    .digest('hex'),
  base = { ...scope, ownerKey, actorUserId: actor, activeRole: 'Admin', serverDate: '2026-10-28' },
  batchId = randomUUID(),
  approvalId = randomUUID(),
  finalTransitionId = randomUUID(),
  requestId = randomUUID(),
  artifactId = randomUUID(),
  snapshotId = randomUUID(),
  refs = ['Project', 'Engagement', 'Contract'].map((entityType) => ({
    entityType,
    entityId:
      entityType === 'Project'
        ? 'synthetic-project'
        : entityType === 'Engagement'
          ? 'synthetic-engagement'
          : 'synthetic-contract',
    lifecycleEventId: 'synthetic-lifecycle',
    contractVersionId: 'synthetic-version',
  })),
  evidence = {
    snapshotId,
    engagementId: 'synthetic-engagement',
    policyId: randomUUID(),
    submissionId: 'synthetic-submission',
    decisionId: 'synthetic-decision',
    entryId: randomUUID(),
    billingAdoptionId: randomUUID(),
    projectId: 'synthetic-project',
    bindingId: 'synthetic-binding',
    workDate: '2026-10-28',
    references: refs,
    currency: 'USD',
    amount: '125.15',
  },
  line = {
    lineId: randomUUID(),
    sequence: 1,
    itemId: randomUUID(),
    itemVersion: 1,
    eventId: randomUUID(),
    snapshotId,
    currency: 'USD',
    amount: '125.15',
    workDate: '2026-10-28',
    eligibleDate: '2026-10-28',
    evidenceJson: JSON.stringify(evidence),
  },
  source = {
    batchId,
    clientId: 'synthetic-client',
    contractId: 'synthetic-contract',
    engagementId: 'synthetic-engagement',
    currency: 'USD',
    periodStart: '2026-10-28',
    periodEnd: '2026-10-28',
    periodBasis: 'WORK_DATE',
    lines: [line],
  },
  rendered = invoiceCsvArtifact(source),
  artifact = {
    id: artifactId,
    batchId,
    approvalId,
    finalTransitionId,
    lineageHash: 'a'.repeat(64),
    schemaVersion: rendered.schemaVersion,
    version: 1,
    sha256: rendered.sha256,
    lineCount: 1,
    currency: 'USD',
    total: rendered.total,
    actorId: actor,
    activeRole: 'Admin',
    requestId,
    reason: 'Synthetic export',
    operationId: 'synthetic-operation',
    generatedAt: '2026-10-28T00:00:00Z',
    payloadBase64: rendered.bytes.toString('base64'),
  };
let raw = { ...base, artifact },
  mutate = () => {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  mutate();
  return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
assert.deepEqual(Buffer.from((await invoiceCsv.artifact(artifactId, capture())).bytes), rendered.bytes);
for (const a of [
  { ...artifact, sha256: 'b'.repeat(64) },
  { ...artifact, total: '125.16' },
  { ...artifact, lineCount: 2 },
  { ...artifact, batchId: randomUUID() },
]) {
  raw = { ...base, artifact: a };
  await assert.rejects(invoiceCsv.artifact(artifactId, capture()), { status: 503 });
}
const secondSnapshot = randomUUID(),
  secondLine = {
    ...line,
    lineId: randomUUID(),
    sequence: 2,
    itemId: randomUUID(),
    eventId: randomUUID(),
    snapshotId: secondSnapshot,
    evidenceJson: JSON.stringify({ ...evidence, snapshotId: secondSnapshot }),
  },
  two = invoiceCsvArtifact({ ...source, lines: [line, secondLine] }),
  rows = two.bytes.toString('utf8').split('\r\n'),
  columns = rows[2].split(',');
async function readTwoRows(cells) {
  const bytes = Buffer.from([rows[0], rows[1], cells.join(','), ''].join('\r\n'));
  raw = { ...base, artifact: { ...artifact, lineCount: 2, total: two.total,
    payloadBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } };
  return invoiceCsv.artifact(artifactId, capture());
}
assert.deepEqual(Buffer.from((await readTwoRows(columns)).bytes), two.bytes);
const changedClient = [...columns];
changedClient[9] = 'b64:' + Buffer.from('other-client').toString('base64');
await assert.rejects(readTwoRows(changedClient), { status: 503 });

for (const [field, column] of [['lineId', 2], ['itemId', 4], ['eventId', 6], ['snapshotId', 7]]) {
  const duplicate = line[field].toUpperCase();
  const repeated = {...secondLine, [field]: duplicate};
  const changed = [...columns];
  changed[column] = duplicate;
  if (field === 'snapshotId') {
    repeated.evidenceJson = JSON.stringify({...evidence, snapshotId: duplicate});
    changed[8] = 'b64:' + Buffer.from(repeated.evidenceJson).toString('base64');
  }
  assert.throws(() => invoiceCsvArtifact({...source, lines: [line, repeated]}), undefined, field);
  await assert.rejects(readTwoRows(changed), {status: 503}, field);
}
raw = { ...base, artifact };
for (const change of [
  () => store.set('workos_api_token', 'other'),
  () => store.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'foreign' })),
]) {
  reset();
  const c = capture();
  mutate = change;
  await assert.rejects(invoiceCsv.artifact(artifactId, c), { status: 403 });
  const n = calls.length;
  await assert.rejects(invoiceCsv.artifact(artifactId, c), { status: 403 });
  assert.equal(calls.length, n);
}
reset();
mutate = () => {};
const op = {
  requestId,
  batchId,
  approvalId,
  finalTransitionId,
  lineageHash: 'a'.repeat(64),
  schemaVersion: 'workos.invoice-tm-csv/1',
  expectedLineCount: 1,
  expectedTotal: '125.15',
  reason: 'Synthetic export',
};
globalThis.fetch = async () => {
  calls.push({});
  throw Error('Synthetic uncertain transport');
};
const n = calls.length;
await assert.rejects(invoiceCsv.run(op, capture()));
assert.equal(calls.length, n + 1, 'Uncertain export writes are never retried automatically');
console.log('Invoice CSV client verifies retained bytes, totals, source context and uncertainty.');
