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
      'commercial.contracts.manage',
      'commercial.tm_billing.view',
      'commercial.tm_billing.manage',
      'commercial.tm_billing.decide',
      'employees.view',
      'notifications.view',
      'approvals.view',
    ],
  },
  reset = () => {
    store.set('workos_session', JSON.stringify(user));
    store.set('workos_organization_scope', JSON.stringify(scope));
    store.set('workos_api_token', 'synthetic-token');
  };
reset();
const { tmBillingEligibility: s, captureRateContext: capture } = await import(
  '../src/services/tmBillingEligibility.ts'
);
const ownerKey = createHash('sha256')
    .update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId]))
    .digest('hex'),
  base = { ...scope, ownerKey, actorUserId: actor, activeRole: 'Admin', serverDate: '2026-10-28' },
  snapshotId = randomUUID(),
  policyId = randomUUID(),
  entryId = randomUUID(),
  rateId = randomUUID(),
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
  source = {
    snapshotId,
    engagementId: 'synthetic-engagement',
    policyId,
    submissionId: 'synthetic-submission',
    decisionId: 'synthetic-decision',
    entryId,
    billingAdoptionId: rateId,
    projectId: 'synthetic-project',
    bindingId: 'synthetic-binding',
    workDate: '2026-10-28',
    references: refs,
    currency: 'USD',
    amount: '125.15',
  },
  item = {
    id: randomUUID(),
    version: 1,
    eventId: randomUUID(),
    snapshotId,
    clientId: 'synthetic-client',
    contractId: 'synthetic-contract',
    engagementId: source.engagementId,
    eligibleOn: '2026-10-28',
    currency: 'USD',
    amount: '125.1500',
    evidence: source,
    createdAt: '2026-10-28T00:00:00.000Z',
  };
let raw = { ...base, items: [item], nextAfter: null },
  mutate = () => {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  mutate();
  return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
assert.equal((await s.register(capture())).items[0].id, item.id);
for (const bad of [
  { ...raw, legalEntityId: 'foreign' },
  { ...raw, actorUserId: randomUUID() },
  { ...raw, items: [{ ...item, contractId: 'other' }] },
  { ...raw, items: [{ ...item, amount: '125.16' }] },
  {
    ...raw,
    items: [
      {
        ...item,
        evidence: {
          ...source,
          references: refs.map((r) => (r.entityType === 'Project' ? { ...r, entityId: 'other' } : r)),
        },
      },
    ],
  },
  { ...raw, items: [{ ...item, evidence: { ...source, costValue: '50.00' } }] },
  { ...raw, items: [{ ...item, evidence: { ...source, marginValue: '75.15' } }] },
]) {
  raw = bad;
  await assert.rejects(s.register(capture()), { status: 503 });
}
raw = { ...base, items: [item], nextAfter: null };
for (const change of [
  () => store.set('workos_api_token', 'other'),
  () => store.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'foreign' })),
  () =>
    store.set('workos_session', JSON.stringify({ ...user, role: 'Employee', permissionRole: 'Employee' })),
]) {
  reset();
  const ctx = capture();
  mutate = change;
  await assert.rejects(s.register(ctx), { status: 403 });
  const count = calls.length;
  await assert.rejects(s.register(ctx), { status: 403 });
  assert.equal(calls.length, count);
}
reset();
mutate = () => {};
let count = calls.length;
globalThis.fetch = async () => {
  calls.push({});
  throw Error('Synthetic uncertain transport');
};
await assert.rejects(s.register(capture()));
assert.equal(calls.length, count + 1);
assert.deepEqual(fallback, []);
console.log('Billing-only response validation, exact amount, actor and scope fences passed.');
