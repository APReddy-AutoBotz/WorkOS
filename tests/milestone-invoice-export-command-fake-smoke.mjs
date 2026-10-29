import assert from 'node:assert/strict';
import express from 'express';
import {createInvoiceCsvRouter} from '../server/modules/invoice-export/router.mjs';
import {workApprovalOwner} from '../server/modules/approvals/work-approval-service.mjs';
import {capacityHash,capacityCanonical} from '../server/modules/planning/worker-capacity-service.mjs';

// In-memory transaction double: no authenticated database, secrets or grants.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user={sub:id(1),username:'synthetic',activeRole:'Admin'},organizationScope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};
const b={id:id(2),organization_id:'synthetic-org',legal_entity_id:'synthetic-legal',client_id:'client',contract_id:'contract',engagement_id:'engagement',currency:'USD',period_start:'2026-10-01',period_end:'2026-10-31',period_basis:'ELIGIBLE_DATE',owner_user_id:id(3),owner_role:'Admin',state:'Approved',current:true,lineage_hash:'a'.repeat(64)};
const evidence={milestoneId:'milestone',sourceVersion:1,engagementId:'engagement',contractVersionId:'version',engagementLifecycleId:'engagement-lifecycle',contractLifecycleId:'contract-lifecycle',dueOn:'2026-10-10',evidence:[{kind:'INTERNAL_ASSERTION',reference:'Synthetic acceptance',url:'https://example.test/proof'}],ownerUserId:id(3),ownerRole:'Admin',policyId:id(4),decisionId:id(5),currency:'USD',amount:'125.15'};
const line={lineId:id(6),sequence:1,itemId:id(7),itemVersion:1,eventId:id(8),sourceType:'MILESTONE_ACCEPTANCE',currency:'USD',amount:'125.15',eligibleDate:'2026-10-11',evidenceJson:JSON.stringify(evidence)};
const policy={id:id(9),route_id:id(10),definition:{entityType:'InvoiceExport',engagementId:'engagement',financeOwner:{userId:id(3),role:'Admin'},integrationAdmin:{userId:id(11),role:'Admin'},alertRouteId:id(10),locale:'en-US',templates:['invoice_batch.export_failed','invoice_batch.exported_or_billed_confirmed'].map(key=>({key,subject:'Invoice {{sourceRef}}',body:'Synthetic event'})),completionInApp:true}};
let mode='stale',writes=[],pending=[],fingerprint='';
const fake={async query(sql,args=[]){const q=String(sql);
 if(q==='begin'){pending=[];return{rows:[],rowCount:0};}if(q==='commit'){writes.push(...pending);pending=[];return{rows:[],rowCount:0};}if(q==='rollback'){pending=[];return{rows:[],rowCount:0};}
 if(/^(select pg_advisory|select set_config|savepoint |release savepoint |rollback to savepoint )/.test(q))return{rows:[],rowCount:0};
 if(q.startsWith('select 1 from user_organization_scopes'))return{rows:[{}],rowCount:1};
 if(q.startsWith('select permission_key from'))return{rows:[],rowCount:0};
 if(q.includes('select s.organization_id, s.legal_entity_id'))return{rows:[{organization_id:'synthetic-org',legal_entity_id:'synthetic-legal'}],rowCount:1};
 if(q.includes('select u.id from users u join user_roles'))return{rows:[{id:user.sub}],rowCount:1};
 if(q.startsWith('select e.model from invoice_draft_batches'))return{rows:[{model:'milestone'}],rowCount:1};
 if(q.includes('milestone_invoice_batch_source_current(b,'))return{rows:[b],rowCount:1};
 if(q.startsWith('select l.id,l.sequence,l.item_id'))return{rows:[{id:line.lineId,sequence:1,item_id:line.itemId,item_version:1,event_id:line.eventId,snapshot_id:null,currency:'USD',amount:'125.15',billing_evidence:evidence}],rowCount:1};
 if(q.startsWith('select count(*)::int n'))return{rows:[{n:1,total:'125.15'}],rowCount:1};
 if(q.includes('l.source_type as "sourceType"'))return{rows:[line],rowCount:1};
 if(q.includes('milestone_invoice_approval_pin_current(i)'))return{rows:[{id:id(12),final_transition_id:id(13),lineage_hash:'a'.repeat(64),current:mode!=='stale'}],rowCount:1};
 if(q.startsWith('select * from invoice_csv_artifacts where organization_id='))return{rows:mode==='replay'?[{id:id(14),batch_id:b.id,approval_id:id(12),final_transition_id:id(13),lineage_hash:'a'.repeat(64),schema_version:'workos.invoice-milestone-csv/1',version:1,sha256:'b'.repeat(64),line_count:1,currency:'USD',total:'125.15',actor_id:user.sub,active_role:'Admin',request_id:id(15),request_fingerprint:fingerprint,reason:'Synthetic export',operation_id:'synthetic',generated_at:'2026-10-29T00:00:00Z',payload:Buffer.from('synthetic')}]:[],rowCount:mode==='replay'?1:0};
 if(q.startsWith('select * from invoice_csv_failures where organization_id='))return{rows:[],rowCount:0};
 if(q.startsWith('select * from invoice_export_notice_policies'))return{rows:[policy],rowCount:1};
 if(q.includes('clock_timestamp()'))return{rows:[{d:'2026-10-29'}],rowCount:1};
 if(q.startsWith('select n.in_app'))return{rows:[],rowCount:0};
 if(q.startsWith('insert into invoice_csv_artifacts')){pending.push(q);return{rows:[{id:args[0],batch_id:args[1],approval_id:args[4],final_transition_id:args[5],lineage_hash:args[6],schema_version:args[7],version:1,payload:args[8],sha256:args[9],line_count:args[10],currency:args[11],total:args[12],actor_id:args[13],active_role:args[14],request_id:args[15],reason:args[17],operation_id:args[18],generated_at:'2026-10-29T00:00:00Z'}],rowCount:1};}
 if(q.startsWith('insert ')){pending.push(q);return{rows:[],rowCount:1};}
 throw new Error('Unexpected synthetic query: '+q.slice(0,100));
},release(){}};
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=user;req.organizationScope=organizationScope;req.operationId='synthetic';next();});const pass=(_r,_s,n)=>n();
app.use(createInvoiceCsvRouter({pool:{connect:async()=>fake},requireDatabase:pass,requireAuth:pass,buildEmployeeScopeWhere:()=> 'true',audit:async()=>{},logError:()=>{}}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
try{
 const body={expectedOwnerKey:workApprovalOwner({user,organizationScope}),requestId:id(15),batchId:b.id,approvalId:id(12),finalTransitionId:id(13),lineageHash:'a'.repeat(64),schemaVersion:'workos.invoice-milestone-csv/1',expectedLineCount:1,expectedTotal:'125.15',reason:'Synthetic export'};
 fingerprint=capacityHash(capacityCanonical(body));const command=input=>fetch(`http://127.0.0.1:${server.address().port}/exports`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
 let response=await command(body);assert.equal(response.status,409);assert.equal(writes.length,0);
 mode='replay';response=await command(body);assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);assert.equal(writes.length,0);
 fingerprint='f'.repeat(64);response=await command(body);assert.equal(response.status,409);assert.equal(writes.length,0);
 mode='fresh';response=await command({...body,schemaVersion:'workos.invoice-tm-csv/1'});assert.equal(response.status,409);assert.equal(writes.length,0);
 response=await command(body);assert.equal(response.status,201);const result=await response.json();assert.equal(result.artifact.schemaVersion,body.schemaVersion);assert.equal(result.artifact.total,'125.15');assert(writes.some(q=>q.startsWith('insert into invoice_csv_artifacts')));assert(writes.some(q=>q.startsWith('insert into invoice_export_notice_events')));
}finally{await new Promise(resolve=>server.close(resolve));}
console.log('Synthetic milestone export command covers stale refusal, exact replay, schema isolation and artifact dispatch.');
