import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonicalHours, compareHours, isHourMultiple, sumHours} from '../shared/work-hours.mjs';
import {CAPTURE_POLICY_VERSION, capturePolicyInput, captureHoursInput, assertCaptureReplacementPeriods, resolveCapturePolicy, validateEntryCaptureRules, validateCapturePolicy} from '../server/modules/work-capture/capture-policy.mjs';

assert.equal(sumHours(['0.1', '0.2', '0.25']), '0.55');
assert.equal(sumHours(Array(100).fill('0.25')), '25');
assert.equal(canonicalHours('000.2500'), '0.25');
assert.equal(canonicalHours(1e-7), '0.0000001');
assert.equal(compareHours('0.25000000000000000001', '0.25'), 1);
assert.equal(isHourMultiple('1.25', '0.25'), true);
assert.equal(isHourMultiple('0.3', '0.25'), false);
assert.equal(captureHoursInput.parse('0.25000000000000001'),'0.25000000000000001');
assert.equal(captureHoursInput.parse(0.25),'0.25');
for(const value of ['', ' ', '-0.25', 'Infinity', '25'])assert.equal(captureHoursInput.safeParse(value).success,false);
assert.throws(()=>validateEntryCaptureRules({work_date:'2026-10-21',hours:captureHoursInput.parse('0.25000000000000001')},{minimum_increment:'0.25',comment_required:false}),{code:'WORK_CAPTURE_INCREMENT'});
assert.throws(() => canonicalHours('-0.25'));
const input = {expectedLatestId: null, effectiveFrom: '2026-10-19', minimumIncrement: '0.25', dailyMaximum: '8', weeklyMaximum: '40', commentRequired: true};
assert(capturePolicyInput.safeParse(input).success);
for (const extra of [{minimumIncrement: '0'}, {minimumIncrement: '0.00001'}, {dailyMaximum: '25'}, {weeklyMaximum: '169'}, {dailyMaximum: '0.1'}, {commentRequired: 'true'}, {organizationId: 'forged'}]) {
  assert.equal(capturePolicyInput.safeParse({...input, ...extra}).success, false);
}
const policy = {id: 'capture-synthetic', sequence: 1, policy_version: CAPTURE_POLICY_VERSION,
  effective_from: '2026-10-19', minimum_increment: '0.25', daily_maximum: '1', weekly_maximum: '2', comment_required: true};
assert.equal(resolveCapturePolicy([policy], '2026-10-18'), null);
assert.equal(resolveCapturePolicy([policy], '2026-10-19').id, policy.id);
const entry = {work_date: '2026-10-20', hours: 0.25, remark: 'Synthetic work comment', category: 'Unchanged ordinary category'};
assert.deepEqual(validateEntryCaptureRules(entry, policy).capturePolicyReference, {id: policy.id, policyVersion: CAPTURE_POLICY_VERSION});
assert.equal(validateEntryCaptureRules(entry, policy).hours, '0.25');
assert.throws(() => validateEntryCaptureRules({...entry, hours: 0.3}, policy), {code: 'WORK_CAPTURE_INCREMENT'});
assert.throws(() => validateEntryCaptureRules({...entry, remark: ' \n '}, policy), {code: 'WORK_CAPTURE_COMMENT_REQUIRED'});
assert.equal(validateEntryCaptureRules({...entry, hours: 0, remark: null}, policy).hours, '0');
assert.equal(validateEntryCaptureRules({...entry, hours: 0.3, remark: null}, null).capturePolicyReference, null, 'neutral compatibility is not a configured policy');

