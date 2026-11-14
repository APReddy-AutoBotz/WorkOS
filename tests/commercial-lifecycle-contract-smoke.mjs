import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {createCommercialDraftingRouter} from '../server/modules/commercial-drafting/router.mjs';
import {lifecycleTransitionSchema,projectBindingSchema,lifecycleQuerySchema,lifecycleTypes} from '../server/modules/commercial-drafting/lifecycle-contracts.mjs';
import {transitionLifecycle,getLifecycleWorkspace,getClosureReadiness} from '../server/modules/commercial-drafting/lifecycle-service.mjs';
import {assertLegacyProjectMutationAllowed,sendGovernedProjectConflict} from '../server/modules/commercial-drafting/project-mutation.mjs';

// Lightweight tests intentionally use no PostgreSQL or browser. The companion
// postgres suite is a mandatory real persistence/API test, not replaced by this.
const transition={expectedSequence:0,state:'Active',contractVersionId:null,reason:'Synthetic activation',approvalReference:null};
const binding={engagementId:'engagement-synthetic',projectId:null,code:'SYNTHETIC-PROJECT',name:'Synthetic controlled project',managerId:'employee-synthetic',
  startsOn:'2026-01-01',endsOn:'2026-12-31',billable:false,budgetAllocation:'0.0000',reason:'Synthetic project activation'};
assert.deepEqual([...lifecycleTypes],['Contract','Engagement','Project']);
assert(lifecycleTransitionSchema.safeParse(transition).success);
assert(lifecycleTransitionSchema.safeParse({...transition,expectedSequence:199,state:'On Hold',contractVersionId:'version-synthetic',approvalReference:'Synthetic approval metadata'}).success);
for(const delta of [{expectedSequence:-1},{expectedSequence:200},{expectedSequence:'0'},{expectedSequence:0.5},{state:'Draft'},{state:'Completed'},
  {state:'Closed'},{state:'Deleted'},{contractVersionId:''},{reason:'  '},{reason:'x'.repeat(1001)},{approvalReference:''},{approvalReference:'x'.repeat(201)}])
  assert.equal(lifecycleTransitionSchema.safeParse({...transition,...delta}).success,false,JSON.stringify(delta));
for(const key of ['expectedSequence','state','contractVersionId','reason','approvalReference']){
  const input={...transition};delete input[key];assert.equal(lifecycleTransitionSchema.safeParse(input).success,false,`${key} is explicit, including nulls`);
}
for(const schemaAndValue of [[lifecycleTransitionSchema,transition],[projectBindingSchema,binding]])for(const [key,value] of Object.entries({
  organizationId:'forged',legalEntityId:'forged',actorId:'forged',createdBy:'forged',activeRole:'Admin',role:'Admin',status:'Active',
  effectiveOn:'2000-01-01',effectiveFrom:'2000-01-01',sequence:99,source:'Migration',billingEligible:true,billingAuthority:true,
}))assert.equal(schemaAndValue[0].safeParse({...schemaAndValue[1],[key]:value}).success,false,`${key} must never become client authority`);
assert(projectBindingSchema.safeParse(binding).success);
assert(projectBindingSchema.safeParse({...binding,projectId:'project-synthetic',billable:true,budgetAllocation:'99999999999999.9999'}).success);
for(const delta of [{projectId:''},{code:'lower case'},{code:'X'.repeat(81)},{name:''},{managerId:''},{engagementId:''},{startsOn:'2026-02-30'},
  {startsOn:'2025-02-29'},{endsOn:'2026-01-00'},{endsOn:'2025-12-31'},{billable:'false'},{budgetAllocation:0},{budgetAllocation:'1e3'},
  {budgetAllocation:'-0.0001'},{budgetAllocation:'01'},{budgetAllocation:'0.00001'},{budgetAllocation:'100000000000000'}])
  assert.equal(projectBindingSchema.safeParse({...binding,...delta}).success,false,JSON.stringify(delta));
