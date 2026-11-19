import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { calculateTmEntry } from '../shared/governed-tm-valuation.mjs';
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
      'commercial.cost_candidates.view',
      'employees.view',
      'commercial.tm_valuation.view',
      'commercial.tm_valuation.create',
    ],
  },
  reset = () => {
    values.set('workos_session', JSON.stringify(u));
    values.set('workos_organization_scope', JSON.stringify(scope));
    values.set('workos_api_token', 'synthetic-token');
  };
reset();
const { governedTmValuations: s, captureRateContext: capture } = await import(
  '../src/services/governedTmValuations.ts'
);
const actor = randomUUID(),
  policyId = randomUUID(),
  entryId = randomUUID(),
  billingId = randomUUID(),
  costId = randomUUID(),
  engagementId = 'synthetic-engagement',
  definition = {
    version: 'governed-tm/1',
    currency: 'USD',
    precision: 2,
    rounding: 'HALF_UP',
    aggregation: 'PER_ENTRY',
    capTreatment: 'NONE',
    exclusions: 'NONE',
    unit: 'HOUR',
    approvalTreatment: 'NONE',
  },
  base = {
    ...scope,
    ownerKey: createHash('sha256')
      .update(JSON.stringify([u.userName, u.id, u.role, scope.organizationId, scope.legalEntityId]))
      .digest('hex'),
    actorUserId: actor,
    activeRole: 'Admin',
    serverDate: '2026-10-28',
    calculationVersion: 'governed-tm/1',
  },
  policyCmd = {
    requestId: randomUUID(),
    engagementId,
    expectedLatestId: null,
    effectiveFrom: '2026-10-28',
    definition,
    reason: 'Synthetic policy',
  },
  policy = {
    id: policyId,
    engagementId,
    sequence: 1,
    previousId: null,
    effectiveFrom: policyCmd.effectiveFrom,
    definition,
    actorId: actor,
    activeRole: 'Admin',
    requestId: policyCmd.requestId,
    reason: policyCmd.reason,
    createdAt: '2026-10-28T00:00:00.000Z',
  },
  source = {
    submissionId: 'synthetic-submission',
    decisionId: 'synthetic-decision',
    entryId,
    workDate: '2026-10-28',
    hoursExact: '1.25',
    projectId: 'synthetic-project',
    workerId: 'synthetic-worker',
    workerName: 'Synthetic worker',
    workerStatus: 'Active',
    bindingId: 'synthetic-binding',
    valuationId: null,
  },
  command = {
    requestId: randomUUID(),
    engagementId,
    policyId,
    submissionId: source.submissionId,
    entryId,
    billingAdoptionId: billingId,
    costAdoptionId: costId,
    reason: 'Synthetic valuation',
  },
  result = calculateTmEntry({
    hours: source.hoursExact,
    billingRate: '100.1234',
    costRate: '40.0020',
    currency: 'USD',
    unit: 'HOUR',
    policy: definition,
  }),
  snapshot = {
    id: randomUUID(),
    engagementId,
    policyId,
    submissionId: source.submissionId,
    decisionId: source.decisionId,
    entryId,
    billingAdoptionId: billingId,
    costAdoptionId: costId,
    sourceEvidence: {
      submissionId: source.submissionId,
      decisionId: source.decisionId,
      entryId,
      projectId: source.projectId,
      bindingId: source.bindingId,
      workDate: source.workDate,
      hours: source.hoursExact,
      references: [{}, {}, {}],
      assignmentSnapshots: [{}],
      billingAdoptionId: billingId,
      costAdoptionId: costId,
      policyId,
    },
    result,
    actorId: actor,
    activeRole: 'Admin',
    requestId: command.requestId,
    reason: command.reason,
    createdAt: policy.createdAt,
  };
const rates = {
    billingId,
    billingAmount: '100.1234',
    costId,
    costAmount: '40.0020',
    currency: 'USD',
    unit: 'HOUR',
  },
  billingRate = {
    adoptionId: billingId,
    candidateId: randomUUID(),
    kind: 'billing',
    bindingType: 'engagement',
    bindingId: engagementId,
    priority: 1,
    effectiveFrom: source.workDate,
    effectiveTo: source.workDate,
    amount: rates.billingAmount,
    currency: 'USD',
    unit: 'HOUR',
  },
  costRate = {
    adoptionId: costId,
    candidateId: randomUUID(),
    kind: 'cost',
    bindingType: 'worker',
    bindingId: source.workerId,
    priority: 1,
    effectiveFrom: source.workDate,
    effectiveTo: source.workDate,
    amount: rates.costAmount,
    currency: 'USD',
    unit: 'HOUR',
  };
