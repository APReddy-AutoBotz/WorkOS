import assert from 'node:assert/strict';
import {commercialFixture as f} from './commercial-drafting-test.mjs';
export const workPermissions=['allocations.manage','allocations.view','timesheets.submit','timesheets.approve','approvals.view','employees.view','projects.view','clients.view','imports.manage','settings.manage','audit.view','reports.export'];
export const grantWorkPermissions=pool=>pool.query(`insert into role_permissions(role_name,permission_key,enabled) select 'Admin',key,true from unnest($1::text[]) key on conflict(role_name,permission_key) do update set enabled=true`,[workPermissions]);
export const seedWorkPeriods=async(pool,today)=>{
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values('period-work-current',$1,$2,'SYN-WORK-CURRENT','Synthetic work period',$3::date-6,$3::date,'Open','Weekly'),
    ('period-work-previous',$1,$2,'SYN-WORK-PREVIOUS','Synthetic previous work period',$3::date-13,$3::date-7,'Open','Weekly')`,[f.organizationId,f.legalEntityId,today]);
};
export const workAllocation=(projectId,today,overrides={})=>({employee_id:f.ownerId,project_id:projectId,percentage:20,start_date:today,end_date:today,billable:true,status:'Active',...overrides});
export const workInput=(projectId,today,overrides={})=>({employee_id:f.ownerId,week_ending:today,status:'Submitted',entries:[{project_id:projectId,work_type:'Project Work',work_date:today,hours:2,remark:'Synthetic submitted work note',category:'Synthetic ordinary work',billable:true}],...overrides});
export const workSnapshot=async pool=>{
  const result={};for(const table of ['timesheets','timesheet_entries','work_submission_evidence','work_submission_decisions','project_allocations','approval_records'])result[table]=(await pool.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
  // Pre-133 allocation rows represent percentage assignments, with no fixed total.
  for (const {value} of result.project_allocations) {
    if (!Object.hasOwn(value, 'fixed_hours')) value.fixed_hours = null;
  }
  return result;
};
export const workPost=async(request,path,body,status=200)=>{
  const result=await request(path,{method:'POST',body});assert.equal(result.status,status,`${path}: ${JSON.stringify(result.body)}`);return result.body;
};
export const workImport=(row,overrides={})=>({fileName:'synthetic-work-policy.csv',rows:[row],schemaVersion:'timesheet-import/1',dryRun:false,...overrides});
export const workImportRow=(projectId,today,overrides={})=>({employeeId:f.ownerId,weekEnding:today,workType:'Project Work',...(projectId?{projectId}:{}),date:today,hours:2,status:'Submitted',remark:'Synthetic imported work note',...overrides});