for(const key of Object.keys(binding)){const input={...binding};delete input[key];assert.equal(projectBindingSchema.safeParse(input).success,false,`${key} is required`);}
assert(lifecycleQuerySchema.safeParse({}).success);
for(const input of [{asOf:'2026-10-20'},{organizationId:'forged'},{state:'Active'},{limit:'999'},{actorId:'forged'}])assert.equal(lifecycleQuerySchema.safeParse(input).success,false);

const scope={organizationId:'org-synthetic',legalEntityId:'legal-synthetic'};
const req={user:{sub:'actor-synthetic',activeRole:'Admin'},organizationScope:scope,correlationId:'synthetic-correlation',operationId:'synthetic-operation'};
const event=(state='Active',sequence=1)=>({id:`event-${sequence}`,sequence,state,effective_on:'2026-10-20',contract_version_id:null,
  reason:transition.reason,approval_reference:null,actor_id:req.user.sub,active_role:req.user.activeRole,correlation_id:req.correlationId,operation_id:req.operationId});
const root={id:'engagement-synthetic',origin:'manual',model:'internal',owner_id:'employee-synthetic',starts_on:'2026-01-01',ends_on:'2026-12-31',
  client_id:null,contract_id:null,contract_version_id:null,attribution_id:'attribution-synthetic',currency:'USD',budget:'0.0000',billable:false};
const serviceClient=({previous=null,entity=root,children=false,onInsert}={})=>{
  const calls=[];
  return {calls,query:async(sql,values=[])=>{
    calls.push({sql,values});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('from commercial_engagements where') && sql.includes('for update'))return {rows:entity?[entity]:[],rowCount:entity?1:0};
    if(sql.includes('from commercial_lifecycle_events'))return {rows:previous?[previous]:[],rowCount:previous?1:0};
    if(sql.includes("now() at time zone 'UTC'"))return {rows:[{today:'2026-10-20'}],rowCount:1};
    if(sql.includes('from employees'))return {rows:[{id:root.owner_id}],rowCount:1};
    if(sql.includes('from organization_catalog_items'))return {rows:[{id:root.attribution_id}],rowCount:1};
    if(sql.includes('select p.project_id'))return {rows:children?[{project_id:'project-child'}]:[],rowCount:children?1:0};
    if(sql.includes('insert into commercial_lifecycle_events')){
      onInsert?.(values);return {rows:[event(values[6],values[5])],rowCount:1};
    }
    assert.fail(`Unexpected lifecycle service SQL: ${sql}`);
  }};
};
let auditCalls=[];
const audit=async(client,request,value)=>{assert.equal(request,req);auditCalls.push({client,value});};
const successfulClient=serviceClient({onInsert:values=>{
  assert.deepEqual(values.slice(1,4),[scope.organizationId,scope.legalEntityId,'Engagement']);
  assert.equal(values[4],root.id);assert.equal(values[5],1);assert.equal(values[6],'Active');
  assert.equal(values[7],null);assert.equal(values[8],null);assert.equal(values[9],null);
  assert.equal(JSON.parse(values[10]).lifecycle.effectiveOn,'2026-10-20');
  assert.deepEqual(values.slice(13),[req.user.sub,req.user.activeRole,req.correlationId,req.operationId]);
}});
const activated=await transitionLifecycle(successfulClient,req,'Engagement',root.id,transition,audit);
assert.equal(activated.state,'Active');assert.equal(activated.sequence,1);assert.equal(activated.effectiveOn,'2026-10-20');
assert.match(successfulClient.calls[0].sql,/pg_advisory_xact_lock/);
assert.deepEqual(successfulClient.calls[0].values,[`commercial-lifecycle:${scope.organizationId}:${scope.legalEntityId}`]);
assert.equal(auditCalls.length,1);assert.equal(auditCalls[0].client,successfulClient);
assert.deepEqual(auditCalls[0].value.newValue,{commercialEventId:activated.id,snapshot:'after'});
assert.equal(auditCalls[0].value.oldValue,null);
assert.doesNotMatch(JSON.stringify(auditCalls[0].value),/Synthetic activation|attribution-synthetic|employee-synthetic|USD/,'general audit has opaque pointers only');
const rejectTransition=async(options,input,code)=>{
  const client=serviceClient(options);const before=auditCalls.length;
  await assert.rejects(transitionLifecycle(client,req,'Engagement',root.id,input,audit),error=>error.code===code);
  assert.equal(client.calls.some(call=>call.sql.includes('insert into commercial_lifecycle_events')),false);
  assert.equal(auditCalls.length,before);
};
await rejectTransition({previous:event()},{...transition,expectedSequence:0,state:'On Hold'},'COMMERCIAL_LIFECYCLE_CONFLICT');
await rejectTransition({}, {...transition,state:'On Hold'},'COMMERCIAL_INVALID_TRANSITION');
await rejectTransition({previous:event()}, {...transition,expectedSequence:1},'COMMERCIAL_INVALID_TRANSITION');
await rejectTransition({previous:event()}, {...transition,expectedSequence:1,state:'On Hold',contractVersionId:'forged'},'COMMERCIAL_PIN_CONFLICT');
await rejectTransition({previous:event(),children:true},{...transition,expectedSequence:1,state:'On Hold'},'COMMERCIAL_ACTIVE_DEPENDENCIES');
await rejectTransition({entity:{...root,starts_on:'2027-01-01'}},transition,'COMMERCIAL_INACTIVE_DATES');
await rejectTransition({entity:{...root,origin:'legacy-neutral'}},transition,'COMMERCIAL_NOT_FOUND');
await rejectTransition({entity:null},transition,'COMMERCIAL_NOT_FOUND');
const limitedClient={query:async(sql)=>{
  if(sql.includes("now() at time zone 'UTC'"))return {rows:[{today:'2026-10-20'}]};
  return {rows:[],rowCount:0};
}};
const emptyWorkspace=await getLifecycleWorkspace(limitedClient,req);
assert.equal(emptyWorkspace.closure.available,false);
assert.ok(emptyWorkspace.closure.unavailableEvidence.length>=3,'unknown unbilled/balance/acceptance evidence must be explicit');
assert.match(emptyWorkspace.closure.message,/unknown, never assumed zero/);
assert.equal(emptyWorkspace.closure.unbilledAmount,undefined);
assert.equal(emptyWorkspace.limits.pageSize,200);