const req = {organizationScope: {organizationId: 'org-synthetic', legalEntityId: 'legal-synthetic'}};
const fixture = () => {
  const state = {policies: [policy], stored: [], calls: [], periodState: 'Open'};
  state.client = {query: async (sql, values) => {
    state.calls.push({sql, values});
    if (sql.includes('from unnest($3::date[])')) return {rows: values[2].map(at => ({id: 'week-synthetic', code: 'SYN-WEEK', relevant_date: at,
      starts_on: '2026-10-19', ends_on: '2026-10-25', frequency: 'Weekly', status: state.periodState}))};
    if (sql.includes('from work_capture_policy_versions')) return {rows: state.policies};
    if (sql.includes('from timesheet_entries te')) return {rows: state.stored.filter(row => !values[5].includes(row.timesheetId))};
    throw new Error(`Unexpected synthetic query: ${sql}`);
  }};
  return state;
};
let f = fixture();
let result = await validateCapturePolicy(f.client, req, 'worker-synthetic', [entry]);
assert.equal(result[0].hours, '0.25');
assert.equal(result[0].category, entry.category);
assert.equal(result[0].remark, entry.remark);
f.stored = [{timesheetId: 'other-header', work_date: entry.work_date, hours: '0.75'}];
await assert.rejects(validateCapturePolicy(f.client, req, 'worker-synthetic', [{...entry, hours: 0.5}]), {code: 'WORK_CAPTURE_DAILY_LIMIT'});
await validateCapturePolicy(f.client, req, 'worker-synthetic', [{...entry, hours: 0.5}], {replacementTimesheetId: 'other-header'});
assert.deepEqual(f.calls.at(-1).values.slice(0, 5), ['org-synthetic', 'legal-synthetic', 'worker-synthetic', '2026-10-19', '2026-10-25'], 'aggregate query is scoped by authoritative Weekly bounds, not a header');
f = fixture(); f.stored = [{timesheetId: 'old-header', work_date: '2026-10-19', hours: '1'}];
await assert.rejects(validateCapturePolicy(f.client, req, 'worker-synthetic', [entry], {stagedReplacements: [
  {employeeId: 'worker-synthetic', timesheetId: null, entries: [{...entry, work_date: '2026-10-21', hours: '1'}]},
]}), {code: 'WORK_CAPTURE_WEEKLY_LIMIT'}, 'a later dry-run group includes earlier prospective groups');
await validateCapturePolicy(f.client, req, 'worker-synthetic', [entry], {stagedReplacements: [
  {employeeId: 'worker-synthetic', timesheetId: 'old-header', entries: [{...entry, work_date: '2026-10-19', hours: '0.5'}]},
  {employeeId: 'unrelated-worker', timesheetId: null, entries: [{...entry, hours: '24'}]},
]});
f.policies = []; result = await validateCapturePolicy(f.client, req, 'worker-synthetic', [{...entry, hours: 0.3, remark: null}]);
assert.equal(result[0].hours, '0.3'); assert.equal(result[0].capturePolicyReference, null);
f.periodState = 'Financially Locked';
await assert.rejects(validateCapturePolicy(f.client, req, 'worker-synthetic', [entry]), {code: 'REPORTING_PERIOD_CLOSED'});
const replacementClient={query:async(sql,values)=>{
 if(sql.includes('select e.work_date::text')){assert.deepEqual(values,['header-old','org-synthetic','legal-synthetic']);return {rows:[{work_date:'2026-10-20'}]};}
 if(sql.includes('from unnest($3::date[])'))return {rows:[{id:'old-week',frequency:'Weekly',relevant_date:'2026-10-20',status:'Financially Locked'}]};
 throw Error('Unexpected replacement query');
}};
await assert.rejects(assertCaptureReplacementPeriods(replacementClient,req,'header-old'),{code:'REPORTING_PERIOD_CLOSED'});
const source = await readFile(new URL('../server/modules/imports/operational-import-router.mjs', import.meta.url), 'utf8');
assert.match(source, /category:entry.category,remark:entry.remark/);
assert.match(source, /stagedReplacements:dryRun\?stagedCaptureReplacements:\[\]/);
assert.doesNotMatch(source, /hours: round1\(row.hours\)/);
const assignmentMigration = await readFile(new URL('../server/migrations/044_wos04_work_submission_evidence.sql', import.meta.url), 'utf8');
assert.match(assignmentMigration, /policy_version='assignment-work-date\/1'/);
console.log('Capture policy decimal, effective-date, increment, comment, scope, all-header daily/Weekly aggregate, replacement, staged preview, neutral and locked-period vectors passed.');
