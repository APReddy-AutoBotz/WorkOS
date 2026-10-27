import {WORKER_EXIT_VERSION,workerExitKinds,workerExitStates,validWorkerExitCommand,workerExitCanonical} from '../../shared/reviewed-worker-exit.mjs';
import {approvalKeys as keys,approvalHash as hash,approvalUuid as uuid} from '../../shared/work-approval.mjs';
import {businessItemId} from '../../shared/business-structure.mjs';
import {validCapabilityDate} from '../../shared/workforce-capabilities.mjs';
import {calendarLabel} from '../../shared/calendar-authoring.mjs';
import {captureDirectoryContext,isDirectoryContextCurrent,type DirectoryContext} from './workforceDirectory';
import {getEffectivePermissions} from './permissions';import {authService} from './authService';import {api,ApiClientError} from './apiClient';
export type ExitCommand={requestId:string;employeeId:string;expectedToken:string;reason:string};
export type ExitWorker={id:string;code:string;name:string;status:'Active'|'On Leave'|'Exited';exitDate:string|null};
type Envelope={contractVersion:'reviewed-worker-exit/1';organizationId:string;legalEntityId:string;ownerKey:string;actorUserId:string;activeRole:string;serverDate:string};
export type ExitAssessment=Envelope&{worker:ExitWorker;latestHistoryFrom:string|null;dependencies:{kind:string;id:string}[];truncated:boolean;state:string;observationToken:string};
export type ExitReceipt=Envelope&{command:ExitCommand;receipt:{requestId:string;employeeId:string;worker:ExitWorker;previousStatus:string;effectiveFrom:string;reason:string;actorUserId:string;activeRole:string;source:'Web';recordedAt:string;operationId:string};replayed?:boolean};
export type ExitContext=DirectoryContext;
export const captureExitContext=captureDirectoryContext,isExitContextCurrent=isDirectoryContextCurrent;
export const canReviewExit=()=>{const u=authService.getCurrentUser();return Boolean(u&&captureExitContext()&&getEffectivePermissions(u).includes('employees.manage'));};
const invalid=():never=>{throw new ApiClientError('Exit response could not be confirmed. Read the original receipt before another write.',{status:503,code:'WORKER_EXIT_RESPONSE_INVALID'});};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const worker=(v:unknown):v is ExitWorker=>object(v)&&keys(v,['id','code','name','status','exitDate'])&&businessItemId(v.id)&&typeof v.code==='string'&&v.code.length>0&&typeof v.name==='string'&&v.name.length>0&&['Active','On Leave','Exited'].includes(String(v.status))&&(v.exitDate===null||validCapabilityDate(v.exitDate));
const owner=(c:ExitContext|null)=>{if(!c||!isExitContextCurrent(c)||!canReviewExit())throw new ApiClientError('Exit account, role, session or scope changed. Reload explicitly.',{status:403});return c;};
const call=async(method:'GET'|'POST',path:string,input:unknown,c:ExitContext|null,extra:string[])=>{
 const ctx=owner(c),key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))))).map(x=>x.toString(16).padStart(2,'0')).join('');owner(ctx);
 const raw=await api.requestWithContext<unknown>(method,'/api/v1/workforce-exit'+path,input,ctx);owner(ctx);
 if(!object(raw)||!keys(raw,['contractVersion','organizationId','legalEntityId','ownerKey','actorUserId','activeRole','serverDate',...extra])||raw.contractVersion!==WORKER_EXIT_VERSION||raw.organizationId!==ctx.scope.organizationId||raw.legalEntityId!==ctx.scope.legalEntityId||raw.ownerKey!==key||!uuid(raw.actorUserId)||raw.activeRole!==ctx.activeRole||!validCapabilityDate(raw.serverDate))return invalid();return raw;
};
const receipt=(raw:Record<string,unknown>,input:ExitCommand):ExitReceipt=>{
 const r=raw.receipt;if(!validWorkerExitCommand(raw.command)||workerExitCanonical(raw.command)!==workerExitCanonical(input)||!object(r)||!keys(r,['requestId','employeeId','worker','previousStatus','effectiveFrom','reason','actorUserId','activeRole','source','recordedAt','operationId'])||r.requestId!==input.requestId||r.employeeId!==input.employeeId||!worker(r.worker)||r.worker.id!==input.employeeId||r.worker.status!=='Exited'||!validCapabilityDate(r.effectiveFrom)||r.worker.exitDate!==r.effectiveFrom||!['Active','On Leave'].includes(String(r.previousStatus))||r.reason!==input.reason||r.actorUserId!==raw.actorUserId||r.activeRole!==raw.activeRole||r.source!=='Web'||!calendarLabel(r.operationId,200)||typeof r.recordedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.recordedAt)||!Number.isFinite(Date.parse(r.recordedAt)))return invalid();return raw as unknown as ExitReceipt;
};
export const reviewedWorkerExitService={
 inspect:async(id:string,c:ExitContext|null):Promise<ExitAssessment>=>{
  if(!businessItemId(id))return invalid();const r=await call('GET','/workers/'+encodeURIComponent(id),undefined,c,['worker','latestHistoryFrom','dependencies','truncated','state','observationToken']);
  if(!worker(r.worker)||r.worker.id!==id||(r.latestHistoryFrom!==null&&!validCapabilityDate(r.latestHistoryFrom))||!hash(r.observationToken)||!workerExitStates.includes(String(r.state))||typeof r.truncated!=='boolean'||!Array.isArray(r.dependencies)||r.dependencies.length>100||r.truncated&&r.dependencies.length!==100)return invalid();
  const seen=new Set();for(const d of r.dependencies){if(!object(d)||!keys(d,['kind','id'])||!workerExitKinds.includes(String(d.kind))||!businessItemId(d.id)||seen.has(d.kind+':'+d.id))return invalid();seen.add(d.kind+':'+d.id);}
  if(r.state==='READY'&&(r.dependencies.length||r.truncated||r.worker.status==='Exited'||r.latestHistoryFrom===null||r.latestHistoryFrom>=String(r.serverDate)))return invalid();return r as unknown as ExitAssessment;
 },
 apply:async(input:ExitCommand,c:ExitContext|null)=>{if(!validWorkerExitCommand(input))return invalid();const r=await call('POST','/commands',input,c,['command','receipt','replayed']);if(typeof r.replayed!=='boolean')return invalid();return receipt(r,input);},
 reconcile:async(input:ExitCommand,c:ExitContext|null)=>{if(!validWorkerExitCommand(input))return invalid();return receipt(await call('GET','/commands/'+input.requestId,undefined,c,['command','receipt']),input);}
};
