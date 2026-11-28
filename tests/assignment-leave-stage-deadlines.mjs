import {collectAssignmentLeaveReminders} from '../server/modules/approvals/overdue-work.mjs';
import {adoptActualInputs} from './support/actual-work-test.mjs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {runMigrations} from '../server/migrate.mjs';
import {withCommercialDatabase, withCommercialMigrationsThrough, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {adoptDelegation,delegationDefinition,revokeDelegation,waitForDelegationStart,seedDelegationFixture,prepareDelegationInputs,canonicalSnapshot,createDelegationSources,readDelegationInstance,decideDelegationInstance,delegationOk} from './support/canonical-delegation-test.mjs';
import {WORK_APPROVAL_BASE,prepareStagedWork,adoptStagedPolicy} from './support/work-approval-test.mjs';
import {createApprovalAssignment,assignmentApprovalDefinition,adoptAssignmentApproval} from './support/assignment-approval-test.mjs';
import {adoptLeavePolicy,leaveDefinition} from './support/leave-approval-test.mjs';
import {validStageDeadline} from '../shared/approval-stage-deadline.mjs';
import {expectedMigrationsFrom} from './support/expected-migrations.mjs';

await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await withCommercialMigrationsThrough(136,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
  const fx=await seedDelegationFixture(pool);
  const ids=fx.identities;
  const definitions={assignment:{...assignmentApprovalDefinition(ids),creationRequired:true},leave:leaveDefinition(ids)};
  const check=async(domain,definition)=>(await pool.query('select valid_'+domain+'_approval_definition($1::jsonb) as ok',[JSON.stringify(definition)])).rows[0].ok;
  for(const [domain,definition] of Object.entries(definitions)){
    assert(await check(domain,definition));
    assert.equal(await check(domain,{...definition,stageDueMinutes:1}),false);
  }
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,expectedMigrationsFrom('137_wos05_assignment_leave_stage_deadlines'));
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
  for(const [domain,definition] of Object.entries(definitions)){
    assert(await check(domain,definition));
    assert(await check(domain,{...definition,stageDueMinutes:2,reminderLeadMinutes:1}));
    assert.equal(await check(domain,{...definition,reminderLeadMinutes:1}),false);
    for(const invalid of [0,-1,0.5,2,3,'1',null]){
      assert.equal(await check(domain,{...definition,stageDueMinutes:2,reminderLeadMinutes:invalid}),false);
    }
    for(const invalid of [0,-1,0.5,2147483648,'1',null]){
      assert.equal(await check(domain,{...definition,stageDueMinutes:invalid}),false);
    }
  }
  await withCommercialApi({databaseUrl,identities:ids,enableLeave:true},async({request})=>{
    await prepareStagedWork(request,ids,fx.today);
    await adoptActualInputs(request,fx.today);
    await adoptStagedPolicy(request,ids,fx.today);
    const assignment=await createApprovalAssignment(request,fx);
    const assignmentPolicy=await adoptAssignmentApproval(request,fx,{...definitions.assignment,stageDueMinutes:2,reminderLeadMinutes:1});
    await adoptLeavePolicy(request,fx,{...definitions.leave,stageDueMinutes:2,reminderLeadMinutes:1});
    const grant=delegationOk(await adoptDelegation(request,ids.manager,delegationDefinition(fx)),201).delegation;
    await waitForDelegationStart(grant.definition);
    const sources=(await createDelegationSources(request,fx,{assignment,assignmentPolicy})).filter(([kind])=>kind!=='Work');
    assert.deepEqual(sources.map(([kind])=>kind),['Material','Creation','Leave']);
    for(const [,instance] of sources){
      assert.equal(instance.stageDeadline.stage,0);
      assert.equal(instance.stageDeadline.dueAt,new Date(Date.parse(instance.createdAt)+120000).toISOString());
      assert.equal(instance.stageDeadline.overdue,false);
    }
    const due=Math.max(...sources.map(([,i])=>Date.parse(i.stageDeadline.dueAt)));
    const eligibleCount=async()=>Number((await pool.query('select count(*) from assignment_leave_reminder_candidates')).rows[0].count);
    assert.equal(await eligibleCount(),6);
    delegationOk(await revokeDelegation(request,ids.manager,grant.id),201);
    assert.equal(await eligibleCount(),3);
    const countReminders=async()=>Number((await pool.query('select count(*) from assignment_leave_stage_reminders')).rows[0].count);
    await collectAssignmentLeaveReminders(pool);
    assert.equal(await countReminders(),0);
    await delay(Math.max(0,due-60000-Date.now()+30));
    await Promise.all([collectAssignmentLeaveReminders(pool),collectAssignmentLeaveReminders(pool)]);
    assert.equal(await countReminders(),3);
    const inbox=async identity=>delegationOk(await request(WORK_APPROVAL_BASE+'/inbox',{identity}),200);
    const managerInbox=await inbox(ids.manager);
    const notices=managerInbox.notifications.filter(n=>n.reminder && sources.some(([,i])=>i.id===n.instanceId));
    assert.deepEqual(notices.map(n=>n.kind).sort(),['assignment-approval','assignment-creation-approval','leave-approval']);
    const otherInbox=await inbox(ids.second);
    for (const n of notices) {
      const original=managerInbox.notifications.find(x=>x.eventId===n.eventId && !x.reminder);
      assert.ok(original);
      assert.notEqual(original.deliveryId,n.deliveryId);
      const path=WORK_APPROVAL_BASE+'/inbox/'+n.id+'/read';
      assert.equal((await request(path,{method:'POST',identity:ids.second,body:{expectedOwnerKey:otherInbox.ownerKey}})).status,404);
      const read=()=>request(path,{method:'POST',identity:ids.manager,body:{expectedOwnerKey:managerInbox.ownerKey}});
      const first=delegationOk(await read(),200).notification;
      assert.ok(first.readAt);
      assert.equal(delegationOk(await read(),200).notification.readAt,first.readAt);
    }
    assert.ok((await inbox(ids.manager)).notifications.filter(n=>!n.reminder).every(n=>n.readAt===null));

    await delay(Math.max(0,due-Date.now()+30));
    for(const [kind,instance] of sources){
      const late=await readDelegationInstance(request,kind,instance.id);
      assert.equal(late.stageDeadline.dueAt,instance.stageDeadline.dueAt);
      assert.equal(late.stageDeadline.overdue,true);
      const decision=delegationOk(await decideDelegationInstance(request,ids.manager,kind,late),201);
      const next=await readDelegationInstance(request,kind,instance.id);
      assert.equal(next.stageDeadline.stage,1);
      assert.equal(next.stageDeadline.dueAt,new Date(Date.parse(decision.receipt.createdAt)+120000).toISOString());
      assert(validStageDeadline(next.stageDeadline,2,1,next.createdAt,next.transitions));
      assert.equal(validStageDeadline({...next.stageDeadline,overdue:true},2,1,next.createdAt,next.transitions),false);
      delegationOk(await decideDelegationInstance(request,ids.second,kind,next,'Rejected'),201);
      const closed=await readDelegationInstance(request,kind,instance.id);
      assert.equal(closed.state.status,'Rejected');
      assert.equal(closed.stageDeadline,undefined);
    }
  });
});
console.log('Pinned assignment change, creation and leave stage clocks, real UTC expiry, next-stage reset, terminal suppression and migration replay passed.');
await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await withCommercialMigrationsThrough(136,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
  const fx=await seedDelegationFixture(pool);
  await withCommercialApi({databaseUrl,identities:fx.identities,enableLeave:true},async({request})=>{
    const inputs=await prepareDelegationInputs(request,fx);
    const sources=(await createDelegationSources(request,fx,inputs)).filter(([kind])=>kind!=='Work');
    for(const [,instance] of sources)assert.equal(instance.stageDeadline,undefined);
    const tables=['assignment_approval_policies','assignment_approval_instances','leave_approval_policies','leave_approval_instances'];
    const before=await canonicalSnapshot(pool,tables);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,expectedMigrationsFrom('137_wos05_assignment_leave_stage_deadlines'));
    assert.deepEqual(await canonicalSnapshot(pool,tables),before);
    for(const [kind,instance] of sources){
      const after=await readDelegationInstance(request,kind,instance.id);
      assert.equal(after.stageDeadline,undefined);
      assert.deepEqual(after.policy,instance.policy);
      assert.deepEqual(after.state,instance.state);
    }
  });
});
console.log('Migration 137 preserved populated untimed assignment and leave policies and pending instances.');

