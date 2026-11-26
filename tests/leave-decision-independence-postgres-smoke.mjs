import assert from 'node:assert/strict';
import {withCommercialDatabase, migrateCommercialDatabase, seedCommercialReferences, seedCommercialIdentities, withCommercialApi, commercialFixture as f} from './support/commercial-drafting-test.mjs';

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  await seedCommercialReferences(pool);
  const identities = await seedCommercialIdentities(pool);
  const owner = {...identities.manager, employeeRecordId:f.ownerId, employeeId:'SYNTHETIC-COMMERCIAL-LOCAL'};
  await pool.query('update users set employee_record_id=$2,employee_id=$3 where id=$1',[owner.id,owner.employeeRecordId,owner.employeeId]);
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'",[identities.reader.id]);
  const independent = {...identities.reader,role:'Admin'};
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'",[identities.denied.id]);
  const third = {...identities.denied,role:'Admin'};
  const snapshot = async () => Object.fromEntries(await Promise.all(['leave_requests','leave_balances','approval_records','audit_logs','notification_events','teams_action_tokens','integration_event_logs'].map(async t=>[t,(await pool.query(`select to_jsonb(t) value from ${t} t order by to_jsonb(t)::text`)).rows])));
  await withCommercialApi({enableLeave:true, databaseUrl,identities},async ({request})=>{
    const enabled = await request('/api/organization-setup/module-releases/teams',{method:'PUT',body:{enabled:true,evidence:'Synthetic Teams leave boundary check',expectedRevision:0}});
    assert.equal(enabled.status,201,JSON.stringify(enabled.body));
    const create = async (actor=owner) => {
      const result=await request('/api/leave/requests',{identity:actor,method:'POST',body:{employee_id:f.ownerId,leave_type_id:'leave-type-unpaid',start_date:'2026-11-16',end_date:'2026-11-16',reason:'Synthetic independence test'}});
      assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
    };
    const decide=(leave,actor,status='Approved')=>request(`/api/leave/requests/${leave.id}/status`,{identity:actor,method:'PATCH',body:{status,comments:'Synthetic decision'}});
    const approvalFor=async leave=>(await pool.query("select * from approval_records where entity_type='LeaveRequest' and entity_id=$1",[leave.id])).rows[0];
    const generic=async(leave,actor,status='Approved',scope=f)=>request(`/api/approvals/${(await approvalFor(leave)).id}/status`,{identity:actor,scope,method:'PATCH',body:{status,comments:'Synthetic decision'}});
    const own=await create(),before=await snapshot();
    for(const status of ['Approved','Rejected']) {
      assert.equal((await decide(own,owner,status)).status,403,'affected worker cannot decide own leave');
      assert.deepEqual(await snapshot(),before);
      assert.equal((await generic(own,owner,status)).status,403);
      assert.deepEqual(await snapshot(),before);
    }
    const stale={...owner,employeeRecordId:f.otherOwnerId,employeeId:'SYNTHETIC-COMMERCIAL-OTHER'};
    assert.equal((await decide(own,stale)).status,403);
    assert.equal((await generic(own,stale)).status,403);
    assert.deepEqual(await snapshot(),before);
    const approval=await approvalFor(own);
    await pool.query(`insert into teams_action_tokens(token,entity_type,entity_id,action,expires_at,organization_id,legal_entity_id) values('synthetic-leave-action','ApprovalRecord',$1,'approve',now()+interval '1 hour',$2,$3)`,[approval.id,f.organizationId,f.legalEntityId]);
    const beforeTeams=await snapshot();
    const teams=await request('/api/integrations/teams-action-tokens/synthetic-leave-action/execute',{identity:owner,method:'POST',body:{}});
    assert.equal(teams.status,409,JSON.stringify(teams.body));
    assert.equal(teams.body.code,'LEAVE_SOURCE_DECISION_REQUIRED');
    assert.deepEqual(await snapshot(),beforeTeams);
    assert.equal((await generic(own,independent)).status,200,'independent scoped approver remains valid');
    assert.equal((await decide(own,owner,'Cancelled')).status,200,'owner cancellation remains valid');
    const behalf=await create(independent),beforeBehalf=await snapshot();
    assert.equal((await decide(behalf,independent)).status,403,'on-behalf submitter cannot decide');
    assert.equal((await generic(behalf,independent)).status,403);
    assert.equal((await decide(behalf,owner)).status,403,'affected worker cannot decide on-behalf request');
    assert.deepEqual(await snapshot(),beforeBehalf);
    await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',[third.id,f.organizationId,f.otherLegalEntityId]);
    assert.equal((await generic(behalf,third,'Approved',{...f,legalEntityId:f.otherLegalEntityId})).status,403);
    assert.deepEqual(await snapshot(),beforeBehalf);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='leave.approve'");
    assert.equal((await generic(behalf,third)).status,403,'view permission cannot grant decision authority');
    await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='leave.approve'");
    assert.deepEqual(await snapshot(),beforeBehalf);
    const concurrent=await Promise.all([generic(behalf,third),generic(behalf,third)]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,422],'only one concurrent decision commits');
    assert.equal((await decide(behalf,owner,'Cancelled')).status,200);
    // Historical source rows without attributable submission evidence cannot prove independence.
    const historical=(await pool.query(`insert into leave_requests(employee_id,leave_type_id,start_date,end_date,total_days,status)
      values($1,'leave-type-unpaid','2026-11-17','2026-11-17',1,'Submitted') returning *`,[f.ownerId])).rows[0];
    const beforeHistorical=await snapshot();
    const unknown=await decide(historical,third);
    assert.equal(unknown.status,409);assert.equal(unknown.body.code,'LEAVE_SUBMITTER_UNCONFIRMED');
    assert.deepEqual(await snapshot(),beforeHistorical);
    assert.equal((await decide(historical,owner,'Cancelled')).status,200,'historical cancellation remains possible');
    for (const [identity,id,code] of [[third,'synthetic-leave-lead-a','SYNTHETIC-LEAD-A'],[independent,'synthetic-leave-lead-b','SYNTHETIC-LEAD-B']]) {
      await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,status,organization_id,legal_entity_id,primary_country_director_id)
        values($1,$2,'Synthetic team lead',$2||'@example.test','Lead','Delivery','US','Active',$3,$4,'director-commercial')`,[id,code,f.organizationId,f.legalEntityId]);
      await pool.query('update users set employee_record_id=$2,employee_id=$3 where id=$1',[identity.id,id,code]);
      await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='TeamLead' on conflict do nothing",[identity.id]);
    }
    await pool.query("update employees set reporting_manager_id='synthetic-leave-lead-a' where id=$1",[f.ownerId]);
    await pool.query(`insert into approval_delegations(id,delegator_id,delegate_id,role,start_date,end_date,status)
      values('synthetic-leave-delegation','synthetic-leave-lead-a','synthetic-leave-lead-b','TeamLead',current_date-1,current_date+1,'Active')`);
    const delegated=await create();
    const delegate={...independent,role:'TeamLead',employeeRecordId:'synthetic-leave-lead-b',employeeId:'SYNTHETIC-LEAD-B'};
    const beforeDelegation=await snapshot();
    for (const change of [
      ["update approval_delegations set status='Inactive' where id='synthetic-leave-delegation'","update approval_delegations set status='Active' where id='synthetic-leave-delegation'"],
      ["update approval_delegations set role='HR' where id='synthetic-leave-delegation'","update approval_delegations set role='TeamLead' where id='synthetic-leave-delegation'"],
      ["update approval_delegations set start_date=current_date-3,end_date=current_date-1 where id='synthetic-leave-delegation'","update approval_delegations set end_date=current_date+1 where id='synthetic-leave-delegation'"],
      [`update users set status='Disabled' where id='${third.id}'`,`update users set status='Active' where id='${third.id}'`],
      [`delete from user_roles where user_id='${third.id}' and role_id=(select id from roles where name='TeamLead')`,`insert into user_roles(user_id,role_id) select '${third.id}',id from roles where name='TeamLead'`],
    ]) {
      await pool.query(change[0]);
      assert.equal((await generic(delegated,delegate)).status,403,'stale or mismatched delegated authority must be denied');
      assert.deepEqual(await snapshot(),beforeDelegation);
      await pool.query(change[1]);
    }
    assert.equal((await generic(delegated,delegate)).status,200,'current valid delegation preserves independent decision authority');
    assert.equal((await decide(delegated,owner,'Cancelled')).status,200);
    const delegatorSubmitted=await create(third),beforeDelegatorSubmitted=await snapshot();
    assert.equal((await generic(delegatorSubmitted,delegate)).status,403,'delegation cannot pass on forbidden submitter authority');
    assert.deepEqual(await snapshot(),beforeDelegatorSubmitted);
    assert.equal((await decide(delegatorSubmitted,owner,'Cancelled')).status,200);
    await pool.query("insert into roles(name)values('ProjectManager') on conflict do nothing");
    for (const id of [third.id,independent.id]) await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='ProjectManager' on conflict do nothing",[id]);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('ProjectManager','approvals.view',true),('ProjectManager','leave.approve',true) on conflict(role_name,permission_key) do update set enabled=true");
    await pool.query("update approval_delegations set role='ProjectManager' where id='synthetic-leave-delegation'");
    const projectLeave=await create(),beforeProjectScope=await snapshot();
    const projectDelegate={...delegate,role:'ProjectManager'};
    const projectDelegator={...third,role:'ProjectManager',employeeRecordId:'synthetic-leave-lead-a',employeeId:'SYNTHETIC-LEAD-A'};
    assert.equal((await decide(projectLeave,projectDelegator)).status,403,'direct-report relation does not confer ProjectManager scope');
    assert.equal((await generic(projectLeave,projectDelegate)).status,403,'delegation cannot exceed delegator project scope');
    assert.deepEqual(await snapshot(),beforeProjectScope);
    await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,start_date,end_date,status,organization_id,legal_entity_id)
      values('synthetic-leave-project','SYNTHETIC-LEAVE-PROJECT','Synthetic delegated project',$1,'Synthetic client','synthetic-leave-lead-a','Synthetic lead','2026-01-01','2026-12-31','Active',$2,$3)`,[f.clientId,f.organizationId,f.legalEntityId]);
    await pool.query(`insert into project_allocations(employee_id,project_id,percentage,start_date,end_date,status,organization_id,legal_entity_id)
      values($1,'synthetic-leave-project',10,'2026-01-01','2026-12-31','Active',$2,$3)`,[f.ownerId,f.organizationId,f.legalEntityId]);
    assert.equal((await generic(projectLeave,projectDelegate)).status,200,'delegation retains actual ProjectManager worker authority');
    assert.equal((await decide(projectLeave,owner,'Cancelled')).status,200);
    for (const id of [third.id,independent.id]) await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='CountryDirector' on conflict do nothing",[id]);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('CountryDirector','approvals.view',true),('CountryDirector','leave.approve',true) on conflict(role_name,permission_key) do update set enabled=true");
    await pool.query("update approval_delegations set role='CountryDirector' where id='synthetic-leave-delegation'");
    const directorLeave=await create(),beforeDirector=await snapshot();
    const directorDelegator={...projectDelegator,role:'CountryDirector',countryDirectorId:'director-commercial'};
    const directorDelegate={...delegate,role:'CountryDirector',countryDirectorId:'director-commercial'};
    assert.equal((await decide(directorLeave,directorDelegator)).status,403,'assigned role and primary director do not confer director qualification');
    assert.equal((await generic(directorLeave,directorDelegate)).status,403,'delegation cannot bypass delegator director qualification');
    assert.deepEqual(await snapshot(),beforeDirector);
    await pool.query("update employees set designation='Country Director',primary_country_director_id='director-commercial' where id='synthetic-leave-lead-a'");
    assert.equal((await generic(directorLeave,directorDelegate)).status,200,'qualified delegator retains independent delegated authority');
    assert.equal((await decide(directorLeave,owner,'Cancelled')).status,200);
    const conflicting=await create();
    await pool.query(`insert into audit_logs(user_id,user_name,user_role,details,active_role,module,action,entity_type,entity_id,organization_id,legal_entity_id)
      values($1,'Synthetic submitter','Admin','Synthetic conflicting provenance','Admin','Leave','Submit Leave','LeaveRequest',$2,$3,$4)`,[independent.id,conflicting.id,f.organizationId,f.legalEntityId]);
    const beforeConflict=await snapshot();
    assert.equal((await generic(conflicting,third)).status,409);
    assert.deepEqual(await snapshot(),beforeConflict);
  });
});
console.log('Leave decision independence PostgreSQL/API checks passed.');
