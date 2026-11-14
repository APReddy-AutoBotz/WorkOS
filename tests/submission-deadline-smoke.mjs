import assert from 'node:assert/strict';
import {submissionDeadlineInput,submissionDeadlineRule,assertSubmissionTiming} from '../server/modules/work-capture/submission-deadline.mjs';
import {normalizeSubmissionTiming,normalizeImportSubmissionTiming,importSubmissionTimingNotice} from '../src/services/submissionDeadline.ts';
const rule={anchor:'weekly-end-date',timezone:'UTC',daysAfterPeriodEnd:1,time:'23:30',graceMinutes:90,lateTreatment:'warn'};
assert.deepEqual(submissionDeadlineInput.parse(rule),rule);assert.equal(submissionDeadlineRule(null),null);assert.equal(submissionDeadlineRule({enabled:false}),null);assert.throws(()=>submissionDeadlineRule({enabled:false,unexpected:true}));
for(const value of [{...rule,timezone:'Europe/London'},{...rule,time:'1:30'},{...rule,time:'23:60'},{...rule,daysAfterPeriodEnd:367},{...rule,graceMinutes:527041},{...rule,lateTreatment:'allow'},{...rule,actor:'forged'}])assert.equal(submissionDeadlineInput.safeParse(value).success,false);
const check={version:'submission-deadline/1',policyId:'synthetic-deadline-rule',periodId:'synthetic-period',periodCode:'SYN-WEEK',timezone:'UTC',checkedAt:'2027-01-02T00:00:00Z',deadlineAt:'2027-01-01T23:30:00Z',graceEndsAt:'2027-01-02T01:00:00Z',lateTreatment:'warn',state:'grace'};
assert.deepEqual(normalizeSubmissionTiming([check]),[check]);assert.deepEqual(normalizeSubmissionTiming([]),[]);assert.equal(normalizeSubmissionTiming(null),undefined);for(const value of [[{...check,timezone:'UTC+1'}],[{...check,state:'accepted'}],[{...check,graceEndsAt:'2026-01-01T00:00:00Z'}],[check,check]])assert.equal(normalizeSubmissionTiming(value),undefined);
for(const field of ['lateTreatment','state'])for(const malformed of [[check[field]],null,1,{},true]){
 const invalid={...check,[field]:malformed};assert.equal(normalizeSubmissionTiming([invalid]),undefined,`${field} must be a literal enum string`);
 assert.equal(normalizeImportSubmissionTiming([{employeeId:'synthetic-worker',weekEnding:'2026-10-24',checks:[invalid]}]),undefined);
}
assertSubmissionTiming([check]);assertSubmissionTiming([{...check,state:'overdue'}]);assert.throws(()=>assertSubmissionTiming([{...check,state:'overdue',lateTreatment:'block'}]),{code:'WDL01'});assert.throws(()=>assertSubmissionTiming(null),{code:'WDL02'});
const groups=[{employeeId:'synthetic-worker',weekEnding:'2026-10-24',checks:[{...check,state:'overdue'}]}];assert.deepEqual(normalizeImportSubmissionTiming(groups),groups);assert.equal(normalizeImportSubmissionTiming([{...groups[0],weekEnding:'2026-99-99'}]),undefined);assert.equal(normalizeImportSubmissionTiming([...groups,...groups]),undefined);assert.match(importSubmissionTimingNotice(groups),/1 overdue period checks/);assert.equal(importSubmissionTimingNotice([]),'');
console.log('Explicit deadline profiles, strict off/unsupported values, immutable timing DTOs, unavailable versus unconfigured, warn/block and import diagnostic contracts passed.');
