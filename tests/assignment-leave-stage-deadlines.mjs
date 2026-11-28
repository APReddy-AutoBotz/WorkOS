import {collectAssignmentLeaveBreaches,dispatchAssignmentLeaveOverdue} from '../server/modules/approvals/assignment-leave-escalation.mjs';
import {collectAssignmentLeaveReminders} from '../server/modules/approvals/overdue-work.mjs';
import {adoptActualInputs} from './support/actual-work-test.mjs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {runMigrations} from '../server/migrate.mjs';
import {commercialFixture,withCommercialDatabase, withCommercialMigrationsThrough, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
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
    assert(await check(domain,{...definition,stageDueMinutes:1,escalationUserId:ids.manager.id}));
    const template={key:'approval.overdue_or_escalated',subject:'Stage {{stageNumber}} overdue',body:'Review {{sourceRef}}'};
    assert(await check(domain,{...definition,stageDueMinutes:1,overdueTemplate:template}));
    assert.equal(await check(domain,{...definition,overdueTemplate:template}),false);
    for (const invalid of [null,{...template,key:'approval.completed'},{...template,body:'{{amount}}'},
      {...template,subject:'{{decisionReason}}'},{...template,extra:'unbound'},{...template,body:'{{workerCode}}'.repeat(61)}]){
      assert.equal(await check(domain,{...definition,stageDueMinutes:1,overdueTemplate:invalid}),false);
    }
    const literal=(await pool.query("select render_stage_overdue_text('{{workerCode}} / {{sourceRef}}','{{sourceRef}}','{{stageNumber}}',1) as value")).rows[0];
    assert.equal(literal.value,'{{sourceRef}} / {{stageNumber}}');
    assert.equal(await check(domain,{...definition,escalationUserId:ids.manager.id}),false);
    for(const value of [null,{},'unknown',12])assert.equal(await check(domain,{...definition,stageDueMinutes:1,escalationUserId:value}),false);
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
    const assignmentPolicy=await adoptAssignmentApproval(request,fx,{...definitions.assignment,stageDueMinutes:2,reminderLeadMinutes:1,escalationUserId:ids.delegate.id});
    await adoptLeavePolicy(request,fx,{...definitions.leave,stageDueMinutes:2,reminderLeadMinutes:1,escalationUserId:ids.manager.id,locale:'fr',overdueTemplate:{key:'approval.overdue_or_escalated',subject:'Retard - {{stageNumber}}',body:'Demande {{sourceRef}}.'}});
    const grant=delegationOk(await adoptDelegation(request,ids.manager,delegationDefinition(fx,{sourceKinds:['Creation','Material']})),201).delegation;
    const leaveGrant=delegationOk(await adoptDelegation(request,ids.manager,delegationDefinition(fx,{
      sourceKinds:['Leave'],delegateUserId:ids.requester.id})),201).delegation;
    await waitForDelegationStart(leaveGrant.definition);
    const sources=(await createDelegationSources(request,fx,{assignment,assignmentPolicy})).filter(([kind])=>kind!=='Work');
    assert.deepEqual(sources.map(([kind])=>kind),['Material','Creation','Leave']);
    for(const [,instance] of sources){
      assert.equal(instance.stageDeadline.stage,0);
      assert.equal(instance.stageDeadline.dueAt,new Date(Date.parse(instance.createdAt)+120000).toISOString());
      assert.equal(instance.stageDeadline.overdue,false);
    }
    const paths={Material:'/assignments/instances',Creation:'/assignments/creation-instances',Leave:'/leave/instances'};
    const overdueRows=async(kind,after=null)=>delegationOk(await request(WORK_APPROVAL_BASE+paths[kind]+
      '?timing=overdue'+(after?'&after='+after:''),{identity:ids.manager}),200).instances;
    for(const [kind] of sources) assert.deepEqual(await overdueRows(kind),[]);
    const breaches=async()=>(await pool.query('select assignment_event_id,leave_event_id,due_at,observed_at from assignment_leave_deadline_breaches order by id')).rows;
    await collectAssignmentLeaveBreaches(pool);
    assert.deepEqual(await breaches(),[]);
    const due=Math.max(...sources.map(([,i])=>Date.parse(i.stageDeadline.dueAt)));
    const eligibleCount=async()=>Number((await pool.query('select count(*) from assignment_leave_reminder_candidates')).rows[0].count);
    assert.equal(await eligibleCount(),6);
    delegationOk(await revokeDelegation(request,ids.manager,grant.id),201);
    assert.equal(await eligibleCount(),4);
    const countReminders=async()=>Number((await pool.query('select count(*) from assignment_leave_stage_reminders')).rows[0].count);
    await collectAssignmentLeaveReminders(pool);
    assert.equal(await countReminders(),0);
    await delay(Math.max(0,due-60000-Date.now()+30));
    await Promise.all([collectAssignmentLeaveReminders(pool),collectAssignmentLeaveReminders(pool)]);
    assert.equal(await countReminders(),4);
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
    const otherScope={organizationId:commercialFixture.organizationId,legalEntityId:commercialFixture.otherLegalEntityId};
    await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true)',
      [ids.requester.id,otherScope.organizationId,otherScope.legalEntityId]);
    for(const [kind,instance] of sources){
      const late=await readDelegationInstance(request,kind,instance.id);
      assert.equal(late.stageDeadline.dueAt,instance.stageDeadline.dueAt);
      assert.equal(late.stageDeadline.overdue,true);
      const overdue=await overdueRows(kind);
      assert.deepEqual(overdue.map(row=>row.id),[instance.id]);
      const query=WORK_APPROVAL_BASE+paths[kind]+'?timing=overdue';
      const permitted=delegationOk(await request(query,{identity:ids.requester}),200);
      assert.deepEqual(permitted.instances.map(row=>row.id),[instance.id]);
      const otherEntity=delegationOk(await request(query,{identity:ids.requester,scope:otherScope}),200);
      assert.deepEqual(otherEntity.instances,[]);
      assert.equal(otherEntity.nextAfter,null);
      assert.equal(overdue[0].stageDeadline.dueAt,late.stageDeadline.dueAt);
      assert.deepEqual(await overdueRows(kind,instance.id),[]);
      const decision=delegationOk(await decideDelegationInstance(request,ids.manager,kind,late),201);
      const next=await readDelegationInstance(request,kind,instance.id);
      assert.equal(next.stageDeadline.stage,1);
      if(kind==='Material'){
        const recorded=await breaches();
        assert.ok(recorded.some(row=>new Date(row.due_at).toISOString()===late.stageDeadline.dueAt && row.assignment_event_id));
        await Promise.all([collectAssignmentLeaveBreaches(pool),collectAssignmentLeaveBreaches(pool)]);
        assert.equal((await breaches()).length,3);
      }
      assert.deepEqual(await overdueRows(kind),[]);
      assert.equal(next.stageDeadline.dueAt,new Date(Date.parse(decision.receipt.createdAt)+120000).toISOString());
      assert(validStageDeadline(next.stageDeadline,2,1,next.createdAt,next.transitions));
      assert.equal(validStageDeadline({...next.stageDeadline,overdue:true},2,1,next.createdAt,next.transitions),false);
      delegationOk(await decideDelegationInstance(request,ids.second,kind,next,'Rejected'),201);
      const closed=await readDelegationInstance(request,kind,instance.id);
      assert.equal(closed.state.status,'Rejected');
      assert.equal((await breaches()).length,3);
      assert.equal(closed.stageDeadline,undefined);
      assert.deepEqual(await overdueRows(kind),[]);
    }
    const setTargetActive=active=>pool.query('update user_organization_scopes set active=$1 where user_id=$2 and organization_id=$3 and legal_entity_id=$4',
      [active,ids.delegate.id,commercialFixture.organizationId,commercialFixture.legalEntityId]);
    const isolated=await pool.connect();
    try{
      await isolated.query('begin');
      const leaveSource=(await isolated.query("select breach_id,employee_id from assignment_leave_overdue_sources where kind='Leave'")).rows[0];
      await isolated.query("update employees set employee_id=repeat('w',201) where id=$1",[leaveSource.employee_id]);
      await isolated.query('savepoint invalid_message');
      await assert.rejects(()=>isolated.query('insert into assignment_leave_overdue_attempts(breach_id)values($1)',[leaveSource.breach_id]),
        err=>err.code==='WGA06');
      await isolated.query('rollback to savepoint invalid_message');
      assert.equal((await isolated.query('select * from assignment_leave_overdue_receipts where breach_id=$1',[leaveSource.breach_id])).rowCount,0);
    }finally{
      await isolated.query('rollback');
      isolated.release();
    }
    await setTargetActive(false);
    await dispatchAssignmentLeaveOverdue(pool);
    const attempts=async()=>(await pool.query('select a.* from assignment_leave_overdue_attempts a order by a.created_at')).rows;
    const firstAttempts=await attempts();
    assert.equal(firstAttempts.length,3);
    assert.equal(firstAttempts.filter(a=>a.failure==='RECIPIENT_UNAVAILABLE').length,2);
    assert.equal((await pool.query('select * from assignment_leave_overdue_receipts')).rowCount,2);
    for(const [kind,instance] of sources){
      const retained=await readDelegationInstance(request,kind,instance.id);
      assert.deepEqual(retained.overdueDeliveries,[{stage:0,dueAt:instance.stageDeadline.dueAt,attempts:1,
        status:kind==='Leave'?'Delivered':'RecipientUnavailable'}]);
    }
    await setTargetActive(true);
    await dispatchAssignmentLeaveOverdue(pool);
    assert.equal((await attempts()).length,3);
    await delay(Math.max(0,Math.max(...firstAttempts.map(a=>new Date(a.created_at).getTime()))+60050-Date.now()));
    await Promise.all([dispatchAssignmentLeaveOverdue(pool),dispatchAssignmentLeaveOverdue(pool)]);
    assert.equal((await attempts()).length,5);
    const visible=async identity=>{
      let cursor='',result=[];
      do {
        const page=delegationOk(await request(WORK_APPROVAL_BASE+'/inbox'+(cursor?'?after='+cursor:''),{identity}),200);
        result.push(...page.notifications.filter(n=>n.eventKey==='approval.overdue_or_escalated' && sources.some(([,i])=>i.id===n.instanceId)));
        cursor=page.nextAfter;
      } while(cursor);
      return result;
    };
    for(const [kind,instance] of sources){
      const retained=await readDelegationInstance(request,kind,instance.id);
      assert.equal(retained.overdueDeliveries[0].status,'Delivered');
      assert.equal(retained.overdueDeliveries[0].attempts,kind==='Leave'?1:2);
    }
    const named=await visible(ids.manager),target=await visible(ids.delegate);
    const eligibleDelegate=await visible(ids.requester);
    assert.equal(eligibleDelegate.length,1);
    assert.equal(eligibleDelegate[0].kind,'leave-approval');
    assert.deepEqual(eligibleDelegate[0].reasons,['current_stage_approver']);
    assert.equal(named.length,3);
    assert.equal(target.length,2);
    for(const notice of target)assert.deepEqual(notice.reasons,['escalation_target']);
    assert.deepEqual(named.find(n=>n.kind==='leave-approval').reasons,['current_stage_approver','escalation_target']);
    const localized=named.find(n=>n.kind==='leave-approval');
    assert.equal(localized.locale,'fr');
    assert.equal(localized.title,'Retard - 1');
    assert.equal(localized.body,'Demande leave/'+localized.requestId+'.');
    assert.equal(localized.templateId,sources.find(([kind])=>kind==='Leave')[1].policy.id);
    assert.equal(named.find(n=>n.kind==='assignment-approval').locale,'en');
    for(const notice of named){
      assert.equal(notice.policyClass,'CONTROL_MANDATORY');
      const origin=notice.kind==='leave-approval'?'leave-approval':'assignment-approval';
      assert.equal(notice.eventId,origin+'/'+notice.instanceId+'/0/approval.overdue_or_escalated/deadline');
      const foreignRead=await request(WORK_APPROVAL_BASE+'/inbox/'+notice.id+'/read',{method:'POST',identity:ids.second,
        body:{expectedOwnerKey:otherInbox.ownerKey}});
      assert.equal(foreignRead.status,404);
      const read=()=>request(WORK_APPROVAL_BASE+'/inbox/'+notice.id+'/read',{method:'POST',identity:ids.manager,body:{expectedOwnerKey:managerInbox.ownerKey}});
      const first=delegationOk(await read(),200).notification;
      assert.ok(first.readAt);
      assert.equal(delegationOk(await read(),200).notification.readAt,first.readAt);
    }
    assert.ok((await visible(ids.delegate)).every(n=>n.readAt===null));
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
    await withCommercialMigrationsThrough(138,async rootDir=>{
      const migrated=await runMigrations({pool,rootDir,logger:{log(){}}});
      assert.deepEqual(migrated.applied,['138_wos05_assignment_leave_reminders']);
    });
    assert.deepEqual(await canonicalSnapshot(pool,tables),before);
    await withCommercialMigrationsThrough(139,async rootDir=>{
      assert.deepEqual((await runMigrations({pool,rootDir,logger:{log(){}}})).applied,['139_wos05_open_stage_clocks']);
    });
    const clocksBefore=await canonicalSnapshot(pool,['assignment_leave_open_stage_clocks']);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,expectedMigrationsFrom('140_wos05_assignment_leave_escalation'));
    assert.deepEqual(await canonicalSnapshot(pool,['assignment_leave_open_stage_clocks']),clocksBefore);
    await collectAssignmentLeaveBreaches(pool);
    assert.equal((await pool.query('select * from assignment_leave_deadline_breaches')).rowCount,0);
    assert.deepEqual(await canonicalSnapshot(pool,tables),before);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
    for(const [kind,instance] of sources){
      const after=await readDelegationInstance(request,kind,instance.id);
      assert.equal(after.stageDeadline.dueAt,instance.stageDeadline.dueAt);
      assert.deepEqual(after.policy,instance.policy);
    }
    const clocks=(await pool.query('select instance_id,due_at from assignment_leave_open_stage_clocks')).rows;
    assert.equal(clocks.length,3);
    for(const [,instance] of sources){
      assert.equal(new Date(clocks.find(c=>c.instance_id===instance.id).due_at).toISOString(),instance.stageDeadline.dueAt);
    }
    assert.equal((await pool.query('select * from assignment_leave_reminder_candidates')).rowCount,0);
    await collectAssignmentLeaveReminders(pool);
    assert.equal((await pool.query('select * from assignment_leave_stage_reminders')).rowCount,0);
  });
});
console.log('Migration 138 preserved populated timed policies, exact deadlines and action recipients without scheduling retroactive reminders.');
await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await withCommercialMigrationsThrough(140,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
  const fx=await seedDelegationFixture(pool),ids=fx.identities;
  await withCommercialApi({databaseUrl,identities:ids,enableLeave:true},async({request})=>{
    await prepareStagedWork(request,ids,fx.today);
    await adoptActualInputs(request,fx.today);
    await adoptStagedPolicy(request,ids,fx.today);
    const assignment=await createApprovalAssignment(request,fx);
    const assignmentPolicy=await adoptAssignmentApproval(request,fx,{...assignmentApprovalDefinition(ids),creationRequired:true,stageDueMinutes:1});
    await adoptLeavePolicy(request,fx,{...leaveDefinition(ids),stageDueMinutes:1});
    const sources=(await createDelegationSources(request,fx,{assignment,assignmentPolicy})).filter(([kind])=>kind!=='Work');
    await delay(Math.max(...sources.map(([,i])=>Date.parse(i.stageDeadline.dueAt)))-Date.now()+50);
    await collectAssignmentLeaveBreaches(pool);
    await dispatchAssignmentLeaveOverdue(pool);
    const inbox=delegationOk(await request(WORK_APPROVAL_BASE+'/inbox',{identity:ids.manager}),200);
    const notices=inbox.notifications.filter(n=>n.eventKey==='approval.overdue_or_escalated');
    assert.equal(notices.length,3);
    for(const notice of notices){
      assert.equal(notice.title,'Approval stage overdue');
      assert.equal(notice.locale,'en');
      assert.equal(notice.templateId,'cd24c38c-8195-46db-b94e-0ad675e6f5c4');
      delegationOk(await request(WORK_APPROVAL_BASE+'/inbox/'+notice.id+'/read',{identity:ids.manager,method:'POST',
        body:{expectedOwnerKey:inbox.ownerKey}}),200);
    }
    const retained=['assignment_approval_policies','leave_approval_policies','assignment_leave_deadline_breaches',
      'assignment_leave_overdue_attempts','assignment_leave_overdue_receipts','assignment_leave_overdue_reads'];
    const before=await canonicalSnapshot(pool,retained);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,expectedMigrationsFrom('141_wos05_localized_stage_escalation'));
    await dispatchAssignmentLeaveOverdue(pool);
    assert.deepEqual(await canonicalSnapshot(pool,retained),before);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
  });
});
console.log('Populated template upgrade retained all historical standard messages, delivery evidence and acknowledgements.');
