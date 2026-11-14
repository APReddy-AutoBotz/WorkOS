import {createHash} from 'node:crypto';
import {canonicalHours} from './work-hours.mjs';

export const DUPLICATE_ENTRY_VERSION='exact-entry-content/1';
const optionalText=value=>value===undefined||value===null||value===''?null:value;
const fields=['project_id','client_name','category','remark','evidence_url','work_reference'];

// Diagnostics only, within this header. Compare complete canonical content;
// hashes are group labels, never equality, identity or authorization authority.
export const checkDuplicateEntries=entries=>{
 if(!Array.isArray(entries))return null;
 const grouped=new Map(),ids=new Set();
 for(const entry of entries){
  if(!entry||typeof entry.id!=='string'||!entry.id||ids.has(entry.id)
    ||!['Project Work','Client Misc Task'].includes(entry.work_type)||typeof entry.billable!=='boolean'
    ||fields.some(field=>optionalText(entry[field])!==null&&typeof entry[field]!=='string'))return null;
  ids.add(entry.id);
  let workDate,hoursExact;
  try{
   workDate=entry.work_date instanceof Date?entry.work_date.toISOString().slice(0,10):String(entry.work_date).slice(0,10);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(workDate)||new Date(`${workDate}T00:00:00Z`).toISOString().slice(0,10)!==workDate)return null;
   hoursExact=canonicalHours(entry.hours_exact??entry.hours);
  }catch{return null;}
  const content=JSON.stringify([workDate,entry.work_type,optionalText(entry.project_id),optionalText(entry.client_name),optionalText(entry.category),hoursExact,entry.billable,
   optionalText(entry.remark),optionalText(entry.evidence_url),optionalText(entry.work_reference)]);
  let group=grouped.get(content);
  if(!group){group={key:createHash('sha256').update(content).digest('hex'),entryIds:[],workDate,hoursExact,
   workType:entry.work_type,projectId:optionalText(entry.project_id),clientName:optionalText(entry.client_name),category:optionalText(entry.category)};grouped.set(content,group);}
  group.entryIds.push(entry.id);
 }
 return {version:DUPLICATE_ENTRY_VERSION,groups:[...grouped.values()].filter(group=>group.entryIds.length>1)
  .map(group=>({...group,entryIds:[...group.entryIds].sort()})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)};
};
export const duplicateCheckSummary=check=>check?{version:check.version,groupCount:check.groups.length}:null;
export const projectTimesheetDuplicateCheck=row=>({...row,duplicate_entry_check:checkDuplicateEntries(row.entries)});
export const readDuplicateEntryCheck=async(client,timesheetId)=>timesheetId
 ?checkDuplicateEntries((await client.query('select *,work_date::text,hours::text from timesheet_entries where timesheet_id=$1 order by id',[timesheetId])).rows)
 :null;
