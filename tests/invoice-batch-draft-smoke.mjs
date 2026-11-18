import assert from 'node:assert/strict';
import { validInvoiceDraft, invoiceItemMatches, invoiceDraftTotal } from '../shared/invoice-batch-draft.mjs';
const owner = '00000000-0000-4000-8000-000000000001',
  itemId = '00000000-0000-4000-8000-000000000002',
  draft = {
    clientId: 'synthetic-client',
    contractId: 'synthetic-contract',
    engagementId: 'synthetic-engagement',
    currency: 'USD',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    periodBasis: 'WORK_DATE',
    ownerUserId: owner,
    ownerRole: 'Admin',
  },
  item = {
    itemId,
    itemVersion: 1,
    clientId: draft.clientId,
    contractId: draft.contractId,
    engagementId: draft.engagementId,
    currency: 'USD',
    workDate: '2026-10-12',
    eligibleOn: '2026-11-01',
    amount: '125.1500',
    current: true,
  };
assert.equal(validInvoiceDraft(draft), true);
for (const mutation of [
  { periodBasis: '' },
  { periodStart: '2026-02-30' },
  { periodEnd: '2026-09-30' },
  { currency: 'usd' },
  { ownerRole: '' },
  { ownerUserId: 'unknown' },
  { extra: true },
])
  assert.equal(validInvoiceDraft({ ...draft, ...mutation }), false);
assert.equal(invoiceItemMatches(draft, item), true);
assert.equal(invoiceItemMatches({ ...draft, periodBasis: 'ELIGIBLE_DATE' }, item), false);
assert.equal(
  invoiceItemMatches({ ...draft, periodBasis: 'ELIGIBLE_DATE', periodEnd: '2026-11-01' }, item),
  true,
);
for (const mutation of [
  { current: false },
  { itemVersion: 2 },
  { clientId: 'foreign' },
  { contractId: 'foreign' },
  { engagementId: 'foreign' },
  { currency: 'EUR' },
  { amount: '0.0000' },
  { amount: '1e4' },
  { workDate: '2026-11-01' },
  { extra: true },
])
  assert.equal(invoiceItemMatches(draft, { ...item, ...mutation }), false);
assert.deepEqual(invoiceDraftTotal(['125.1500', '0.0001', '9999999999999999.9999']), {
  lineCount: 3,
  amount: '10000000000000125.15',
});
assert.deepEqual(invoiceDraftTotal([]), { lineCount: 0, amount: '0' });
assert.throws(() => invoiceDraftTotal(['0']));
assert.throws(() => invoiceDraftTotal(['1.00001']));
console.log('Explicit invoice draft basis, scope, source and decimal totals passed.');
