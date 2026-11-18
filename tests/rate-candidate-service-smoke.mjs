import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const values = new Map(),
  calls = [],
  fallback = [];
globalThis.sessionStorage = {
  getItem: (k) => values.get(k) ?? null,
  setItem: (k, v) => values.set(k, String(v)),
  removeItem: (k) => values.delete(k),
};
globalThis.localStorage = Object.fromEntries(
  ['getItem', 'setItem', 'removeItem', 'clear'].map((k) => [
    k,
    () => {
      fallback.push(k);
      throw Error('No rate fallback');
    },
  ]),
);
globalThis.window = {
  localStorage,
  location: { pathname: '/commercial-drafting', href: '/commercial-drafting' },
  dispatchEvent: () => true,
};
const scope = { organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal' },
  u = {
    id: 'synthetic-actor-record',
    employeeId: 'SYN-RATE',
    userName: 'synthetic-rate-actor',
    role: 'Admin',
    permissionRole: 'Admin',
    permissions: [
      'commercial.contracts.view',
      'commercial.rate_candidates.view',
      'commercial.rate_candidates.manage',
    ],
  },
  reset = () => {
    values.set('workos_session', JSON.stringify(u));
    values.set('workos_organization_scope', JSON.stringify(scope));
    values.set('workos_api_token', 'synthetic-rate-token');
  };
reset();
const {
  rateCandidateService: s,
  captureRateContext: capture,
  rateCandidateInput,
} = await import('../src/services/rateCandidates.ts');
const actor = randomUUID(),
  input = {
    requestId: randomUUID(),
    streamId: randomUUID(),
    expectedLatestId: null,
    kind: 'billing',
    bindingType: 'contract',
    bindingId: 'synthetic-contract',
    effectiveFrom: '2026-10-27',
    effectiveTo: '2026-10-29',
    currency: 'USD',
    unit: 'HOUR',
    amount: '12345678901234.1234',
    priority: 30,
    reason: 'Synthetic unapproved rate',
  },
  event = {
    id: randomUUID(),
    streamId: input.streamId,
    sequence: 1,
    previousId: null,
    kind: input.kind,
    bindingType: input.bindingType,
    bindingId: input.bindingId,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    currency: input.currency,
    unit: input.unit,
    amount: input.amount,
    priority: input.priority,
    requestId: input.requestId,
    actorId: actor,
    activeRole: 'Admin',
    reason: input.reason,
    createdAt: '2026-10-27T00:00:00.000Z',
  },
  base = {
    ...scope,
    ownerKey: createHash('sha256')
      .update(JSON.stringify([u.userName, u.id, u.role, scope.organizationId, scope.legalEntityId]))
      .digest('hex'),
    actorUserId: actor,
    activeRole: 'Admin',
    serverDate: input.effectiveFrom,
    previewOnly: true,
  },
  receipt = { ...base, candidate: event, replayed: false };
let raw = receipt,
  status = 201,
  change = () => {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  change();
  return new Response(JSON.stringify(raw), { status, headers: { 'Content-Type': 'application/json' } });
};
assert(rateCandidateInput.safeParse(input).success);
for (const x of [
  { ...input, amount: '1e3' },
  { ...input, amount: '1.00001' },
  { ...input, priority: -1 },
  { ...input, kind: 'cost', bindingType: 'contract' },
  { ...input, extra: true },
])
  assert(!rateCandidateInput.safeParse(x).success);
assert.deepEqual(await s.submit(input, capture()), event);
for (const bad of [
  { ...receipt, organizationId: 'foreign' },
  { ...receipt, ownerKey: 'b'.repeat(64) },
  { ...receipt, actorUserId: randomUUID() },
  { ...receipt, candidate: { ...event, amount: '1.0000' } },
  { ...receipt, candidate: { ...event, extra: true } },
  { ...receipt, previewOnly: false },
]) {
  raw = bad;
  await assert.rejects(s.submit(input, capture()), { status: 503 });
}
status = 200;
raw = { ...base, candidate: event };
assert.deepEqual(await s.submit(input, capture(), true), event);
assert.equal(calls.at(-1).init.method, 'GET');
raw = { ...base, candidates: [event], truncated: false };
assert.equal((await s.list('billing', 'contract', input.bindingId, capture())).candidates.length, 1);
raw = { ...raw, candidates: [{ ...event, kind: 'cost' }] };
await assert.rejects(s.list('billing', 'contract', input.bindingId, capture()), { status: 503 });
const selection = {
  kind: 'billing',
  sourceId: 'synthetic-engagement',
  asOf: input.effectiveFrom,
  currency: 'USD',
  unit: 'HOUR',
};
raw = { ...base, selection, result: 'candidate', candidate: event, matchingBasis: 'contract' };
assert.equal(
  (
    await s.preview(
      'billing',
      selection.sourceId,
      selection.asOf,
      selection.currency,
      selection.unit,
      capture(),
    )
  ).candidate.amount,
  input.amount,
);
raw = { ...raw, candidate: { ...event, currency: 'EUR' } };
await assert.rejects(
  s.preview('billing', selection.sourceId, selection.asOf, selection.currency, selection.unit, capture()),
  { status: 503 },
);
const beforeDenied = calls.length;
await assert.rejects(
  s.preview('cost', 'synthetic-worker', selection.asOf, selection.currency, selection.unit, capture()),
  { status: 403 },
);
assert.equal(calls.length, beforeDenied);
raw = receipt;
status = 201;
for (const mutate of [
  () => values.set('workos_api_token', 'other-token'),
  () => values.set('workos_session', JSON.stringify({ ...u, role: 'Employee', permissionRole: 'Employee' })),
  () => values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'foreign' })),
]) {
  reset();
  const ctx = capture();
  change = mutate;
  await assert.rejects(s.submit(input, ctx), { status: 403 });
  const n = calls.length;
  await assert.rejects(s.submit(input, ctx), { status: 403 });
  assert.equal(calls.length, n);
}
reset();
change = () => {};
const n = calls.length;
globalThis.fetch = async () => {
  calls.push({});
  throw Error('Synthetic uncertain transport');
};
await assert.rejects(s.submit(input, capture()));
assert.equal(calls.length, n + 1);
assert.deepEqual(fallback, []);
console.log('Rate candidates strict decimals, scoped receipts, owner fences and no write retry passed.');
