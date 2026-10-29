import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval,readApprovalOwner} from './support/work-approval-test.mjs';
import {grantAmendmentPermissions,createAmendmentHierarchy} from './support/commercial-amendments-test.mjs';
import {shiftCapacityDate} from '../shared/worker-capacity.mjs';

// This test is intentionally not runnable while migration 088 has its sentinel.
// It creates only synthetic permissions and a temporary local test session in a
// disposable database; execution requires authorization for that setup.
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
const events=['approval.action_required','approval.rejected_or_correction_required','approval.completed'];
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);
 const fx=await seedWorkApproval(pool),ids=fx.identities;
 await grantAmendmentPermissions(pool);
 for(const permission of ['commercial.milestone_billing.view','commercial.milestone_billing.manage','commercial.milestone_billing.decide','approvals.view'])await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",[permission]);
 await withCommercialApi({databaseUrl,identities:ids,onServerError:s=>process.stderr.write(s)},async({request})=>{
  const end=shiftCapacityDate(fx.today,30),roots=await createAmendmentHierarchy(request,'SYN-MILESTONE',{contract:{model:'milestone',startsOn:fx.today,endsOn:end,effectiveFrom:fx.today,currency:'USD'},engagement:{startsOn:fx.today,endsOn:end,currency:'USD'},project:{startsOn:fx.today,endsOn:end}});
  const milestone=ok(await request('/milestones',{method:'POST',body:{engagementId:roots.engagement.id,code:'SYN-MILESTONE-1',name:'Synthetic delivery',dueOn:fx.today,amount:'125.1500',currency:'USD',reason:'Synthetic milestone'}}),201);
  const route='/api/v1/milestone-billing',initial=ok(await request(route+'/policies?engagementId='+roots.engagement.id)),definition={entityType:'MilestoneBillingEligibility',engagementId:roots.engagement.id,evidenceKinds:['INTERNAL_ASSERTION','CLIENT_EVIDENCE_ASSERTION'],stages:[{userId:ids.manager.id,role:'Admin'},{userId:ids.second.id,role:'Admin'}],locale:'en-US',templates:events.map(key=>({key,subject:'Review {{sourceRef}}',body:'Stage {{stageNumber}}'})),completionInApp:false};
  const policy=ok(await request(route+'/policies',{method:'POST',body:{expectedOwnerKey:initial.ownerKey,requestId:randomUUID(),engagementId:roots.engagement.id,expectedLatestId:null,effectiveFrom:fx.today,definition,reason:'Synthetic policy'}}),201).policy;
  const requesterKey=await readApprovalOwner(request,ids.requester),evidence=[{kind:'INTERNAL_ASSERTION',reference:'Synthetic internal acceptance',url:'https://example.test/internal'},{kind:'CLIENT_EVIDENCE_ASSERTION',reference:'Synthetic client evidence',url:'https://example.test/client'}],requestBody={expectedOwnerKey:requesterKey,requestId:randomUUID(),milestoneId:milestone.id,expectedPolicyId:policy.id,ownerUserId:ids.manager.id,ownerRole:'Admin',evidence,reason:'Synthetic review'};
  assert.equal((await request(route+'/requests',{method:'POST',identity:ids.requester,body:{...requestBody,evidence:evidence.slice(0,1)}})).status,409);
  assert.equal((await pool.query("select count(*)::int n from billing_eligibility_events where source_type='MILESTONE_ACCEPTANCE'")).rows[0].n,0);
  await pool.query("create function synthetic_milestone_recipient_failure() returns trigger language plpgsql as $$begin raise exception 'Synthetic recipient refusal' using errcode='MBE03';end$$;create trigger synthetic_milestone_recipient_failure before insert on milestone_billing_recipients for each row execute function synthetic_milestone_recipient_failure()");
  assert.equal((await request(route+'/requests',{method:'POST',identity:ids.requester,body:requestBody})).status,409);
  assert.equal((await pool.query('select count(*)::int n from milestone_billing_instances')).rows[0].n,0);
  await pool.query('drop trigger synthetic_milestone_recipient_failure on milestone_billing_recipients;drop function synthetic_milestone_recipient_failure()');
  const requestRace=await Promise.all([request(route+'/requests',{method:'POST',identity:ids.requester,body:requestBody}),request(route+'/requests',{method:'POST',identity:ids.requester,body:requestBody})]);
  assert.deepEqual(requestRace.map(r=>r.status).sort(),[200,201]);const created=ok(requestRace.find(r=>r.status===201),201).approval;
  assert.equal(created.state.status,'Pending');assert.equal(ok(await request(route+'/requests',{method:'POST',identity:ids.requester,body:requestBody})).replayed,true);
  const decision=async(identity,sequence,decision='Approved',requestId=randomUUID())=>request(route+'/instances/'+created.id+'/decisions',{method:'POST',identity,body:{expectedOwnerKey:await readApprovalOwner(request,identity),requestId,expectedSequence:sequence,decision,reason:'Synthetic decision'}});
  assert.equal((await decision(ids.requester,0)).status,409);
  const firstKey=randomUUID(),first=ok(await decision(ids.manager,0,'Approved',firstKey),201);assert.equal(first.approval.state.status,'Pending');assert.equal(first.eventId,null);
  assert.equal(ok(await decision(ids.manager,0,'Approved',firstKey)).replayed,true);assert.equal((await pool.query("select count(*)::int n from approved_unbilled_items where source_type='MILESTONE_ACCEPTANCE'")).rows[0].n,0);
  const finalKey=randomUUID(),final=ok(await decision(ids.second,1,'Approved',finalKey),201);assert.equal(final.approval.state.status,'Approved');assert(final.eventId&&final.itemId);
  assert.equal(ok(await decision(ids.second,1,'Approved',finalKey)).itemId,final.itemId);
  const register=ok(await request(route+'/register'));assert.equal(register.batchSupport,false);assert.equal(register.items.length,1);assert.equal(register.items[0].id,final.itemId);assert.equal(register.items[0].evidence.milestoneId,milestone.id);assert.equal(register.items[0].currency,'USD');
  assert.equal((await pool.query("select count(*)::int n from billing_eligibility_events where source_type='MILESTONE_ACCEPTANCE'")).rows[0].n,1);
  await assert.rejects(pool.query("update approved_unbilled_items set source_type='TM_SNAPSHOT' where id=$1",[final.itemId]),e=>e.code==='55000');
  assert.equal((await request(route+'/register',{identity:ids.reader})).status,403);
 });
});
console.log('Scoped milestone evidence, staged decision and register journey passed.');
