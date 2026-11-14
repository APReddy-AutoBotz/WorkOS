import {syntheticHexDigest} from './support/synthetic-values.mjs';
import assert from 'node:assert/strict';
import {checkDuplicateEntries,duplicateCheckSummary,projectTimesheetDuplicateCheck,DUPLICATE_ENTRY_VERSION} from '../server/modules/work-capture/duplicate-entry-check.mjs';
import {normalizeDuplicateEntryCheck,normalizeDuplicateCheckSummary} from '../src/services/duplicateEntryCheck.ts';
import {normalizeTimesheetSummary,normalizeWorkAssurance} from '../src/services/apiClient.ts';
const base={id:'entry-a',work_date:'2026-10-24',work_type:'Client Misc Task',project_id:null,client_name:'Synthetic context',category:'Synthetic category',hours:'0.2500',billable:false,remark:'Synthetic note',evidence_url:'https://example.test/work/42',work_reference:'TASK-42'};
const other={...base,id:'entry-b',hours:'0.25'};const input=[base,other];const before=structuredClone(input),check=checkDuplicateEntries(input);
assert.equal(check.version,DUPLICATE_ENTRY_VERSION);assert.equal(check.groups.length,1);assert.deepEqual(check.groups[0].entryIds,['entry-a','entry-b']);assert.equal(check.groups[0].hoursExact,'0.25');assert.deepEqual(input,before);
assert.deepEqual(checkDuplicateEntries([other,base]),check,'physical order is not the content key');
assert.equal(checkDuplicateEntries([{...base,id:'new-a'},{...other,id:'new-b'}]).groups[0].key,check.groups[0].key,'physical identities do not change the content key');
for(const field of ['work_date','work_type','project_id','client_name','category','hours','billable','remark','evidence_url','work_reference']){
 const values={work_date:'2026-10-23',work_type:'Project Work',project_id:'project-different',client_name:'Different context',category:'Different category',hours:'0.5',billable:true,remark:'Different note',evidence_url:'https://example.test/different',work_reference:'TASK-43'};
 assert.equal(checkDuplicateEntries([base,{...other,[field]:values[field]}]).groups.length,0,`${field} differences remain distinct`);
}
assert.equal(checkDuplicateEntries([base,{...other,hours:'0.25000000000000001'}]).groups.length,0,'exact decimals are not rounded through Number');
assert.equal(checkDuplicateEntries([{...base,hours:'0'},{...other,hours:'0.000'}]).groups.length,1,'identical zero records are advisory too');
assert.deepEqual(checkDuplicateEntries([]),{version:DUPLICATE_ENTRY_VERSION,groups:[]});assert.equal(checkDuplicateEntries([base]).groups.length,0);
for(const entries of [null,[base,{...other,id:base.id}],[{...base,hours:'not-a-quantity'}],[{...base,work_date:'2026-02-30'}],[{...base,work_type:'Unknown legacy kind'}]])assert.equal(checkDuplicateEntries(entries),null,'unknown legacy data is unavailable, never a fabricated clean check');
const revision=syntheticHexDigest();assert.equal(projectTimesheetDuplicateCheck({entries:input,write_token:revision}).write_token,revision);assert.deepEqual(duplicateCheckSummary(check),{version:DUPLICATE_ENTRY_VERSION,groupCount:1});assert.equal(duplicateCheckSummary(null),null);
assert.deepEqual(normalizeDuplicateEntryCheck(check),check);assert.deepEqual(normalizeDuplicateEntryCheck({version:DUPLICATE_ENTRY_VERSION,groups:[]}),{version:DUPLICATE_ENTRY_VERSION,groups:[]});
for(const value of [null,{},[],{version:'unknown',groups:[]},{...check,groups:[{...check.groups[0],key:'bad'}]},{...check,groups:[{...check.groups[0],entryIds:['same','same']}]},{...check,groups:[{...check.groups[0],workDate:'2026-02-30'}]},{...check,groups:[{...check.groups[0],hoursExact:'-1'}]}])assert.equal(normalizeDuplicateEntryCheck(value),undefined);
assert.equal(normalizeDuplicateCheckSummary({version:DUPLICATE_ENTRY_VERSION,groupCount:2},2),undefined);assert.equal(normalizeDuplicateCheckSummary(null,2),undefined);
const assurance={id:'submission',sequence:1,policyVersion:'assignment-work-date/1',entryCount:2,governedEntryCount:0};assert.equal(Object.hasOwn(normalizeWorkAssurance(assurance),'duplicateCheck'),false,'legacy history is not assigned an inferred clean result');
assert.deepEqual(normalizeWorkAssurance({...assurance,duplicateCheck:duplicateCheckSummary(check)}).duplicateCheck,{version:DUPLICATE_ENTRY_VERSION,groupCount:1});
assert.deepEqual(normalizeTimesheetSummary({employee_id:'worker',duplicate_entry_check:check,entries:[]},new Map()).duplicateEntryCheck,check);
console.log('Exact-entry diagnostic content/decimal/identity/order vectors, distinct contexts, zero and unavailable legacy data, immutable inputs and compatible DTO decoding passed.');
