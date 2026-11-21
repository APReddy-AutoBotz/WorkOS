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
      throw Error('No fallback');
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
    id: 'synthetic-record',
    employeeId: 'SYN-ACTOR',
    userName: 'synthetic-actor',
    role: 'Admin',
    permissionRole: 'Admin',
    permissions: [
      'commercial.contracts.view',
      'commercial.contracts.manage',
      'commercial.rate_candidates.view',
      'commercial.rate_candidates.manage',
    ],
  },
  reset = () => {
    values.set('workos_session', JSON.stringify(u));
    values.set('workos_organization_scope', JSON.stringify(scope));
    values.set('workos_api_token', 'synthetic-token');
  };
reset();
const { approvedRateSources: s } = await import('../src/services/approvedRateSources.ts');
const { captureRateContext: capture } = await import('../src/services/rateCandidates.ts');
const actor = randomUUID(),
  candidateId = randomUUID(),
  ownerId = randomUUID(),
  policyId = randomUUID(),
  approvalId = randomUUID(),
  finalId = randomUUID(),
  base = {
    ...scope,
    ownerKey: createHash('sha256')
      .update(JSON.stringify([u.userName, u.id, u.role, scope.organizationId, scope.legalEntityId]))
      .digest('hex'),
    actorUserId: actor,
    activeRole: 'Admin',
    serverDate: '2026-10-28',
    authority: 'adopted_source',
  },
  cmd = {
    requestId: randomUUID(),
    candidateId,
    expectedOwnerEventId: ownerId,
    approvalId,
    expectedPolicyId: policyId,
    expectedFinalTransitionId: finalId,
    reason: 'Synthetic adoption',
  },
  a = {
    id: randomUUID(),
    candidateId,
    ownerEventId: ownerId,
    approvalId,
    policyId,
    finalTransitionId: finalId,
    actorId: actor,
    activeRole: 'Admin',
    requestId: cmd.requestId,
    reason: cmd.reason,
    createdAt: '2026-10-28T00:00:00.000Z',
  };
let raw = { ...base, kind: 'billing', adoption: a, replayed: false },
  status = 201,
  change = () => {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  change();
  return new Response(JSON.stringify(raw), { status, headers: { 'Content-Type': 'application/json' } });
};
assert.equal((await s.adopt(cmd, 'billing', capture())).id, a.id);
for (const bad of [
  { ...raw, organizationId: 'foreign' },
  { ...raw, ownerKey: 'b'.repeat(64) },
  { ...raw, actorUserId: randomUUID() },
  { ...raw, adoption: { ...a, ownerEventId: randomUUID() } },
  { ...raw, adoption: { ...a, approvalId: randomUUID() } },
  { ...raw, adoption: { ...a, finalTransitionId: randomUUID() } },
  { ...raw, adoption: { ...a, extra: true } },
]) {
  raw = bad;
  await assert.rejects(s.adopt(cmd, 'billing', capture()), { status: 503 });
}
status = 200;
raw = { ...base, kind: 'billing', adoption: a };
assert.equal((await s.adopt(cmd, 'billing', capture(), true)).id, a.id);
assert.equal(calls.at(-1).init.method, 'GET');
const q = {
    kind: 'billing',
    sourceId: 'synthetic-engagement',
    asOf: '2026-10-28',
    currency: 'USD',
    unit: 'HOUR',
  },
  candidate = {
    id: candidateId,
    streamId: randomUUID(),
    sequence: 1,
    previousId: null,
    kind: 'billing',
    bindingType: 'engagement',
    bindingId: q.sourceId,
    effectiveFrom: '2026-10-28',
    effectiveTo: '2026-10-29',
    currency: 'USD',
    unit: 'HOUR',
    amount: '23.0000',
    priority: 10,
    requestId: randomUUID(),
    actorId: actor,
    activeRole: 'Admin',
    reason: 'Synthetic candidate',
    createdAt: a.createdAt,
    adoptionId: a.id,
    ownerEventId: ownerId,
    approvalId,
    policyId,
    finalTransitionId: finalId,
    adoptedAt: a.createdAt,
  };
raw = { ...base, selection: q, result: 'source', source: candidate };
assert.equal((await s.resolve(q, capture())).source.amount, '23.0000');
raw = { ...raw, source: { ...candidate, bindingId: 'foreign' } };
await assert.rejects(s.resolve(q, capture()), { status: 503 });
raw = { ...base, selection: q, result: 'conflict', source: null };
assert.equal((await s.resolve(q, capture())).result, 'conflict');
const pair = [candidate.id, randomUUID()];
raw = { ...raw, conflict: { priority: 10, candidateIds: pair } };
assert.deepEqual((await s.resolve(q, capture())).conflict.candidateIds, pair);
raw = { ...raw, conflict: { priority: 10, candidateIds: [pair[0], pair[0]] } };
await assert.rejects(s.resolve(q, capture()), { status: 503 });
raw = { ...raw, result: 'source', source: candidate, conflict: { priority: 10, candidateIds: pair } };
await assert.rejects(s.resolve(q, capture()), { status: 503 });
raw = { ...base, kind: 'billing', adoption: a, replayed: false };
status = 201;
for (const mutate of [
  () => values.set('workos_api_token', 'other-token'),
  () => values.set('workos_session', JSON.stringify({ ...u, role: 'Employee', permissionRole: 'Employee' })),
  () => values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'foreign' })),
]) {
  reset();
  const c = capture();
  change = mutate;
  await assert.rejects(s.adopt(cmd, 'billing', c), { status: 403 });
  const n = calls.length;
  await assert.rejects(s.adopt(cmd, 'billing', c), { status: 403 });
  assert.equal(calls.length, n);
}
reset();
change = () => {};
const n = calls.length;
globalThis.fetch = async () => {
  calls.push({});
  throw Error('Synthetic uncertain transport');
};
await assert.rejects(s.adopt(cmd, 'billing', capture()));
assert.equal(calls.length, n + 1);
assert.deepEqual(fallback, []);
console.log('Adoption source pins, exact receipts, scope fencing and no automatic retry passed.');
