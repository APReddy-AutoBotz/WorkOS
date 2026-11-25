import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedCapacity} from './support/worker-capacity-test.mjs';
await withCommercialDatabase(async ({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);const fx=await seedCapacity(pool),ids=fx.identities;
 const employee='synthetic-delegation-recipient';
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values($1,$1,'Synthetic delegate','synthetic-delegate@example.test','Team lead','Delivery','US','director-commercial','Active','org-default','legal-default')`,[employee]);
 await pool.query('update users set employee_record_id=$1,employee_id=$1 where id=$2',[employee,ids.denied.id]);
 await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('TeamLead','approvals.view',true) on conflict(role_name,permission_key) do update set enabled=true");
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='TeamLead' on conflict do nothing",[ids.reader.id]);
 await withCommercialApi({databaseUrl,identities:ids},async ({request})=>{
  const releases = '/api/v1/organization-setup/module-releases';
  const change = {enabled:true, evidence:'Synthetic Teams UAT approval', expectedRevision:0};
  const setRelease = (body, identity=ids.manager) => request(releases+'/teams',{method:'PUT',body,identity});
  const initial = await request(releases);
  assert.equal(initial.status,200,JSON.stringify(initial.body));
  assert.deepEqual(initial.body.decisions,[]);
  assert.equal((await setRelease(change,ids.reader)).status,403);
  assert.equal((await setRelease({...change,organizationId:f.otherOrganizationId})).status,400);
  const teamsLinks = '/api/integrations/teams-user-links';
  assert.equal((await request(teamsLinks)).status,403);
  const accepted = await setRelease(change);
  assert.equal((await request(teamsLinks)).status,200);
  assert.equal(accepted.status,201,JSON.stringify(accepted.body));
  assert.equal(accepted.body.owner_id,ids.manager.id);
  assert.ok(Date.parse(accepted.body.activated_at));
  assert.equal((await setRelease(change)).body.id,accepted.body.id);
  assert.equal((await setRelease({...change,enabled:false})).status,409);
  const disabled = await setRelease({enabled:false,evidence:'Synthetic rollback',expectedRevision:1});
  assert.equal(disabled.status,201);
  assert.equal((await request(releases)).body.decisions[0].enabled,false);
  assert.equal((await request(teamsLinks)).status,403);
  assert.deepEqual((await request(releases+'/effective',{identity:ids.reader})).body,{teams:false,entra:false,planning:false,notifications:false});
  const report = '/api/reports/resource-planning';
  assert.equal((await request(report)).body.code,'MODULE_DISABLED');
  const planningRelease = (enabled,expectedRevision) => request(releases+'/planning',{method:'PUT',body:{
    enabled, expectedRevision, evidence:'Synthetic planning review',
  }});
  assert.equal((await planningRelease(true,0)).status,201);
  assert.equal((await request(report)).status,200);
  assert.equal((await planningRelease(false,1)).status,201);
  assert.equal((await request(report)).body.code,'MODULE_DISABLED');
  assert.equal((await request('/api/allocations')).status,200);
  assert.equal((await request('/api/reports/workforce-command-center')).status,200);
  await pool.query(`insert into notification_preferences(employee_id,event_type,in_app,email,teams)
    values($1,'TestDelivery',true,false,true)`,[employee]);
  const deliver = channels => request('/api/notifications/test-delivery',{method:'POST',body:{employee_id:employee,channels}});
  assert.equal((await deliver(['InApp'])).body.code,'MODULE_DISABLED');
  assert.equal((await request('/api/notifications')).status,200);
  assert.equal((await request(releases+'/notifications',{method:'PUT',body:{...change,evidence:'Synthetic notification center release'}})).status,201);
  assert.equal((await deliver(['Teams'])).status,403);
  const notice = await deliver(['InApp']);
  assert.equal(notice.status,200,JSON.stringify(notice.body));
  const channelsFor = async id => (await pool.query('select channel from notification_delivery_attempts where notification_id=$1 order by channel',[id])).rows.map(row=>row.channel);
  assert.deepEqual(await channelsFor(notice.body.id),['InApp']);
  assert.equal((await setRelease({...change,expectedRevision:2})).status,201);
  const enabledNotice = await deliver(['InApp']);
  assert.equal(enabledNotice.status,200,JSON.stringify(enabledNotice.body));
  assert.deepEqual(await channelsFor(enabledNotice.body.id),['InApp','Teams']);
  const auditRows=await pool.query("select organization_id,legal_entity_id,active_role,old_value,new_value from audit_logs where entity_id=$1",[disabled.body.id]);
  assert.equal(auditRows.rowCount,1);
  assert.deepEqual([auditRows.rows[0].organization_id,auditRows.rows[0].legal_entity_id,auditRows.rows[0].active_role],[f.organizationId,null,ids.manager.role]);
  assert.equal(auditRows.rows[0].old_value.enabled,true);
  assert.equal(auditRows.rows[0].new_value.enabled,false);
  const delegationDate=(await pool.query("select current_date::text today")).rows[0].today;
  const body={delegator_id:f.ownerId,delegate_id:employee,role:'TeamLead',start_date:delegationDate,end_date:delegationDate,status:'Active',reason:'Synthetic delegation'};
  const baselineOriginal=await request('/api/approval-delegations',{method:'POST',body});
  assert.equal(baselineOriginal.status,200,JSON.stringify(baselineOriginal.body));
  const baselineTakeover=await request('/api/approval-delegations',{identity:ids.denied,method:'POST',body:{...body,id:baselineOriginal.body.id,delegator_id:employee,delegate_id:f.ownerId}});
  await pool.query(`insert into approval_records(id,entity_type,entity_id,subject_employee_id,requester_name,status)
    values('synthetic-boundary-probe','LeaveRequest','synthetic-boundary-source',$1,'Synthetic foreign requester','Pending')`,[f.otherOwnerId]);
  const baselineInbox=await request('/api/approvals');assert.equal(baselineInbox.status,200);
  assert.deepEqual({takeoverStatus:baselineTakeover.status,foreignVisible:baselineInbox.body.some(row=>row.id==='synthetic-boundary-probe')},
    {takeoverStatus:403,foreignVisible:false},'Retained ownership and selected-entity approval scope must both be enforced');
  assert.equal((await request('/api/approval-delegations',{method:'POST',body:{...body,id:baselineOriginal.body.id,status:'Inactive'}})).status,200);
  const invalidRole=await request('/api/approval-delegations',{method:'POST',body:{...body,role:'Admin'}});
  assert.equal(invalidRole.status,422,'Cannot delegate a role absent from participants');
  await pool.query("update users set status='Disabled' where id=$1",[ids.reader.id]);
  const disabledOwner=await request('/api/approval-delegations',{method:'POST',body});assert.equal(disabledOwner.status,422);
  await pool.query("update users set status='Active' where id=$1",[ids.reader.id]);
  await pool.query("update users set status='Disabled' where id=$1",[ids.denied.id]);
  assert.equal((await request('/api/approval-delegations',{method:'POST',body})).status,422);
  await pool.query("update users set status='Active' where id=$1",[ids.denied.id]);
  await pool.query("update user_organization_scopes set active=false where user_id=$1",[ids.denied.id]);
  assert.equal((await request('/api/approval-delegations',{method:'POST',body})).status,422);
  await pool.query("update user_organization_scopes set active=true where user_id=$1",[ids.denied.id]);
  await pool.query("update role_permissions set enabled=false where role_name='TeamLead' and permission_key='approvals.view'");
  assert.equal((await request('/api/approval-delegations',{method:'POST',body})).status,422);
  await pool.query("insert into user_permission_grants(user_id,permission_key)values($1,'approvals.view'),($2,'approvals.view') on conflict do nothing",[ids.reader.id,ids.denied.id]);
  const created=await request('/api/approval-delegations',{method:'POST',body});assert.equal(created.status,200,JSON.stringify(created.body));
  const listed=await request('/api/approval-delegations',{identity:ids.denied});assert.equal(listed.status,200);assert.ok(listed.body.some(x=>x.id===created.body.id));
  const beforeDenied=(await pool.query("select * from audit_logs where entity_type='ApprovalDelegation' order by id")).rows;
  const overwritten=await request('/api/approval-delegations',{identity:ids.denied,method:'POST',body:{...body,id:created.body.id,delegator_id:employee,delegate_id:f.ownerId}});
  assert.equal(overwritten.status,403,JSON.stringify(overwritten.body));
  assert.deepEqual((await pool.query("select * from audit_logs where entity_type='ApprovalDelegation' order by id")).rows,beforeDenied);
  assert.equal((await pool.query('select delegator_id from approval_delegations where id=$1',[created.body.id])).rows[0].delegator_id,f.ownerId);
  const edited=await request('/api/approval-delegations',{method:'POST',body:{...body,id:created.body.id,status:'Inactive'}});
  assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.delegator_id,f.ownerId);
  const owned={...body,delegator_id:employee,delegate_id:f.ownerId};
  const ownerCreated=await request('/api/approval-delegations',{identity:ids.denied,method:'POST',body:owned});
  assert.equal(ownerCreated.status,200,JSON.stringify(ownerCreated.body));
  const ownerEdited=await request('/api/approval-delegations',{identity:ids.denied,method:'POST',body:{...owned,id:ownerCreated.body.id,status:'Inactive'}});
  assert.equal(ownerEdited.status,200,JSON.stringify(ownerEdited.body));
  const concurrent=await Promise.all([1,2].map(()=>request('/api/approval-delegations',{identity:ids.denied,method:'POST',body:owned})));
  assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,422]);
  const contestedId='synthetic-contested-delegation';
  const competing=await Promise.all([body,owned].map(value=>request('/api/approval-delegations',{method:'POST',body:{...value,id:contestedId,start_date:'2099-01-01',end_date:'2099-01-02'}})));
  assert.deepEqual(competing.map(x=>x.status).sort(),[200,403]);
  const winner=competing.find(x=>x.status===200).body;
  assert.equal((await pool.query('select delegator_id from approval_delegations where id=$1',[contestedId])).rows[0].delegator_id,winner.delegator_id);
  assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_type='ApprovalDelegation' and entity_id=$1",[contestedId])).rows[0].n,1);
  await pool.query(`insert into approval_delegations(id,delegator_id,delegate_id,role,start_date,end_date,status)
    values('synthetic-retained-cross-entity',$1,$2,'TeamLead',current_date,current_date,'Active')`,[f.ownerId,f.otherOwnerId]);
  const retainedBefore=(await pool.query("select * from approval_delegations where id='synthetic-retained-cross-entity'")).rows;
  const retainedRefusal=await request('/api/approval-delegations',{method:'POST',body:{...body,id:'synthetic-retained-cross-entity'}});assert.equal(retainedRefusal.status,403);
  assert.deepEqual((await pool.query("select * from approval_delegations where id='synthetic-retained-cross-entity'")).rows,retainedBefore);
  const scopedList=await request('/api/approval-delegations');assert.equal(scopedList.status,200);
  assert.ok(!scopedList.body.some(row=>row.id==='synthetic-retained-cross-entity'));
  const adminTakeover=await request('/api/approval-delegations',{method:'POST',body:{...body,id:created.body.id,delegator_id:employee,delegate_id:f.ownerId}});
  assert.equal(adminTakeover.status,403,'Administration cannot transfer retained ownership');
  const beforeUnrelated=(await pool.query('select * from approval_delegations where id=$1',[created.body.id])).rows;
  assert.equal((await request('/api/approval-delegations',{identity:ids.denied,method:'POST',body:{...body,id:created.body.id,status:'Inactive'}})).status,403);
  assert.deepEqual((await pool.query('select * from approval_delegations where id=$1',[created.body.id])).rows,beforeUnrelated);
  await pool.query("update employees set status='On Leave' where id=$1",[employee]);
  assert.equal((await request('/api/approval-delegations',{method:'POST',body:{...body,start_date:'2098-01-01',end_date:'2098-01-02'}})).status,200,'On Leave participants remain eligible under retained lifecycle rules');
  await pool.query("update employees set status='Active' where id=$1",[employee]);
  const invalidDate=await request('/api/approval-delegations',{method:'POST',body:{...body,start_date:'2026-02-30'}});
  assert.equal(invalidDate.status,400);

  const crossed=await request('/api/approval-delegations',{method:'POST',body:{...body,delegate_id:f.otherOwnerId}});
  assert.equal(crossed.status,422,JSON.stringify(crossed.body));
  await pool.query(`insert into approval_records(id,entity_type,entity_id,subject_employee_id,requester_name,status)
    values('synthetic-foreign-approval','LeaveRequest','synthetic-foreign-source',$1,'Synthetic foreign requester','Pending')`,[f.otherOwnerId]);
  const approvals=await request('/api/approvals');assert.equal(approvals.status,200);
  assert.ok(!approvals.body.some(x=>x.id==='synthetic-foreign-approval'));
  const sla=await request('/api/reports/approval-sla');assert.equal(sla.status,200);
  assert.ok(!sla.body.rows.some(x=>x.id==='synthetic-foreign-approval'));
  const command=await request('/api/reports/workforce-command-center');assert.equal(command.status,200,JSON.stringify(command.body));
  assert.equal(command.body.pendingApprovalLoad,sla.body.pendingCount,'Command-center load shares selected-entity approval scope');
  const actionToken = randomUUID();
  await pool.query(`insert into teams_action_tokens(token,entity_type,entity_id,action,expires_at,organization_id,legal_entity_id)
    values($3,'ApprovalRecord','synthetic-foreign-approval','approve',now()+interval '1 hour',$1,$2)`,[f.organizationId,f.legalEntityId,actionToken]);
  const tokenBefore=(await pool.query("select * from teams_action_tokens where token=$1",[actionToken])).rows;
  const teamsRefusal=await request(`/api/integrations/teams-action-tokens/${actionToken}/execute`,{method:'POST',body:{}});
  assert.equal(teamsRefusal.status,403,JSON.stringify(teamsRefusal.body));
  assert.deepEqual((await pool.query("select * from teams_action_tokens where token=$1",[actionToken])).rows,tokenBefore,'Out-of-scope approval does not consume the Teams token');
  await pool.query(`insert into approval_records(id,entity_type,entity_id,subject_employee_id,requester_name,status)
    values('synthetic-other-organization','LeaveRequest','synthetic-other-organization-source',$1,'Synthetic requester','Pending'),
          ('synthetic-orphan-approval','LeaveRequest','synthetic-orphan-source',null,'Synthetic requester','Pending')`,[f.foreignOwnerId]);
  await pool.query('update employees set reporting_manager_id=$1 where id=$2',[employee,f.otherOwnerId]);
  for (const identity of [ids.manager,ids.denied]) {
    for (const path of ['/api/approvals','/api/reports/approval-sla']) {
      const r=await request(path,{identity});assert.equal(r.status,200);
      assert.ok(!(Array.isArray(r.body)?r.body:r.body.rows).some(row=>['synthetic-foreign-approval','synthetic-other-organization','synthetic-orphan-approval'].includes(row.id)),'Neither direct reports nor administrative roles bypass selected ownership');
    }
  }
  await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',[ids.manager.id,f.organizationId,f.otherLegalEntityId]);
  const switched=await request('/api/approvals',{scope:{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId}});
  assert.equal(switched.status,200);assert.ok(switched.body.some(row=>row.id==='synthetic-foreign-approval'));
  assert.ok(!switched.body.some(row=>row.id==='synthetic-other-organization'||row.id==='synthetic-orphan-approval'));
  assert.equal((await request('/api/approval-delegations',{authenticated:false})).status,401);
  const deniedDecision=await request('/api/approvals/synthetic-foreign-approval/status',{method:'PATCH',body:{status:'Rejected',comments:'Synthetic scope refusal'}});
  assert.equal(deniedDecision.status,403,JSON.stringify(deniedDecision.body));
  assert.equal((await pool.query("select status from approval_records where id='synthetic-foreign-approval'")).rows[0].status,'Pending');
  const beforeAuditFailure=(await pool.query('select * from approval_delegations where id=$1',[created.body.id])).rows;
  await pool.query("create function synthetic_delegation_audit_failure() returns trigger language plpgsql as $$ begin if new.entity_type='ApprovalDelegation' then raise exception 'synthetic refusal'; end if; return new; end $$; create trigger synthetic_delegation_audit_failure before insert on audit_logs for each row execute function synthetic_delegation_audit_failure()");
  const refusedAudit=await request('/api/approval-delegations',{method:'POST',body:{...body,id:created.body.id,status:'Inactive',reason:'Synthetic rollback'}});
  assert.equal(refusedAudit.status,500);
  assert.deepEqual((await pool.query('select * from approval_delegations where id=$1',[created.body.id])).rows,beforeAuditFailure);
  await pool.query('drop trigger synthetic_delegation_audit_failure on audit_logs; drop function synthetic_delegation_audit_failure()');
  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id,reporting_manager_id)
    values('synthetic-delegated-worker','SYN-DELEGATED','Synthetic delegated worker','delegated-worker@example.test','Analyst','Delivery','US','director-commercial','Active','org-default','legal-default',$1)`,[f.ownerId]);
  await pool.query(`insert into approval_records(id,entity_type,entity_id,subject_employee_id,requester_name,status)
    values('synthetic-delegated-approval','LeaveRequest','synthetic-delegated-source','synthetic-delegated-worker','Synthetic requester','Pending')`);
  await pool.query("update approval_delegations set status='Active' where id=$1",[created.body.id]);
  const assertDelegated=async (expected,role=ids.denied.role)=>{
    for(const path of ['/api/approvals','/api/reports/approval-sla']){
      const result=await request(path,{identity:{...ids.denied,role}});assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal((Array.isArray(result.body)?result.body:result.body.rows).some(x=>x.id==='synthetic-delegated-approval'),expected,path);
    }
  };
  await assertDelegated(true);
  await pool.query("update approval_delegations set start_date=current_date-2,end_date=current_date-1 where id=$1",[created.body.id]);await assertDelegated(false);
  await pool.query("update approval_delegations set start_date=current_date,end_date=current_date where id=$1",[created.body.id]);
  await pool.query("update employees set reporting_manager_id=null where id='synthetic-delegated-worker'");await assertDelegated(false);
  await pool.query("update employees set reporting_manager_id=$1 where id='synthetic-delegated-worker'",[f.ownerId]);
  await pool.query("update employees set status='Exited' where id=$1",[employee]);await assertDelegated(false);
  const revokeExited=await request('/api/approval-delegations',{method:'POST',body:{...body,id:created.body.id,status:'Inactive'}});
  assert.equal(revokeExited.status,200,'Scoped administration can revoke delegation after a participant exits');
  await pool.query("update employees set status='Active' where id=$1",[employee]);
  await pool.query("update approval_delegations set status='Active' where id=$1",[created.body.id]);await assertDelegated(true);
  await pool.query("update users set status='Disabled' where id=$1",[ids.reader.id]);await assertDelegated(false);
  await pool.query("update users set status='Active' where id=$1",[ids.reader.id]);await assertDelegated(true);
  await pool.query("delete from user_roles where user_id=$1 and role_id=(select id from roles where name='TeamLead')",[ids.reader.id]);await assertDelegated(false);
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='TeamLead'",[ids.reader.id]);
  await pool.query("update user_organization_scopes set active=false where user_id=$1",[ids.reader.id]);await assertDelegated(false);
  await pool.query("update user_organization_scopes set active=true where user_id=$1",[ids.reader.id]);
  await pool.query("update employees set status='Exited' where id=$1",[f.ownerId]);await assertDelegated(false);
  await pool.query("update employees set status='Active' where id=$1",[f.ownerId]);
  await pool.query("update approval_delegations set role='Employee' where id=$1",[created.body.id]);await assertDelegated(false);
  await pool.query("update approval_delegations set role='TeamLead',status='Inactive' where id=$1",[created.body.id]);await assertDelegated(false);
  await pool.query("update approval_delegations set status='Active' where id=$1",[created.body.id]);await assertDelegated(true);
  await pool.query("insert into user_permission_grants(user_id,permission_key) values($1,'approvals.view'),($2,'approvals.view') on conflict do nothing",[ids.reader.id,ids.denied.id]);
  await pool.query("update role_permissions set enabled=false where role_name='TeamLead' and permission_key='approvals.view'");await assertDelegated(true);
  await pool.query("delete from user_permission_grants where user_id=$1 and permission_key='approvals.view'",[ids.reader.id]);await assertDelegated(false);
  await pool.query("insert into country_directors(id,name,region)values('synthetic-other-director','Synthetic other director','Synthetic other region')");
  for(const role of ['CountryDirector','ProjectManager']){
    for(const uid of [ids.reader.id,ids.denied.id])await pool.query('insert into user_roles(user_id,role_id)select $1,id from roles where name=$2 on conflict do nothing',[uid,role]);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled)values($1,'approvals.view',true) on conflict(role_name,permission_key)do update set enabled=true",[role]);
    await pool.query('update approval_delegations set role=$2 where id=$1',[created.body.id,role]);
    if(role==='CountryDirector'){
      await pool.query("update employees set designation='Country Director' where id=$1",[f.ownerId]);await assertDelegated(true,role);
      await pool.query("update employees set designation='Analyst' where id=$1",[f.ownerId]);await assertDelegated(false,role);
      await pool.query("update employees set designation='Country Director' where id=$1",[f.ownerId]);await assertDelegated(true,role);
      await pool.query("update employees set primary_country_director_id='synthetic-other-director' where id='synthetic-delegated-worker'");await assertDelegated(false,role);
      await pool.query("update employees set primary_country_director_id='director-commercial' where id='synthetic-delegated-worker'");
    }else{
      await assertDelegated(false,role);
      await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)
        values('synthetic-delegated-project-allocation','synthetic-delegated-worker',$1,10,'2020-03-08','2021-11-07',true,'Completed','org-default','legal-default')`,[f.projectId]);
      await assertDelegated(true,role);
      await pool.query('update projects set manager_id=null where id=$1',[f.projectId]);await assertDelegated(false,role);
      await pool.query('update projects set manager_id=$2 where id=$1',[f.projectId,f.ownerId]);await assertDelegated(true,role);
    }
    await pool.query('delete from user_roles where user_id=$1 and role_id=(select id from roles where name=$2)',[ids.reader.id,role]);await assertDelegated(false,role);
  }
  console.log('Legacy approval selected-entity scope, immutable delegation owner, owner/admin edits, calendar dates and concurrent overlap denial passed.');
 });
});
