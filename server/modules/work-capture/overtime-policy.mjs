import {z} from 'zod';
import {canonicalHours,compareHours,decimalQuantity,sumHours} from './work-hours.mjs';
import {WorkPolicyError} from './assignment-work-policy.mjs';
const threshold=max=>z.union([z.string(),z.number()]).transform((value,context)=>{
 try{const quantity=decimalQuantity(value);if(quantity.scale>4||quantity.units===0n||compareHours(value,max)>0)throw Error();return canonicalHours(value);}
 catch{context.addIssue({code:'custom',message:'Use a positive standard threshold within the supported range and four decimal places.'});return z.NEVER;}
});
export const overtimeInput=z.object({action:z.enum(['warn','block']),dailyThreshold:threshold('24').nullable(),weeklyThreshold:threshold('168').nullable()}).strict()
 .refine(value=>value.dailyThreshold!==null||value.weeklyThreshold!==null,'Select at least one standard threshold.');
export const overtimeRule=value=>{
 if(value==null)return null;
 if(value.action==='off'){if(value.dailyThreshold!==null||value.weeklyThreshold!==null||Object.keys(value).sort().join(',')!=='action,dailyThreshold,weeklyThreshold')throw new TypeError('Invalid off rule');return null;}
 return overtimeInput.parse(value);
};
export const OVERTIME_OFF={action:'off',dailyThreshold:null,weeklyThreshold:null};
export const evaluateOvertime=(weeks,policies,entries,targetEntries=entries)=>{
 const warnings=[];
 for(const week of weeks){
  const all=entries.filter(entry=>entry.work_date>=week.starts_on&&entry.work_date<=week.ends_on),targets=targetEntries.filter(entry=>entry.work_date>=week.starts_on&&entry.work_date<=week.ends_on);
  const weeklyTotal=sumHours(all.map(entry=>entry.hours)),weeklySeen=new Set();
  for(const date of [...new Set(targets.map(entry=>entry.work_date))].sort()){
   const policy=[...policies].reverse().find(row=>row.effective_from<=date),rule=overtimeRule(policy?.overtime_rule);if(!rule)continue;
   const base={version:'overtime-capture/1',policyId:policy.id,action:rule.action,periodCode:week.code};
   const daily=sumHours(all.filter(entry=>entry.work_date===date).map(entry=>entry.hours));
   if(rule.dailyThreshold!==null&&compareHours(daily,rule.dailyThreshold)>0)warnings.push({...base,kind:'daily',workDate:date,threshold:rule.dailyThreshold});
   if(rule.weeklyThreshold!==null&&compareHours(weeklyTotal,rule.weeklyThreshold)>0&&!weeklySeen.has(policy.id)){
    warnings.push({...base,kind:'weekly',workDate:null,threshold:rule.weeklyThreshold});weeklySeen.add(policy.id);
   }
  }
 }return warnings;
};
export const assertOvertimeAllowed=warnings=>{
 if(warnings.some(warning=>warning.action==='block'))throw new WorkPolicyError('WORK_CAPTURE_OVERTIME_BLOCKED','Recorded work exceeds a buyer-selected overtime threshold configured to block capture.');
};
// One scoped batch load per source kind, not a separate query for every header.
// The caller holds the existing scope/work locks throughout import validation.
export const prospectiveImportOvertimeWarnings=async(client,req,groups)=>{
 if(!groups.length)return [];
 const dates=groups.flatMap(group=>group.entries.map(entry=>entry.work_date)).sort(),scope=[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
 const policies=(await client.query('select id,effective_from::text,overtime_rule from work_capture_policy_versions where organization_id=$1 and legal_entity_id=$2 and effective_from<=$3::date order by effective_from',[...scope,dates.at(-1)])).rows;
 if(!policies.some(policy=>overtimeRule(policy.overtime_rule)))return [];
 const weeks=(await client.query("select id,code,starts_on::text,ends_on::text from reporting_periods where organization_id=$1 and legal_entity_id=$2 and frequency='Weekly' and starts_on<=$4::date and ends_on>=$3::date order by starts_on",[...scope,dates[0],dates.at(-1)])).rows;
 const starts=weeks.map(week=>week.starts_on).sort()[0],ends=weeks.map(week=>week.ends_on).sort().at(-1),workers=[...new Set(groups.map(group=>group.employeeId))],excluded=groups.map(group=>group.timesheetId).filter(Boolean);
 const stored=(await client.query(`select t.employee_id,e.work_date::text,e.hours::text from timesheet_entries e join timesheets t on t.id=e.timesheet_id
  where t.organization_id=$1 and t.legal_entity_id=$2 and t.employee_id=any($3::text[]) and e.work_date between $4::date and $5::date and not(t.id=any($6::uuid[]))`,[...scope,workers,starts,ends,excluded])).rows;
 return groups.map(group=>{
  const entries=[...stored.filter(entry=>entry.employee_id===group.employeeId),...groups.filter(change=>change.employeeId===group.employeeId).flatMap(change=>change.entries)];
  return {employeeId:group.employeeId,weekEnding:group.weekEnding,warnings:evaluateOvertime(weeks,policies,entries,group.entries)};
 }).filter(group=>group.warnings.length);
};
