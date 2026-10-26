import {randomUUID} from 'node:crypto';
import {CLASSIFICATION_VERSION,CLASSIFICATION_PAGE_SIZE,classificationFields,classificationCanonical} from '../../../shared/workforce-classification.mjs';
import {capacityFailure as sourceFailure} from '../planning/worker-capacity-service.mjs';
import {workApprovalOwner} from '../approvals/work-approval-service.mjs';
const scope=r=>[r.organizationScope.organizationId,r.organizationScope.legalEntityId];
const capacityFailure=(code,message,status=409)=>sourceFailure(code,message,status);
const context=async(c,r)=>({contractVersion:CLASSIFICATION_VERSION,organizationId:r.organizationScope.organizationId,legalEntityId:r.organizationScope.legalEntityId,ownerKey:workApprovalOwner(r),actorUserId:r.user.sub,activeRole:r.user.activeRole,serverDate:(await c.query("select to_char((clock_timestamp()at time zone'UTC')::date,'YYYY-MM-DD')today")).rows[0].today});
export const classificationWorker=async(c,r,id,buildScope,lock=false)=>{
 const args=[],where=buildScope(r,args,'e');args.push(id);
 const row=(await c.query(`select e.id,e.status,workforce_classification_worker(e)worker,encode(digest(workforce_classification_worker(e)::text,'sha256'),'hex')"workerToken"from employees e where ${where} and e.id=$${args.length}${lock?' for update':''}`,args)).rows[0];
 if(!row)capacityFailure('CLASSIFICATION_WORKER_UNAVAILABLE','Worker classification is unavailable in this current scope.',404);return row;
};
const latest=async(c,r,worker)=>(await c.query('select e.*,workforce_classification_event_json(e)event from workforce_classification_events e where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 order by sequence desc limit 1',[...scope(r),worker])).rows[0];
export const readClassification=async(c,r,id,q,buildScope)=>{
 const w=await classificationWorker(c,r,id,buildScope),ctx=await context(c,r),asOf=q.asOf??ctx.serverDate,l=await latest(c,r,id);
 const current=(await c.query('select workforce_classification_event_json(e)event from workforce_classification_events e where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 and effective_from<=$4::date order by effective_from desc limit 1',[...scope(r),id,asOf])).rows[0]?.event??null;
 const rows=(await c.query(`select workforce_classification_event_json(e)event from workforce_classification_events e where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 and($4::integer is null or sequence<$4)order by sequence desc limit ${CLASSIFICATION_PAGE_SIZE+1}`,[...scope(r),id,q.before??null])).rows.map(x=>x.event),availability={};
 for(const k of classificationFields)availability[k]=current?.definition[k]?(await c.query('select workforce_classification_source($1,$2,$3,$4,$5::date)s',[current.definition[k].itemId,k,...scope(r),asOf])).rows[0].s!==null:null;
 return{...ctx,worker:w.worker,workerToken:w.workerToken,asOf,latest:l?.event??null,current,availability,events:rows.slice(0,CLASSIFICATION_PAGE_SIZE),nextBefore:rows.length>CLASSIFICATION_PAGE_SIZE?rows[CLASSIFICATION_PAGE_SIZE-1].sequence:null};
};
export const classificationOptions=async(c,r,id,q,buildScope)=>{
 await classificationWorker(c,r,id,buildScope);const ctx=await context(c,r);if(q.effectiveFrom<ctx.serverDate)capacityFailure('CLASSIFICATION_DATE','Select an explicit current or future UTC date.');
 const rows=(await c.query(`select source,encode(digest(source::text,'sha256'),'hex')token from(select workforce_classification_source(i.id,$3,$1,$2,$4::date)source from organization_catalog_items i where i.organization_id=$1 and i.legal_entity_id=$2 and i.catalog_type=$3 and i.active and $4::date between i.effective_from and coalesce(i.effective_to,'infinity'::date)and($5::text is null or i.id collate "C">$5::text collate "C"))x where source is not null order by(source->>'itemId')collate "C" limit ${CLASSIFICATION_PAGE_SIZE+1}`,[...scope(r),q.type,q.effectiveFrom,q.after??null])).rows;
 return{...ctx,employeeId:id,selection:{type:q.type,effectiveFrom:q.effectiveFrom},options:rows.slice(0,CLASSIFICATION_PAGE_SIZE),nextAfter:rows.length>CLASSIFICATION_PAGE_SIZE?rows[CLASSIFICATION_PAGE_SIZE-1].source.itemId:null};
};
const owned=async(c,r,id)=>(await c.query('select command,workforce_classification_event_json(e)event from workforce_classification_events e where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',[...scope(r),r.user.sub,r.user.activeRole,id])).rows[0];
export const reconcileClassification=async(c,r,id,buildScope)=>{const row=await owned(c,r,id);if(!row)capacityFailure('CLASSIFICATION_RECEIPT_UNCONFIRMED','No committed original receipt is confirmed. It may still be in flight; do not replace its key.',404);await classificationWorker(c,r,row.event.employeeId,buildScope);return{...await context(c,r),...row};};
export const applyClassification=async(c,r,input,buildScope,audit)=>{
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[`classification:${scope(r).join(':')}:${r.user.sub}:${input.requestId}`]);
 const w=await classificationWorker(c,r,input.employeeId,buildScope,true),prior=await latest(c,r,input.employeeId),old=await owned(c,r,input.requestId);
 if(old){if(classificationCanonical(old.command)!==classificationCanonical(input))capacityFailure('CLASSIFICATION_KEY_CONFLICT','This request key belongs to different input. Reconcile the original.');return{...await context(c,r),...old,replayed:true};}
 if(w.status==='Exited')capacityFailure('CLASSIFICATION_WORKER_UNAVAILABLE','Exited workers cannot receive a new classification.');
 if((prior?.id??null)!==input.expectedLatestId||w.workerToken!==input.expectedWorkerToken)capacityFailure('CLASSIFICATION_STALE','Worker or classification changed. Reload the current sources.');
 const ctx=await context(c,r);if(input.effectiveFrom<ctx.serverDate||prior&&input.effectiveFrom<=prior.event.effectiveFrom)capacityFailure('CLASSIFICATION_DATE','Use a current/future UTC date strictly after the last classification.');
 const sources={};for(const k of classificationFields){const ref=input.definition[k];if(ref===null){sources[k]=null;continue;}
  await c.query('select 1 from organization_catalog_items where id=$1 for share',[ref.itemId]);const row=(await c.query("select s,encode(digest(s::text,'sha256'),'hex')token from(select workforce_classification_source($1,$2,$3,$4,$5::date)s)x",[ref.itemId,k,...scope(r),input.effectiveFrom])).rows[0];
  if(!row.s)capacityFailure('CLASSIFICATION_SOURCE_UNAVAILABLE','Select an owned active matching catalog source covering the explicit date.',404);if(row.token!==ref.token)capacityFailure('CLASSIFICATION_SOURCE_CHANGED','An inspected catalog source changed. Reload options.');sources[k]=row.s;
 }
 const id=randomUUID();await c.query("select set_config('workos.workforce_classification_context',$1,true)",[JSON.stringify({organizationId:ctx.organizationId,legalEntityId:ctx.legalEntityId,actorId:r.user.sub,activeRole:r.user.activeRole,eventId:id,operationId:r.operationId})]);
 await c.query(`insert into workforce_classification_events(id,organization_id,legal_entity_id,employee_id,sequence,previous_event_id,effective_from,definition,sources,worker_snapshot,worker_token,request_id,command,request_fingerprint,actor_id,active_role,source,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,encode(digest($13::jsonb::text,'sha256'),'hex'),$14,$15,'Web',$16,$17)`,[id,...scope(r),input.employeeId,(prior?.sequence??0)+1,prior?.id??null,input.effectiveFrom,JSON.stringify(input.definition),JSON.stringify(sources),JSON.stringify(w.worker),w.workerToken,input.requestId,JSON.stringify(input),r.user.sub,r.user.activeRole,input.reason,r.operationId]);
 for(const k of classificationFields)if(input.definition[k])await c.query('insert into workforce_classification_references(event_id,catalog_type,item_id)values($1,$2,$3)',[id,k,input.definition[k].itemId]);
 const row=await owned(c,r,input.requestId);await audit(c,r,{module:'Workforce Classification',action:'Record Worker Classification',entityType:'WorkforceClassificationEvent',entityId:id,oldValue:prior?.event??null,newValue:row.event,reason:input.reason,details:'Explicit exact catalog sources; legacy text and capacity/calendar/manager/commercial authority unchanged.'});return{...ctx,...row,replayed:false};
};
