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
 await withCommercialApi({databaseUrl,identities:ids},async ({request})=>{
  const body={delegator_id:f.ownerId,delegate_id:employee,role:'TeamLead',start_date:fx.today,end_date:fx.today,status:'Active',reason:'Synthetic delegation'};
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
  console.log('Legacy approval selected-entity scope, immutable delegation owner, owner/admin edits, calendar dates and concurrent overlap denial passed.');
 });
});