const evidenceCounts={openAssignments:2,draftSubmittedWorkLines:3,pendingTimesheetApprovals:1,unacceptedMilestones:4,draftPurchaseOrders:5};
const readinessQueries=[];
const readinessClient={query:async(sql,values=[])=>{
  readinessQueries.push({sql,values});
  if(sql.includes('from commercial_project_bindings where') && sql.includes('project_id=$3'))return {rows:[{...root,project_id:'project-synthetic',engagement_id:root.id,manager_id:root.owner_id}],rowCount:1};
  if(sql.includes('"openAssignments"'))return {rows:[evidenceCounts],rowCount:1};
  if(sql.includes('from employees'))return {rows:[{}],rowCount:1};
  if(sql.includes("now() at time zone 'UTC'"))return {rows:[{today:'2026-10-20'}],rowCount:1};
  assert.fail(`Unexpected readiness SQL: ${sql}`);
}};
const readiness=await getClosureReadiness(readinessClient,req,'Project','project-synthetic');
assert.equal(readiness.available,false);assert.equal(readiness.checkedOn,'2026-10-20');
assert.deepEqual(readiness.evidence,{...evidenceCounts,ownerActive:true});
assert.ok(readiness.unavailableEvidence.length>=3);assert.match(readiness.message,/unknown, not zero/);
assert.equal(readinessQueries.some(call=>call.sql.includes('for update')),false,'read-only readiness does not acquire mutation row locks');
const evidenceQuery=readinessQueries.find(call=>call.sql.includes('"openAssignments"'));
assert.deepEqual(evidenceQuery.values,[scope.organizationId,scope.legalEntityId,['project-synthetic'],[root.id],null]);
assert.match(evidenceQuery.sql,/count\(distinct a\.id\)/,'one pending approval is not double counted across work lines');

