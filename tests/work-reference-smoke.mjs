import assert from 'node:assert/strict';
import {normalizeWorkReference,workReferenceIsValid} from '../shared/work-reference.mjs';
import {workReferenceInput} from '../server/modules/work-capture/work-reference.mjs';
import {resolveWorkEntryMetadataReplacement} from '../server/modules/work-capture/work-evidence.mjs';
import {hydrateWorkCaptureGrid,patchVisibleCaptureRow,removeVisibleCaptureRow,captureCellPresent} from '../src/services/workCaptureGrid.ts';
import {normalizeTimesheetSummary} from '../src/services/apiClient.ts';
for(const value of [null,'','   '])assert.equal(normalizeWorkReference(value),null);
for(const value of ['TASK-42','TICKET-17 · discovery milestone','مرحلة الاكتشاف','任务-42','👩‍💻 discovery','x'.repeat(200),'😀'.repeat(200),'javascript:descriptive-text','<script>reference text</script>']){
 assert.equal(normalizeWorkReference(` ${value} `),value);assert.equal(workReferenceInput.parse(value),value);
}
for(const value of ['x'.repeat(201),'😀'.repeat(201),'line1\nline2','\tTASK-42','TASK-42\r','A\u0000B','A\u2028B','A\u2029B','\ud800',42,{},[]]){
 assert.equal(workReferenceIsValid(value),false);assert.equal(workReferenceInput.safeParse(value).success,false);
}
assert.equal(workReferenceInput.parse(undefined),undefined);
const base={work_type:'Client Misc Task',client_name:'Synthetic reference client',category:'A',work_date:'2026-10-19',hours:'1',billable:false};
const reference='TASK-42',url='https://example.test/work/42';let prior=[{...base,id:'old',evidence_url:url,work_reference:reference}];const client={query:async()=>({rows:prior})};
for(const fields of [{},{evidence_url:null},{evidence_url:'https://example.test/other'}]){
 const result=(await resolveWorkEntryMetadataReplacement(client,'header',[{...base,...fields}]))[0];assert.equal(result.work_reference,reference);assert.equal(result.evidence_url,fields.evidence_url===undefined?url:fields.evidence_url);
}
for(const work_reference of [null,'TASK-43']){
 const result=(await resolveWorkEntryMetadataReplacement(client,'header',[{...base,work_reference}]))[0];assert.equal(result.work_reference,work_reference);assert.equal(result.evidence_url,url,'changing or clearing one dimension preserves the other omitted dimension');
}
await assert.rejects(resolveWorkEntryMetadataReplacement(client,'header',[{...base,category:'Changed',evidence_url:null}]),{code:'WORK_REFERENCE_REPLACEMENT_CONFLICT',statusCode:409});
await assert.rejects(resolveWorkEntryMetadataReplacement(client,'header',[{...base,category:'Changed',work_reference:null}]),{code:'WORK_EVIDENCE_REPLACEMENT_CONFLICT',statusCode:409});
assert.equal((await resolveWorkEntryMetadataReplacement(client,'header',[{...base,category:'Changed',work_reference:null,evidence_url:null}]))[0].work_reference,null);
await assert.rejects(resolveWorkEntryMetadataReplacement(client,'header',[{...base,evidence_url:url},{...base,evidence_url:url}]),{code:'WORK_REFERENCE_REPLACEMENT_CONFLICT'});
prior=[{...base,id:'old',evidence_url:null}];assert.equal((await resolveWorkEntryMetadataReplacement(client,'header',[base]))[0].work_reference,null,'old work acquires no inferred reference');
const entry={id:'entry',employeeId:'worker',workType:'Client Misc Task',clientName:base.client_name,date:'2026-10-19',hours:1,status:'Draft',billable:false,weekEnding:'2026-10-23',workReference:reference,evidenceUrl:url};
const grid=hydrateWorkCaptureGrid([entry,{...entry,id:'weekend',date:'2026-10-17'},{...entry,id:'zero',hours:0}],'2026-10-17',7);
assert.equal(grid.rows[0].workReferences[2],reference);assert.equal(grid.rows[1].workReferences[0],reference);assert.equal(grid.preservedEntries[0].workReference,reference);
const row={...grid.rows[0],id:'mixed',hours:[0,0,1,1,0,0,0],exactHours:['0','0','1','1','0','0','0'],workReferences:[null,null,reference,'TASK-UNSEEN',null,null,null]};
const split=patchVisibleCaptureRow([row],{},row.id,[2],{category:'Edited'},'retained');assert.equal(split.rows[0].workReferences[2],reference);assert.equal(split.rows[0].workReferences[3],null);assert.equal(split.rows[1].workReferences[3],'TASK-UNSEEN');
assert.equal(removeVisibleCaptureRow(split.rows,{},row.id,[2]).rows[0].workReferences[3],'TASK-UNSEEN');assert.equal(captureCellPresent({...row,hours:Array(7).fill(0),exactHours:Array(7).fill('0')},2,{}),true);
assert.equal(normalizeTimesheetSummary({employee_id:'worker',entries:[{work_date:entry.date,work_reference:reference}]},new Map()).entries[0].workReference,reference);
console.log('Work reference text/Unicode boundaries, independent omitted/clear metadata, replacement conflicts, grid/service and hidden/context/zero preservation passed.');
