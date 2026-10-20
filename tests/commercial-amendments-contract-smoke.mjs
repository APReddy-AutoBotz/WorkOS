import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {amendmentPreviewSchema,amendmentCommandSchema} from '../server/modules/commercial-drafting/amendment-contracts.mjs';
import {createCommercialDraftingRouter} from '../server/modules/commercial-drafting/router.mjs';

// Pure strict-schema and actual route-handler tests. No HTTP listener, browser,
// PostgreSQL service, external account or test fallback is used by this suite.
const preview={expectedSequence:0,expectedLifecycleSequence:1,expectedContractVersion:2,contractVersionId:'contract-version-synthetic-2',
  effectiveOn:'2026-10-20',startsOn:'2020-01-01',endsOn:'2099-12-31',budget:'99999999999999.9999',
  reason:'Synthetic governed terms adoption',approvalReference:'SYNTHETIC-APPROVAL'};
const command={...preview,previewToken:'a'.repeat(64)};
assert(amendmentPreviewSchema.safeParse(preview).success);
assert(amendmentCommandSchema.safeParse(command).success);
for(const [schema,input] of [[amendmentPreviewSchema,preview],[amendmentCommandSchema,command]]){
  for(const key of Object.keys(input)){
    const missing={...input};delete missing[key];assert.equal(schema.safeParse(missing).success,false,`${key} must be explicit`);
  }
  for(const delta of [
    {expectedSequence:-1},{expectedSequence:200},{expectedSequence:0.1},{expectedSequence:'0'},
    {expectedLifecycleSequence:0},{expectedLifecycleSequence:201},{expectedLifecycleSequence:1.5},{expectedLifecycleSequence:'1'},
    {expectedContractVersion:0},{expectedContractVersion:201},{expectedContractVersion:2.5},{expectedContractVersion:'2'},
    {contractVersionId:''},{contractVersionId:null},{contractVersionId:'x'.repeat(201)},
    {effectiveOn:'2026-02-30'},{effectiveOn:'2025-02-29'},{effectiveOn:'2026-10-20T00:00:00Z'},
    {startsOn:'2026-00-01'},{endsOn:'2026-10-32'},{startsOn:'2026-10-21'},{endsOn:'2026-10-19'},
    {startsOn:'2099-12-31',endsOn:'2020-01-01'},
    {budget:0},{budget:null},{budget:'NaN'},{budget:'Infinity'},{budget:'1e4'},{budget:'-0.0001'},
    {budget:'01.0000'},{budget:'0.00001'},{budget:'100000000000000'},{budget:'1,000.00'},
    {reason:''},{reason:'  '},{reason:'ab'},{reason:'x'.repeat(1001)},
    {approvalReference:''},{approvalReference:'  '},{approvalReference:null},{approvalReference:'x'.repeat(201)},
  ])assert.equal(schema.safeParse({...input,...delta}).success,false,JSON.stringify(delta));
  for(const [key,value] of Object.entries({organizationId:'forged',legalEntityId:'forged',entityType:'Project',entityId:'forged',
    actorId:'forged',createdBy:'forged',activeRole:'Admin',role:'Admin',source:'Migration',correlationId:'forged',operationId:'forged',
    clientId:'forged',contractId:'forged',currency:'GBP',model:'fixed_fee',name:'forged',billable:true,billingEligible:true,
    state:'Active',status:'Active',sequence:9,before:{budget:'0'},after:{budget:'0'},effectiveFrom:'2000-01-01'}))
    assert.equal(schema.safeParse({...input,[key]:value}).success,false,`${key} cannot become client authority`);
}
for(const budget of ['0','0.0000','0.0001','1','10.1','99999999999999.9999'])assert(amendmentPreviewSchema.safeParse({...preview,budget}).success);
assert(amendmentPreviewSchema.safeParse({...preview,expectedSequence:199,expectedLifecycleSequence:200,expectedContractVersion:200}).success);
assert(amendmentPreviewSchema.safeParse({...preview,effectiveOn:'2028-02-29'}).success);
assert.equal(amendmentPreviewSchema.safeParse(command).success,false,'preview cannot accept an unbound submitted token');
for(const previewToken of ['',null,'A'.repeat(64),'a'.repeat(63),'a'.repeat(65),'g'.repeat(64),'abc'])
  assert.equal(amendmentCommandSchema.safeParse({...command,previewToken}).success,false,'tokens are canonical SHA-256 hex');

