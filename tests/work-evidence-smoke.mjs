import assert from 'node:assert/strict';
import {syntheticCredential} from './support/synthetic-values.mjs';
import {normalizeEvidenceUrl,evidenceUrlIsValid} from '../shared/work-evidence.mjs';
import {evidenceUrlInput,resolveWorkEvidenceReplacement} from '../server/modules/work-capture/work-evidence.mjs';
import {hydrateWorkCaptureGrid,patchVisibleCaptureRow,removeVisibleCaptureRow,captureCellPresent} from '../src/services/workCaptureGrid.ts';
import {normalizeTimesheetSummary} from '../src/services/apiClient.ts';

for(const value of [null,'','  '])assert.equal(normalizeEvidenceUrl(value),null);
for(const value of ['https://example.test/work/42?revision=1#note','http://example.test:8080/work','https://example.test/<reference>']){
 assert.equal(normalizeEvidenceUrl(` ${value} `),value);assert.equal(evidenceUrlInput.parse(value),value);
}
const credentialUrl = new URL('https://example.test/work');
credentialUrl.username = 'synthetic-user';
credentialUrl.password = syntheticCredential();
for(const value of ['javascript:alert(1)','data:text/html,test','//example.test/work','file:///tmp/work','https:example.test',credentialUrl.href,'https://example.test/space here','https://example.test/\\work','https://example.test/\nwork','https://',42,{},'https://example.test/'+ 'a'.repeat(2048)]){
 assert.equal(evidenceUrlIsValid(value),false);assert.equal(evidenceUrlInput.safeParse(value).success,false);
}
assert.equal(evidenceUrlInput.parse(undefined),undefined);
const base={work_type:'Client Misc Task',client_name:'Synthetic client',category:'A',work_date:'2026-10-19',hours:'1',billable:false};
const link='https://example.test/work/42';let prior=[];
const client={query:async()=>({rows:prior})};
assert.equal((await resolveWorkEvidenceReplacement(client,null,[base]))[0].evidence_url,null);
prior=[{...base,id:'old',evidence_url:link}];
assert.equal((await resolveWorkEvidenceReplacement(client,'header',[{...base,remark:'Changed comment',hours:'2'}]))[0].evidence_url,link);
for(const value of [null,'https://example.test/replacement'])assert.equal((await resolveWorkEvidenceReplacement(client,'header',[{...base,evidence_url:value}]))[0].evidence_url,value);
await assert.rejects(resolveWorkEvidenceReplacement(client,'header',[{...base,category:'B'}]),{code:'WORK_EVIDENCE_REPLACEMENT_CONFLICT',statusCode:409});
await assert.rejects(resolveWorkEvidenceReplacement(client,'header',[base,base]),{code:'WORK_EVIDENCE_REPLACEMENT_CONFLICT'});
prior.push({...base,id:'duplicate',evidence_url:'https://example.test/other'});
await assert.rejects(resolveWorkEvidenceReplacement(client,'header',[base]),{code:'WORK_EVIDENCE_REPLACEMENT_CONFLICT'});
assert.equal((await resolveWorkEvidenceReplacement(client,'header',[{...base,category:'B',evidence_url:null}]))[0].evidence_url,null,'explicit complete replacements acknowledge removal');

const entry={id:'entry',employeeId:'worker',workType:'Client Misc Task',clientName:'Synthetic client',date:'2026-10-19',hours:1,status:'Draft',billable:false,weekEnding:'2026-10-23',evidenceUrl:link};
const grid=hydrateWorkCaptureGrid([entry,{...entry,id:'weekend',date:'2026-10-17'},{...entry,id:'zero',hours:0}],'2026-10-17',7);
assert.equal(grid.rows[0].evidenceUrls[2],link);assert.equal(grid.rows[1].evidenceUrls[0],link);assert.equal(grid.preservedEntries[0].evidenceUrl,link);
const row={...grid.rows[0],id:'mixed',hours:[0,0,1,1,0,0,0],exactHours:['0','0','1','1','0','0','0'],evidenceUrls:[null,null,link,'https://example.test/unseen',null,null,null]};
const split=patchVisibleCaptureRow([row],{},row.id,[2],{category:'Edited'},'retained');
assert.equal(split.rows[0].evidenceUrls[2],link);assert.equal(split.rows[0].evidenceUrls[3],null);assert.equal(split.rows[1].evidenceUrls[3],'https://example.test/unseen');
const removed=removeVisibleCaptureRow(split.rows,{},row.id,[2]);assert.equal(removed.rows[0].evidenceUrls[3],'https://example.test/unseen');
assert.equal(captureCellPresent({...row,hours:Array(7).fill(0),exactHours:Array(7).fill('0')},2,{}),true,'evidence-only zero cells remain visible/preserved');
const summary=normalizeTimesheetSummary({employee_id:'worker',entries:[{work_date:entry.date,evidence_url:link}]},new Map());assert.equal(summary.entries[0].evidenceUrl,link);
console.log('Work evidence URL validation, omitted/clear/replacement semantics, duplicate conflicts and hidden/context/zero preservation passed.');
