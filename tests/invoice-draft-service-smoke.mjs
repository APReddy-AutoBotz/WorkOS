import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const store = new Map(),
  fallback = [],
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
      fallback.push(k);
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
      'commercial.invoice_drafts.prepare',
      'commercial.invoice_drafts.cancel',
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
const { invoiceDrafts: s, captureRateContext: capture } = await import('../src/services/invoiceDrafts.ts');
const ownerKey = createHash('sha256')
    .update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId]))
    .digest('hex'),
  base = { ...scope, ownerKey, actorUserId: actor, activeRole: 'Admin', serverDate: '2026-10-28' },
  batchId = randomUUID(),
  snapshotId = randomUUID(),
  requestId = randomUUID(),
  itemId = randomUUID(),
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
  batch = {
    id: batchId,
    clientId: 'synthetic-client',
    contractId: 'synthetic-contract',
    engagementId: 'synthetic-engagement',
    currency: 'USD',
    periodStart: '2026-10-28',
    periodEnd: '2026-10-28',
    periodBasis: 'WORK_DATE',
    ownerUserId: actor,
    ownerRole: 'Admin',
    preparerUserId: actor,
    preparerRole: 'Admin',
    requestId: randomUUID(),
    reason: 'Synthetic draft',
    createdAt: '2026-10-28T00:00:00Z',
    ownerCurrent: true,
    state: 'Draft',
  },
  line = {
    id: randomUUID(),
    batchId,
    sequence: 1,
    itemId,
    itemVersion: 1,
    eventId: randomUUID(),
    snapshotId,
    currency: 'USD',
    amount: '125.15',
    evidence,
    actorId: actor,
    activeRole: 'Admin',
    requestId,
    reason: 'Synthetic reserve',
    createdAt: '2026-10-28T00:00:00Z',
  };
let raw = { ...base, batch, lines: [line], total: { lineCount: 1, amount: '125.15' }, cancellation: null },
  mutate = () => {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  mutate();
  return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
assert.equal((await s.inspect(batchId, capture())).lines[0].id, line.id);
const valid = raw;
for (const bad of [
  { ...valid, legalEntityId: 'foreign' },
  { ...valid, actorUserId: randomUUID() },
  { ...valid, total: { lineCount: 1, amount: '125.16' } },
  { ...valid, lines: [{ ...line, sequence: 2 }] },
  { ...valid, lines: [{ ...line, evidence: { ...evidence, costValue: '50' } }] },
  { ...valid, batch: { ...batch, contractId: 'foreign' } },
]) {
  raw = bad;
  await assert.rejects(s.inspect(batchId, capture()), { status: 503 });
}
raw = valid;
for (const change of [
  () => store.set('workos_api_token', 'other'),
  () => store.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'foreign' })),
  () =>
    store.set('workos_session', JSON.stringify({ ...user, role: 'Employee', permissionRole: 'Employee' })),
]) {
  reset();
  const c = capture();
  mutate = change;
  await assert.rejects(s.inspect(batchId, c), { status: 403 });
  const n = calls.length;
  await assert.rejects(s.inspect(batchId, c), { status: 403 });
  assert.equal(calls.length, n);
}
reset();
mutate = () => {};
raw = { ...valid, line, replayed: false };
const op = {
  type: 'line',
  batchId,
  data: { requestId, itemId, itemVersion: 1, expectedLineCount: 0, reason: 'Synthetic reserve' },
};
assert.equal((await s.run(op, capture())).line.id, line.id);
raw = { ...raw, line: { ...line, itemId: randomUUID() } };
await assert.rejects(s.run(op, capture()), { status: 503 });
let n = calls.length;
globalThis.fetch = async () => {
  calls.push({});
  throw Error('Synthetic uncertain transport');
};
await assert.rejects(s.run(op, capture()));
assert.equal(calls.length, n + 1, 'An uncertain write is not retried automatically');
assert.deepEqual(fallback, []);
console.log('Invoice draft exact totals, response, scope fences and uncertain-write behavior passed.');
