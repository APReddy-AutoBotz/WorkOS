import {OPERATIONAL_CONTROL_VERSION,OPERATIONAL_PAGE_SIZE,OPERATIONAL_PENDING_CAP,OPERATIONAL_KINDS,OPERATIONAL_REQUIRED,operationalSelection,operationalConfidence} from '../../shared/operational-control.mjs';
import {approvalKeys as keys,approvalHash as hash,approvalUuid as uuid,approvalText as text} from '../../shared/work-approval.mjs';
import {compareCapabilityIds,validCapabilityDate} from '../../shared/workforce-capabilities.mjs';
import {authService} from './authService';
import {api,ApiClientError,getOrganizationScope,getToken,type ApiRequestContext} from './apiClient';
import {getEffectivePermissions} from './permissions';
import {decodeActualResult,type ActualResult} from './actualWork';
import {decodeNativeResult,type NativeResult} from './nativeForecast';
import type {ReviewKind} from './reviewedApprovalBatch';
export type OperationalSelection={startsOn:string;endsOn:string;forecastStartsOn:string;forecastEndsOn:string;months:number};
export type PendingControl={kind:ReviewKind;state:'available'|'limited'|'unavailable'|'not_permitted';items:null|Array<{kind:ReviewKind;id:string;stage:number;sourceToken:string;sourceEventId:string;pendingAt:string;decisionAuthority:'RequiresFreshReview'}>};
export type OperationalRow={worker:{id:string;code:string;name:string;status:'Active'};actual:ActualResult;forecast:NativeResult;pending:PendingControl[];confidence:string[]};
export type OperationalPage={contractVersion:'operational-control/1';organizationId:string;legalEntityId:string;ownerKey:string;actorUserId:string;activeRole:string;selection:OperationalSelection;roster:{totalActive:number;sourceToken:string;nextAfter:string|null};coverage:'CurrentPage';workers:OperationalRow[];today:string;sourceToken:string;observedAt:string};
export type OperationalContext=ApiRequestContext&{identityKey:string;activeRole:string;ownerIdentity:unknown[];isCurrent:()=>boolean};
const identity=()=>{const u=authService.getCurrentUser();return u?JSON.stringify([u.id,u.employeeId,u.userName,u.role,u.permissionRole,[...getEffectivePermissions(u)].sort()]):null;};
export const captureOperationalContext=(isCurrent=()=>true):OperationalContext|null=>{
 const u=authService.getCurrentUser(),scope=getOrganizationScope(),p=getEffectivePermissions(u);if(!u||!text(u.userName)||!scope?.organizationId||!scope.legalEntityId||!OPERATIONAL_REQUIRED.every(k=>p.includes(k)))return null;
 return{scope:{...scope},token:getToken(),identityKey:identity()!,activeRole:u.role,ownerIdentity:[u.userName,u.id,u.role,scope.organizationId,scope.legalEntityId],isCurrent};
};
export const isOperationalContextCurrent=(c:OperationalContext)=>{const n=captureOperationalContext();return Boolean(c.isCurrent()&&n&&c.identityKey===n.identityKey&&c.token===n.token&&c.scope.organizationId===n.scope.organizationId&&c.scope.legalEntityId===n.scope.legalEntityId);};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const instant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));
const integer=(v:unknown,min:number,max=2147483647)=>Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max;
const fail=():never=>{throw new ApiClientError('Operational snapshot could not be confirmed for this account, scope and selection. Refresh explicitly.',{status:503});};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sameSelection=(v:unknown,s:OperationalSelection)=>object(v)&&keys(v,['startsOn','endsOn','forecastStartsOn','forecastEndsOn','months'])&&Object.entries(s).every(([k,x])=>v[k]===x);
const assertContext=(c:OperationalContext|null)=>{if(!c||!isOperationalContextCurrent(c))throw new ApiClientError('Operational access or scope changed. Reload explicitly.',{status:403});return c;};
const ownerHash=async(c:OperationalContext)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(c.ownerIdentity))))).map(b=>b.toString(16).padStart(2,'0')).join('');
export const decodeOperationalPage=(v:unknown,selection:OperationalSelection,after:string|null,rosterToken:string|null,owner:OperationalContext,ownerKey:string):OperationalPage=>{
 if(!object(v)||!keys(v,['contractVersion','organizationId','legalEntityId','ownerKey','actorUserId','activeRole','selection','roster','coverage','workers','today','sourceToken','observedAt'])||v.contractVersion!==OPERATIONAL_CONTROL_VERSION||v.organizationId!==owner.scope.organizationId||v.legalEntityId!==owner.scope.legalEntityId||v.ownerKey!==ownerKey||!uuid(v.actorUserId)||v.activeRole!==owner.activeRole||v.coverage!=='CurrentPage'||!sameSelection(v.selection,selection)||!object(v.roster)||!keys(v.roster,['totalActive','sourceToken','nextAfter'])||!integer(v.roster.totalActive,0)||!hash(v.roster.sourceToken)||rosterToken!==null&&v.roster.sourceToken!==rosterToken||v.roster.nextAfter!==null&&!text(v.roster.nextAfter)||!Array.isArray(v.workers)||v.workers.length>OPERATIONAL_PAGE_SIZE||!hash(v.sourceToken)||!instant(v.observedAt)||!validCapabilityDate(v.today))return fail();
 const page=v as unknown as OperationalPage;let previous=after;const seen=new Set<string>();
 for(const raw of page.workers){
  if(!object(raw)||!keys(raw,['worker','actual','forecast','pending','confidence'])||!object(raw.worker)||!keys(raw.worker,['id','code','name','status'])||!text(raw.worker.id)||!text(raw.worker.code)||!text(raw.worker.name,2000)||raw.worker.status!=='Active'||previous!==null&&compareCapabilityIds(raw.worker.id,previous)<=0||seen.has(raw.worker.id))return fail();previous=raw.worker.id;seen.add(previous);
  decodeActualResult(raw.actual,raw.worker.id,selection.startsOn,selection.endsOn);decodeNativeResult(raw.forecast,raw.worker.id,selection.forecastStartsOn,selection.forecastEndsOn,selection.months);
  if(!Array.isArray(raw.pending)||raw.pending.length!==OPERATIONAL_KINDS.length)return fail();
  for(let i=0;i<raw.pending.length;i++){
   const d=raw.pending[i];if(!object(d)||!keys(d,['kind','state','items'])||d.kind!==OPERATIONAL_KINDS[i]||!['available','limited','unavailable','not_permitted'].includes(String(d.state)))return fail();
   if(['unavailable','not_permitted'].includes(d.state)){if(d.items!==null)return fail();continue;}
   if(!Array.isArray(d.items)||d.items.length>OPERATIONAL_PENDING_CAP||d.state==='limited'&&d.items.length!==OPERATIONAL_PENDING_CAP)return fail();let last='';
   for(const item of d.items){if(!object(item)||!keys(item,['kind','id','stage','sourceToken','sourceEventId','pendingAt','decisionAuthority'])||item.kind!==d.kind||!uuid(item.id)||item.id<=last||!integer(item.stage,0,9)||!hash(item.sourceToken)||!text(item.sourceEventId,2000)||!instant(item.pendingAt)||item.decisionAuthority!=='RequiresFreshReview')return fail();last=item.id;}
  }
  if(!same(raw.confidence,operationalConfidence(raw)))return fail();
 }
 if(page.roster.totalActive<page.workers.length||page.roster.nextAfter!==null&&(page.workers.length!==OPERATIONAL_PAGE_SIZE||page.roster.totalActive<=page.workers.length||page.roster.nextAfter!==page.workers.at(-1)?.worker.id)||page.workers.length===0&&page.roster.nextAfter!==null||after===null&&page.roster.nextAfter===null&&page.roster.totalActive!==page.workers.length)return fail();
 return page;
};
export const operationalControlService={snapshot:async(selection:OperationalSelection,after:string|null,rosterToken:string|null,c:OperationalContext|null)=>{
 const ctx=assertContext(c),s=operationalSelection(selection.startsOn,selection.endsOn,selection.forecastStartsOn,selection.months);if(!same(s,selection)||Boolean(after)!==Boolean(rosterToken)||after!==null&&!text(after)||rosterToken!==null&&!hash(rosterToken))return fail();const ownerKey=await ownerHash(ctx);assertContext(ctx);
 const q=new URLSearchParams({startsOn:s.startsOn,endsOn:s.endsOn,forecastStartsOn:s.forecastStartsOn,months:String(s.months),...after?{after,expectedRosterToken:rosterToken!}:{}}),v=await api.requestWithContext<unknown>('GET','/api/v1/operational-control/snapshot?'+q,undefined,ctx);assertContext(ctx);return decodeOperationalPage(v,selection,after,rosterToken,ctx,ownerKey);
}};
