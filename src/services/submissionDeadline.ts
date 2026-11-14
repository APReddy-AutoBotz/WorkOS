export type SubmissionTiming={version:'submission-deadline/1';policyId:string;periodId:string;periodCode:string;timezone:'UTC';checkedAt:string;deadlineAt:string;graceEndsAt:string;lateTreatment:'warn'|'block';state:'before-deadline'|'grace'|'overdue'};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const instant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&/(Z|[+-]\d{2}:\d{2})$/.test(v)&&!Number.isNaN(Date.parse(v));
export const normalizeSubmissionTiming=(value:unknown):SubmissionTiming[]|undefined=>{
 if(!Array.isArray(value))return undefined;const result:SubmissionTiming[]=[],seen=new Set();
 for(const v of value){if(!object(v)||v.version!=='submission-deadline/1'||v.timezone!=='UTC'||!['policyId','periodId','periodCode'].every(key=>typeof v[key]==='string'&&v[key])||(v.lateTreatment!=='warn'&&v.lateTreatment!=='block')||(v.state!=='before-deadline'&&v.state!=='grace'&&v.state!=='overdue')||!instant(v.checkedAt)||!instant(v.deadlineAt)||!instant(v.graceEndsAt)||Date.parse(v.graceEndsAt)<Date.parse(v.deadlineAt)||seen.has(v.periodId))return undefined;seen.add(v.periodId);result.push({version:v.version,policyId:v.policyId,periodId:v.periodId,periodCode:v.periodCode,timezone:'UTC',checkedAt:v.checkedAt,deadlineAt:v.deadlineAt,graceEndsAt:v.graceEndsAt,lateTreatment:v.lateTreatment,state:v.state} as SubmissionTiming);}return result;
};
export type ImportSubmissionTiming={employeeId:string;weekEnding:string;checks:SubmissionTiming[]};
export const normalizeImportSubmissionTiming=(value:unknown):ImportSubmissionTiming[]|undefined=>{
 if(!Array.isArray(value))return undefined;const groups:ImportSubmissionTiming[]=[],seen=new Set();for(const v of value){if(!object(v)||typeof v.employeeId!=='string'||!v.employeeId||typeof v.weekEnding!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.weekEnding)||Number.isNaN(Date.parse(v.weekEnding+'T00:00:00Z'))||new Date(v.weekEnding+'T00:00:00Z').toISOString().slice(0,10)!==v.weekEnding)return undefined;const checks=normalizeSubmissionTiming(v.checks),key=JSON.stringify([v.employeeId,v.weekEnding]);if(!checks||seen.has(key))return undefined;seen.add(key);groups.push({employeeId:v.employeeId,weekEnding:v.weekEnding,checks});}return groups;
};
export const importSubmissionTimingNotice=(groups:ImportSubmissionTiming[]|undefined)=>{
 const count=groups?.flatMap(group=>group.checks).filter(check=>check.state==='overdue').length||0;return count?` Submission timing: ${count} overdue period checks. Draft work is retained; Submitted work follows the configured warn/block treatment.`:'';
};
