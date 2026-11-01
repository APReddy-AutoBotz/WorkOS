import assert from 'node:assert/strict';
import express from 'express';
import {createInvoiceBatchApprovalRouter} from '../server/modules/invoice-approval/router.mjs';
import {workApprovalOwner} from '../server/modules/approvals/work-approval-service.mjs';
import {capacityHash,capacityCanonical} from '../server/modules/planning/worker-capacity-service.mjs';

// HTTP command against a synthetic transactional double, not PostgreSQL acceptance.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user={sub:id(1),username:'synthetic',activeRole:'Admin'},organizationScope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};
const b={id:id(2),source_type:'MILESTONE_ACCEPTANCE',organization_id:'synthetic-org',legal_entity_id:'synthetic-legal',client_id:'client',contract_id:'contract',engagement_id:'engagement',currency:'USD',period_start:'2026-10-01',period_end:'2026-10-31',period_basis:'ELIGIBLE_DATE',owner_user_id:id(3),owner_role:'Admin',preparer_user_id:id(4),preparer_role:'Admin',state:'Draft',current:true,lineage_hash:'a'.repeat(64)};
const policy={id:id(5),engagement_id:'engagement',sequence:1,previous_id:null,effective_from:'2026-10-01',actor_id:id(3),active_role:'Admin',reason:'Synthetic policy',request_id:id(6),created_at:'2026-10-01T00:00:00Z',definition:{entityType:'InvoiceBatch',engagementId:'engagement',stages:[{userId:id(7),role:'Admin'}],locale:'en-US',templates:['approval.action_required','approval.rejected_or_correction_required','approval.completed'].map(key=>({key,subject:'Review {{sourceRef}}',body:'Stage {{stageNumber}}'})),completionInApp:false}};
let mode='stale',writes=[],fingerprint='';
const fake={async query(sql,args=[]){const q=String(sql);
 if(['begin','commit','rollback'].includes(q)||q.startsWith('select pg_advisory'))return{rows:[],rowCount:0};
 if(q.startsWith('select 1 from user_organization_scopes'))return{rows:[{}],rowCount:1};if(q.startsWith('select permission_key from'))return{rows:[],rowCount:0};
 if(q.includes('select s.organization_id, s.legal_entity_id'))return{rows:[{organization_id:'synthetic-org',legal_entity_id:'synthetic-legal'}],rowCount:1};
 if(q.includes('select u.id from users u join user_roles'))return{rows:[{id:user.sub}],rowCount:1};
 if(q.startsWith('select e.model from invoice_draft_batches'))return{rows:[{model:'milestone'}],rowCount:1};
 if(q.includes('milestone_invoice_batch_source_current(b,'))return{rows:[{...b,current:mode!=='stale'}],rowCount:1};
 if(q.startsWith('select l.id,l.sequence,l.item_id'))return{rows:[{id:id(8),sequence:1,item_id:id(9),item_version:1,event_id:id(10),snapshot_id:null,currency:'USD',amount:'125.15',billing_evidence:{}}],rowCount:1};
 if(q.startsWith('select count(*)::int n'))return{rows:[{n:1,total:'125.15'}],rowCount:1};
 if(q.startsWith('select * from invoice_batch_approval_instances where organization_id='))return{rows:mode==='replay'?[{id:id(11),batch_id:b.id,sequence:1,policy_id:policy.id,owner_user_id:b.owner_user_id,owner_role:b.owner_role,preparer_user_id:b.preparer_user_id,preparer_role:b.preparer_role,requester_user_id:user.sub,active_role:'Admin',line_count:1,lineage_hash:b.lineage_hash,currency:'USD',total:'125.15',request_id:id(12),request_fingerprint:fingerprint,reason:'Synthetic review',created_at:'2026-10-29T00:00:00Z'}]:[],rowCount:mode==='replay'?1:0};
 if(q.startsWith('select *,effective_from::text from invoice_batch_approval_policies where id='))return{rows:[policy],rowCount:1};
 if(q.startsWith('select id,sequence,stage,decision'))return{rows:[],rowCount:0};if(q.startsWith('select id,actor_id as "actorId"'))return{rows:[],rowCount:0};
 if(q.startsWith('select e.model from invoice_batch_approval_instances'))return{rows:[{model:'milestone'}],rowCount:1};
 if(q.includes("invoice_batch_governed_state(i.batch_id)='Under Review'"))return{rows:[{current:true}],rowCount:1};
 if(q.includes('clock_timestamp()'))return{rows:[{d:'2026-10-29'}],rowCount:1};
 if(q.startsWith('insert ')){writes.push(q);return{rows:[],rowCount:1};}
 throw new Error('Unexpected synthetic query: '+q.slice(0,100));
},release(){}};
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=user;req.organizationScope=organizationScope;req.operationId='synthetic';next();});const pass=(_r,_s,n)=>n();
app.use(createInvoiceBatchApprovalRouter({pool:{connect:async()=>fake},requireDatabase:pass,requireAuth:pass,buildEmployeeScopeWhere:()=> 'true',audit:async()=>{},logError:()=>{}}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
try{
 const body={expectedOwnerKey:workApprovalOwner({user,organizationScope}),requestId:id(12),batchId:b.id,expectedPolicyId:policy.id,expectedLineCount:1,expectedLineageHash:b.lineage_hash,reason:'Synthetic review'};fingerprint=capacityHash(capacityCanonical(body));
 const command=()=>fetch(`http://127.0.0.1:${server.address().port}/requests`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 let response=await command();assert.equal(response.status,409);assert.equal(writes.length,0);
 b.source_type='TM_SNAPSHOT';response=await command();assert.equal(response.status,404);assert.equal(writes.length,0);b.source_type='MILESTONE_ACCEPTANCE';
 mode='replay';response=await command();assert.equal(response.status,200);const result=await response.json();assert.equal(result.replayed,true);assert.equal(result.approval.state.status,'Pending');assert.equal(writes.length,0);
 fingerprint='f'.repeat(64);response=await command();assert.equal(response.status,409);assert.equal(writes.length,0);
}finally{await new Promise(resolve=>server.close(resolve));}
console.log('Synthetic milestone invoice approval command covers stale refusal and exact-request replay.');