await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await withCommercialMigrationsThrough(137,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
  const fx=await seedDelegationFixture(pool);
  const ids=fx.identities;
  await withCommercialApi({databaseUrl,identities:ids,enableLeave:true},async({request})=>{
    await prepareStagedWork(request,ids,fx.today);
    await adoptActualInputs(request,fx.today);
    await adoptStagedPolicy(request,ids,fx.today);
    const assignment=await createApprovalAssignment(request,fx);
    const assignmentPolicy=await adoptAssignmentApproval(request,fx,{...assignmentApprovalDefinition(ids),creationRequired:true,stageDueMinutes:10});
    await adoptLeavePolicy(request,fx,{...leaveDefinition(ids),stageDueMinutes:10});
    const sources=(await createDelegationSources(request,fx,{assignment,assignmentPolicy})).filter(([kind])=>kind!=='Work');
    const tables=['assignment_approval_policies','assignment_approval_instances','assignment_approval_recipients',
      'leave_approval_policies','leave_approval_instances','leave_approval_recipients'];
    const before=await canonicalSnapshot(pool,tables);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,expectedMigrationsFrom('138_wos05_assignment_leave_reminders'));
    assert.deepEqual(await canonicalSnapshot(pool,tables),before);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
    for(const [kind,instance] of sources){
      const after=await readDelegationInstance(request,kind,instance.id);
      assert.equal(after.stageDeadline.dueAt,instance.stageDeadline.dueAt);
      assert.deepEqual(after.policy,instance.policy);
    }
    assert.equal((await pool.query('select * from assignment_leave_reminder_candidates')).rowCount,0);
    await collectAssignmentLeaveReminders(pool);
    assert.equal((await pool.query('select * from assignment_leave_stage_reminders')).rowCount,0);
  });
});
console.log('Migration 138 preserved populated timed policies, exact deadlines and action recipients without scheduling retroactive reminders.');
