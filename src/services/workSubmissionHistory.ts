import {readCategoryEntry} from '../../shared/work-category.mjs';
import {normalizeWorkSourceIdentity,workSourceIdentityIsValid} from '../../shared/work-source-identity.mjs';
import {normalizeSubmissionTiming,type SubmissionTiming} from './submissionDeadline';
import {api,ApiClientError} from './apiClient';
import {assertWorkCaptureContext,type WorkCaptureContext} from './workCaptureModes';
import {canonicalHours} from '../../shared/work-hours.mjs';
import {normalizeEvidenceUrl,evidenceUrlIsValid} from '../../shared/work-evidence.mjs';
import {workReferenceIsValid} from '../../shared/work-reference.mjs';
export type HistoricalWorkEntry={sourceIdentity?:import('../types').WorkSourceIdentity|null;entryId:string;projectId:string|null;categoryCode?:string|null;categoryReference?:import('../types').WorkCategoryReference|null;workType:import('../types').WorkType;workDate:string;hoursExact:string;billable:boolean;clientName:string|null;category:string|null;remark:string|null;evidenceUrl?:string|null;workReference?:string|null};
export type WorkHistorySubmission={submissionTiming?:SubmissionTiming[];id:string;sequence:number;createdAt:string;activeRole:string;source:string;entries:HistoricalWorkEntry[];decision:null|{status:'Approved'|'Rejected'|'Cancelled';reason:string|null;createdAt:string;activeRole:string;source:string}};
export type WorkHistoryPage={organizationId:string;legalEntityId:string;timesheetId:string;employeeId:string;weekEnding:string;submissions:WorkHistorySubmission[];nextBeforeSequence:number|null};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
const optionalText=(v:unknown)=>v===null||typeof v==='string';
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const instant=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&/(Z|[+-]\d{2}:\d{2})$/.test(v)&&!Number.isNaN(Date.parse(v));
const fail=():never=>{throw new ApiClientError('Retained work history response is invalid. Retry.',{status:503});};
export const decodeWorkHistoryPage=(value:unknown,before:number|null=null):WorkHistoryPage=>{
 if(!object(value)||!text(value.organizationId)||!text(value.legalEntityId)||!text(value.timesheetId)||!text(value.employeeId)||!date(value.weekEnding)
  ||!Array.isArray(value.submissions)||value.submissions.length>10)fail();
 const page=value as Record<string,unknown>,seen=new Set<string>();let previous=before??2147483648;
 const submissions=(page.submissions as unknown[]).map(raw=>{
  if(!object(raw)||!text(raw.id)||seen.has(raw.id)||!Number.isInteger(raw.sequence)||Number(raw.sequence)<1||Number(raw.sequence)>=previous||!instant(raw.createdAt)||!text(raw.activeRole)||!text(raw.source)||!Array.isArray(raw.entries)||raw.entries.length<1||raw.entries.length>100)fail();
  const row=raw as Record<string,unknown>;previous=Number(row.sequence);seen.add(row.id as string);const ids=new Set<string>();
  const entries=(row.entries as unknown[]).map(rawEntry=>{
   if(!object(rawEntry)||!text(rawEntry.entryId)||ids.has(rawEntry.entryId)||!optionalText(rawEntry.projectId)||!['Project Work','Client Misc Task','Non-client Work'].includes(String(rawEntry.workType))||!date(rawEntry.workDate)||typeof rawEntry.hoursExact!=='string'||typeof rawEntry.billable!=='boolean'||!['clientName','category','remark'].every(key=>optionalText(rawEntry[key])))fail();
   const entry=rawEntry as Record<string,unknown>;ids.add(entry.entryId as string);
   try{canonicalHours(entry.hoursExact as string);}catch{fail();}
   if(Object.hasOwn(entry,'evidenceUrl')&&(!optionalText(entry.evidenceUrl)||!evidenceUrlIsValid(entry.evidenceUrl)))fail();
   if(Object.hasOwn(entry,'sourceIdentity')&&!workSourceIdentityIsValid(entry.sourceIdentity))fail();
   if(Object.hasOwn(entry,'workReference')&&(!optionalText(entry.workReference)||!workReferenceIsValid(entry.workReference)))fail();
   let classification;try{classification=readCategoryEntry(entry.categoryCode,entry.categoryReference,entry.workType,entry.workDate,entry.billable,entry.category);}catch{fail();}
   return {...classification,entryId:entry.entryId,projectId:entry.projectId,workType:entry.workType,workDate:entry.workDate,hoursExact:canonicalHours(entry.hoursExact as string),billable:entry.billable,clientName:entry.clientName,category:entry.category,remark:entry.remark,
    ...(Object.hasOwn(entry,'evidenceUrl')?{evidenceUrl:normalizeEvidenceUrl(entry.evidenceUrl)}:{}),...(Object.hasOwn(entry,'workReference')?{workReference:entry.workReference}:{}),...(Object.hasOwn(entry,'sourceIdentity')?{sourceIdentity:normalizeWorkSourceIdentity(entry.sourceIdentity)}:{})} as HistoricalWorkEntry;
  });
  let decision:WorkHistorySubmission['decision']=null;
  if(row.decision!==null){const d=row.decision;if(!object(d)||!['Approved','Rejected','Cancelled'].includes(String(d.status))||!optionalText(d.reason)||!instant(d.createdAt)||!text(d.activeRole)||!text(d.source))fail();const decisionRow=d as Record<string,unknown>;decision={status:decisionRow.status,reason:decisionRow.reason,createdAt:decisionRow.createdAt,activeRole:decisionRow.activeRole,source:decisionRow.source} as WorkHistorySubmission['decision'];}
  if(row.submissionTiming!==undefined&&!normalizeSubmissionTiming(row.submissionTiming))fail();
  return {...(row.submissionTiming!==undefined?{submissionTiming:normalizeSubmissionTiming(row.submissionTiming)}:{}),id:row.id,sequence:row.sequence,createdAt:row.createdAt,activeRole:row.activeRole,source:row.source,entries,decision} as WorkHistorySubmission;
 });
 const next=page.nextBeforeSequence;if(next!==null&&(!Number.isInteger(next)||submissions.length!==10||next!==submissions.at(-1)?.sequence))fail();
 return {organizationId:page.organizationId,legalEntityId:page.legalEntityId,timesheetId:page.timesheetId,employeeId:page.employeeId,weekEnding:page.weekEnding,submissions,nextBeforeSequence:next} as WorkHistoryPage;
};
export const workSubmissionHistoryService={get:async(timesheetId:string,before:number|null,context:WorkCaptureContext|null,expectedEmployeeId?:string)=>{
 const owner=assertWorkCaptureContext(context);
 const raw=await api.requestWithContext<unknown>('GET',`/api/v1/timesheets/${encodeURIComponent(timesheetId)}/submissions${before===null?'':`?beforeSequence=${before}`}`,undefined,owner);
 assertWorkCaptureContext(owner);const page=decodeWorkHistoryPage(raw,before);
 if(page.organizationId!==owner.scope.organizationId||page.legalEntityId!==owner.scope.legalEntityId||page.timesheetId!==timesheetId||expectedEmployeeId&&page.employeeId!==expectedEmployeeId)throw new ApiClientError('Work history scope changed. Reload.',{status:403});return page;
}};