const guardQueries=[];
let bound=false;
const guardClient={query:async(sql,values)=>{guardQueries.push({sql,values});return {rows:bound?[{}]:[],rowCount:bound?1:0};}};
await assertLegacyProjectMutationAllowed(guardClient,scope,[null,'project-synthetic',undefined]);
assert.match(guardQueries[0].sql,/pg_advisory_xact_lock/);assert.deepEqual(guardQueries[1].values,[scope.organizationId,scope.legalEntityId,['project-synthetic']]);
bound=true;await assert.rejects(assertLegacyProjectMutationAllowed(guardClient,scope,['project-synthetic']),error=>error.code==='WPG01');
let conflictStatus,conflictBody;
const res={status(value){conflictStatus=value;return this;},json(value){conflictBody=value;return this;}};
assert.equal(sendGovernedProjectConflict(res,{code:'23505'}),false);
assert.equal(sendGovernedProjectConflict(res,{code:'WPG01'}),true);
assert.equal(conflictStatus,409);assert.equal(conflictBody.error.code,'GOVERNED_PROJECT_MUTATION_REQUIRED');

// Exercise the actual Express router: strict parsing precedes DB acquisition,
// every new route is opt-in, write DTOs require view plus manage, all exits release.
let released=0,connected=0,authorized=false,unavailable=false,auditFails=false;
const deniedPermissions=new Set();
const routeQueries=[];
const query=async(sql,values=[])=>{
  routeQueries.push({sql,values});
  if(sql.includes('from user_organization_scopes s'))return {rows:[{organization_id:scope.organizationId,legal_entity_id:scope.legalEntityId}],rowCount:1};
  if(sql.includes('select u.id from users u'))return {rows:authorized&&!deniedPermissions.has(values[2])?[{id:req.user.sub}]:[],rowCount:authorized&&!deniedPermissions.has(values[2])?1:0};
  if(sql.includes('from commercial_engagements where') && sql.includes('for update'))return {rows:[root],rowCount:1};
  if(sql.includes('from employees'))return {rows:[{id:root.owner_id}],rowCount:1};
  if(sql.includes('from organization_catalog_items'))return {rows:[{id:root.attribution_id}],rowCount:1};
  if(sql.includes("now() at time zone 'UTC'"))return {rows:[{today:'2026-10-20'}],rowCount:1};
  if(sql.includes('insert into commercial_lifecycle_events'))return {rows:[event()],rowCount:1};
  return {rows:[],rowCount:0};
};
const pool={connect:async()=>{connected++;if(unavailable)throw new Error('Synthetic unavailable');return {query,release(){released++;}};}};
const app=express();app.use(express.json());
app.use('/api/v1/commercial-drafting',createCommercialDraftingRouter({pool,requireDatabase:(_req,_res,next)=>next(),
  requireAuth:(request,_res,next)=>{Object.assign(request,req);request.headers['x-organization-id']=scope.organizationId;request.headers['x-legal-entity-id']=scope.legalEntityId;next();},
  audit:async()=>{if(auditFails)throw new Error('Synthetic audit transaction failure');},logError:()=>{}}));
