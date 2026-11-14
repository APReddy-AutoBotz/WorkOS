import {CAPABILITIES_VERSION,validCapabilities,validCapabilityCriteria,compareCapabilityIds,matchesCapabilities} from '../../shared/workforce-capabilities.mjs';
import {api,ApiClientError,getOrganizationScope,getToken,type ApiRequestContext} from './apiClient';
import {authService} from './authService';
import {getEffectivePermissions} from './permissions';
export type CapabilityProfile={skills:{skill:string;proficiency:string|null}[];certifications:{certification:string;validFrom:string;validThrough:string|null;noExpiry:boolean}[];availabilityNote:string|null};
export type CapabilityCriteria={skill:string|null;proficiency:string|null;certification:string|null;validOn:string|null};
export type CapabilityVersion={id:string;sequence:number;contractVersion:string;profile:CapabilityProfile;createdAt:string;activeRole:string;source:'Web';reason:string};
export type CapabilityWorker={employeeId:string;employeeCode:string;employeeName:string;current:CapabilityVersion|null};
export type CapabilityPage=CapabilityWorker & {organizationId:string;legalEntityId:string;contractVersion:string;versions:CapabilityVersion[];nextBeforeSequence:number|null};
export type CapabilitySearch={organizationId:string;legalEntityId:string;contractVersion:string;criteria:CapabilityCriteria;workers:CapabilityWorker[];nextAfterEmployeeId:string|null};
type Mode='read'|'manage'|'search';
export type CapabilityContext=ApiRequestContext & {mode:Mode;identityKey:string;isCurrent:()=>boolean};
const identityKey=()=>{const u=authService.getCurrentUser();return u&&JSON.stringify([u.id,u.employeeId,u.role,u.permissionRole,[...getEffectivePermissions(u)].sort()]);};
export const captureCapabilityContext=(mode:Mode='read',isCurrent=()=>true):CapabilityContext|null=>{
 const scope=getOrganizationScope(),u=authService.getCurrentUser(),p=getEffectivePermissions(u);
 if(!scope?.organizationId||!scope.legalEntityId||!u||!p.includes('employees.view')||(mode==='manage'&&!p.includes('employees.manage'))||(mode==='search'&&!p.includes('allocations.view')))return null;
 return {scope:{...scope},token:getToken(),mode,identityKey:identityKey()!,isCurrent};
};
export const isCapabilityContextCurrent=(context:CapabilityContext)=>{const now=captureCapabilityContext(context.mode);return Boolean(context.isCurrent()&&now&&now.identityKey===context.identityKey&&now.token===context.token&&now.scope.organizationId===context.scope.organizationId&&now.scope.legalEntityId===context.scope.legalEntityId);};
const assertContext=(context:CapabilityContext|null,mode?:Mode)=>{if(!context||!isCapabilityContextCurrent(context)||(mode&&context.mode!==mode))throw new ApiClientError('Capability access changed. Reload for the current scope.',{status:403});return context;};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const invalid=():never=>{throw new ApiClientError('Capability response is invalid. Reload before saving.',{status:503});};
export const decodeCapabilityVersion=(raw:unknown):CapabilityVersion=>{
 if(!object(raw)||!uuid(raw.id)||!Number.isSafeInteger(raw.sequence)||Number(raw.sequence)<1||raw.contractVersion!==CAPABILITIES_VERSION
  ||!validCapabilities(raw.profile)||!text(raw.createdAt)||!/^\d{4}-\d{2}-\d{2}T/.test(raw.createdAt)||!/(Z|[+-]\d{2}:\d{2})$/.test(raw.createdAt)||Number.isNaN(Date.parse(raw.createdAt))||!text(raw.activeRole)||raw.source!=='Web'||!text(raw.reason))invalid();
 return raw as CapabilityVersion;
};
const decodeWorker=(raw:unknown):CapabilityWorker=>{
 if(!object(raw)||!text(raw.employeeId)||!text(raw.employeeCode)||!text(raw.employeeName)||!Object.hasOwn(raw,'current'))invalid();
 const r=raw as Record<string,unknown>;return {employeeId:r.employeeId as string,employeeCode:r.employeeCode as string,employeeName:r.employeeName as string,current:r.current===null?null:decodeCapabilityVersion(r.current)};
};
const checkScope=(raw:unknown,owner:CapabilityContext)=>{
 if(!object(raw)||raw.contractVersion!==CAPABILITIES_VERSION)invalid();
 const r=raw as Record<string,unknown>;if(r.organizationId!==owner.scope.organizationId||r.legalEntityId!==owner.scope.legalEntityId)throw new ApiClientError('Capability scope changed. Reload.',{status:403});return r;
};
const canonical=(value:unknown):string=>JSON.stringify(value,(_k,v)=>object(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const workforceCapabilitiesService={
 get:async(employeeId:string,before:number|null,context:CapabilityContext|null):Promise<CapabilityPage>=>{
  const owner=assertContext(context);const raw=await api.requestWithContext<unknown>('GET',`/api/v1/workforce-capabilities/workers/${encodeURIComponent(employeeId)}${before===null?'':`?beforeSequence=${before}`}`,undefined,owner);
  assertContext(owner);const r=checkScope(raw,owner),worker=decodeWorker(r);if(worker.employeeId!==employeeId||!Array.isArray(r.versions)||r.versions.length>10)invalid();
  let prior=before??2147483648;const ids=new Set<string>(),versions=(r.versions as unknown[]).map(raw=>{const v=decodeCapabilityVersion(raw);if(v.sequence>=prior||ids.has(v.id))invalid();prior=v.sequence;ids.add(v.id);return v;});
  const next=r.nextBeforeSequence;if(next!==null&&(!Number.isSafeInteger(next)||versions.length!==10||next!==versions.at(-1)?.sequence))invalid();
  if((worker.current===null)!==(versions.length===0&&before===null)||before===null&&worker.current?.id!==versions[0]?.id)invalid();
  return {...worker,organizationId:r.organizationId as string,legalEntityId:r.legalEntityId as string,contractVersion:CAPABILITIES_VERSION,versions,nextBeforeSequence:next as number|null};
 },
 save:async(employeeId:string,input:{expectedLatestId:string|null;profile:CapabilityProfile;reason:string},context:CapabilityContext|null):Promise<CapabilityVersion>=>{
  const owner=assertContext(context,'manage');if(!validCapabilities(input.profile)||!input.reason.trim())throw new ApiClientError('Capability profile is invalid.',{status:400});
  const raw=await api.requestWithContext<unknown>('POST',`/api/v1/workforce-capabilities/workers/${encodeURIComponent(employeeId)}`,input,owner);assertContext(owner);const r=checkScope(raw,owner);
  const current=decodeCapabilityVersion(r.current);if(r.employeeId!==employeeId||current.id===input.expectedLatestId||canonical(current.profile)!==canonical(input.profile)||current.reason!==input.reason.trim())invalid();return current;
 },
 search:async(criteria:CapabilityCriteria,after:string|null,context:CapabilityContext|null):Promise<CapabilitySearch>=>{
  const owner=assertContext(context,'search');if(!validCapabilityCriteria(criteria))throw new ApiClientError('Use exact criteria and an explicit certification validity date.',{status:400});
  const query=new URLSearchParams();Object.entries(criteria).forEach(([k,v])=>{if(v!==null)query.set(k,v);});if(after!==null)query.set('afterEmployeeId',after);
  const raw=await api.requestWithContext<unknown>('GET','/api/v1/workforce-capabilities/workers?'+query,undefined,owner);assertContext(owner);const r=checkScope(raw,owner);
  if(!validCapabilityCriteria(r.criteria)||canonical(r.criteria)!==canonical(criteria)||!Array.isArray(r.workers)||r.workers.length>20)invalid();
  const workers=(r.workers as unknown[]).map(decodeWorker),ids=new Set<string>();let previous=after;
  for(const w of workers){if(ids.has(w.employeeId)||(previous!==null&&compareCapabilityIds(w.employeeId,previous)<=0)||((criteria.skill!==null||criteria.certification!==null)&&(!w.current||!matchesCapabilities(w.current.profile,criteria))))invalid();ids.add(w.employeeId);previous=w.employeeId;}
  const next=r.nextAfterEmployeeId;if(next!==null&&(!text(next)||workers.length!==20||next!==workers.at(-1)?.employeeId))invalid();
  return {organizationId:r.organizationId as string,legalEntityId:r.legalEntityId as string,contractVersion:CAPABILITIES_VERSION,criteria,workers,nextAfterEmployeeId:next as string|null};
 }
};
