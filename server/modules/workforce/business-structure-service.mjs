import {randomUUID} from 'node:crypto';
import {BUSINESS_STRUCTURE_VERSION,BUSINESS_STRUCTURE_PAGE_SIZE,businessCommandCanonical} from '../../../shared/business-structure.mjs';
import {capacityFailure} from '../planning/worker-capacity-service.mjs';
import {workApprovalOwner} from '../approvals/work-approval-service.mjs';
const failure=(code,message,status=409)=>capacityFailure(code,message,status);
const scopeValues=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
export const businessStructureContext=async(c,req)=>({contractVersion:BUSINESS_STRUCTURE_VERSION,organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,ownerKey:workApprovalOwner(req),actorUserId:req.user.sub,activeRole:req.user.activeRole,serverDate:(await c.query("select to_char((clock_timestamp()at time zone'UTC')::date,'YYYY-MM-DD')today")).rows[0].today});
export const listBusinessStructures=async(c,req,type,after=null)=>{
 const rows=(await c.query(`select e.lineage_id id,business_structure_event_json(e)latest from business_structure_events e where e.organization_id=$1 and e.legal_entity_id=$2 and e.catalog_type=$3
  and e.sequence=(select max(x.sequence)from business_structure_events x where x.lineage_id=e.lineage_id)and($4::text is null or e.lineage_id::text collate "C">$4::text collate "C")order by e.lineage_id::text collate "C" limit ${BUSINESS_STRUCTURE_PAGE_SIZE+1}`,[...scopeValues(req),type,after])).rows;
 return{...await businessStructureContext(c,req),type,lineages:rows.slice(0,BUSINESS_STRUCTURE_PAGE_SIZE),nextAfter:rows.length>BUSINESS_STRUCTURE_PAGE_SIZE?rows[BUSINESS_STRUCTURE_PAGE_SIZE-1].id:null};
};
const latest=async(c,req,id)=>{
 const row=(await c.query('select e.*,business_structure_event_json(e)event from business_structure_events e where organization_id=$1 and legal_entity_id=$2 and lineage_id=$3 order by sequence desc limit 1',[...scopeValues(req),id])).rows[0];
 if(!row)failure('BUSINESS_STRUCTURE_NOT_FOUND','This authored catalog source is unavailable in the current scope.',404);return row;
};
export const readBusinessStructure=async(c,req,id,before=null)=>{
 const row=await latest(c,req,id),events=(await c.query(`select business_structure_event_json(e)event from business_structure_events e where organization_id=$1 and legal_entity_id=$2 and lineage_id=$3 and($4::integer is null or sequence<$4)order by sequence desc limit ${BUSINESS_STRUCTURE_PAGE_SIZE+1}`,[...scopeValues(req),id,before])).rows.map(x=>x.event);
 return{...await businessStructureContext(c,req),lineageId:id,latest:row.event,events:events.slice(0,BUSINESS_STRUCTURE_PAGE_SIZE),nextBefore:events.length>BUSINESS_STRUCTURE_PAGE_SIZE?events[BUSINESS_STRUCTURE_PAGE_SIZE-1].sequence:null};
};
export const listBusinessParents=async(c,req,type,effectiveFrom,lineageId=null,after=null)=>{
 if(effectiveFrom<(await businessStructureContext(c,req)).serverDate)failure('BUSINESS_STRUCTURE_DATE','Use an explicit current or future catalog date.');
 if(lineageId){const current=await latest(c,req,lineageId);if(current.catalog_type!==type||current.action==='Retire')failure('BUSINESS_STRUCTURE_STALE','Reload the current active catalog lineage.');}
 const rows=(await c.query(`select parent,encode(digest(parent::text,'sha256'),'hex')"parentToken" from(select business_structure_parent_snapshot(i.id,$1,$2,$3,$4::date,$5::uuid)parent from organization_catalog_items i
 where i.organization_id=$1 and i.legal_entity_id=$2 and i.catalog_type=$3 and i.active and $4::date between i.effective_from and coalesce(i.effective_to,'infinity'::date)and($6::text is null or i.id collate "C">$6::text collate "C"))s where parent is not null order by(parent->>'itemId')collate "C" limit ${BUSINESS_STRUCTURE_PAGE_SIZE+1}`,[...scopeValues(req),type,effectiveFrom,lineageId,after])).rows;
 return{...await businessStructureContext(c,req),selection:{type,effectiveFrom,lineageId},parents:rows.slice(0,BUSINESS_STRUCTURE_PAGE_SIZE),nextAfter:rows.length>BUSINESS_STRUCTURE_PAGE_SIZE?rows[BUSINESS_STRUCTURE_PAGE_SIZE-1].parent.itemId:null};
};
export const readBusinessImpact=async(c,req,id)=>{
 const row=await latest(c,req,id),counts=(await c.query('select business_structure_dependencies($1,$2)counts',[req.organizationScope.organizationId,row.native_item_id])).rows[0].counts;
 return{...await businessStructureContext(c,req),lineageId:id,latestId:row.id,nativeItemId:row.native_item_id,counts,total:Object.values(counts).reduce((sum,n)=>sum+Number(n),0)};
};
const owned=async(c,req,id)=>(await c.query('select command,business_structure_event_json(e)event from business_structure_events e where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',[...scopeValues(req),req.user.sub,id])).rows[0];
export const readBusinessCommand=async(c,req,id)=>{
 const row=await owned(c,req,id);if(!row||row.event.activeRole!==req.user.activeRole)failure('BUSINESS_STRUCTURE_COMMAND_NOT_FOUND','No committed receipt is confirmed for the original actor and role. An earlier request may still be in flight; do not replace its key.',404);
 return{...await businessStructureContext(c,req),...row};
};
export const applyBusinessCommand=async(c,req,input,audit)=>{
 const [org,leg]=scopeValues(req);
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[`business-command:${org}:${leg}:${req.user.sub}:${input.requestId}`]);
 const replay=await owned(c,req,input.requestId);
 if(replay){if(replay.event.activeRole!==req.user.activeRole||businessCommandCanonical(replay.command)!==businessCommandCanonical(input))failure('BUSINESS_STRUCTURE_KEY_CONFLICT','This key belongs to a different exact command. Reconcile the original.');return{...await businessStructureContext(c,req),...replay,replayed:true};}
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[`${org}:${leg}:${input.type}:${input.code}`]);
 const prior=(await c.query('select e.*,business_structure_event_json(e)event from business_structure_events e where organization_id=$1 and legal_entity_id=$2 and catalog_type=$3 and code=$4 order by sequence desc limit 1',[org,leg,input.type,input.code])).rows[0];
 if((prior?.lineage_id??null)!==input.lineageId||(prior?.id??null)!==input.expectedLatestId||prior?.action==='Retire')failure('BUSINESS_STRUCTURE_STALE','The current catalog source changed or is terminal. Reload its history.');
 if(!prior&&(await c.query('select 1 from organization_catalog_items where organization_id=$1 and legal_entity_id=$2 and catalog_type=$3 and code=$4 limit 1',[org,leg,input.type,input.code])).rowCount)failure('BUSINESS_STRUCTURE_LEGACY','An existing or retired native code cannot be adopted or reactivated implicitly.');
 const today=(await businessStructureContext(c,req)).serverDate;
 let parent=null,parentToken=null,retiredOn=null;
 const id=randomUUID(),lineageId=prior?.lineage_id??randomUUID(),nativeItemId=input.action==='Append'?'structure-item-'+id:prior?.native_item_id;
 if(input.action==='Append'){
  if(input.effectiveFrom<today||prior&&input.effectiveFrom<=prior.event.effectiveFrom)failure('BUSINESS_STRUCTURE_DATE','Use an explicit current/future date strictly after the prior source.');
  if(input.definition.parentId!==null){
   await c.query('select 1 from organization_catalog_items where id=$1 and organization_id=$2 and legal_entity_id=$3 for share',[input.definition.parentId,org,leg]);
   const p=(await c.query("select parent,encode(digest(parent::text,'sha256'),'hex')token from(select business_structure_parent_snapshot($1,$2,$3,$4,$5::date,$6::uuid)parent)x",[input.definition.parentId,org,leg,input.type,input.effectiveFrom,lineageId])).rows[0];
   if(!p.parent)failure('BUSINESS_STRUCTURE_PARENT_UNAVAILABLE','Choose an exact active same-type owned parent covering the date, without self/lineage cycles.',404);
   if(p.token!==input.expectedParentToken)failure('BUSINESS_STRUCTURE_PARENT_CHANGED','The inspected parent changed. Reload its exact source before a new command.');parent=p.parent;parentToken=p.token;
  }
 }else{
  if(!prior||input.effectiveFrom!==prior.event.effectiveFrom||businessCommandCanonical(input.definition)!==businessCommandCanonical(prior.definition)||input.effectiveFrom>today)failure('BUSINESS_STRUCTURE_RETIRE_BOUNDARY','Retire only the inspected currently effective latest unused source. No future cancellation or older-version retirement is inferred.');
  await c.query('select 1 from organization_catalog_items where id=$1 for update',[nativeItemId]);
  const counts=(await c.query('select business_structure_dependencies($1,$2)counts',[org,nativeItemId])).rows[0].counts;
  if(Object.values(counts).some(n=>Number(n)>0))failure('BUSINESS_STRUCTURE_IN_USE','Current or retained catalog, calendar, capacity or commercial references prevent unused-node retirement. Inspect scoped dependency counts.');
  parent=prior.parent_snapshot;parentToken=prior.parent_token;retiredOn=today;
 }
 await c.query("select set_config('workos.business_structure_context',$1,true)",[JSON.stringify({organizationId:org,legalEntityId:leg,actorId:req.user.sub,activeRole:req.user.activeRole,eventId:id,lineageId,nativeItemId,requestId:input.requestId,operationId:req.operationId})]);
 await c.query(`insert into business_structure_events(id,lineage_id,organization_id,legal_entity_id,catalog_type,code,sequence,previous_event_id,action,effective_from,retired_on,definition,native_item_id,parent_snapshot,parent_token,contract_version,request_id,command,request_fingerprint,actor_id,active_role,source,reason,operation_id)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18::jsonb,encode(digest($18::jsonb::text,'sha256'),'hex'),$19,$20,'Web',$21,$22)`,[id,lineageId,org,leg,input.type,input.code,(prior?.sequence??0)+1,prior?.id??null,input.action,input.effectiveFrom,retiredOn,JSON.stringify(input.definition),nativeItemId,parent?JSON.stringify(parent):null,parentToken,BUSINESS_STRUCTURE_VERSION,input.requestId,JSON.stringify(input),req.user.sub,req.user.activeRole,input.reason,req.operationId]);
 if(input.action==='Append'){
  if(prior)await c.query('update organization_catalog_items set effective_to=$2::date-1,updated_at=now()where id=$1',[prior.native_item_id,input.effectiveFrom]);
  await c.query('insert into organization_catalog_items(id,organization_id,legal_entity_id,catalog_type,code,name,parent_id,effective_from)values($1,$2,$3,$4,$5,$6,$7,$8)',[nativeItemId,org,leg,input.type,input.code,input.definition.name,input.definition.parentId,input.effectiveFrom]);
 }else await c.query('update organization_catalog_items set active=false,effective_to=$2::date,updated_at=now()where id=$1',[nativeItemId,today]);
 const receipt=await owned(c,req,input.requestId);
 await audit(c,req,{module:'Business Structure',action:input.action+' Catalog Source',entityType:'BusinessStructureEvent',entityId:id,oldValue:prior?.event??null,newValue:receipt.event,reason:input.reason,details:'Explicit effective catalog source and exact retained references; no manager, financial, transfer or reassignment authority.'});
 return{...await businessStructureContext(c,req),...receipt,replayed:false};
};
