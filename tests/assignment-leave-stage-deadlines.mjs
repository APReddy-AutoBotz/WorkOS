import {adoptActualInputs} from './support/actual-work-test.mjs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {runMigrations} from '../server/migrate.mjs';
import {withCommercialDatabase, withCommercialMigrationsThrough, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedDelegationFixture,prepareDelegationInputs,canonicalSnapshot,createDelegationSources,readDelegationInstance,decideDelegationInstance,delegationOk} from './support/canonical-delegation-test.mjs';
import {prepareStagedWork,adoptStagedPolicy} from './support/work-approval-test.mjs';
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
    for(const invalid of [0,-1,0.5,2147483648,'1',null]){
      assert.equal(await check(domain,{...definition,stageDueMinutes:invalid}),false);
    }
  }
  await withCommercialApi({databaseUrl,identities:ids,enableLeave:true},async({request})=>{
    await prepareStagedWork(request,ids,fx.today);
    await adoptActualInputs(request,fx.today);
    await adoptStagedPolicy(request,ids,fx.today);
    const assignment=await createApprovalAssignment(request,fx);
    const assignmentPolicy=await adoptAssignmentApproval(request,fx,{...definitions.assignment,stageDueMinutes:1});
    await adoptLeavePolicy(request,fx,{...definitions.leave,stageDueMinutes:1});
    const sources=(await createDelegationSources(request,fx,{assignment,assignmentPolicy})).filter(([kind])=>kind!=='Work');
    assert.deepEqual(sources.map(([kind])=>kind),['Material','Creation','Leave']);
    for(const [,instance] of sources){
      assert.equal(instance.stageDeadline.stage,0);
      assert.equal(instance.stageDeadline.dueAt,new Date(Date.parse(instance.createdAt)+60000).toISOString());
      assert.equal(instance.stageDeadline.overdue,false);
    }
    const due=Math.max(...sources.map(([,i])=>Date.parse(i.stageDeadline.dueAt)));
    await delay(Math.max(0,due-Date.now()+30));
    for(const [kind,instance] of sources){
      const late=await readDelegationInstance(request,kind,instance.id);
      assert.equal(late.stageDeadline.dueAt,instance.stageDeadline.dueAt);
      assert.equal(late.stageDeadline.overdue,true);
      const decision=delegationOk(await decideDelegationInstance(request,ids.manager,kind,late),201);
      const next=await readDelegationInstance(request,kind,instance.id);
      assert.equal(next.stageDeadline.stage,1);
      assert.equal(next.stageDeadline.dueAt,new Date(Date.parse(decision.receipt.createdAt)+60000).toISOString());
      assert(validStageDeadline(next.stageDeadline,1,1,next.createdAt,next.transitions));
      assert.equal(validStageDeadline({...next.stageDeadline,overdue:true},1,1,next.createdAt,next.transitions),false);
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
