import {workSourceIdentityKey} from '../../shared/work-source-identity.mjs';
import {normalizeOvertimeWarnings} from './overtimeCapture';
import {normalizeDuplicateEntryCheck} from './duplicateEntryCheck';
import {authService} from './authService';
import {getEffectivePermissions} from './permissions';
import {api,ApiClientError,checkBackend,getOrganizationScope,getToken,normalizeProject,normalizeAllocation,
  normalizeTimesheetSummary,normalizeSettings,normalizeWorkAssurance,type ApiRequestContext} from './apiClient';
import {assertOrganizationProfileContext,type OrganizationProfileContext} from './organizationProfileScope';
import type {TimesheetEntry,TimesheetSummary} from '../types';
import {canonicalHours} from '../../shared/work-hours.mjs';

export type CaptureMode='weekly'|'daily';
export type WorkCaptureContext=ApiRequestContext & Readonly<{identityKey:string;isCurrent:()=>boolean}>;
const identityKey=()=>{const user=authService.getCurrentUser();return user&&JSON.stringify([user.id,user.employeeId,user.role,user.permissionRole,[...getEffectivePermissions(user)].sort()]);};
export const captureWorkCaptureContext=(isCurrent=()=>true):WorkCaptureContext|null=>{
  const scope=getOrganizationScope(),user=authService.getCurrentUser();
  if(!scope?.organizationId||!scope.legalEntityId||!user||!getEffectivePermissions(user).includes('timesheets.submit'))return null;
  return {scope:{...scope},token:getToken(),identityKey:identityKey()!,isCurrent};
};
export const isWorkCaptureContextCurrent=(context:WorkCaptureContext)=>{
  const current=captureWorkCaptureContext();return Boolean(context.isCurrent()&&current&&context.token===current.token
    &&context.identityKey===current.identityKey&&context.scope.organizationId===current.scope.organizationId&&context.scope.legalEntityId===current.scope.legalEntityId);
};
export const assertWorkCaptureContext=(context:WorkCaptureContext|null)=>{
  if(!context||!isWorkCaptureContextCurrent(context))throw new ApiClientError('Work access changed. Reload for the current scope.',{status:403});
  return context;
};
export type CaptureModesProjection={organizationId:string;legalEntityId:string;serverDate:string;latestId:string|null;enabledModes:CaptureMode[]};
export type CaptureModeVersion={id:string;sequence:number;policyVersion:'work-capture-modes/1';enabledModes:CaptureMode[];createdAt:string};
export type CaptureModesSettings={organizationId:string;legalEntityId:string;latestId:string|null;versions:CaptureModeVersion[];truncated:boolean};
export type CaptureModesDraft={expectedLatestId:string|null;enabledModes:CaptureMode[]};
const scopeMatches=(result:{organizationId:string;legalEntityId:string},owner:ApiRequestContext)=>{
  if(result.organizationId!==owner.scope.organizationId||result.legalEntityId!==owner.scope.legalEntityId)
    throw new ApiClientError('Work capture scope changed. Reload.',{status:403});
};
export const workCaptureModesSettingsService={
  get:async(context:OrganizationProfileContext|null):Promise<CaptureModesSettings>=>{
    const owner=assertOrganizationProfileContext(context);
    if(!await checkBackend())throw new ApiClientError('Capture modes require the server.',{status:503});
    assertOrganizationProfileContext(owner);
    const result=await api.requestWithContext<CaptureModesSettings>('GET','/api/v1/work-capture-modes/settings',undefined,owner);
    assertOrganizationProfileContext(owner);scopeMatches(result,owner);return result;
  },
  append:async(input:CaptureModesDraft,context:OrganizationProfileContext|null)=>{
    const owner=assertOrganizationProfileContext(context);
    const result=await api.requestWithContext<CaptureModeVersion>('POST','/api/v1/work-capture-modes/settings',
      {expectedLatestId:input.expectedLatestId,enabledModes:input.enabledModes},owner);
    assertOrganizationProfileContext(owner);return result;
  },
};
type CaptureEntry=Omit<TimesheetEntry,'hours'> & {hours:number|string};
export const workCaptureWorkspaceService={
  get:async(context:WorkCaptureContext|null)=>{
    const owner=assertWorkCaptureContext(context);
    if(!await checkBackend())throw new ApiClientError('Work capture requires the server.',{status:503});
    assertWorkCaptureContext(owner);
    const get=<T>(path:string)=>api.requestWithContext<T>('GET',path,undefined,owner);
    const [modes,rawProjects,rawAllocations,rawTimesheets]=await Promise.all([
      get<CaptureModesProjection>('/api/v1/work-capture-modes'),get<Record<string,unknown>[]>('/api/projects'),
      get<Record<string,unknown>[]>('/api/allocations'),get<Record<string,unknown>[]>('/api/timesheets')]);
    assertWorkCaptureContext(owner);scopeMatches(modes,owner);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(modes.serverDate)||!Array.isArray(modes.enabledModes)
      ||modes.enabledModes.some(mode=>!['weekly','daily'].includes(mode)))throw new ApiClientError('Capture mode response is invalid. Reload.',{status:503});
    const projects=rawProjects.map(normalizeProject),projectMap=new Map(projects.map(project=>[project.id,project]));
    const timesheets=rawTimesheets.map(row=>normalizeTimesheetSummary(row,new Map()));
    if(timesheets.some(row=>!row.writeToken||!/^[a-f0-9]{64}$/.test(row.writeToken)))throw new ApiClientError('Work revision is unavailable. Reload.',{status:503});
    return {modes,projects,allocations:rawAllocations.map(row=>normalizeAllocation(row,projectMap)),timesheets};
  },
  submissionSettings:async(context:WorkCaptureContext|null)=>{
    const owner=assertWorkCaptureContext(context);
    const rows=await api.requestWithContext<Array<{key:string;value:unknown}>>('GET','/api/settings',undefined,owner);
    assertWorkCaptureContext(owner);return normalizeSettings(rows);
  },
  save:async(input:{employeeId:string;weekEnding:string;status:'Draft'|'Submitted';entries:CaptureEntry[]},
    precondition:{writeToken:string|null;mode:CaptureMode;modePolicyId:string|null},context:WorkCaptureContext|null)=>{
    const owner=assertWorkCaptureContext(context);
    const result=await api.requestWithContext<Record<string,unknown>>('POST','/api/timesheets',{
      employee_id:input.employeeId,week_ending:input.weekEnding,status:input.status,
      expected_write_token:precondition.writeToken,capture_mode:precondition.mode,expected_mode_policy_id:precondition.modePolicyId,
      entries:input.entries.map(entry=>({project_id:entry.projectId||null,work_type:entry.workType,client_name:entry.clientName||null,
        category:entry.category||null,work_date:entry.date,hours:canonicalHours(entry.hoursExact??entry.hours),remark:entry.remark||null,billable:entry.billable,evidence_url:entry.evidenceUrl,work_reference:entry.workReference,source_identity:entry.sourceIdentity})),
    },owner);
    assertWorkCaptureContext(owner);
    if(typeof result.write_token!=='string'||!/^[a-f0-9]{64}$/.test(result.write_token))throw new ApiClientError('Save revision could not be confirmed. Reload work.',{status:503});
    const requestedKeys=input.entries.map(entry=>workSourceIdentityKey(entry.sourceIdentity)).filter(Boolean);
    if(requestedKeys.length){let acknowledged:Array<string|null>;try{acknowledged=Array.isArray(result.entries)?result.entries.map((entry:Record<string,unknown>)=>workSourceIdentityKey(entry.source_identity)).filter(Boolean):[];}catch{throw new ApiClientError('Source identity capture could not be confirmed. Reload work before retrying.',{status:503});}if(requestedKeys.length!==acknowledged.length||requestedKeys.some(key=>!acknowledged.includes(key)))throw new ApiClientError('Source identity capture could not be confirmed. Reload work before retrying.',{status:503});}
    return {captureWarnings:normalizeOvertimeWarnings(result.capture_warnings),timesheetId:typeof result.id==='string'?result.id:undefined,writeToken:result.write_token,workAssurance:normalizeWorkAssurance(result.work_assurance),duplicateEntryCheck:normalizeDuplicateEntryCheck(result.duplicate_entry_check)} as {captureWarnings:TimesheetSummary['captureWarnings'];timesheetId:string|undefined;duplicateEntryCheck:TimesheetSummary['duplicateEntryCheck'];writeToken:string;workAssurance:TimesheetSummary['workAssurance']};
  },
};
