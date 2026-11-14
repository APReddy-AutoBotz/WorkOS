import assert from 'node:assert/strict';
import {projectContributionCsv} from '../server/modules/planning/project-contribution-artifact.mjs';
import {calculateProjectContribution} from '../shared/project-contribution.mjs';
import {actualFixtureCapacity} from './support/actual-work-test.mjs';

const day = '2026-10-24';
const scope = {organizationId: '=synthetic\r\norganization', legalEntityId: '+synthetic,legal'};
const projectId = '@synthetic"project';
const employeeId = '-synthetic\tworker';
const worker = {employeeId, capacity: {...actualFixtureCapacity(day), employeeId}, rows: [
  {id: 'entry', date: day, status: 'Approved', hoursExact: '0.00000000000000001', disposition: 'included', reason: null},
]};
const result = (patch = {}) => ({...calculateProjectContribution({projectId, startsOn: day, endsOn: day, workers: [worker], ...patch}),
  sourceToken: 'a'.repeat(64), observedAt: '2026-10-25T00:00:00.000Z'});
const parse = csv => csv.trimEnd().split('\r\n').map(line => line.slice(1, -1).split('","').map(value => value.replaceAll('""', '"')));
const records = csv => {const [header, ...rows] = parse(csv); assert.equal(new Set(header).size, header.length);
  return rows.map(row => {assert.equal(row.length, header.length); return Object.fromEntries(header.map((key, index) => [key, row[index]]));});};
const csv = projectContributionCsv(scope, result());
assert.equal(csv, projectContributionCsv(scope, result()), 'identical observation produces identical bytes');
const rows = records(csv);
assert.equal(rows.length, 2);
assert.equal(rows[0].row_kind, 'aggregate');
assert.equal(rows[1].row_kind, 'worker');
assert.equal(rows[0].worker_count, '1');
assert.equal(rows[1].worker_count, '');
assert.equal(rows[0].included_hours_exact, '0.00000000000000001');
assert.equal(rows[0].percent_numerator_exact, '1');
assert.equal(rows[0].percent_denominator_exact, '8000000000000000');
assert.equal(rows[1].worker_reference, `worker/${encodeURIComponent(employeeId)}`);
assert.equal(rows[0].scope_reference, `scope/${encodeURIComponent(scope.organizationId)}/${encodeURIComponent(scope.legalEntityId)}`);
for (const record of rows) for (const value of Object.values(record)) assert.doesNotMatch(value, /^[\s\x00-\x1f]*[=+@-]/);
const limited = records(projectContributionCsv(scope, result({sourceLimited: true})));
assert.equal(limited.length, 1);
assert.equal(limited[0].status, 'unavailable');
for (const key of ['worker_count', 'included_hours_exact', 'eligible_available_hours_exact', 'entry_count', 'percent_rounded_display']) assert.equal(limited[0][key], '', key);
const empty = records(projectContributionCsv(scope, result({workers: []})));
assert.equal(empty[0].status, 'not_applicable');
assert.equal(empty[0].worker_count, '0');
assert.equal(empty[0].eligible_available_hours_exact, '0');
assert.equal(empty[0].percent_rounded_display, '');
const mixed = {...worker, rows: [
  {...worker.rows[0], hoursExact: '12'},
  {...worker.rows[0], id: 'excluded', hoursExact: '2', disposition: 'excluded'},
  {...worker.rows[0], id: 'draft', hoursExact: '3', status: 'Draft', disposition: 'not_approved'},
  {...worker.rows[0], id: 'submitted', hoursExact: '4', status: 'Submitted', disposition: 'not_approved'},
  {...worker.rows[0], id: 'rejected', hoursExact: '5', status: 'Rejected', disposition: 'not_approved'},
]};
const controlled = records(projectContributionCsv(scope, result({workers: [mixed]})))[0];
assert.equal(controlled.percent_rounded_display, '150', 'do not cap legitimate contributions');
assert.equal(controlled.entry_count, '5');
assert.equal(controlled.approved_entry_count, '2');
assert.equal(controlled.included_approved_entry_count, '1');
assert.equal(controlled.excluded_approved_entry_count, '1');
assert.equal(controlled.known_excluded_hours_exact, '2');
assert.equal(controlled.approved_hours_exact, '14');
assert.equal(controlled.draft_hours_exact, '3');
assert.equal(controlled.submitted_hours_exact, '4');
assert.equal(controlled.rejected_hours_exact, '5');
const unresolved = {...mixed, rows: [...mixed.rows, {...worker.rows[0], id: 'unknown', hoursExact: '6', disposition: 'unresolved', reason: 'APPROVAL_EVIDENCE_UNAVAILABLE'}]};
const unknown = records(projectContributionCsv(scope, result({workers: [unresolved]})))[0];
assert.equal(unknown.status, 'unavailable');
assert.equal(unknown.included_hours_exact, '');
assert.equal(unknown.known_included_hours_exact, '12');
assert.equal(unknown.unresolved_approved_entry_count, '1');
assert.equal(unknown.unresolved_approved_hours_exact, '6');
assert.equal(unknown.percent_numerator_exact, '');
assert.equal(unknown.percent_rounded_display, '');
assert.throws(() => projectContributionCsv({}, result()), /explicit scope/);
assert.throws(() => projectContributionCsv(scope, {...result(), includedHoursExact: '1'}), /inconsistent/);
assert.throws(() => projectContributionCsv(scope, {...result(), sourceToken: '=bad'}), /inconsistent/);
assert.throws(() => projectContributionCsv(scope, {...result(), reasonCodes: ['=bad']}), /inconsistent/);
console.log('Project contribution CSV: exact controls, deterministic bytes, formula-safe references, unknown versus zero, source-limit refusal and malformed-result negatives passed.');
