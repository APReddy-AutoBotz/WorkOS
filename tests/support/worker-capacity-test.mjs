import assert from 'node:assert/strict';
import {commercialFixture as f,seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities} from './commercial-drafting-test.mjs';
import {grantWorkPermissions} from './work-assignment-test.mjs';
import {shiftCapacityDate} from '../../shared/worker-capacity.mjs';
export const capacityDefinition={fullTimeWeeklyHoursExact:'40',partTimePercentExact:'50',hoursByWeekdayExact:['0','2','6','4','4','4','0'],utilizationEligible:true,workerGroupId:null,calendarOverrideId:null};
export const seedCapacity=async pool=>{
 await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);const identities=await seedCommercialIdentities(pool);await grantWorkPermissions(pool);
 await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','employees.manage',true),('Admin','leave.self_service',true),('Admin','leave.approve',true),('Employee','employees.view',true) on conflict(role_name,permission_key) do update set enabled=true");
 identities.reader.employeeRecordId=f.ownerId;identities.reader.employeeId='SYNTHETIC-COMMERCIAL-LOCAL';await pool.query('update users set employee_record_id=$1,employee_id=$2 where id=$3',[f.ownerId,identities.reader.employeeId,identities.reader.id]);
 const today=(await pool.query("select to_char((clock_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d;let monday=shiftCapacityDate(today,14);while(new Date(monday+'T00:00:00Z').getUTCDay()!==1)monday=shiftCapacityDate(monday,1);
 const dates=Array.from({length:7},(_,i)=>shiftCapacityDate(monday,i));
 await pool.query("update projects set status='Active',start_date=$1::date-10,end_date=$1::date+400 where id=$2",[monday,f.projectId]);
 const calendarId='synthetic-capacity-calendar';await pool.query(`insert into working_calendars(id,organization_id,legal_entity_id,code,name,timezone,working_days,hours_per_day,effective_from,active,applicability_type) values($1,$2,$3,'SYNTHETIC-CAPACITY','Synthetic capacity calendar','America/New_York',array[1,2,3,4,5],8,'1970-01-01',true,'legal_entity')`,[calendarId,f.organizationId,f.legalEntityId]);
 await pool.query(`insert into working_calendar_holidays(id,organization_id,calendar_id,holiday_date,label,holiday_type,active,effective_from) values('synthetic-capacity-holiday',$1,$2,$3,'Synthetic calendar holiday','Company',true,'1970-01-01')`,[f.organizationId,calendarId,dates[2]]);
 return{identities,today,monday,dates,calendarId};
};
export const approveCapacityLeave=async(request,date)=>{
 const created=await request('/api/leave/requests',{method:'POST',body:{employee_id:f.ownerId,leave_type_id:'leave-type-annual',start_date:date,end_date:date,reason:'Synthetic private leave reason must not escape capacity'}});assert.equal(created.status,200,JSON.stringify(created.body));
 const decided=await request('/api/leave/requests/'+created.body.id+'/status',{method:'PATCH',body:{status:'Approved',comments:'Synthetic existing approval command'}});assert.equal(decided.status,200,JSON.stringify(decided.body));return created.body.id;
};
export const insertLegacyCapacityLeave=(pool,id,start,end,amount,status='Approved')=>pool.query(`insert into leave_requests(id,employee_id,leave_type_id,start_date,end_date,total_days,status,reason) values($1,$2,'leave-type-annual',$3,$4,$5,$6,'Synthetic private legacy reason')`,[id,f.ownerId,start,end,amount,status]);