const scope={organizationId:'org-synthetic',legalEntityId:'legal-synthetic'};
let connected=0,released=0,deniedPermission=null,unavailable=false;
const calls=[],permissions=[];
const connection={release(){released++;},async query(sql,values=[]){
  calls.push({sql,values});
  if(sql.includes('from user_organization_scopes'))return {rows:[{organization_id:scope.organizationId,legal_entity_id:scope.legalEntityId}],rowCount:1};
  if(sql.includes('select u.id from users u')){
    permissions.push(values[2]);const allowed=deniedPermission!==values[2];return {rows:allowed?[{id:'actor-synthetic'}]:[],rowCount:allowed?1:0};
  }
  if(sql.includes("at time zone 'UTC'"))return {rows:[{today:'2026-10-20'}],rowCount:1};
  return {rows:[],rowCount:0};
}};
const router=createCommercialDraftingRouter({pool:{async connect(){connected++;if(unavailable)throw new Error('Synthetic unavailable');return connection;}},
  requireDatabase:(_req,_res,next)=>next(),requireAuth:(_req,_res,next)=>next(),audit:async()=>{},logError(){}});
const invoke=async(method,path,body,query={})=>{
  calls.length=permissions.length=0;
  const layer=router.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]);
  assert(layer,`production ${method.toUpperCase()} ${path} must be registered`);
  const req={body,query,params:{type:'Contract',id:'missing-synthetic-contract'},organizationScope:scope,
    headers:{'x-organization-id':scope.organizationId,'x-legal-entity-id':scope.legalEntityId},
    user:{sub:'actor-synthetic',activeRole:'Admin'},correlationId:'synthetic-correlation',operationId:'synthetic-operation'};
  const result={status:200,body:null};
  const res={status(status){result.status=status;return this;},json(value){result.body=value;return this;}};
  await layer.route.stack[0].handle(req,res);return result;
};
const readPath='/amendments/:type/:id',previewPath='/amendments/:type/:id/preview';
for(const [method,path,body] of [['get',readPath],['post',previewPath,preview],['post',readPath,command]]){
  deniedPermission='commercial.contracts.view';const before=released;const result=await invoke(method,path,body);
  assert.equal(result.status,403);assert.equal(result.body.error.code,'COMMERCIAL_PERMISSION_DENIED');
  assert.deepEqual(permissions,['commercial.contracts.view']);assert.equal(calls.at(-1).sql,'rollback');assert.equal(released,before+1);
}
for(const [path,body] of [[previewPath,preview],[readPath,command]]){
  for(const denied of ['commercial.amendments.manage','commercial.lifecycle.manage']){
    deniedPermission=denied;const result=await invoke('post',path,body);
    assert.equal(result.status,403,`${denied} is independently required`);assert.equal(result.body.error.code,'COMMERCIAL_PERMISSION_DENIED');
    assert(permissions.includes(denied));assert.equal(calls.some(call=>/insert into/i.test(call.sql)),false);assert.equal(calls.at(-1).sql,'rollback');
  }
}
deniedPermission=null;
for(const [method,path,body,query] of [['get',readPath,undefined,{organizationId:'forged'}],['get',readPath,undefined,{asOf:'2020-01-01'}],
  ['post',previewPath,{...preview,actorId:'forged'}],['post',readPath,{...command,previewToken:'not-a-token'}]]){
  const before=connected;const result=await invoke(method,path,body,query);
  assert.equal(result.status,400);assert.equal(result.body.error.code,'COMMERCIAL_INVALID_REQUEST');assert.equal(connected,before,'reject malformed request before acquiring DB');
}
const missing=await invoke('get',readPath);assert.equal(missing.status,404);assert.equal(missing.body.error.code,'COMMERCIAL_NOT_FOUND');
assert.deepEqual(permissions,['commercial.contracts.view']);assert.equal(calls[0].sql,'begin isolation level repeatable read');assert.equal(calls.at(-1).sql,'rollback');
unavailable=true;const unavailableResult=await invoke('get',readPath);assert.equal(unavailableResult.status,503);assert.equal(unavailableResult.body.error.code,'COMMERCIAL_UNAVAILABLE');
assert.equal(connected,released+1,'failed connection does not create a releasable client');

const migration=await readFile(new URL('../server/migrations/043_wos04_governed_amendments.sql',import.meta.url),'utf8');
assert.match(migration,/commercial\.amendments\.manage/);
assert.doesNotMatch(migration,/insert\s+into\s+(role_permissions|user_permission_grants)/i,'authority remains explicitly opt-in');
assert.match(migration,/create table commercial_amendments/i);
assert.match(migration,/before update or delete on commercial_amendments/i,'committed adoptions are append-only');
assert.match(migration,/pg_advisory_xact_lock/i,'lifecycle and commercial budget writers share a serialized scope lock');
assert.doesNotMatch(migration,/\b(update|delete\s+from)\s+(commercial_contracts|commercial_contract_versions|commercial_engagements|commercial_project_bindings|commercial_lifecycle_events|commercial_draft_events|project_engagement_mappings|timesheet_entries)\b/i,'migration never rewrites roots, activation pins or historical work');
assert.doesNotMatch(migration,/disable trigger|session_replication_role|current_setting\s*\(/i,'no mutable writer bypass');
console.log('Commercial amendment strict schemas, server-owned context, separately required permissions, transaction/release/error contracts and additive append-only migration passed without sockets.');