let raw = { ...base, policy, replayed: false },
  status = 201,
  change = () => {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  change();
  return new Response(JSON.stringify(raw), { status, headers: { 'Content-Type': 'application/json' } });
};
assert.equal((await s.policy(policyCmd, capture())).id, policyId);
raw = { ...base, valuation: snapshot, replayed: false };
assert.equal((await s.calculate(command, policy, source, rates, capture())).id, snapshot.id);
for (const bad of [
  { ...raw, organizationId: 'foreign' },
  { ...raw, ownerKey: 'b'.repeat(64) },
  { ...raw, actorUserId: randomUUID() },
  { ...raw, valuation: { ...snapshot, costAdoptionId: randomUUID() } },
  { ...raw, valuation: { ...snapshot, sourceEvidence: { ...snapshot.sourceEvidence, decisionId: 'other' } } },
  { ...raw, valuation: { ...snapshot, result: { ...result, marginValue: '999.99' } } },
  { ...raw, valuation: { ...snapshot, extra: true } },
]) {
  raw = bad;
  await assert.rejects(s.calculate(command, policy, source, rates, capture()), { status: 503 });
}
raw = {
  ...base,
  valuation: {
    ...snapshot,
    result: calculateTmEntry({
      hours: source.hoursExact,
      billingRate: '999.0000',
      costRate: '40.0020',
      currency: 'USD',
      unit: 'HOUR',
      policy: definition,
    }),
  },
  replayed: false,
};
await assert.rejects(s.calculate(command, policy, source, rates, capture()), { status: 503 });
status = 200;
raw = { ...base, valuation: snapshot };
assert.equal((await s.calculate(command, policy, source, rates, capture(), true)).id, snapshot.id);
assert.equal(calls.at(-1).init.method, 'GET');
raw = {
  ...base,
  valuation: snapshot,
  policy,
  resolutionRule: 'UNIQUE_HIGHEST_PRIORITY',
  billingRate,
  costRate,
};
assert.equal(
  (await s.inspect(snapshot.id, engagementId, { ...source, valuationId: snapshot.id }, capture())).valuation
    .id,
  snapshot.id,
);
for (const billing of [
  { ...billingRate, effectiveTo: '2026-10-27' },
  { ...billingRate, bindingType: 'contract', bindingId: 'unrelated-contract' },
]) {
  raw = { ...raw, billingRate: billing };
  await assert.rejects(
    s.inspect(snapshot.id, engagementId, { ...source, valuationId: snapshot.id }, capture()),
    { status: 503 },
  );
}
raw = { ...raw, billingRate: { ...billingRate, amount: '999.0000' } };
await assert.rejects(
  s.inspect(snapshot.id, engagementId, { ...source, valuationId: snapshot.id }, capture()),
  { status: 503 },
);
raw = { ...base, valuation: snapshot, replayed: false };
status = 201;
for (const mutate of [
  () => values.set('workos_api_token', 'other-token'),
  () => values.set('workos_session', JSON.stringify({ ...u, role: 'Employee', permissionRole: 'Employee' })),
  () => values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'foreign' })),
]) {
  reset();
  const c = capture();
  change = mutate;
  await assert.rejects(s.calculate(command, policy, source, rates, c), { status: 403 });
  const n = calls.length;
  await assert.rejects(s.calculate(command, policy, source, rates, c), { status: 403 });
  assert.equal(calls.length, n);
}
reset();
change = () => {};
const n = calls.length;
globalThis.fetch = async () => {
  calls.push({});
  throw Error('Synthetic uncertain transport');
};
await assert.rejects(s.calculate(command, policy, source, rates, capture()));
assert.equal(calls.length, n + 1);
assert.deepEqual(fallback, []);
console.log(
  'T&M policy and valuation source pins, exact results, scope fencing and no automatic retry passed.',
);
