import assert from 'node:assert/strict';
import {operationalSelection,operationalConfidence,OPERATIONAL_PAGE_SIZE,OPERATIONAL_PENDING_CAP} from '../shared/operational-control.mjs';
assert.equal(OPERATIONAL_PAGE_SIZE,10);assert.equal(OPERATIONAL_PENDING_CAP,5);
assert.deepEqual(operationalSelection('2026-01-01','2026-01-31','2026-01-31',1),{startsOn:'2026-01-01',endsOn:'2026-01-31',forecastStartsOn:'2026-01-31',forecastEndsOn:'2026-03-03',months:1});
for(const v of [['2026-01-31','2026-01-01','2026-01-31',1],['2026-01-01','2027-02-01','2026-01-31',1],['2026-02-30','2026-03-01','2026-01-31',1],['2026-01-01','2026-01-31','2026-01-31',0],['2026-01-01','2026-01-31','2026-01-31','1']])assert.throws(()=>operationalSelection(...v));
const row={actual:{reasonCodes:['CAPACITY_UNAVAILABLE'],capacity:{reasonCodes:['PROFILE_MISSING']}},forecast:{sourceReason:'SCOPE_UNAVAILABLE',points:[{reasonCodes:['NATIVE_THRESHOLDS_MISSING'],capacity:{reasonCodes:['PROFILE_MISSING']}}]},pending:[{kind:'Work',state:'not_permitted'},{kind:'Leave',state:'unavailable'},{kind:'Creation',state:'limited'},{kind:'Material',state:'available'}]};
assert.deepEqual(operationalConfidence(row),['ACTUAL:CAPACITY_UNAVAILABLE','CAPACITY:PROFILE_MISSING','FORECAST:NATIVE_THRESHOLDS_MISSING','FORECAST:PROFILE_MISSING','FORECAST:SCOPE_UNAVAILABLE','PENDING_CREATION:LIMITED','PENDING_LEAVE:UNAVAILABLE','PENDING_WORK:NOT_PERMITTED']);
console.log('Operational selection preserves existing UTC/native horizon and limits; data confidence retains source/permission/cap reasons without inferred zero, manager or conversion.');
