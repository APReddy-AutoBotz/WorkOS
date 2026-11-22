import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './contracts.mjs';

export const reviewGrant='commercial.service_units.decide';
export const reviewCommand=z.object({decision:z.enum(['Accepted','Rejected']),reason:z.string().trim().min(3).max(1000)}).strict();
export const reviewFields='id,evidence_id as "evidenceId",decision,reason,created_at as "createdAt"';

export async function reviewServiceUnits(client,req,input,audit) {
  const {organizationId,legalEntityId}=req.organizationScope;
  const {id:engagementId,evidenceId}=req.params;
  if (!z.string().uuid().safeParse(evidenceId).success) fail(400,'SERVICE_REVIEW_INVALID','Invalid evidence identifier.');
  const keys=[organizationId,legalEntityId,engagementId,evidenceId];
  const evidence=await client.query(`select id from commercial_service_unit_evidence
    where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and id=$4`,keys);
  if (!evidence.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','The recorded service evidence was not found.');
  const {rows:[prior]}=await client.query(`select ${reviewFields},actor_id,active_role from commercial_service_unit_reviews
    where evidence_id=$1`,[evidenceId]);
  if (prior) {
    const {actor_id,active_role,...record}=prior;
    if (actor_id===req.user.sub && active_role===req.user.activeRole && record.decision===input.decision && record.reason===input.reason) return record;
    fail(409,'SERVICE_UNIT_ALREADY_REVIEWED','A decision has already been recorded for this receipt.');
  }
  const id=randomUUID();
  await client.query("select set_config('workos.service_unit_review',$1,true)",[JSON.stringify({actor:req.user.sub,operation:req.operationId,id,evidence:evidenceId})]);
  const {rows:[record]}=await client.query(`insert into commercial_service_unit_reviews
    (organization_id,legal_entity_id,evidence_id,id,actor_id,active_role,operation_id,decision,reason)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${reviewFields}`,
    [organizationId,legalEntityId,evidenceId,id,req.user.sub,req.user.activeRole,req.operationId,input.decision,input.reason]);
  await audit(client,req,{module:'Commercial Drafting',action:input.decision,entityType:'Managed Service Review',entityId:id,
    oldValue:{status:'Pending'},newValue:{evidenceId,decision:input.decision,reason:input.reason},source:'Web',details:'Independent decision on delivered service units.'});
  return record;
}
