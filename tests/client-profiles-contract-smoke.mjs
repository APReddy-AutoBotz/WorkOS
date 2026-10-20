import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {clientProfileSchema,billingUnitSchema,billingUnitVersionSchema,profileQuerySchema} from '../server/modules/client-profiles/contracts.mjs';
import {createClientProfilesRouter} from '../server/modules/client-profiles/router.mjs';

const fields={effectiveFrom:'2026-10-20',legalName:null,displayName:null,defaultCurrency:null,billingContacts:[],reason:'Synthetic profile'};
const profile={...fields,code:'SYN-CLIENT',expectedVersion:0,parentClientId:null};
const unit={...fields,code:'SYN-BILLING',kind:'billing_entity'};
const revision={...fields,expectedVersion:1};
for(const [schema,input] of [[clientProfileSchema,profile],[billingUnitSchema,unit],[billingUnitVersionSchema,revision]]){
 assert(schema.safeParse(input).success);
 assert(schema.safeParse({...input,legalName:'Synthetic customer legal name',displayName:'Synthetic display',defaultCurrency:'USD',billingContacts:[{name:'Synthetic billing contact',email:'billing@example.test'}]}).success);
 for(const key of Object.keys(input)){const copy={...input};delete copy[key];assert.equal(schema.safeParse(copy).success,false,`${key} must be explicit, including nulls`);}
 for(const patch of [{organizationId:'forged'},{legalEntityId:'forged'},{actorId:'forged'},{activeRole:'Admin'},{status:'Inactive'},
  {currency:'USD'},{billingEligible:true},{taxIdentifier:'forged'},{paymentAccount:'forged'},
  {effectiveFrom:'2026-02-30'},{effectiveFrom:'2025-02-29'},{legalName:''},{displayName:'x'.repeat(201)},
  {defaultCurrency:''},{defaultCurrency:'usd'},{billingContacts:null},{billingContacts:Array.from({length:11},()=>({name:'Synthetic',email:'billing@example.test'}))},
  {billingContacts:[{name:'',email:'billing@example.test'}]},{billingContacts:[{name:'Synthetic',email:'not-an-email'}]},
  {billingContacts:[{name:'Synthetic',email:'billing@example.test',bank:'not-supported'}]},{reason:'  '},{reason:'x'.repeat(1001)}])
  assert.equal(schema.safeParse({...input,...patch}).success,false,JSON.stringify(patch));
}
for(const patch of [{code:''},{code:'lowercase'},{code:'X'.repeat(81)},{expectedVersion:-1},{expectedVersion:200},{expectedVersion:'0'},{parentClientId:''}])
 assert.equal(clientProfileSchema.safeParse({...profile,...patch}).success,false);
for(const kind of ['business_unit','billing_entity'])assert(billingUnitSchema.safeParse({...unit,kind}).success);
for(const kind of ['legal_entity','parent','tax_entity',''])assert.equal(billingUnitSchema.safeParse({...unit,kind}).success,false);
assert.equal(billingUnitVersionSchema.safeParse({...revision,expectedVersion:0}).success,false);
assert(profileQuerySchema.safeParse({asOf:'2026-10-20'}).success);assert(profileQuerySchema.safeParse({}).success);
for(const value of [{asOf:'2026-02-30'},{organizationId:'forged'},{limit:'10000'},{includeContacts:true}])assert.equal(profileQuerySchema.safeParse(value).success,false);
assert.throws(()=>createClientProfilesRouter({}));
const scope={organizationId:'org-synthetic',legalEntityId:'legal-synthetic'};
let calls=[],permissions=[],deny=null,failure=null,released=0;
const connection={release(){released++;},async query(sql,values=[]){
 calls.push({sql,values});
 if(sql.includes('from user_organization_scopes'))return {rows:[{organization_id:scope.organizationId,legal_entity_id:scope.legalEntityId}],rowCount:1};
 if(sql.includes('from users u join user_roles')){permissions.push(values[2]);return {rows:deny===values[2]?[]:[{id:'actor-synthetic'}],rowCount:deny===values[2]?0:1};}
 if(sql.includes("now() at time zone 'UTC'"))return {rows:[{today:'2026-10-20'}],rowCount:1};
 if(sql.includes('from clients c')){if(failure)throw Object.assign(new Error('CONFIDENTIAL RAW SQL'),{code:failure});return {rows:[],rowCount:0};}
 return {rows:[],rowCount:0};
}};
const app=express();app.use(express.json());
app.use('/api/v1/client-profiles',createClientProfilesRouter({pool:{connect:async()=>connection},requireDatabase:(req,res,next)=>next(),
 requireAuth:(req,res,next)=>{req.user={sub:'actor-synthetic',activeRole:'Admin'};req.organizationScope=scope;req.correlationId='synthetic-correlation';req.operationId='synthetic-operation';next();},audit:async()=>{},logError(){}}));
