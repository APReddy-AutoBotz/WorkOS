import assert from 'node:assert/strict';
import {
  readBillingReconciliation,
  readPortfolioReconciliation,
} from '../server/modules/invoice-drafts/reconciliation.mjs';
import {
  reconciliationCsv,
  portfolioReconciliationCsv,
  reconciliationToken,
} from '../server/modules/invoice-drafts/reconciliation-csv.mjs';

const scope = { organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal' };
const req = { organizationScope: scope };
const row = (n, currency = 'USD') => ({
  itemId: `item-${n}`,
  itemVersion: 1,
  eventId: `event-${n}`,
  eventVersion: 1,
  sourceType: 'TM_SNAPSHOT',
  snapshotId: `source-${n}`,
  engagementId: 'synthetic-engagement',
  currency,
  amount: '0.0001',
  sourceCurrency: currency,
  sourceAmount: '0.0001',
  sourceMatches: true,
  sourceCurrent: true,
  batchId: null,
  lineId: null,
  lineAmount: null,
  lineCurrency: null,
  batchState: null,
  artifactId: null,
  artifactHash: null,
  confirmationId: null,
  lineMatches: true,
  artifactMatches: true,
  history: [],
  historicalLineCount: 0,
});
const fake = (rows, missing = []) => ({
  query: async (sql) =>
    sql.includes('select ev.id as "eventId"')
      ? { rows: missing }
      : sql.includes('from approved_unbilled_items item')
        ? { rows }
        : { rows: [{ ts: new Date('2026-01-01T00:00:00Z') }] },
});
const options = { buildEmployeeScopeWhere: () => 'true' };
const atLimit = await readBillingReconciliation(
  fake(Array.from({ length: 500 }, (_, n) => row(n))),
  req,
  'synthetic-engagement',
  options,
);
assert.equal(atLimit.items.length, 500);
assert.equal(atLimit.controls.find((c) => c.boundary === 'REGISTER_ITEM').amount, '0.05');
await assert.rejects(
  readBillingReconciliation(
    fake(Array.from({ length: 501 }, (_, n) => row(n))),
    req,
    'synthetic-engagement',
    options,
  ),
  (e) => e.statusCode === 422 && e.code === 'BILLING_RECONCILIATION_LIMIT',
);
const missing = {
  eventId: 'missing',
  snapshotId: 'missing-source',
  currency: 'USD',
  amount: '1.0000',
  sourceCurrency: 'USD',
  sourceAmount: '1.0000',
};
const exception = await readBillingReconciliation(
  fake([row(0)], [missing]),
  req,
  'synthetic-engagement',
  options,
);
assert.equal(exception.exceptionCount, 1);
assert.equal(exception.controls.find((c) => c.boundary === 'ELIGIBILITY_EVENT').amount, '1.0001');
assert.equal(exception.controls.find((c) => c.boundary === 'REGISTER_ITEM').amount, '0.0001');
await assert.rejects(
  readBillingReconciliation(
    fake(
      Array.from({ length: 500 }, (_, n) => row(n)),
      [missing],
    ),
    req,
    'synthetic-engagement',
    options,
  ),
  (e) => e.statusCode === 422 && e.code === 'BILLING_RECONCILIATION_LIMIT',
);
const mixed = await readBillingReconciliation(
  fake([row(1), row(2, 'EUR')]),
  req,
  'synthetic-engagement',
  options,
);
assert.deepEqual(
  mixed.controls.filter((c) => c.boundary === 'REGISTER_ITEM').map((c) => [c.currency, c.amount]),
  [
    ['EUR', '0.0001'],
    ['USD', '0.0001'],
  ],
);
const token = reconciliationToken(scope, mixed),
  csv = reconciliationCsv({ ...scope, organizationId: '=synthetic' }, mixed, token);
assert(csv.includes('"\'=synthetic"'), 'Spreadsheet formula prefixes must be escaped');
assert(csv.includes('EVENT_BACKED_SOURCE') && csv.includes('REGISTER_ITEM'));
assert(
  csv
    .trimEnd()
    .split('\r\n')
    .every((line) => line.split('","').length === 23),
  'Every CSV row must have the declared columns',
);
console.log('Scoped reconciliation 500/501 boundary, currency isolation and CSV escaping passed.');

for (const unsafeId of ['\t=1+1', '\r=1+1', '  ＝1+1', '＠SUM(1)', '\nordinary']) {
  const protectedCsv = reconciliationCsv({ ...scope, organizationId: unsafeId }, mixed, token);
  assert(
    protectedCsv.includes('"\'' + unsafeId + '"'),
    'Reconciliation uses the shared literal-text prefix rule',
  );
}

const tmEntries = Array.from({ length: 502 }, (_, n) => ({
  ...row(n),
  engagementId: n % 2 ? 'alpha' : 'beta',
}));
const milestoneEntries = [
  { ...row(503), acceptanceMatches: true },
  { ...row(504, 'EUR'), acceptanceMatches: true },
];
const missingEvents = Array.from({ length: 501 }, (_, n) => ({ ...missing, eventId: 'missing-' + n }));
const pagedClient = {
  query: async (sql, args) => {
    if (!args) return { rows: [{ ts: new Date('2026-01-01T00:00:00Z') }] };
    const isMissing = sql.includes('select ev.id as "eventId"'),
      isMilestone = sql.includes("eng.model='milestone'");
    const data = isMissing ? (isMilestone ? [] : missingEvents) : isMilestone ? milestoneEntries : tmEntries,
      label = isMissing ? 'eventId' : 'itemId';
    const offset = args[4] === null ? 0 : data.findIndex((x) => x[label] === args[4]) + 1;
    return { rows: data.slice(offset, offset + 501) };
  },
};
const portfolio = await readPortfolioReconciliation(pagedClient, req, options, {
  start: '2026-01-01',
  end: '2026-01-31',
  source: 'both',
});
assert.equal(portfolio.exceptionCount, 501);
assert.deepEqual(
  portfolio.controls
    .filter((x) => x.boundary === 'REGISTER_ITEM')
    .map((x) => [x.currency, x.lineCount, x.amount]),
  [
    ['EUR', 1, '0.0001'],
    ['USD', 503, '0.0503'],
  ],
);
assert.equal(
  portfolio.controls.find((x) => x.currency === 'USD' && x.boundary === 'ELIGIBILITY_EVENT').amount,
  '501.0503',
);

const emptyCsv = portfolioReconciliationCsv(
  { ...scope, organizationId: '=synthetic' },
  { ...portfolio, controls: [], totals: [], reportToken: 'synthetic-token' },
);
assert.equal(emptyCsv.trimEnd().split('\r\n').length, 2);
assert.ok(emptyCsv.includes("'=synthetic"));

const filters = { start: '2026-01-01', end: '2026-01-31', source: 'time_and_materials' };
const inspected = await readPortfolioReconciliation(fake([row(1)]), req, options, filters, true);
const replaced = await readPortfolioReconciliation(fake([row(2)]), req, options, filters, true);
assert.deepEqual(inspected.controls, replaced.controls);
assert.notEqual(
  inspected.reportToken,
  replaced.reportToken,
  'Equal totals must preserve distinct source membership',
);
