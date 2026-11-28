import {randomUUID} from 'node:crypto';
import {validDelegationDefinition} from '../../../shared/canonical-delegation.mjs';
import {capacityHash} from '../planning/worker-capacity-service.mjs';
const scope=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{code:'CANONICAL_DELEGATION_CONFLICT',statusCode:status});};
const iso=v=>v==null?null:new Date(v).toISOString();
export const delegationAvailable=async c=>Boolean((await c.query("select to_regclass('public.canonical_delegations')t")).rows[0].t);
export const delegationView=r=>({revocation:r.revocation?{id:r.revocation.id,actorId:r.revocation.actor_id,activeRole:r.revocation.active_role,requestId:r.revocation.request_id,reason:r.revocation.reason,operationId:r.revocation.operation_id,createdAt:iso(r.revocation.created_at)}:null,id:r.id,delegatorUserId:r.delegator_user_id,definition:r.definition,requestId:r.request_id,reason:r.reason,operationId:r.operation_id,createdAt:iso(r.created_at),revokedAt:iso(r.revoked_at??null)});
export const delegationBindings=async(c,req,kind,id)=>{
 if(!await delegationAvailable(c))return[];
 return(await c.query(`select b.id,b.delegation_id "delegationId",b.stage,d.delegator_user_id "delegatorUserId",d.definition->>'delegateUserId' "delegateUserId",d.definition->>'role'role,d.definition->>'startsAt'"startsAt",d.definition->>'endsAt'"endsAt",r.created_at "revokedAt",canonical_delegation_eligible(b,clock_timestamp())eligible from canonical_delegation_bindings b join canonical_delegations d on d.id=b.delegation_id left join canonical_delegation_revocations r on r.delegation_id=d.id where b.origin=$1 and b.instance_id=$2 and d.organization_id=$3 and d.legal_entity_id=$4 order by b.stage`,[kind,id,...scope(req)])).rows.map(r=>({...r,revokedAt:iso(r.revokedAt)}));
};
export const delegationReceiptProof=async(c,kind,rows)=>{
 if(!rows.length||!await delegationAvailable(c))return rows;
 const proofs=(await c.query('select transition_id,binding_id from canonical_delegation_decisions where origin=$1 and transition_id=any($2::uuid[])',[kind,rows.map(r=>r.id)])).rows;
 for(const p of proofs){const row=rows.find(r=>r.id===p.transition_id);row.delegation_binding_id=p.binding_id;}return rows;
};
const lockCanonicalActors=async(c,req,ids,role)=>{
 const selected=[...new Set(ids)].sort();await c.query('select id from users where id=any($1::uuid[])order by id for share',[selected]);
 await c.query('select user_id from user_roles where user_id=any($1::uuid[])order by user_id,role_id for share',[selected]);
 await c.query('select user_id from user_organization_scopes where user_id=any($1::uuid[])and organization_id=$2 and legal_entity_id=$3 order by user_id for share',[selected,...scope(req)]);
 await c.query('select permission_key from role_permissions where role_name=$1 order by permission_key for share',[role]);
 await c.query('select id from user_permission_grants where user_id=any($1::uuid[])order by id for share',[selected]);
 await c.query('select id from employees where id in(select employee_record_id from users where id=any($1::uuid[]))order by id for share',[selected]);
};
export const assertCanonicalActor=async(c,req,kind,v,stages,source,actorValidator,o)=>{
 const stage=stages[v.state.currentStage];if(!stage||stage.role!==req.user.activeRole)fail('Use the configured held role for the current stage.',403);
 await lockCanonicalActors(c,req,[stage.userId,req.user.sub],stage.role);
 const namedActor=await actorValidator(c,req,stage,source,o);
 if(stage.userId===req.user.sub)return namedActor;
 const b=(v.delegations??[]).find(b=>b.stage===v.state.currentStage&&b.delegateUserId===req.user.sub&&b.eligible);
 if(!b)fail('No current prospective delegation covers this actor and stage.',403);
 await actorValidator(c,req,{userId:req.user.sub,role:stage.role},source,o);
 return namedActor;
};
export const canonicalStageRecipients=async(c,req,v,stages,stage,source,actorValidator,o)=>{
 await lockCanonicalActors(c,req,[stages[stage].userId,...(v.delegations??[]).filter(b=>b.stage===stage&&b.eligible).map(b=>b.delegateUserId)],stages[stage].role);
 const named=await actorValidator(c,req,stages[stage],source,o),rows=[{userId:named.user.sub,reason:'current_stage_approver'}];
 for(const b of v.delegations??[])if(b.stage===stage&&b.eligible){await actorValidator(c,req,{userId:b.delegateUserId,role:b.role},source,o);rows.push({userId:b.delegateUserId,reason:'current_stage_approver'});}return rows;
};
const context=(c,req)=>c.query("select set_config('workos.canonical_delegation_context',$1,true)",[JSON.stringify({actorId:req.user.sub,activeRole:req.user.activeRole,operationId:req.operationId,organizationId:scope(req)[0],legalEntityId:scope(req)[1]})]);
export const adoptCanonicalDelegation=async(c,req,input,o)=>{
 const definition=input.definition;if(!validDelegationDefinition(definition)||definition.role!==req.user.activeRole||definition.delegateUserId===req.user.sub)fail('Choose an explicit different named delegate and current held role.',400);
 const fingerprint=capacityHash({actorId:req.user.sub,activeRole:req.user.activeRole,...input}),old=(await c.query('select d.*,r.created_at revoked_at,to_jsonb(r)revocation from canonical_delegations d left join canonical_delegation_revocations r on r.delegation_id=d.id where d.organization_id=$1 and d.legal_entity_id=$2 and d.delegator_user_id=$3 and d.request_id=$4',[...scope(req),req.user.sub,input.requestId])).rows[0];
 if(old){if(old.request_fingerprint!==fingerprint)fail('The adoption request has different content.');return{delegation:delegationView(old),replayed:true};}
 await context(c,req);const row=(await c.query('insert into canonical_delegations(id,organization_id,legal_entity_id,delegator_user_id,definition,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9)returning *',[randomUUID(),...scope(req),req.user.sub,definition,input.requestId,fingerprint,input.reason,req.operationId])).rows[0];
 await o.audit(c,req,{module:'Approvals',action:'Adopt Prospective Canonical Delegation',entityType:'CanonicalDelegation',entityId:row.id,newValue:delegationView(row),reason:input.reason,details:'Explicit future-instance UTC substitution within both existing roles and source scopes; no grant or impersonation.'});return{delegation:delegationView(row),replayed:false};
};
export const revokeCanonicalDelegation=async(c,req,id,input,o)=>{
 const d=(await c.query('select * from canonical_delegations where id=$1 and organization_id=$2 and legal_entity_id=$3 and delegator_user_id=$4',[id,...scope(req),req.user.sub])).rows[0];if(!d)fail('Owned delegation is unavailable.',404);
 const fingerprint=capacityHash({id,actorId:req.user.sub,activeRole:req.user.activeRole,...input}),old=(await c.query('select * from canonical_delegation_revocations where delegation_id=$1',[id])).rows[0];
 if(old){if(old.request_id!==input.requestId||old.request_fingerprint!==fingerprint)fail('A different revocation already exists. Read history.');return{delegation:delegationView({...d,revoked_at:old.created_at,revocation:old}),replayed:true};}
 await context(c,req);const revoked=(await c.query('insert into canonical_delegation_revocations(id,delegation_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8)returning *',[randomUUID(),id,req.user.sub,req.user.activeRole,input.requestId,fingerprint,input.reason,req.operationId])).rows[0];
 const view=delegationView({...d,revoked_at:revoked.created_at,revocation:revoked});await o.audit(c,req,{module:'Approvals',action:'Revoke Canonical Delegation',entityType:'CanonicalDelegation',entityId:id,newValue:view,reason:input.reason,details:'Future delegated decisions denied; prior source/actor/clock/receipt evidence retained.'});return{delegation:view,replayed:false};
};
