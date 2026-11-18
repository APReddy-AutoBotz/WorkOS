import assert from 'node:assert/strict';
import { calculateTmEntry, validTmValuationPolicy } from '../shared/governed-tm-valuation.mjs';
const p = {
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
  run = (hours, billingRate, costRate, policy = p) =>
    calculateTmEntry({ hours, billingRate, costRate, currency: 'USD', unit: 'HOUR', policy });
assert(validTmValuationPolicy(p));
assert.deepEqual(run('1.25', '100.1234', '40.0020'), {
  version: 'governed-tm/1',
  currency: 'USD',
  unit: 'HOUR',
  hoursExact: '1.25',
  billingRateExact: '100.1234',
  costRateExact: '40.0020',
  unroundedBillableExact: '125.15425',
  unroundedCostExact: '50.0025',
  billableValue: '125.15',
  costValue: '50.00',
  marginValue: '75.15',
});
assert.equal(run('1', '1.0050', '0', p).billableValue, '1.01');
assert.equal(run('1', '1.0050', '0', { ...p, rounding: 'HALF_EVEN' }).billableValue, '1.00');
assert.equal(run('1', '1.0150', '0', { ...p, rounding: 'HALF_EVEN' }).billableValue, '1.02');
assert.equal(run('1', '1.0199', '0', { ...p, rounding: 'DOWN' }).billableValue, '1.01');
assert.equal(run('24', '99999999999999.9999', '0').billableValue, '2400000000000000.00');
assert.equal(run('1', '0', '2.9999').marginValue, '-3.00');
for (const bad of [
  { ...p, rounding: undefined },
  { ...p, precision: undefined },
  { ...p, aggregation: 'TOTAL' },
  { ...p, capTreatment: 'DEFAULT' },
  { ...p, exclusions: 'AUTO' },
  { ...p, extra: true },
])
  assert(!validTmValuationPolicy(bad));
for (const [hours, billing, cost] of [
  ['0', '1', '1'],
  ['24.0001', '1', '1'],
  ['1e0', '1', '1'],
  ['1', '-1', '1'],
  ['1', '1', 'NaN'],
])
  assert.throws(() => run(hours, billing, cost));
assert.throws(() =>
  calculateTmEntry({ hours: '1', billingRate: '1', costRate: '1', currency: 'EUR', unit: 'HOUR', policy: p }),
);
assert.throws(() =>
  calculateTmEntry({ hours: '1', billingRate: '1', costRate: '1', currency: 'USD', unit: 'DAY', policy: p }),
);
console.log('Explicit native T&M decimal policy, ties, limits and no conversion passed.');
