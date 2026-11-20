import {z} from 'zod';
import {resolveOrganizationScope} from '../../organization-setup.mjs';
import {workApprovalOwner} from '../approvals/work-approval-service.mjs';

const choices=z.object({on:z.string().date(),search:z.string().trim().max(100).default(''),before:z.string().date().optional()}).strict();
const command=z.object({requestId:z.string().uuid(),expectedOwnerKey:z.string().regex(/^[a-f0-9]{64}$/),expectedLatestId:z.string().uuid().nullable(),
  effectiveFrom:z.string().date(),workerTypeId:z.string().min(1).max(200).nullable(),reason:z.string().trim().min(3).max(500)}).strict();
const fields='id,effective_from::text as "effectiveFrom",worker_type_id as "workerTypeId",recorded_label as label,reason';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const workerWhere='organization_id=$1 and legal_entity_id=$2 and employee_id=$3';

export function registerWorkerTypeAssignments(router,{pool,requirePermission,buildEmployeeScopeWhere,hasActiveAssignedRole,getEffectivePermissionsForUser,audit}){
  const path='/workers/:id/type-assignments';
  const handle=(write,action)=>async(req,res)=>{
    const parsed=(write?command:choices).safeParse(write?req.body:req.query);
    if(!parsed.success)return res.status(400).json({error:'Invalid worker classification input.'});
    let c;
    try{
      c=await pool.connect();
      await c.query(write?'begin':'begin isolation level repeatable read read only');
      if(write)await c.query('select lock_commercial_candidate_identity($1,$2,$3,$4)',[req.organizationScope.organizationId,req.organizationScope.legalEntityId,req.user.sub,req.user.activeRole]);
      const current=await resolveOrganizationScope(c,req);
      if(current.organizationId!==req.organizationScope.organizationId || current.legalEntityId!==req.organizationScope.legalEntityId)throw fail(403,'Workforce scope changed.');
      if(!await hasActiveAssignedRole(c,req.user.sub,req.user.activeRole))throw fail(403,'Current held role required.');
      const permissions=await getEffectivePermissionsForUser(c,req.user.sub,req.user.activeRole);
      if(!['employees.view','employees.manage'].every(p=>permissions.includes(p)))throw fail(403,'Workforce access changed.');
      const args=[req.organizationScope.organizationId,req.organizationScope.legalEntityId,req.params.id],scoped=[...args];
      const visible=buildEmployeeScopeWhere(req,scoped,'e');
      if(!(await c.query(`select e.id from employees e where e.organization_id=$1 and e.legal_entity_id=$2 and e.id=$3 and (${visible}) ${write?'for update of e':''}`,scoped)).rowCount)
        throw fail(404,'Worker unavailable in the selected scope.');
      const result=await action(c,req,parsed.data,args);
      await c.query('commit');res.status(result.status).json(result.data);
    }catch(e){
      if(!e.status && !e.statusCode)console.error('Worker classification failed',e.code??e.name);
      if(c)await c.query('rollback').catch(()=>{});
      res.status(e.status??e.statusCode??(['23505','WKT02'].includes(e.code)?409:503)).json({error:e.status?e.message:'Worker classification could not be confirmed.'});
    }finally{c?.release();}
  };
  router.get(path,requirePermission('employees.manage'),handle(false,async(c,r,q,args)=>{
    const options=(await c.query(`select id,name,code from organization_catalog_items where organization_id=$1 and (legal_entity_id=$2 or legal_entity_id is null)
      and catalog_type='worker_type' and active and $3::date between effective_from and coalesce(effective_to,'infinity'::date)
      and (strpos(lower(name),lower($4))>0 or strpos(lower(code),lower($4))>0) order by code,id limit 51`,[args[0],args[1],q.on,q.search])).rows;
    const history=(await c.query(`select ${fields} from worker_type_assignments where ${workerWhere}
      and ($4::date is null or effective_from<$4) order by effective_from desc limit 21`,[...args,q.before??null])).rows;
    const latest=(await c.query(`select id from worker_type_assignments where ${workerWhere} order by effective_from desc limit 1`,args)).rows[0];
    return {status:200,data:{employeeId:r.params.id,ownerKey:workApprovalOwner(r),on:q.on,latestId:latest?.id??null,history:history.slice(0,20),
      nextBefore:history.length>20?history[19].effectiveFrom:null,options:options.slice(0,50),moreOptions:options.length>50}};
  }));
  router.post(path,requirePermission('employees.manage'),handle(true,async(c,r,q,args)=>{
    if(workApprovalOwner(r)!==q.expectedOwnerKey)throw fail(409,'Account, role or scope changed.');
    const previous=(await c.query(`select ${fields} from worker_type_assignments where ${workerWhere} order by effective_from desc limit 1`,args)).rows[0];
    const existing=(await c.query(`select ${fields},actor_id,active_role,previous_id from worker_type_assignments where ${workerWhere} and id=$4`,[...args,q.requestId])).rows[0];
    if(existing){
      if(existing.actor_id!==r.user.sub || existing.active_role!==r.user.activeRole || existing.effectiveFrom!==q.effectiveFrom ||
        existing.workerTypeId!==q.workerTypeId || existing.reason!==q.reason || existing.previous_id!==q.expectedLatestId)throw fail(409,'The recorded request differs.');
      return {status:200,data:{id:existing.id,employeeId:r.params.id,ownerKey:q.expectedOwnerKey,replayed:true}};
    }
    const today=(await c.query("select (statement_timestamp() at time zone 'UTC')::date::text today")).rows[0].today;
    if((previous?.id??null)!==q.expectedLatestId || q.effectiveFrom<today || (previous && q.effectiveFrom<=previous.effectiveFrom))
      throw fail(409,'Reload the timeline and select a date after the latest assignment.');
    let label=null;
    if(q.workerTypeId!==null){
      const type=(await c.query(`select name from organization_catalog_items where id=$1 and organization_id=$2 and (legal_entity_id=$3 or legal_entity_id is null)
        and active and catalog_type='worker_type' and $4::date between effective_from and coalesce(effective_to,'infinity'::date) for share`,
        [q.workerTypeId,args[0],args[1],q.effectiveFrom])).rows[0];
      if(!type)throw fail(409,'Selected type is unavailable on this date.');
      label=type.name;
    }
    const legacy=previous?null:(await c.query(`select kind.id as "workerTypeId",kind.name as label from worker_profiles profile
      join organization_catalog_items kind on kind.id=profile.worker_type_id and kind.organization_id=profile.organization_id
      and (kind.legal_entity_id is null or kind.legal_entity_id=profile.legal_entity_id) and kind.active and kind.catalog_type='worker_type'
      where profile.organization_id=$1 and profile.legal_entity_id=$2 and profile.employee_id=$3
      and $4::date between profile.effective_from and coalesce(profile.effective_to,'infinity'::date)
      and $4::date between kind.effective_from and coalesce(kind.effective_to,'infinity'::date) for share of kind`,[...args,q.effectiveFrom])).rows[0];
    const saved=(await c.query(`insert into worker_type_assignments(organization_id,legal_entity_id,employee_id,id,previous_id,effective_from,worker_type_id,recorded_label,actor_id,active_role,reason)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${fields}`,[...args,q.requestId,q.expectedLatestId,q.effectiveFrom,q.workerTypeId,label,r.user.sub,r.user.activeRole,q.reason])).rows[0];
    await audit(c,r,{module:'Workforce',action:'Schedule Worker Type',entityType:'Employee',entityId:r.params.id,oldValue:previous??legacy??null,newValue:saved,reason:q.reason,details:'Recorded an effective-dated worker classification.'});
    return {status:201,data:{id:saved.id,employeeId:r.params.id,ownerKey:q.expectedOwnerKey,replayed:false}};
  }));
}
