import assert from 'node:assert/strict';
import express from 'express';
import {createInvoiceNoticeConfigRouter} from '../server/modules/invoice-export/notice-config-router.mjs';

// Requests and permissions below are synthetic; no database or credentials exist.
const user={sub:'00000000-0000-4000-8000-000000000001',username:'synthetic',activeRole:'Admin'},organizationScope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};
let model='milestone',canView=false,policyReads=0;
const client={async query(sql,args=[]){const q=String(sql);
 if(['begin','begin isolation level repeatable read','commit','rollback'].includes(q))return{rows:[],rowCount:0};
 if(q.includes('select s.organization_id, s.legal_entity_id'))return{rows:[{organization_id:'synthetic-org',legal_entity_id:'synthetic-legal'}],rowCount:1};
 if(q.includes('select u.id from users u join user_roles'))return args[2]==='commercial.milestone_billing.view'&&!canView?{rows:[],rowCount:0}:{rows:[{id:user.sub}],rowCount:1};
 if(q.startsWith('select model from commercial_engagements'))return{rows:[{model}],rowCount:1};
 if(q.includes('from invoice_export_notice_policies')){policyReads++;return{rows:[],rowCount:0};}
 throw new Error('Unexpected synthetic query: '+q.slice(0,100));
},release(){}};
const app=express(),pass=(_r,_s,n)=>n();app.use((req,_res,next)=>{req.user=user;req.organizationScope=organizationScope;next();});app.use(createInvoiceNoticeConfigRouter({pool:{connect:async()=>client},requireDatabase:pass,requireAuth:pass,logError:()=>{}}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
try{
 const request=()=>fetch(`http://127.0.0.1:${server.address().port}/policies?engagementId=synthetic-engagement`);
 let response=await request();assert.equal(response.status,403);assert.equal(policyReads,0);
 canView=true;response=await request();assert.equal(response.status,200);assert.equal(policyReads,1);
 model='time_and_materials';canView=false;response=await request();assert.equal(response.status,200);assert.equal(policyReads,2);
}finally{await new Promise(resolve=>server.close(resolve));}
console.log('Synthetic invoice notice configuration enforces milestone scope while retaining T&M access.');
