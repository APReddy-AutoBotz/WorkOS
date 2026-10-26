import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedDelegationFixture,prepareDelegationInputs,createDelegationSources,delegationDefinition,adoptDelegation,waitForDelegationStart,readDelegationInstance,decideDelegationInstance,revokeDelegation,canonicalSnapshot} from './support/canonical-delegation-test.mjs';
import {submitStagedWork,readApprovalOwner} from './support/work-approval-test.mjs';

const base='/api/v1/work-approvals/reminders',ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
const definition={afterMinutes:1,locale:'en-GB',template:{key:'approval.action_required',subject:'Reminder {{sourceRef}}',body:'Worker {{workerCode}} pending {{pendingAt}}, reminder {{reminderAt}}, due {{dueAt}} stage {{stageNumber}}.'}};

await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);const fx=await seedDelegationFixture(pool),ids=fx.identities;
 await withCommercialApi({databaseUrl,identities:ids,onServerError:s=>process.stderr.write(s)},async({request})=>{
  const inputs=await prepareDelegationInputs(request,fx,{dueMinutes:3}),due=(await pool.query('select * from approval_due_policies order by sequence desc limit 1')).rows[0];
  const old=(await submitStagedWork(request,ids.legacyImport,fx.today)).instance;
  const owner=await readApprovalOwner(request,ids.manager),policyBody={expectedOwnerKey:owner,expectedLatestId:null,duePolicyId:due.id,effectiveFrom:fx.today,definition,requestId:randomUUID(),reason:'Synthetic explicit prospective pending reminder'};
  for(const change of [{afterMinutes:0},{afterMinutes:3},{afterMinutes:1.5},{template:{...definition.template,key:'approval.reminder'}},{template:{...definition.template,body:'{{cost}}'}}])assert([400,422].includes((await request(base+'/policies',{method:'POST',body:{...policyBody,definition:{...definition,...change},requestId:randomUUID()}})).status));
  const policy=ok(await request(base+'/policies',{method:'POST',body:policyBody}),201).policy;
  assert.equal(policy.previousPolicyId,null);assert.equal(policy.duePolicyId,due.id);assert.deepEqual(policy.definition,definition);
  const replay=ok(await request(base+'/policies',{method:'POST',body:policyBody}));assert(replay.replayed);assert.deepEqual(replay.policy,policy);
  assert.equal((await request(base+'/policies',{method:'POST',body:{...policyBody,reason:'Changed same-key configuration'}})).status,409);
  assert.deepEqual(ok(await request(base+'/policy-requests/'+policy.requestId)).policy,policy);
  assert.equal(ok(await request(base+'/policy-requests/'+policy.requestId,{identity:ids.second})).policy,null);
  const accounts=await canonicalSnapshot(pool,['users','user_roles','role_permissions','user_permission_grants','user_organization_scopes']);
  const dd=delegationDefinition(fx),delegation=ok(await adoptDelegation(request,ids.manager,dd),201).delegation;await waitForDelegationStart(dd);
  const sources=await createDelegationSources(request,fx,inputs);
  const preview=async(kind,id,stage=0)=>ok(await request(base+'/preview?'+new URLSearchParams({origin:kind,instanceId:id,stage:String(stage)}))).preview;
  assert.equal((await preview('Work',old.id)).state,'Unconfigured');
  ok(await decideDelegationInstance(request,ids.manager,'Work',old),201);assert.equal((await preview('Work',old.id,1)).state,'Unconfigured','Old instances do not acquire rules at a later stage');
  const initial=[];for(const[k,i]of sources){const p=await preview(k,i.id);assert.equal(p.state,'Waiting');assert.equal(p.clock.policyId,policy.id);assert.equal(Date.parse(p.clock.reminderAt)-Date.parse(p.clock.pendingAt),60000);assert.equal(Date.parse(p.clock.dueAt)-Date.parse(p.clock.pendingAt),180000);initial.push(p);}
  const retainedClocks=await canonicalSnapshot(pool,['approval_due_clocks']);
  const offBody={...policyBody,expectedLatestId:policy.id,definition:null,requestId:randomUUID(),reason:'Synthetic explicitly disable reminders for future instances only'},off=ok(await request(base+'/policies',{method:'POST',body:offBody}),201).policy;
  const disabledSource=(await submitStagedWork(request,ids.first,fx.today)).instance;assert.equal((await preview('Work',disabledSource.id)).state,'Unconfigured');
  const enabled=ok(await request(base+'/policies',{method:'POST',body:{...policyBody,expectedLatestId:off.id,requestId:randomUUID(),reason:'Synthetic explicit new prospective enabled version'}}),201).policy;
  const fresh=(await submitStagedWork(request,ids.correction,fx.today)).instance;assert.equal((await preview('Work',fresh.id)).clock.policyId,enabled.id);
  for(const[k,i]of sources)assert.equal((await preview(k,i.id)).clock.policyId,policy.id,'Policy edits do not rewrite existing instance bindings');
  for(const row of retainedClocks.approval_due_clocks)assert.deepEqual((await pool.query('select to_jsonb(c)v from approval_due_clocks c where id=$1',[row.v.id])).rows[0],row);
  const evaluate=(p,key=randomUUID(),extra={})=>request(base+'/evaluate',{method:'POST',body:{expectedOwnerKey:owner,origin:p.origin,instanceId:p.instanceId,stage:p.stage,expectedSourceToken:p.sourceToken,expectedEventKey:p.eventKey,requestId:key,reason:'Synthetic inspected actual pending reminder',...extra}});
  const waiting=ok(await evaluate(initial[0]),201);assert.equal(waiting.receipt.outcome.disposition,'NoEvent');
  assert.equal((await request(base+'/preview?'+new URLSearchParams({origin:'Work',instanceId:sources[0][1].id,stage:'0'}),{identity:ids.denied})).status,403);
  assert.equal((await evaluate(initial[0],randomUUID(),{recipients:[ids.requester.id]})).status,400);
  await assert.rejects(pool.query('update approval_reminder_policies set definition=null'),error=>/immutable|append.only|rewrite/i.test(error.message));
  const until=Math.max(...initial.map(p=>Date.parse(p.clock.reminderAt)))+50;
  console.log('Real UTC reminder wait for explicitly configured one-minute pending thresholds; original three-minute due clocks unchanged.');while(Date.now()<until)await delay(Math.min(10000,until-Date.now()));
  const ready=[];for(const[k,i]of sources){const p=await preview(k,i.id);assert.equal(p.state,'Ready');assert.deepEqual(p.recipientReasons.map(x=>x.userId).sort(),[ids.manager.id,ids.delegate.id].sort());assert(!p.recipientReasons.some(x=>x.userId===ids.requester.id));ready.push(p);}
  assert.equal((await evaluate(initial[0])).status,409,'Old waiting inspection cannot emit after phase changes');
  // Current source/clock proof without its required event must roll back, even through SQL.
  const proof=(await preview('Work',fresh.id)),{checkedAt:_at,sourceToken:_token,...canonicalView}=proof;
  const {capacityCanonical}=await import('../server/modules/planning/worker-capacity-service.mjs');
  const sql=await pool.connect();try{await sql.query('begin');await sql.query("select set_config('workos.work_approval_context',$1,true)",[JSON.stringify({actorId:ids.manager.id,activeRole:'Admin',organizationId:f.organizationId,legalEntityId:f.legalEntityId,operationId:'synthetic-incomplete-reminder'})]);
   await sql.query("insert into approval_reminder_runs(id,organization_id,legal_entity_id,origin,instance_id,stage,clock_id,policy_id,sequence,request_id,request_fingerprint,actor_id,active_role,reason,operation_id,correlation_id,source_token,source_canonical,outcome)values($1,$2,$3,'Work',$4,0,$5,$6,1,$7,$8,$9,'Admin','Synthetic missing complete event','synthetic-incomplete-reminder','synthetic-correlation',$10,$11,$12)",[randomUUID(),f.organizationId,f.legalEntityId,fresh.id,proof.clock.id,proof.clock.policyId,randomUUID(),'a'.repeat(64),ids.manager.id,proof.sourceToken,capacityCanonical(canonicalView),{state:proof.state,disposition:'Emitted',eventKey:proof.eventKey,eventId:'synthetic-missing-event',checkedAt:proof.checkedAt,sourceToken:proof.sourceToken}]);await assert.rejects(sql.query('commit'),{code:'ARM03'});
  }finally{await sql.query('rollback');sql.release();}
  await assert.rejects(pool.query("insert into approval_reminder_reads(recipient_id,user_id)values($1,$2)",[randomUUID(),ids.manager.id]),{code:'ARM01'});
  const counts=async()=>(await pool.query('select(select count(*)from approval_reminder_runs)r,(select count(*)from approval_reminder_events)e,(select count(*)from approval_reminder_recipients)n,(select count(*)from approval_reminder_deliveries)d')).rows[0],before=await counts(),key=randomUUID();
  await pool.query("create function synthetic_reminder_failure()returns trigger language plpgsql as $$begin raise exception 'Synthetic required reminder delivery failure';end$$;create trigger synthetic_reminder_failure before insert on approval_reminder_deliveries for each row execute function synthetic_reminder_failure()");
  try{assert.equal((await evaluate(ready[0],key)).status,503);assert.deepEqual(await counts(),before);}finally{await pool.query('drop trigger synthetic_reminder_failure on approval_reminder_deliveries;drop function synthetic_reminder_failure()');}
  const race=await Promise.all([evaluate(ready[0],key),evaluate(ready[0],key)]);assert.deepEqual(race.map(x=>x.status).sort(),[200,201]);assert.deepEqual(race[0].body.receipt,race[1].body.receipt);
  assert.deepEqual(ok(await request(base+'/requests/'+key)).receipt,race[0].body.receipt);assert.equal(ok(await request(base+'/requests/'+key,{identity:ids.second})).receipt,null);
  assert.equal((await evaluate(ready[0],key,{reason:'Changed same-key evaluation'})).status,409);
  assert.equal((await evaluate(ready[0])).status,409);const notified=await preview('Work',sources[0][1].id);assert.equal(notified.state,'Notified');assert.equal(ok(await evaluate(notified),201).receipt.outcome.disposition,'Existing');
  for(const identity of [ids.manager,ids.delegate]){const inbox=ok(await request('/api/v1/work-approvals/inbox',{identity}));const n=inbox.notifications.find(x=>x.kind==='approval-reminder');assert(n);assert.deepEqual(n.reasons,['current_stage_approver']);assert.equal(n.policyClass,'ACTION_REQUIRED');const read=ok(await request('/api/v1/work-approvals/inbox/'+n.id+'/read',{method:'POST',identity,body:{expectedOwnerKey:await readApprovalOwner(request,identity)}}));assert(read.notification.readAt);assert.equal((await request('/api/v1/work-approvals/inbox/'+n.id+'/read',{method:'POST',identity:ids.requester,body:{expectedOwnerKey:await readApprovalOwner(request,ids.requester)}})).status,404);}
  ok(await revokeDelegation(request,ids.manager,delegation.id),201);
  assert.equal((await evaluate(ready[1])).status,409,'Revocation changes current recipient authority');
  for(const[k,i]of sources.slice(1)){const p=await preview(k,i.id);assert.equal(p.state,'Ready');assert.deepEqual(p.recipientReasons.map(x=>x.userId),[ids.manager.id]);ok(await evaluate(p),201);}
  assert.equal((await pool.query('select count(*)::int n from approval_reminder_events')).rows[0].n,4);
  for(const[k,i]of sources){assert.equal((await readDelegationInstance(request,k,i.id)).transitions.length,0);ok(await decideDelegationInstance(request,ids.manager,k,i),201);assert.equal((await preview(k,i.id,0)).state,'Stale');const next=await preview(k,i.id,1);assert.equal(next.state,'Waiting');assert.equal(next.clock.policyId,policy.id);}
  // A terminal stage keeps its sent event; a never-notified elapsed stage cannot send late.
  const workFinal=await readDelegationInstance(request,'Work',sources[0][1].id);ok(await decideDelegationInstance(request,ids.second,'Work',workFinal),201);assert.equal((await preview('Work',workFinal.id,0)).state,'Terminal');assert.equal(ok(await evaluate(await preview('Work',workFinal.id,0)),201).receipt.outcome.disposition,'Existing');
  const overdueUntil=Date.parse((await preview('Work',fresh.id)).clock.dueAt)+30;console.log('Real UTC reminder exclusion at the original due boundary');while(Date.now()<overdueUntil)await delay(Math.min(10000,overdueUntil-Date.now()));
  const overdue=await preview('Work',fresh.id);assert.equal(overdue.state,'Overdue');assert.equal(ok(await evaluate(overdue),201).receipt.outcome.disposition,'NoEvent');assert.equal((await pool.query('select count(*)::int n from approval_reminder_events')).rows[0].n,4);
  const actual=ok(await request('/api/v1/actual-work/workers/'+f.ownerId+'/period?startsOn='+fx.today+'&endsOn='+fx.today));assert.equal(actual.result.includedHoursExact,'4');assert.equal(actual.result.eligibleAvailableHoursExact,'8');
  assert.deepEqual(await canonicalSnapshot(pool,Object.keys(accounts)),accounts);
  console.log('Configured approval reminder PostgreSQL receipt:',JSON.stringify({today:fx.today,policyId:policy.id,duePolicyId:due.id,sources:sources.map(([kind,i])=>({kind,id:i.id})),allFourKinds:true,oldInstanceUnbound:true,explicitDisableAndReenable:true,originalClocksUnchanged:true,canonicalCurrentApproversOnly:true,completeRecipientRollback:true,concurrentExactReplay:true,ownedInboxRead:true,revokedDelegateExcluded:true,noSourceDecisionOrCapacityEffect:true,actualHours:'4',availableHours:'8'}));
 });
});

await import('./approval-reminder-upgrade-postgres-smoke.mjs');
