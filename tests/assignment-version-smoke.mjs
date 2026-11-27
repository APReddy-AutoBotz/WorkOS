import assert from 'node:assert/strict';
import {validAssignmentDefinition,assignmentActivePercentage,distributeFixedHours} from '../shared/assignment-version.mjs';
const d={role:'Synthetic role',quantityUnit:'percentage',quantityExact:'0.10000000000000001',startsOn:'2026-10-01',endsOn:'2026-10-24',billable:false,status:'Active',comment:null};
assert(validAssignmentDefinition(d));for(const change of[{quantityExact:0.1},{quantityExact:'0.10'},{quantityExact:'-1'},{quantityExact:'200.00000000000000001'},{quantityUnit:'hours'},{startsOn:'2026-02-30'},{endsOn:'2026-09-01'},{status:'Approved'},{billable:undefined},{comment:' x '},{role:undefined},{extra:true}])assert.equal(validAssignmentDefinition({...d,...change}),false);
assert(validAssignmentDefinition({...d,quantityExact:'0'}));assert(validAssignmentDefinition({...d,quantityExact:'200'}));assert.equal(assignmentActivePercentage(d,'2026-10-24'),d.quantityExact);assert.equal(assignmentActivePercentage(d,'2026-10-25'),'0');assert.equal(assignmentActivePercentage({...d,status:'Paused'},'2026-10-24'),'0');
console.log('Assignment declared percentage/date/status/unit boundaries preserve exact quantities without hours conversion, approval state or default fields.');

const distribute = (hours, weights) => distributeFixedHours(hours, weights.map(availableHoursExact => ({availableHoursExact})));
assert.deepEqual(distribute('12', ['8','4','0']), ['8','4','0']);
assert.deepEqual(distribute('1', ['8','8','8']), ['0.333333','0.333334','0.333333']);
assert.deepEqual(distribute('0.00000001', ['0','4']), ['0','0.00000001']);
assert.equal(distribute('1', ['0','0']), null);
assert.equal(distribute('1', ['8',null]), null);
assert.deepEqual(distribute('0', ['0','0']), ['0','0']);
