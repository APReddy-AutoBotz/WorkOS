import assert from 'node:assert/strict';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedWorkPeriods} from './support/work-assignment-test.mjs';
import {seedCapacity} from './support/worker-capacity-test.mjs';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);const {identities:ids,today}=await seedCapacity(pool);await seedWorkPeriods(pool,today);
 for(const [id,manager] of [['synthetic-work-delegate',null],['synthetic-work-subject',f.ownerId]])
  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id,reporting_manager_id)
   values($1,$1,'Synthetic timesheet worker',$1||'@example.test','Lead','Delivery','US','director-commercial','Active','org-default','legal-default',$2)`,[id,manager]);
 await pool.query("update users set employee_record_id='synthetic-work-delegate' where id=$1",[ids.denied.id]);
 await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='TeamLead' on conflict do nothing",[ids.reader.id]);
 await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('TeamLead','approvals.view',true),('TeamLead','timesheets.approve',false) on conflict(role_name,permission_key)do update set enabled=excluded.enabled");
 await pool.query("insert into user_permission_grants(user_id,permission_key)values($1,'timesheets.approve')",[ids.denied.id]);
 const sheet=async (worker,date=today)=>{
  const row=(await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
   values($1,$2,'Submitted',2,2,$3,$4) returning *`,[worker,date,f.organizationId,f.legalEntityId])).rows[0];
  await pool.query("insert into timesheet_entries(timesheet_id,project_id,work_type,work_date,hours,remark,billable)values($1,$2,'Project Work',$3,2,'Synthetic work',true)",[row.id,f.projectId,date]);
  row.approval=(await pool.query("insert into approval_records(entity_type,entity_id,subject_employee_id,requester_id,requester_name,status)values('Timesheet',$1,$2,$2,'Synthetic worker','Pending')returning id",[row.id,worker])).rows[0].id;return row;
 };
 const preGrant=await sheet('synthetic-work-subject','2026-01-04');
 await pool.query(`insert into approval_delegations(delegator_id,delegate_id,role,start_date,end_date,status)
  values($1,'synthetic-work-delegate','TeamLead',current_date,current_date,'Active')`,[f.ownerId]);
 const report=await sheet('synthetic-work-subject'),own=await sheet(f.ownerId);
 const snapshot=async()=>Object.fromEntries(await Promise.all(['timesheets','timesheet_entries','approval_records','work_submission_decisions','audit_logs','notification_events'].map(async table=>[table,(await pool.query(`select to_jsonb(t) v from ${table} t order by to_jsonb(t)::text`)).rows])));
 await withCommercialApi({databaseUrl,identities:ids},async({request})=>{
  const decide=(row,identity=ids.denied)=>request(`/api/approvals/${row.approval}/status`,{identity,method:'PATCH',body:{status:'Approved'}});
  const before=await snapshot();
  const revoked=await decide(report);
  await pool.query("insert into user_permission_grants(user_id,permission_key)values($1,'timesheets.approve')",[ids.reader.id]);
  const inbox=await request('/api/approvals',{identity:ids.denied});
  assert.equal(inbox.status,200);
  assert.ok(inbox.body.some(row=>row.id===report.approval));
  assert.ok(!inbox.body.some(row=>row.id===preGrant.approval));
  assert.equal((await decide(preGrant)).status,403,'A new delegation cannot decide a pending instance created before the grant');
  const directSelf=await decide(own,{...ids.reader,role:'TeamLead'});
  const delegatedSelf=await decide(own);
  assert.deepEqual({revoked:revoked.status,directSelf:directSelf.status,delegatedSelf:delegatedSelf.status},{revoked:403,directSelf:403,delegatedSelf:403},'Delegation cannot restore revoked source permission or bypass owner self-approval');
  assert.deepEqual(await snapshot(),before,'Refused decisions preserve complete source, approval and audit state');
  await pool.query('update approval_records set subject_employee_id=$2 where id=$1',[report.approval,f.ownerId]);
  const mismatchedBefore=await snapshot();
  assert.equal((await decide(report)).status,409,'Approval subject must match the authoritative timesheet worker');
  assert.deepEqual(await snapshot(),mismatchedBefore,'Mismatched approval preserves source and audit evidence');
  await pool.query("update approval_records set subject_employee_id='synthetic-work-subject' where id=$1",[report.approval]);
  assert.equal((await decide(report)).status,200,'Restored owner source authority allows legitimate delegated direct-report decision');
  for (const uid of [ids.reader.id,ids.denied.id]) await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='ProjectManager' on conflict do nothing",[uid]);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('ProjectManager','approvals.view',true) on conflict(role_name,permission_key)do update set enabled=true");
  await pool.query("update approval_delegations set role='ProjectManager'");
  await pool.query(`insert into project_allocations(employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)
    values('synthetic-work-subject',$1,10,$2,$2,true,'Active',$3,$4)`,[f.projectId,today,f.organizationId,f.legalEntityId]);
  const previousDate=new Date(today+'T00:00:00Z');previousDate.setUTCDate(previousDate.getUTCDate()-7);
  const pmSheet=await sheet('synthetic-work-subject',previousDate.toISOString().slice(0,10));
  await pool.query("update timesheet_entries set project_id=null,work_type='Client Misc Task' where timesheet_id=$1",[pmSheet.id]);
  const pmBefore=await snapshot();
  assert.equal((await decide(pmSheet,{...ids.reader,role:'ProjectManager'})).status,403,'Direct project manager cannot substitute another allocated project for actual work');
  assert.equal((await decide(pmSheet,{...ids.denied,role:'ProjectManager'})).status,403,'Delegated project manager needs authority over actual work project');
  assert.deepEqual(await snapshot(),pmBefore);
  await pool.query("update timesheet_entries set project_id=$2,work_type='Project Work' where timesheet_id=$1",[pmSheet.id,f.projectId]);
  assert.equal((await decide(pmSheet,{...ids.denied,role:'ProjectManager'})).status,200,'Current project authority permits legitimate delegated project work');

 });
});
console.log('Legacy delegated timesheet permission revocation, owner self-decision denial, unchanged evidence and legitimate restored authority passed.');
