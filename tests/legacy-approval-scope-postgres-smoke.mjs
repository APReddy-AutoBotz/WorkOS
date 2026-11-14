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
  const body={delegator_id:f.ownerId,delegate_id:employee,role:'TeamLead',start_date:fx.today,end_date:fx.today,status:'Active',reason:'Synthetic delegation'};
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
  const assertDelegated=async expected=>{
    for(const path of ['/api/approvals','/api/reports/approval-sla']){
      const result=await request(path,{identity:ids.denied});assert.equal(result.status,200,JSON.stringify(result.body));
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
  console.log('Legacy approval selected-entity scope, immutable delegation owner, owner/admin edits, calendar dates and concurrent overlap denial passed.');
 });
});
