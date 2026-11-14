import assert from 'node:assert/strict';
import {overtimeInput,overtimeRule,evaluateOvertime,assertOvertimeAllowed,OVERTIME_OFF} from '../server/modules/work-capture/overtime-policy.mjs';
import {capturePolicyInput,capturePolicyView,validateEntryCaptureRules} from '../server/modules/work-capture/capture-policy.mjs';
import {normalizeOvertimeWarnings,normalizeImportOvertimeWarnings,importOvertimeNotice} from '../src/services/overtimeCapture.ts';
const week={id:'week-synthetic',code:'SYN-OVERTIME',starts_on:'2026-10-24',ends_on:'2026-10-30'},rule={action:'warn',dailyThreshold:'0.5',weeklyThreshold:'0.75'},policy={id:'policy-synthetic',effective_from:week.starts_on,overtime_rule:rule,policy_version:'work-capture-rules/1',minimum_increment:'0.25',daily_maximum:null,weekly_maximum:null,comment_required:false};
const entries=[{work_date:week.starts_on,hours:'0.25'},{work_date:week.starts_on,hours:'0.2500'},{work_date:week.starts_on,hours:'0.25'},{work_date:'2026-10-25',hours:'0.25'}];
assert.equal(overtimeRule(null),null);assert.equal(overtimeRule(undefined),null);assert.equal(overtimeRule(OVERTIME_OFF),null);assert.throws(()=>overtimeRule({...OVERTIME_OFF,dailyThreshold:'1'}));
assert.deepEqual(overtimeInput.parse({...rule,dailyThreshold:'0.5000'}),rule);
for(const value of [{...rule,action:'approve'},{...rule,dailyThreshold:'0'},{...rule,dailyThreshold:'24.1'},{...rule,weeklyThreshold:'168.1'},{...rule,dailyThreshold:'0.00001'},{...rule,dailyThreshold:null,weeklyThreshold:null},{...rule,payrollRate:2}])assert.equal(overtimeInput.safeParse(value).success,false);
const result=evaluateOvertime([week],[policy],entries);assert.deepEqual(result.map(row=>[row.kind,row.workDate,row.threshold]),[['daily',week.starts_on,'0.5'],['weekly',null,'0.75']]);assertOvertimeAllowed(result);assert.throws(()=>assertOvertimeAllowed(result.map(row=>({...row,action:'block'}))),{code:'WORK_CAPTURE_OVERTIME_BLOCKED'});
assert.deepEqual(evaluateOvertime([week],[],entries),[]);assert.deepEqual(evaluateOvertime([week],[{...policy,overtime_rule:OVERTIME_OFF}],entries),[]);assert.deepEqual(evaluateOvertime([week],[policy],entries.slice(0,2)),[],'equality is permitted');
const precise=evaluateOvertime([week],[{...policy,overtime_rule:{action:'warn',dailyThreshold:'0.5',weeklyThreshold:null}}],[{work_date:week.starts_on,hours:'0.50000000000000001'}]);assert.equal(precise.length,1,'no Number rounding at threshold');
assert.deepEqual(evaluateOvertime([week],[policy],entries,[entries.at(-1)]).map(row=>row.kind),['weekly'],'read warnings show only target dates and shared Weekly condition');
const checked=validateEntryCaptureRules(entries[0],policy);assert.deepEqual(checked.capturePolicyReference.overtime,rule);assert(!Object.hasOwn(validateEntryCaptureRules(entries[0],{...policy,overtime_rule:null}).capturePolicyReference,'overtime'));
const draft={expectedLatestId:null,effectiveFrom:week.starts_on,minimumIncrement:'0.25',dailyMaximum:null,weeklyMaximum:null,commentRequired:false};assert.equal(Object.hasOwn(capturePolicyInput.parse(draft),'overtime'),false);assert.equal(capturePolicyInput.parse({...draft,overtime:null}).overtime,null);assert.deepEqual(capturePolicyView({...policy,sequence:1,evidence_required:null}).overtime,rule);
assert.deepEqual(normalizeOvertimeWarnings(result),result);assert.equal(normalizeOvertimeWarnings(null),undefined);assert.equal(normalizeOvertimeWarnings([result[0],result[0]]),undefined);for(const value of [{...result[0],workDate:'2026-02-30'},{...result[0],threshold:'-1'},{...result[0],action:'pay'},{...result[0],version:'unknown'}])assert.equal(normalizeOvertimeWarnings([value]),undefined);
for (const field of ['action','kind']) {
 for (const malformed of [[result[1][field]],null,1,{},true]) {
  const warning={...result[1],[field]:malformed};
  assert.equal(normalizeOvertimeWarnings([warning]),undefined,`${field} must be a literal enum string`);
  assert.equal(normalizeImportOvertimeWarnings([{employeeId:'worker-synthetic',weekEnding:'2026-10-30',warnings:[warning]}]),undefined,`import ${field} must be a literal enum string`);
 }
}
const batch=[{employeeId:'worker-synthetic',weekEnding:'2026-10-30',warnings:result}];assert.deepEqual(normalizeImportOvertimeWarnings(batch),batch);assert.equal(normalizeImportOvertimeWarnings([...batch,...batch]),undefined);assert(importOvertimeNotice(batch).includes('2 threshold conditions'));assert.equal(importOvertimeNotice(undefined),'');
console.log('Optional explicit overtime warn/block configuration, exact equality/precision, separate daily/Weekly conditions, target-only disclosure, compatible references and strict warning DTOs passed.');
