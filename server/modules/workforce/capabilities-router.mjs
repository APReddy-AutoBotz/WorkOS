import {Router} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CAPABILITIES_VERSION,validCapabilities,validCapabilityCriteria} from '../../../shared/workforce-capabilities.mjs';
const command = z.object({expectedLatestId:z.string().uuid().nullable(),profile:z.unknown().refine(validCapabilities),reason:z.string().trim().min(1).max(1000)}).strict();
const view = row => row && ({id:row.id,sequence:row.sequence,contractVersion:row.contract_version,profile:row.profile,createdAt:row.created_at,activeRole:row.active_role,source:row.source,reason:row.reason});
const scope = req => ({organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId});
const error = (res,status,code,message) => res.status(status).json({error:message,code});
const pageSize=20,historySize=10;
export const createWorkforceCapabilitiesRouter=({pool,requireDatabase,requireAuth,requirePermission,buildEmployeeScopeWhere,audit,logError=e=>console.error('Workforce capability request failed',e?.code||'UNKNOWN')})=>{
 const router=Router();router.use(requireDatabase,requireAuth,requirePermission('employees.view'));
 router.get('/workers',requirePermission('allocations.view'),async(req,res)=>{
  const allowed=['skill','proficiency','certification','validOn','afterEmployeeId'];
  if(Object.keys(req.query).some(k=>!allowed.includes(k))||Object.values(req.query).some(v=>typeof v!=='string')
    ||(req.query.afterEmployeeId!==undefined&&(!req.query.afterEmployeeId||req.query.afterEmployeeId.length>200)))return error(res,400,'CAPABILITY_CRITERIA_INVALID','Capability search criteria are invalid.');
  const criteria=Object.fromEntries(['skill','proficiency','certification','validOn'].map(k=>[k,req.query[k]??null]));
  if(!validCapabilityCriteria(criteria))return error(res,400,'CAPABILITY_CRITERIA_INVALID','Use exact labels and an explicit certification validity date.');
  try{
   const params=[],where=buildEmployeeScopeWhere(req,params,'e');params.push(criteria.skill,criteria.proficiency,criteria.certification,criteria.validOn,req.query.afterEmployeeId??null);
   const [s,p,c,d,a]=[params.length-4,params.length-3,params.length-2,params.length-1,params.length];
   const rows=(await pool.query(`select e.id,e.employee_id,e.name,to_jsonb(v) capability from employees e
    left join lateral(select * from workforce_capability_versions w where w.employee_id=e.id and w.organization_id=e.organization_id and w.legal_entity_id=e.legal_entity_id order by sequence desc limit 1)v on true
    where ${where} and ($${a}::text is null or e.id collate "C">$${a} collate "C")
    and ($${s}::text is null or exists(select 1 from jsonb_array_elements(v.profile->'skills') i where (i->>'skill') collate "C"=$${s} collate "C" and ($${p}::text is null or (i->>'proficiency') collate "C"=$${p} collate "C")))
    and ($${c}::text is null or exists(select 1 from jsonb_array_elements(v.profile->'certifications') i where (i->>'certification') collate "C"=$${c} collate "C" and i->>'validFrom'<=$${d} and (i->'noExpiry'='true'::jsonb or i->>'validThrough'>=$${d})))
    order by e.id collate "C" limit ${pageSize+1}`,params)).rows;
   const more=rows.length>pageSize,selected=rows.slice(0,pageSize);
   return res.json({...scope(req),contractVersion:CAPABILITIES_VERSION,criteria,workers:selected.map(r=>({employeeId:r.id,employeeCode:r.employee_id,employeeName:r.name,current:view(r.capability)})),nextAfterEmployeeId:more?selected.at(-1).id:null});
  }catch(e){logError(e);return error(res,503,'CAPABILITIES_UNAVAILABLE','Capability search is unavailable. Retry.');}
 });
 router.get('/workers/:employeeId',async(req,res)=>{
  const raw=req.query.beforeSequence;
  if(Object.keys(req.query).some(k=>k!=='beforeSequence')||(raw!==undefined&&(typeof raw!=='string'||! /^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>2147483647)))return error(res,400,'CAPABILITIES_INVALID','Capability history cursor is invalid.');
  try{
   const params=[],where=buildEmployeeScopeWhere(req,params,'e');params.push(req.params.employeeId,raw===undefined?null:Number(raw));const id=params.length-1,cursor=params.length;
   const result=(await pool.query(`select e.id,e.employee_id,e.name,
    (select to_jsonb(w) from workforce_capability_versions w where w.organization_id=e.organization_id and w.legal_entity_id=e.legal_entity_id and w.employee_id=e.id order by sequence desc limit 1) current,
    coalesce((select jsonb_agg(to_jsonb(page) order by sequence desc) from(select * from workforce_capability_versions w where w.organization_id=e.organization_id and w.legal_entity_id=e.legal_entity_id and w.employee_id=e.id and ($${cursor}::integer is null or sequence<$${cursor}) order by sequence desc limit ${historySize+1})page),'[]'::jsonb) versions
    from employees e where ${where} and e.id=$${id}`,params)).rows[0];
   if(!result)return error(res,404,'CAPABILITIES_NOT_FOUND','Worker capabilities are unavailable in this scope.');
   const more=result.versions.length>historySize,versions=result.versions.slice(0,historySize).map(view);
   return res.json({...scope(req),contractVersion:CAPABILITIES_VERSION,employeeId:result.id,employeeCode:result.employee_id,employeeName:result.name,current:view(result.current),versions,nextBeforeSequence:more?versions.at(-1).sequence:null});
  }catch(e){logError(e);return error(res,503,'CAPABILITIES_UNAVAILABLE','Worker capabilities are unavailable. Retry.');}
 });
 router.post('/workers/:employeeId',requirePermission('employees.manage'),async(req,res)=>{
  const parsed=command.safeParse(req.body);if(!parsed.success)return error(res,400,'CAPABILITIES_INVALID','Provide a complete capability profile, current version and reason.');
  let client;try{client=await pool.connect();
   await client.query('begin');const params=[],where=buildEmployeeScopeWhere(req,params,'e');params.push(req.params.employeeId);
   const worker=(await client.query(`select e.id from employees e where ${where} and e.id=$${params.length} for update`,params)).rows[0];
   if(!worker){await client.query('rollback');return error(res,404,'CAPABILITIES_NOT_FOUND','Worker capabilities are unavailable in this scope.');}
   const {organizationId,legalEntityId}=scope(req),previous=(await client.query('select * from workforce_capability_versions where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 order by sequence desc limit 1',[organizationId,legalEntityId,worker.id])).rows[0];
   if((previous?.id??null)!==parsed.data.expectedLatestId){await client.query('rollback');return error(res,409,'CAPABILITIES_STALE','Capabilities changed. Reload before saving.');}
   const result=(await client.query(`insert into workforce_capability_versions(id,organization_id,legal_entity_id,employee_id,sequence,contract_version,profile,actor_id,active_role,source,reason)values($1,$2,$3,$4,$5,$6,$7,$8,$9,'Web',$10) returning *`,[randomUUID(),organizationId,legalEntityId,worker.id,(previous?.sequence??0)+1,CAPABILITIES_VERSION,JSON.stringify(parsed.data.profile),req.user.sub,req.user.activeRole,parsed.data.reason])).rows[0];
   await audit(client,req,{module:'Workforce',action:'Record Worker Capabilities',entityType:'WorkerCapabilities',entityId:worker.id,oldValue:previous?view(previous):null,newValue:view(result),reason:parsed.data.reason,details:'Recorded buyer-entered capability profile; no verification or capacity authority.'});
   await client.query('commit');return res.status(201).json({...scope(req),contractVersion:CAPABILITIES_VERSION,employeeId:worker.id,current:view(result)});
  }catch(e){if(client)await client.query('rollback');logError(e);return error(res,503,'CAPABILITIES_UNAVAILABLE','Capability save could not be confirmed. Reload before retrying.');}finally{client?.release();}
 });return router;
};
