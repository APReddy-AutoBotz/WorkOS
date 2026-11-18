import assert from 'node:assert/strict';
import { randomUUID, createHash, webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
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
      'commercial.invoice_batch.confirm',
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
const { invoiceCsv: s, captureRateContext: capture } = await import('../src/services/invoiceCsv.ts');
const ownerKey = createHash('sha256')
    .update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId]))
    .digest('hex'),
  base = { ...scope, ownerKey, actorUserId: actor, activeRole: 'Admin', serverDate: '2026-10-28' },
  batchId = randomUUID(),
  artifactId = randomUUID(),
  requestId = randomUUID(),
  source = {
    batchId,
    state: 'Exported',
    artifactId,
    artifactVersion: 1,
    artifactSha256: 'a'.repeat(64),
    currency: 'USD',
    total: '125.15',
  },
  op = {
    requestId,
    batchId,
    artifactId,
    artifactVersion: 1,
    artifactSha256: source.artifactSha256,
    currency: 'USD',
    total: '125.15',
    reference: 'SYNTHETIC-REFERENCE',
    reason: 'Synthetic manual attestation',
  },
  confirmation = {
    id: randomUUID(),
    ...op,
    method: 'MANUAL_ATTESTATION',
    actorId: actor,
    activeRole: 'Admin',
    operationId: 'synthetic-operation',
    confirmedAt: '2026-10-28T00:00:00Z',
  };
let raw = { ...base, source, confirmation: null },
  mutate = () => {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  mutate();
  return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
assert.equal((await s.confirmationSource(batchId, capture())).source.artifactId, artifactId);
raw = { ...base, source: { ...source, state: 'Billed/Confirmed' }, confirmation };
assert.equal((await s.confirmationSource(batchId, capture())).confirmation.id, confirmation.id);
for (const bad of [
  { ...raw, source: { ...source, state: 'Billed/Confirmed' }, confirmation: null },
  { ...raw, confirmation: { ...confirmation, artifactSha256: 'b'.repeat(64) } },
  { ...raw, confirmation: { ...confirmation, reference: 'bad\nreference' } },
  { ...raw, source: { ...raw.source, total: '0' } },
  { ...raw, legalEntityId: 'foreign' },
]) {
  raw = bad;
  await assert.rejects(s.confirmationSource(batchId, capture()), { status: 503 });
}
raw = { ...base, confirmation, replayed: false };
assert.equal((await s.confirm(op, capture())).id, confirmation.id);
raw = { ...base, confirmation: { ...confirmation, method: 'PROVIDER_VERIFIED' }, replayed: false };
await assert.rejects(s.confirm(op, capture()), { status: 503 });
raw = { ...base, confirmation, replayed: false };
reset();
const c = capture();
mutate = () => store.set('workos_api_token', 'other');
await assert.rejects(s.confirm(op, c), { status: 403 });
const n = calls.length;
await assert.rejects(s.confirm(op, c), { status: 403 });
assert.equal(calls.length, n);
reset();
mutate = () => {};
globalThis.fetch = async () => {
  calls.push({});
  throw Error('Synthetic uncertainty');
};
const before = calls.length;
await assert.rejects(s.confirm(op, capture()));
assert.equal(calls.length, before + 1);
console.log('Manual confirmation client validates source, identity, receipts and no automatic write retry.');
