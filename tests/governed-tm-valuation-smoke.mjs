import assert from 'node:assert/strict';
import { calculateTmEntry, validTmValuationPolicy } from '../shared/governed-tm-valuation.mjs';
import { periodMarginPercent } from '../server/modules/commercial-tm/period-margin.mjs';
for (const [billable, cost, expected] of [
  ['0.00', '20', null],
  ['0', '0', null],
  ['20', '30', '-50.00'],
  ['32', '31', '3.13'],
  ['32', '33', '-3.13'],
  ['1000000000000000000.00', '1000000000000000000.01', '0.00'],
  ['11', '0', '100.00'],
])
  assert.equal(periodMarginPercent(billable, cost), expected);
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
const capped={...p,version:'governed-tm/2',capTreatment:'PER_ENTRY_VALUE',capAmount:'80.00'};
const cappedResult=run('1.25','100.1234','80.0020',capped);
assert.equal(cappedResult.unroundedBillableExact,'125.15425');
assert.equal(cappedResult.billableAfterCapExact,'80');
assert.equal(cappedResult.billableValue,'80.00');
assert.equal(cappedResult.costValue,'100.00');
assert.equal(cappedResult.marginValue,'-20.00');
assert.equal(run('1','79.995','0',capped).billableAfterCapExact,'79.995');
assert.equal(run('1','79.995','0',capped).billableValue,'80.00');
for(const capAmount of ['0','-1','80.001','1e2','080.00',null])assert.equal(validTmValuationPolicy({...capped,capAmount}),false);
assert.equal(validTmValuationPolicy({...capped,version:'governed-tm/1'}),false);
const excluded = {...p, version:'governed-tm/3', exclusions:'ALL_BILLING'};
assert(validTmValuationPolicy(excluded));
assert(!validTmValuationPolicy({...excluded, exclusions:'NONE'}));
assert(!validTmValuationPolicy({...capped, version:'governed-tm/3', exclusions:'ALL_BILLING'}));
const freePhase = run('1.25','100.1234','40.0020',excluded);
assert.deepEqual([freePhase.unroundedBillableExact,freePhase.billableValue,freePhase.costValue,freePhase.marginValue],
  ['125.15425','0.00','50.00','-50.00']);
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
