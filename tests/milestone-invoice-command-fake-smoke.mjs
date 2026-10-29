import assert from 'node:assert/strict';
import express from 'express';
import {createInvoiceDraftRouter} from '../server/modules/invoice-drafts/router.mjs';
import {workApprovalOwner} from '../server/modules/approvals/work-approval-service.mjs';
import {capacityHash,capacityCanonical} from '../server/modules/planning/worker-capacity-service.mjs';

// This exercises HTTP command dispatch and replay with a synthetic transaction
// double. It does not execute PostgreSQL guards or create test credentials.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user={sub:id(1),username:'synthetic',activeRole:'Admin'},organizationScope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};
const batch={id:id(2),clientId:'client',contractId:'contract',engagementId:'engagement',currency:'USD',periodStart:'2026-10-01',periodEnd:'2026-10-31',periodBasis:'ELIGIBLE_DATE',ownerUserId:id(3),ownerRole:'Admin',ownerCurrent:true,state:'Draft'};
const evidence={milestoneId:'milestone',sourceVersion:1,engagementId:'engagement',contractVersionId:'version',engagementLifecycleId:'engagement-lifecycle',contractLifecycleId:'contract-lifecycle',dueOn:'2026-10-10',evidence:[{kind:'INTERNAL_ASSERTION',reference:'Synthetic acceptance',url:'https://example.test/proof'}],ownerUserId:id(3),ownerRole:'Admin',policyId:id(4),decisionId:id(5),currency:'USD',amount:'125.15'};
const item={itemId:id(6),itemVersion:1,eventId:id(7),clientId:'client',contractId:'contract',engagementId:'engagement',currency:'USD',eligibleOn:'2026-10-11',amount:'125.15',evidence,current:true};
let mode='stale',writes=[],pendingWrites=[],fingerprint='',saved=null;
const fake={async query(sql,args=[]){
 const q=String(sql);
 if(q==='begin'){pendingWrites=[];saved=null;return{rows:[],rowCount:0};}
 if(q==='commit'){writes.push(...pendingWrites);pendingWrites=[];return{rows:[],rowCount:0};}
 if(q==='rollback'){pendingWrites=[];saved=null;return{rows:[],rowCount:0};}
 if(q.startsWith('select pg_advisory')||q.startsWith('select set_config'))return{rows:[],rowCount:0};
 if(q.startsWith('select 1 from user_organization_scopes'))return{rows:[{}],rowCount:1};
 if(q.startsWith('select permission_key from'))return{rows:[],rowCount:0};
 if(q.includes('select s.organization_id, s.legal_entity_id'))return{rows:[{organization_id:'synthetic-org',legal_entity_id:'synthetic-legal'}],rowCount:1};
 if(q.includes('select u.id from users u join user_roles'))return mode==='unauthorized'&&args[2]==='commercial.milestone_billing.view'?{rows:[],rowCount:0}:{rows:[{id:user.sub}],rowCount:1};
 if(q.includes('invoice_draft_owner_current(b)'))return{rows:[batch],rowCount:1};
 if(q.startsWith('select e.model from invoice_draft_batches'))return{rows:[{model:'milestone'}],rowCount:1};
 if(q.startsWith('select snapshot_id from invoice_draft_lines'))return{rows:[],rowCount:0};
 if(q.includes("coalesce(to_jsonb(item)->>'source_type'"))return{rows:[{source_type:'MILESTONE_ACCEPTANCE'}],rowCount:1};
 if(q.includes('milestone_invoice_item_current(b,item.id'))return{rows:[{...item,current:mode!=='stale'}],rowCount:1};
 if(q.includes('l.request_fingerprint as fingerprint'))return{rows:mode==='replay'?[{id:id(8),batchId:batch.id,activeRole:'Admin',fingerprint}]:[],rowCount:mode==='replay'?1:0};
 if(q.includes('from invoice_draft_lines l where l.batch_id='))return{rows:saved?[saved]:[],rowCount:saved?1:0};
 if(q.includes('from invoice_draft_lines l where l.id='))return{rows:saved?[saved]:[],rowCount:saved?1:0};
 if(q.startsWith('select count(*)::int as "lineCount"'))return{rows:[{lineCount:saved?1:0,amount:saved?'125.15':'0'}],rowCount:1};
 if(q.includes('from invoice_draft_cancellations c where c.batch_id='))return{rows:[],rowCount:0};
 if(q.includes('clock_timestamp()'))return{rows:[{d:'2026-10-29'}],rowCount:1};
 if(q.startsWith('insert ')){pendingWrites.push({q,args});if(q.startsWith('insert into invoice_draft_lines'))saved={id:args[0],batchId:args[3],itemId:args[5],itemVersion:args[6],eventId:args[7],snapshotId:args[8],currency:args[9],amount:args[10],evidence:JSON.parse(args[11]),actorId:args[12],activeRole:args[13],requestId:args[14]};return{rows:[],rowCount:1};}
 throw new Error('Unexpected synthetic query: '+q.slice(0,100));
},release(){}};
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=user;req.organizationScope=organizationScope;req.operationId='synthetic-operation';next();});
const pass=(_r,_s,n)=>n();app.use(createInvoiceDraftRouter({pool:{connect:async()=>fake},requireDatabase:pass,requireAuth:pass,buildEmployeeScopeWhere:()=> 'true',audit:async()=>{if(mode==='audit-failure')throw new Error('Synthetic audit refusal');},logError:()=>{}}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
try{
 const body={expectedOwnerKey:workApprovalOwner({user,organizationScope}),requestId:id(9),reason:'Synthetic acquisition',itemId:item.itemId,itemVersion:1,expectedLineCount:0};
 fingerprint=capacityHash(capacityCanonical(body));
 const command=()=>fetch(`http://127.0.0.1:${server.address().port}/batches/${batch.id}/lines`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 let response=await command();assert.equal(response.status,409);assert.equal(writes.length,0);
 mode='unauthorized';response=await command();assert.equal(response.status,403);assert.equal(writes.length,0);
 mode='replay';response=await command();assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);assert.equal(writes.length,0);
 mode='replay';fingerprint='f'.repeat(64);response=await command();assert.equal(response.status,409);assert.equal(writes.length,0);
 mode='audit-failure';response=await command();assert.equal(response.status,503);assert.equal(writes.length,0);assert.equal(pendingWrites.length,0);
 mode='fresh';response=await command();assert.equal(response.status,201);assert.equal((await response.json()).replayed,false);assert.equal(writes.length,2);assert(writes[0].q.includes("'MILESTONE_ACCEPTANCE'"));assert(writes[1].q.startsWith('insert into invoice_draft_occupancies'));
}finally{await new Promise(resolve=>server.close(resolve));}
console.log('Synthetic milestone acquisition command covers stale refusal, exact replay, audit rollback and line-plus-occupancy dispatch.');
