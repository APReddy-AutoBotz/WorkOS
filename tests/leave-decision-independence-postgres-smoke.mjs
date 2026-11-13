import assert from 'node:assert/strict';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval} from './support/work-approval-test.mjs';
import {adoptActualInputs} from './support/actual-work-test.mjs';

await withCommercialDatabase(async ({pool,databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  const fx=await seedWorkApproval(pool), {identities:ids,today}=fx;
  const hr={...ids.reader,role:'HR'};
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='HR' on conflict do nothing",[hr.id]);
  const snapshot=async()=>Object.fromEntries(await Promise.all([
    'leave_requests','leave_balances','approval_records','audit_logs','notification_events','notification_delivery_attempts',
  ].map(async table=>[table,(await pool.query(`select to_jsonb(t) v from ${table} t order by to_jsonb(t)::text`)).rows])));
  await withCommercialApi({databaseUrl,identities:ids},async ({request}) => {
    await adoptActualInputs(request,today);
    const create=async(identity,employeeId=hr.employeeRecordId)=>{
      const quote=await request(`/api/v1/leave-calendar/workers/${employeeId}/period?startsOn=${today}&endsOn=${today}`,{identity});
      assert.equal(quote.status,200,JSON.stringify(quote.body));
      const created=await request('/api/leave/requests',{identity,method:'POST',body:{employee_id:employeeId,leave_type_id:'leave-type-annual',start_date:today,end_date:today,expected_calendar_token:quote.body.quote.sourceToken,reason:'Synthetic independent leave decision'}});
      assert.equal(created.status,200,JSON.stringify(created.body));
      assert.equal(created.body.status,'Submitted');return created.body;
    };
    const decide=(leave,identity,status)=>request(`/api/leave/requests/${leave.id}/status`,{identity,method:'PATCH',body:{status,comments:'Synthetic decision'}});
    const generic=async(leave,identity,status,scope=f)=>{
      const approval=(await pool.query("select id from approval_records where entity_type='LeaveRequest' and entity_id=$1",[leave.id])).rows[0];
      return request(`/api/approvals/${approval.id}/status`,{identity,scope,method:'PATCH',body:{status,comments:'Synthetic generic decision'}});
    };
    const own=await create(hr),before=await snapshot();
    for(const status of ['Approved','Rejected']) {
      const denied=await decide(own,hr,status);
      assert.equal(denied.status,403,JSON.stringify(denied.body));
      assert.equal(denied.body.code,'LEAVE_APPROVAL_SELF_DECISION');
      assert.deepEqual(await snapshot(),before,'denial must not mutate source, balance, approval, audit or notifications');
    }
    const forgedClaims={...hr,employeeRecordId:ids.first.employeeRecordId,employeeId:ids.first.employeeId};
    assert.equal((await decide(own,forgedClaims,'Approved')).status,403,'current database linkage must defeat stale worker claims');
    assert.equal((await generic(own,forgedClaims,'Approved')).status,403,'generic approval must also resolve authoritative worker linkage');
    assert.deepEqual(await snapshot(),before);
    assert.equal((await decide(own,ids.manager,'Approved')).status,200,'independent scoped approver retains authority');
    assert.equal((await decide(own,hr,'Cancelled')).status,200,'owner cancellation is not self-approval');
    const onBehalf=await create(ids.manager),beforeOnBehalf=await snapshot();
    assert.equal((await decide(onBehalf,ids.manager,'Approved')).status,403,'recorded submitter cannot approve on behalf of another worker');
    assert.equal((await generic(onBehalf,ids.manager,'Approved')).status,403,'generic approval must retain submitter independence');
    assert.equal((await decide(onBehalf,hr,'Approved')).status,403,'affected worker cannot approve another actor’s submission');
    assert.deepEqual(await snapshot(),beforeOnBehalf);
    await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',[ids.second.id,f.organizationId,f.otherLegalEntityId]);
    assert.equal((await generic(onBehalf,ids.second,'Rejected',{...f,legalEntityId:f.otherLegalEntityId})).status,403,
      'an authorized different legal-entity selection must not authorize this leave');
    assert.deepEqual(await snapshot(),beforeOnBehalf);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='leave.approve'");
    assert.equal((await generic(onBehalf,ids.second,'Approved')).status,403,'generic route requires the actual domain decision permission');
    await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='leave.approve'");
    assert.equal((await generic(onBehalf,ids.second,'Approved')).status,200,'another independent scoped approver can decide through the generic route');
    const row=(await pool.query('select status,approver_id from leave_requests where id=$1',[onBehalf.id])).rows[0];
    assert.equal(row.status,'Approved');assert.equal(row.approver_id,ids.second.id);
  });
});
console.log('Independent legacy leave decisions passed: own/submitter rejection, authoritative linkage, unchanged protected state, independent approval and owner cancellation.');
