import {randomUUID} from 'node:crypto';

import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export async function retainerAssignments(client,req,command,audit) {
  await assertCommercialAuthority(client,req,'commercial.retainer_risk.configure');
  const {organizationId,legalEntityId}=req.organizationScope;
  const scope=[organizationId,legalEntityId,req.params.id];
  const terms=await client.query(`select 1 from commercial_contract_versions where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='retainer'`,scope);
  if (!terms.rowCount) fail(404,'RETAINER_UNAVAILABLE','The retainer version is unavailable.');
  const {rows:[last]}=await client.query(`select id,version,engagement_ids,actor_id,active_role,reason from retainer_risk_assignments
    where organization_id=$1 and legal_entity_id=$2 and contract_version_id=$3 order by version desc limit 1`,scope);
  const version=last?.version??0;
  if (command) {
    const ids=[...command.engagementIds].sort(),id=randomUUID();
    if (version!==command.expectedVersion) {
      if (!(version===command.expectedVersion+1 && last.actor_id===req.user.sub && last.active_role===req.user.activeRole
        && last.reason===command.reason && JSON.stringify(ids)===JSON.stringify(last.engagement_ids)))
        fail(409,'RETAINER_ASSIGNMENTS_CHANGED','Reload the current engagement assignments.');
    } else {
      await client.query("select set_config('workos.retainer_risk_assignment_context',$1,true)",[JSON.stringify({
        version:req.params.id,actor:req.user.sub,role:req.user.activeRole,operation:req.operationId,organization:organizationId,entity:legalEntityId})]);
      await client.query(`insert into retainer_risk_assignments(id,organization_id,legal_entity_id,contract_version_id,version,engagement_ids,actor_id,active_role,operation_id,reason)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,...scope,version+1,ids,req.user.sub,req.user.activeRole,req.operationId,command.reason]);
      await audit(client,req,{module:'Commercial Notifications',action:'Assign Retainer Risk Engagements',entityType:'Retainer Risk Assignment',
        entityId:id,oldValue:last?{versionId:last.id}:null,newValue:{versionId:id},details:'Scoped engagement relationships retained in the assignment version.',
        reason:'Buyer reason retained on the protected assignment.'});
    }
    return retainerAssignments(client,req);
  }
  const {rows}=await client.query(`select engagement_id as "engagementId",user_id is not null as "ownerAvailable"
    from retainer_risk_engagement_owners($1,$2,$3) order by engagement_id collate "C"`,scope);
  return {versionId:req.params.id,version,assignments:rows};
}
