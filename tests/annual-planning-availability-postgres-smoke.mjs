import assert from 'node:assert/strict';
import {commercialFixture as f, migrateCommercialDatabase, withCommercialApi, withCommercialDatabase} from './support/commercial-drafting-test.mjs';
import {actualCapacityDefinition, seedActualWork} from './support/actual-work-test.mjs';

await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  const {identities}=await seedActualWork(pool);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Employee','allocations.view',true) on conflict(role_name,permission_key) do update set enabled=true");
  await withCommercialApi({databaseUrl,identities,timeZone:'Pacific/Kiritimati'},async ({request})=>{
    const release=await request('/api/v1/organization-setup/module-releases/planning',{method:'PUT',body:{
      enabled:true,expectedRevision:0,evidence:'Synthetic annual planning validation'
    }});
    assert.equal(release.status,201,JSON.stringify(release.body));
    const report=async (year,identity=identities.reader)=>{
      const response=await request('/api/reports/resource-planning?date='+year+'-06-01',{identity});
      assert.equal(response.status,200,JSON.stringify(response.body));
      return response.body;
    };
    const before=await report(2032);
    assert.deepEqual(before.rows.map(row=>row.employee_id),[f.ownerId]);
    assert.equal(before.rows[0].availability_hours,null);
    assert.equal(before.summary.averageAvailabilityAdjustedCapacity,null);
    const profile=await request('/api/v1/worker-capacity/workers/'+f.ownerId+'/profiles',{method:'POST',body:{
      expectedLatestId:null,effectiveFrom:'2031-01-01',definition:actualCapacityDefinition,reason:'Synthetic full-year schedule'
    }});
    assert.equal(profile.status,201,JSON.stringify(profile.body));
    await pool.query(`insert into working_calendar_holidays(id,organization_id,calendar_id,holiday_date,label,holiday_type,active,effective_from)
      values('synthetic-annual-holiday',$1,$2,'2032-01-01','Synthetic holiday','Company',true,'2031-01-01')`,
      [f.organizationId,actualCapacityDefinition.calendarOverrideId]);
    await pool.query(`insert into leave_requests(id,employee_id,leave_type_id,start_date,end_date,total_days,status,reason)
      values('synthetic-year-crossing',$1,'leave-type-annual','2031-12-31','2032-01-02',3,'Approved','Synthetic leave')`,[f.ownerId]);
    for(const [year,days,holidays] of [[2031,365,0],[2032,366,1]]){
      const result=await report(year);
      const row=result.rows[0], hours=(days-holidays-1)*8;
      assert.equal(row.availability_hours,hours);
      assert.equal(row.approved_leave_days,1);
      assert.equal(row.holiday_days,holidays);
      assert.equal(result.summary.averageAvailabilityAdjustedCapacity,Math.round(1000*hours/(days*8))/10);
    }
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,status,primary_country_director_id,organization_id,legal_entity_id)
      values('annual-unconfigured','SYN-ANNUAL-2','Synthetic planner colleague','annual-2@example.test','Consultant','Planning','US','Active','director-commercial',$1,$2)`,
      [f.organizationId,f.legalEntityId]);
    const portfolio=await report(2032,identities.manager);
    assert.equal(portfolio.rows.find(row=>row.employee_id===f.ownerId).availability_hours,2912);
    assert.equal(portfolio.rows.find(row=>row.employee_id==='annual-unconfigured').availability_hours,null);
    assert.equal(portfolio.summary.averageAvailabilityAdjustedCapacity,null);
    const command=await request('/api/reports/workforce-command-center');
    assert.equal(command.status,200);
    assert.equal(command.body.leaveAdjustedAvailabilityHours,null);
    const followingProfile=await request('/api/v1/worker-capacity/workers/'+f.ownerId+'/profiles',{method:'POST',body:{
      expectedLatestId:profile.body.version.id,effectiveFrom:'2032-07-01',
      definition:{...actualCapacityDefinition,partTimePercentExact:'50',hoursByWeekdayExact:Array(7).fill('4')},
      reason:'Synthetic midyear part-time change'
    }});
    assert.equal(followingProfile.status,201,JSON.stringify(followingProfile.body));
    const partTime=await report(2032);
    assert.equal(partTime.rows[0].availability_hours,182*8+184*4-16);
    await pool.query(`insert into leave_requests(id,employee_id,leave_type_id,start_date,end_date,total_days,status,reason)
      values('synthetic-ambiguous-annual',$1,'leave-type-annual','2032-02-01','2032-02-03',0.5,'Approved','Synthetic legacy partial leave')`,[f.ownerId]);
    const unresolved=await report(2032);
    assert.equal(unresolved.rows[0].availability_hours,null);
    assert.equal(unresolved.summary.averageAvailabilityAdjustedCapacity,null);
  });
});
console.log('Annual planning capacity passed scoped worker, leap year, year crossing, holiday overlap and unavailable evidence checks.');