const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
const call=async(path,body)=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/commercial-drafting${path}`,body===undefined?{}:
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
};
try{
  for(const [path,body] of [['/lifecycle/workspace'],['/lifecycle/Engagement/engagement-synthetic/history'],['/lifecycle/Engagement/engagement-synthetic/readiness'],
    ['/lifecycle/Engagement/engagement-synthetic/transitions',transition],['/lifecycle/projects',binding]]){
    const before=released;const result=await call(path,body);assert.equal(result.status,403);assert.equal(result.body.error.code,'COMMERCIAL_PERMISSION_DENIED');
    assert.equal(routeQueries.at(-1).sql,'rollback');assert.equal(released,before+1);
  }
  for(const [path,body] of [['/lifecycle/workspace?asOf=2026-10-20'],['/lifecycle/Engagement/engagement-synthetic/history?organizationId=forged'],
    ['/lifecycle/Engagement/engagement-synthetic/transitions',{...transition,effectiveOn:'2000-01-01'}],['/lifecycle/projects',{...binding,actorId:'forged'}]]){
    const before=connected;const result=await call(path,body);assert.equal(result.status,400);assert.equal(result.body.error.code,'COMMERCIAL_INVALID_REQUEST');assert.equal(connected,before);
  }
  authorized=true;routeQueries.length=0;
  let result=await call('/lifecycle/Engagement/engagement-synthetic/transitions',transition);assert.equal(result.status,201);assert.equal(result.body.state,'Active');
  assert.deepEqual(routeQueries.filter(call=>call.sql.includes('select u.id from users u')).map(call=>call.values[2]),['commercial.contracts.view','commercial.lifecycle.manage']);
  assert.equal(routeQueries.at(-1).sql,'commit');
  deniedPermissions.add('commercial.lifecycle.manage');
  result=await call('/lifecycle/Engagement/engagement-synthetic/transitions',transition);assert.equal(result.status,403);assert.equal(result.body.error.code,'COMMERCIAL_PERMISSION_DENIED');
  deniedPermissions.clear();deniedPermissions.add('commercial.contracts.view');
  result=await call('/lifecycle/Engagement/engagement-synthetic/transitions',transition);assert.equal(result.status,403);
  deniedPermissions.clear();deniedPermissions.add('commercial.contracts.manage');
  result=await call('/lifecycle/Engagement/engagement-synthetic/transitions',transition);assert.equal(result.status,201,'draft manage is not required for separately authorized lifecycle commands');
  deniedPermissions.clear();
  auditFails=true;result=await call('/lifecycle/Engagement/engagement-synthetic/transitions',transition);
  assert.equal(result.status,503);assert.equal(result.body.error.code,'COMMERCIAL_UNAVAILABLE');assert.equal(routeQueries.at(-1).sql,'rollback');
  auditFails=false;unavailable=true;result=await call('/lifecycle/workspace');assert.equal(result.status,503);assert.equal(result.body.error.code,'COMMERCIAL_UNAVAILABLE');
  assert.equal(connected,released+1,'failed connect has no acquired client to release');
  const close=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/commercial-drafting/lifecycle/Engagement/engagement-synthetic/close`,{method:'POST'});
  assert.equal(close.status,404,'terminal closure is not exposed without full evidence');
}finally{await new Promise(resolve=>server.close(resolve));}
const migration=await readFile(new URL('../server/migrations/041_wos04_governed_lifecycle.sql',import.meta.url),'utf8');
assert.doesNotMatch(migration,/insert\s+into\s+(role_permissions|user_permission_grants)/i,'041 adds no grants');
assert.doesNotMatch(migration,/\b(update|delete\s+from|alter\s+table)\s+(commercial_contracts|commercial_contract_versions|commercial_engagements|commercial_draft_events|project_engagement_mappings)\b/i,'040 roots, drafts and mappings are not converted');
assert.match(migration,/before update or delete on commercial_project_bindings/i);
assert.match(migration,/before update or delete on commercial_lifecycle_events/i);
assert.match(migration,/before update or delete on projects/i);
assert.match(migration,/after insert on commercial_lifecycle_events/i);
assert.match(migration,/before insert on commercial_lifecycle_events/i);
assert.match(migration,/Lifecycle effective date is server owned/);
assert.match(migration,/Lifecycle sequence or transition is invalid/);
assert.match(migration,/Scoped lifecycle root is unavailable/);
assert.match(migration,/Lifecycle contract pin is immutable/);
assert.match(migration,/commercial\.lifecycle\.manage/);
assert.doesNotMatch(migration,/current_setting\s*\(/i,'governed project projection must not have a client-settable bypass');
console.log('Commercial lifecycle strict schemas, state/pin/stale/parent guards, scoped locking, opaque audit, fail-closed routes and additive immutable migration contracts passed.');
