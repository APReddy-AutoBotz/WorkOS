import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {createCommercialDraftingRouter} from '../server/modules/commercial-drafting/router.mjs';
import {COMMERCIAL_MODELS,ENGAGEMENT_MODELS,createContractSchema,appendContractSchema,createEngagementSchema,createPurchaseOrderSchema,createMilestoneSchema,workspaceQuerySchema} from '../server/modules/commercial-drafting/contracts.mjs';
import {termsDto} from '../server/modules/commercial-drafting/service.mjs';

const terms={name:'Synthetic agreement',model:'time_and_materials',startsOn:'2026-01-01',endsOn:'2030-12-31',effectiveFrom:'2026-01-01',currency:'USD',value:'99999999999999.1234',billingTerms:'Synthetic terms',documents:[{name:'Synthetic document',url:'https://example.test/contract'}],reason:'Synthetic create'};
const credentialUrl=new URL('https://example.test/a');credentialUrl.username='example-user';credentialUrl.password='example-password';
const contract={number:'SYN-CONTRACT',clientId:'synthetic-client',...terms};
assert(createContractSchema.safeParse(contract).success);
for(const model of COMMERCIAL_MODELS)assert(createContractSchema.safeParse({...contract,model}).success);
assert.equal(ENGAGEMENT_MODELS.length,7);
for(const delta of [{organizationId:'forged'},{actorId:'forged'},{status:'Approved'},{value:0.3},{value:'-0.1'},{value:'1e3'},{value:'01.00'},{value:'100000000000000.0000'},{value:'0.00001'},{effectiveFrom:'2026-02-30'},{endsOn:'2025-12-31'},{documents:[{name:'x',url:'http://example.test/a'}]},{documents:[{name:'x',url:credentialUrl.toString()}]},{documents:[{name:'x',url:'javascript:alert(1)'}]}]){
 assert.equal(createContractSchema.safeParse({...contract,...delta}).success,false,JSON.stringify(delta));
}
assert(appendContractSchema.safeParse({...terms,expectedVersion:1}).success);
for(const expectedVersion of [0,200,1.5,'1'])assert.equal(appendContractSchema.safeParse({...terms,expectedVersion}).success,false);
const engagement={code:'SYN-ENG',name:'Synthetic engagement',model:'internal',ownerId:'synthetic-owner',startsOn:'2026-01-01',endsOn:'2026-12-31',currency:'USD',budget:'0',clientId:null,contractId:null,contractVersionId:null,attributionId:'synthetic-bu',reason:'Synthetic attribution'};
for(const model of ENGAGEMENT_MODELS)assert(createEngagementSchema.safeParse({...engagement,model}).success);
assert.equal(createEngagementSchema.safeParse({...engagement,billable:true}).success,false);
const po={contractId:'synthetic-contract',contractVersionId:'synthetic-version',number:'SYN-PO',value:'123.4567',currency:'USD',startsOn:'2026-01-01',endsOn:'2026-12-31',warningThresholdPercent:'80.01',reason:'Synthetic PO'};
assert(createPurchaseOrderSchema.safeParse(po).success);
for(const warningThresholdPercent of ['100.01','101','-1','1.111',50])assert.equal(createPurchaseOrderSchema.safeParse({...po,warningThresholdPercent}).success,false);
assert(createMilestoneSchema.safeParse({engagementId:'synthetic-engagement',code:'SYN-M1',name:'Synthetic milestone',dueOn:'2026-10-01',amount:'0.0000',currency:'USD',reason:'Synthetic checkpoint'}).success);
assert(workspaceQuerySchema.safeParse({asOf:'2026-10-20'}).success);
assert.equal(workspaceQuerySchema.safeParse({organizationId:'forged'}).success,false);
const sample=termsDto({id:'synthetic-version',version:1,name:'Synthetic terms',model:'retainer',starts_on:'2026-10-20',ends_on:'2030-01-01',effective_from:'2026-10-20',currency:'USD',value:'0.1234',billing_terms:'Synthetic',documents:[]});
assert.equal(sample.value,'0.1234');assert.equal(sample.startsOn,'2026-10-20');

const queries=[];let released=0;let unavailable=false;
const query=async(sql)=>{
 queries.push(sql);
 if(sql.includes('from user_organization_scopes s'))return {rows:[{organization_id:'synthetic-org',legal_entity_id:'synthetic-legal'}],rowCount:1};
 if(sql.includes('select u.id from users u'))return {rows:[],rowCount:0};
 return {rows:[],rowCount:0};
};
const pool={connect:async()=>{if(unavailable)throw new Error('Synthetic unavailable');return {query,release(){released+=1;}};}};
const app=express();app.use(express.json());
app.use('/drafts',createCommercialDraftingRouter({pool,requireDatabase:(_req,_res,next)=>next(),requireAuth:(req,_res,next)=>{req.user={sub:'synthetic-user',activeRole:'Admin'};req.organizationScope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};next();},audit:async()=>{throw new Error('Denied request must never audit');},logError:()=>{}}));
const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
try{
 const base=`http://127.0.0.1:${server.address().port}/drafts`;
 let response=await fetch(`${base}/workspace`);assert.equal(response.status,403);assert.equal((await response.json()).error.code,'COMMERCIAL_PERMISSION_DENIED');
 assert.equal(queries.at(-1),'rollback');assert.equal(released,1);assert.equal(queries.some(sql=>sql.includes('from commercial_contracts')),false);
 response=await fetch(`${base}/contracts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...contract,status:'Approved'})});assert.equal(response.status,400);assert.equal(released,1,'invalid payload must not acquire a database client');
 response=await fetch(`${base}/contracts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(contract)});assert.equal(response.status,403);assert.equal(queries.at(-1),'rollback');assert.equal(released,2);
 unavailable=true;response=await fetch(`${base}/workspace`);assert.equal(response.status,503);assert.equal((await response.json()).error.code,'COMMERCIAL_UNAVAILABLE');
 response=await fetch(`${base}/workspace?asOf=2026-02-30`);assert.equal(response.status,400);
 response=await fetch(`${base}/contracts/synthetic/close`,{method:'POST'});assert.equal(response.status,404,'no lifecycle/acceptance endpoint is exposed');
}finally{await new Promise(resolve=>server.close(resolve));}
const migration=await readFile(new URL('../server/migrations/040_wos04_commercial_drafting_foundation.sql',import.meta.url),'utf8');
assert.doesNotMatch(migration,/insert\s+into\s+(role_permissions|user_permission_grants)/i,'migration creates no grants');
assert.match(migration,/deferrable initially deferred/);assert.match(migration,/legacy_unclassified/);assert.match(migration,/immutable_commercial_event/);
console.log('Commercial draft strict schemas, decimal/date transport, seven models, opt-in denial, transactions and unavailable/no-lifecycle route contracts passed.');
