import {BUSINESS_STRUCTURE_VERSION,BUSINESS_STRUCTURE_PAGE_SIZE,businessType,businessCode,businessItemId,validBusinessDefinition,validBusinessCommand,businessCommandCanonical} from '../../shared/business-structure.mjs';
import {approvalKeys as keys,approvalUuid as uuid,approvalHash as hash} from '../../shared/work-approval.mjs';
import {calendarLabel} from '../../shared/calendar-authoring.mjs';
import {validCapabilityDate,compareCapabilityIds} from '../../shared/workforce-capabilities.mjs';
import {api,ApiClientError} from './apiClient';
import {captureCalendarAuthoringContext,isCalendarAuthoringContextCurrent,type CalendarContext} from './calendarAuthoring';
export type BusinessType='business_unit'|'department'|'cost_centre'|'practice'|'location'|'region';
export type BusinessContext=CalendarContext;
export type BusinessDefinition={name:string;parentId:string|null};
export type BusinessCommand={requestId:string;lineageId:string|null;expectedLatestId:string|null;type:BusinessType;code:string;action:'Append'|'Retire';effectiveFrom:string;definition:BusinessDefinition;expectedParentToken:string|null;reason:string};
export type BusinessParent={itemId:string;type:BusinessType;code:string;name:string;ownerLegalEntityId:string;effectiveFrom:string;effectiveTo:string|null};
export type BusinessParentOption={parent:BusinessParent;parentToken:string};
export type BusinessEvent={eventId:string;lineageId:string;type:BusinessType;code:string;sequence:number;previousEventId:string|null;action:'Append'|'Retire';effectiveFrom:string;retiredOn:string|null;definition:BusinessDefinition;nativeItemId:string;parentSource:BusinessParent|null;parentToken:string|null;requestId:string;requestFingerprint:string;actorUserId:string;activeRole:string;source:'Web';reason:string;createdAt:string};
type Envelope={contractVersion:'business-structure/1';organizationId:string;legalEntityId:string;ownerKey:string;actorUserId:string;activeRole:string;serverDate:string};
export type BusinessList=Envelope&{type:BusinessType;lineages:{id:string;latest:BusinessEvent}[];nextAfter:string|null};
export type BusinessHistory=Envelope&{lineageId:string;latest:BusinessEvent;events:BusinessEvent[];nextBefore:number|null};
export type BusinessParents=Envelope&{selection:{type:BusinessType;effectiveFrom:string;lineageId:string|null};parents:BusinessParentOption[];nextAfter:string|null};
export type BusinessReceipt=Envelope&{command:BusinessCommand;event:BusinessEvent;replayed?:boolean};
export type BusinessCounts={catalogChildren:number;workingCalendars:number;capacityVersions:number;commercialEngagements:number;commercialBindings:number};
export type BusinessImpact=Envelope&{lineageId:string;latestId:string;nativeItemId:string;counts:BusinessCounts;total:number};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const invalid=():never=>{throw new ApiClientError('The catalog response could not be confirmed. Reconcile the original request before another save.',{status:503,code:'BUSINESS_STRUCTURE_RESPONSE_INVALID'});};
export const captureBusinessContext=captureCalendarAuthoringContext;
export const isBusinessContextCurrent=isCalendarAuthoringContextCurrent;
const owner=(c:BusinessContext|null)=>{if(!c||!isBusinessContextCurrent(c))throw new ApiClientError('Catalog account, role, token or scope changed. Reload through normal sign-in.',{status:403});return c;};
const sha=async(v:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))).map(x=>x.toString(16).padStart(2,'0')).join('');
const envelope=(raw:unknown,c:BusinessContext,key:string,extra:string[])=>{
 if(!object(raw)||!keys(raw,['contractVersion','organizationId','legalEntityId','ownerKey','actorUserId','activeRole','serverDate',...extra])||raw.contractVersion!==BUSINESS_STRUCTURE_VERSION||raw.organizationId!==c.scope.organizationId||raw.legalEntityId!==c.scope.legalEntityId||raw.ownerKey!==key||!uuid(raw.actorUserId)||raw.activeRole!==c.activeRole||!validCapabilityDate(raw.serverDate))return invalid();return raw;
};
const validParent=(v:unknown,leg:string):v is BusinessParent=>object(v)&&keys(v,['itemId','type','code','name','ownerLegalEntityId','effectiveFrom','effectiveTo'])&&businessItemId(v.itemId)&&businessType(v.type)&&businessCode(v.code)&&calendarLabel(v.name,150)&&v.ownerLegalEntityId===leg&&validCapabilityDate(v.effectiveFrom)&&(v.effectiveTo===null||validCapabilityDate(v.effectiveTo)&&String(v.effectiveTo)>=String(v.effectiveFrom));
const event=(raw:unknown,leg:string):BusinessEvent=>{
 if(!object(raw)||!keys(raw,['eventId','lineageId','type','code','sequence','previousEventId','action','effectiveFrom','retiredOn','definition','nativeItemId','parentSource','parentToken','requestId','requestFingerprint','actorUserId','activeRole','source','reason','createdAt'])
  ||![raw.eventId,raw.lineageId,raw.requestId,raw.actorUserId].every(uuid)||!businessType(raw.type)||!businessCode(raw.code)||!Number.isSafeInteger(raw.sequence)||Number(raw.sequence)<1||!(Number(raw.sequence)===1?raw.previousEventId===null:uuid(raw.previousEventId))
  ||!['Append','Retire'].includes(String(raw.action))||!validCapabilityDate(raw.effectiveFrom)||!validBusinessDefinition(raw.definition)||!hash(raw.requestFingerprint)||!calendarLabel(raw.activeRole,100)||!calendarLabel(raw.reason,1000)||raw.source!=='Web'
  ||typeof raw.createdAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.createdAt)||!Number.isFinite(Date.parse(raw.createdAt)))return invalid();
 const v=raw as unknown as BusinessEvent;
 if(v.action==='Append'?v.retiredOn!==null||v.nativeItemId!=='structure-item-'+v.eventId:!validCapabilityDate(v.retiredOn)||v.retiredOn!<v.effectiveFrom||v.nativeItemId!=='structure-item-'+v.previousEventId)return invalid();
 if(v.definition.parentId===null){if(v.parentSource!==null||v.parentToken!==null)return invalid();}
 else if(!validParent(v.parentSource,leg)||!hash(v.parentToken)||v.parentSource.itemId!==v.definition.parentId||v.parentSource.type!==v.type||v.parentSource.effectiveFrom>v.effectiveFrom||v.parentSource.effectiveTo!==null&&v.parentSource.effectiveTo<v.effectiveFrom)return invalid();return v;
};
const call=async(method:'GET'|'POST',path:string,body:unknown,c:BusinessContext|null)=>{const ctx=owner(c),key=await sha(ctx.ownerIdentity);owner(ctx);const raw=await api.requestWithContext<unknown>(method,'/api/v1/business-structure'+path,body,ctx);owner(ctx);return{raw,ctx,key};};
const receipt=(raw:unknown,ctx:BusinessContext,key:string,input:BusinessCommand,sequence:number,append:boolean):BusinessReceipt=>{
 const r=envelope(raw,ctx,key,['command','event',...append?['replayed']:[]]);if(!validBusinessCommand(r.command)||businessCommandCanonical(r.command)!==businessCommandCanonical(input)||append&&typeof r.replayed!=='boolean')return invalid();const e=event(r.event,ctx.scope.legalEntityId);
 if(e.actorUserId!==r.actorUserId||e.activeRole!==ctx.activeRole||e.requestId!==input.requestId||e.sequence!==sequence+1||e.previousEventId!==input.expectedLatestId||input.lineageId!==null&&e.lineageId!==input.lineageId||e.type!==input.type||e.code!==input.code||e.action!==input.action||e.effectiveFrom!==input.effectiveFrom||e.reason!==input.reason||businessCommandCanonical(e.definition)!==businessCommandCanonical(input.definition)||input.action==='Append'&&e.parentToken!==input.expectedParentToken)return invalid();return{...r,event:e}as BusinessReceipt;
};
export const businessStructureService={
 list:async(type:BusinessType,after:string|null,c:BusinessContext|null):Promise<BusinessList>=>{
  if(!businessType(type)||after!==null&&!uuid(after))return invalid();const{raw,ctx,key}=await call('GET','/lineages?'+new URLSearchParams({type,...after?{after}:{}}),undefined,c),r=envelope(raw,ctx,key,['type','lineages','nextAfter']);if(r.type!==type||!Array.isArray(r.lineages)||r.lineages.length>BUSINESS_STRUCTURE_PAGE_SIZE)return invalid();let prior=after;
  const lineages=r.lineages.map(x=>{if(!object(x)||!keys(x,['id','latest'])||!uuid(x.id)||prior!==null&&String(x.id)<=prior)return invalid();const e=event(x.latest,ctx.scope.legalEntityId);if(e.lineageId!==x.id||e.type!==type)return invalid();prior=String(x.id);return{id:String(x.id),latest:e};});
  if(r.nextAfter!==null&&(!uuid(r.nextAfter)||lineages.length!==BUSINESS_STRUCTURE_PAGE_SIZE||r.nextAfter!==lineages.at(-1)?.id))return invalid();return{...r,lineages}as BusinessList;
 },
 history:async(id:string,before:number|null,c:BusinessContext|null):Promise<BusinessHistory>=>{
  if(!uuid(id)||before!==null&&(!Number.isSafeInteger(before)||before<1||before>2147483647))return invalid();const{raw,ctx,key}=await call('GET','/lineages/'+id+(before?'?before='+before:''),undefined,c),r=envelope(raw,ctx,key,['lineageId','latest','events','nextBefore']),latest=event(r.latest,ctx.scope.legalEntityId);if(r.lineageId!==id||latest.lineageId!==id||!Array.isArray(r.events)||r.events.length>BUSINESS_STRUCTURE_PAGE_SIZE)return invalid();let prior=before??latest.sequence+1;
  const events=r.events.map(x=>{const e=event(x,ctx.scope.legalEntityId);if(e.lineageId!==id||e.type!==latest.type||e.code!==latest.code||e.sequence!==prior-1||e.sequence>latest.sequence)return invalid();prior=e.sequence;return e;});if(before===null&&events[0]?.eventId!==latest.eventId||r.nextBefore!==null&&(!Number.isSafeInteger(r.nextBefore)||events.length!==BUSINESS_STRUCTURE_PAGE_SIZE||r.nextBefore!==events.at(-1)?.sequence))return invalid();return{...r,latest,events}as BusinessHistory;
 },
 parents:async(type:BusinessType,effectiveFrom:string,lineageId:string|null,after:string|null,c:BusinessContext|null):Promise<BusinessParents>=>{
  if(!businessType(type)||!validCapabilityDate(effectiveFrom)||lineageId!==null&&!uuid(lineageId)||after!==null&&!businessItemId(after))return invalid();const{raw,ctx,key}=await call('GET','/parents?'+new URLSearchParams({type,effectiveFrom,...lineageId?{lineageId}:{},...after?{after}:{}}),undefined,c),r=envelope(raw,ctx,key,['selection','parents','nextAfter']);
  if(!object(r.selection)||!keys(r.selection,['type','effectiveFrom','lineageId'])||r.selection.type!==type||r.selection.effectiveFrom!==effectiveFrom||r.selection.lineageId!==lineageId||!Array.isArray(r.parents)||r.parents.length>BUSINESS_STRUCTURE_PAGE_SIZE)return invalid();let prior=after;
  for(const p of r.parents){if(!object(p)||!keys(p,['parent','parentToken'])||!validParent(p.parent,ctx.scope.legalEntityId)||!hash(p.parentToken)||p.parent.type!==type||p.parent.effectiveFrom>effectiveFrom||p.parent.effectiveTo!==null&&p.parent.effectiveTo<effectiveFrom||prior!==null&&compareCapabilityIds(p.parent.itemId,prior)<=0)return invalid();prior=p.parent.itemId;}
  if(r.nextAfter!==null&&(!businessItemId(r.nextAfter)||r.parents.length!==BUSINESS_STRUCTURE_PAGE_SIZE||r.nextAfter!==r.parents.at(-1)?.parent.itemId))return invalid();return r as unknown as BusinessParents;
 },
 impact:async(id:string,c:BusinessContext|null):Promise<BusinessImpact>=>{
  if(!uuid(id))return invalid();const{raw,ctx,key}=await call('GET','/lineages/'+id+'/impact',undefined,c),r=envelope(raw,ctx,key,['lineageId','latestId','nativeItemId','counts','total']);if(r.lineageId!==id||!uuid(r.latestId)||!businessItemId(r.nativeItemId)||!object(r.counts)||!keys(r.counts,['catalogChildren','workingCalendars','capacityVersions','commercialEngagements','commercialBindings'])||Object.values(r.counts).some(x=>!Number.isSafeInteger(x)||Number(x)<0)||!Number.isSafeInteger(r.total)||Number(r.total)!==Object.values(r.counts).reduce<number>((n,x)=>n+Number(x),0))return invalid();return r as unknown as BusinessImpact;
 },
 apply:async(input:BusinessCommand,sequence:number,c:BusinessContext|null):Promise<BusinessReceipt>=>{if(!validBusinessCommand(input)||!Number.isSafeInteger(sequence)||sequence<0)return invalid();const{raw,ctx,key}=await call('POST','/commands',input,c);return receipt(raw,ctx,key,input,sequence,true);},
 reconcile:async(input:BusinessCommand,sequence:number,c:BusinessContext|null):Promise<BusinessReceipt>=>{if(!validBusinessCommand(input)||!Number.isSafeInteger(sequence)||sequence<0)return invalid();const{raw,ctx,key}=await call('GET','/commands/'+input.requestId,undefined,c);return receipt(raw,ctx,key,input,sequence,false);}
};
