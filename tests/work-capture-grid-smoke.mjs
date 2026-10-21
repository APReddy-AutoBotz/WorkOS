// Run with the existing tsx loader after validation is authorized.
import assert from 'node:assert/strict';
import pg from 'pg';
import {hydrateWorkCaptureGrid,parseCaptureHourInput,canonicalCaptureHourInput,captureCalendarDate} from '../src/services/workCaptureGrid.ts';
import {normalizeTimesheetSummary} from '../src/services/apiClient.ts';
const common = {employeeId: 'worker-synthetic', workType: 'Project Work', projectId: 'project-synthetic',
  date: '2026-10-19', status: 'Draft', billable: false, weekEnding: '2026-10-23', hours: 0.25};
for(const value of ['-1','1e999','Infinity','NaN','1foo','25','.'])assert.equal(parseCaptureHourInput(value),null);
assert.equal(canonicalCaptureHourInput('0.25000000000000001'),'0.25000000000000001');
assert.equal(canonicalCaptureHourInput('24.0000000000000001'),null);
const tiny='0.'+'0'.repeat(330)+'1';assert.equal(canonicalCaptureHourInput(tiny),tiny);
assert.equal(parseCaptureHourInput('0.'),0);assert.equal(parseCaptureHourInput('.25'),0.25);assert.equal(parseCaptureHourInput(''),0);
assert.equal(captureCalendarDate(new Date(2026,9,19)), '2026-10-19', 'local civil Monday must not become the previous UTC date');
const entries = [{...common, id: 'entry-a', category: 'Category A', remark: 'Comment A'},
  {...common, id: 'entry-b', category: 'Category B', remark: 'Comment B'},
  {...common, id: 'entry-weekend', date: '2026-10-18', remark: 'Retained weekend'},
  {...common, id: 'entry-zero', hours: 0}];
const hydrated = hydrateWorkCaptureGrid(entries, '2026-10-19');
assert.equal(hydrated.rows.length, 2, 'same project/date does not overwrite distinct rows');
assert.deepEqual(hydrated.rows.map(row => [row.hours[0], row.remarks[0], row.category, row.billable]), [
  [0.25, 'Comment A', 'Category A', false], [0.25, 'Comment B', 'Category B', false],
]);
assert.deepEqual(hydrated.preservedEntries, entries.slice(2), 'unsupported grid dates and zero entries survive unchanged');
const summary = normalizeTimesheetSummary({id: 'header-synthetic', employee_id: common.employeeId, week_ending: common.weekEnding,
  total_hours: '0.25', billable_hours: '0.25', status: 'Draft', entries: [{id: 'entry-synthetic', work_type: 'Project Work', work_date: common.date,
    hours: '0.25', billable: true}]}, new Map());
assert.equal(summary.entries[0].hoursExact,'0.25');
const exactEntries=[{...common,id:'entry-precise',hours:0.25,hoursExact:'0.25000000000000001'},{...common,id:'entry-tiny',hours:0,hoursExact:tiny}];
const exactGrid=hydrateWorkCaptureGrid(exactEntries,'2026-10-19');assert.equal(exactGrid.rows.length,2);assert.deepEqual(exactGrid.rows.map(row=>row.exactHours[0]),['0.25000000000000001',tiny]);
assert.equal(summary.totalHours, 0.25); assert.equal(summary.billableHours, 0.25); assert.equal(summary.entries[0].hours, 0.25);
console.log('Compatibility capture grid preserves duplicate contexts, comments, billability, off-grid records and quarter-hour normalizers.');

const jsonTransport=pg.types.getTypeParser(114)(`{"id":"header-transport","employee_id":"worker-synthetic","week_ending":"2026-10-23","status":"Draft","entries":[{"id":"entry-transport","work_type":"Project Work","work_date":"2026-10-19","hours":0.25000000000000001,"hours_exact":"0.25000000000000001"}]}`);
assert.equal(normalizeTimesheetSummary(jsonTransport,new Map()).entries[0].hoursExact,'0.25000000000000001','nested PostgreSQL JSON must retain explicit numeric text before JS parsing');