const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
const url=`http://127.0.0.1:${server.address().port}/api/v1/client-profiles`;
const request=async(path,body)=>{calls=[];permissions=[];const response=await fetch(url+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
try{
 const read=await request('/workspace');assert.equal(read.status,200);assert.deepEqual(read.body,{asOf:'2026-10-20',clients:[],limit:200,truncated:false});
 assert.deepEqual(permissions,['commercial.clients.view']);assert.equal(calls[0].sql,'begin isolation level repeatable read');assert.equal(calls.at(-1).sql,'commit');
 const invalid=await request('/clients/synthetic/profiles',{...profile,actorId:'forged'});assert.equal(invalid.status,400);assert.equal(calls.length,0);
 deny='commercial.clients.manage';const noManage=await request('/clients/synthetic/profiles',profile);assert.equal(noManage.status,403);assert.equal(noManage.body.error.code,'COMMERCIAL_PERMISSION_DENIED');
 assert.deepEqual(permissions,['commercial.clients.view','commercial.clients.manage']);assert.equal(calls[0].sql,'begin isolation level read committed');assert.equal(calls.at(-1).sql,'rollback');assert.equal(calls.some(x=>/insert into/.test(x.sql)),false);
 deny='commercial.clients.view';const noView=await request('/workspace');assert.equal(noView.status,403);assert.equal(calls.at(-1).sql,'rollback');
 deny=null;for(const [code,status,expected] of [['WCP01',409,'CLIENT_PROFILE_VERSION_CONFLICT'],['WCP02',409,'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT'],['WCP03',409,'CLIENT_PROFILE_PARENT_CYCLE'],['WCP04',409,'CLIENT_PROFILE_ISOLATION_CONFLICT'],['23505',409,'CLIENT_PROFILE_DUPLICATE'],['23503',422,'CLIENT_PROFILE_CONSTRAINT'],['XX000',503,'CLIENT_PROFILE_UNAVAILABLE']]){
  failure=code;const result=await request('/workspace');assert.equal(result.status,status);assert.equal(result.body.error.code,expected);assert.equal(calls.at(-1).sql,'rollback');assert.doesNotMatch(JSON.stringify(result.body),/CONFIDENTIAL RAW SQL/);
 }
 assert.equal(released,10);
}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
const migration=await readFile(new URL('../server/migrations/042_wos04_scoped_client_profiles.sql',import.meta.url),'utf8');
assert.doesNotMatch(migration,/insert into (?:role_permissions|user_permission_grants)|alter table clients|update (?:clients|projects|commercial_contract)/i);
assert.match(migration,/pg_advisory_xact_lock/);assert.match(migration,/every future boundary/);assert.match(migration,/before update or delete on client_profile_events/);
const index=await readFile(new URL('../server/index.mjs',import.meta.url),'utf8');assert.match(index,/createClientProfilesRouter\(\{pool,requireDatabase,requireAuth,audit\}\)/);
console.log('Client profiles strict schemas, opt-in permission/transaction/error contracts, no default grants and additive projection isolation passed.');
