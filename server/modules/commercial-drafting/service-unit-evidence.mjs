import {validServiceEffort} from '../../../shared/service-unit-effort.mjs';
import {canonicalHours} from '../../../shared/work-hours.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {reviewFields} from './service-unit-review.mjs';
import {fail} from './contracts.mjs';

export const captureGrant='commercial.service_units.capture';
export const captureCommand=z.object({
  versionId:z.string().min(1).max(160), serviceDate:z.string().date(),
  dimensionCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
  quantity:z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/).refine(value=>/[1-9]/.test(value)),
  effortHours:z.string().refine(validServiceEffort).transform(canonicalHours).optional(),
  sourceReference:z.string().trim().min(1).max(120)
}).strict();

const receipt=`id,engagement_id as "engagementId",version_id as "versionId",service_date::text as "serviceDate",
   dimension_code as "dimensionCode",quantity::text,source_reference as "sourceReference",created_at as "createdAt"`;

const evidenceReceipt=({effortHours,...record})=>effortHours===null?record:{...record,effortHours};

export const evidenceQuery=z.object({versionId:z.string().min(1).max(160),before:z.string().uuid().optional()}).strict();
export async function serviceUnitHistory(client,req,query) {
  const {organizationId,legalEntityId}=req.organizationScope;
  const {rows}=await client.query(`select ${receipt},
    case when effort_hours is not null and (
      (e.actor_id=$6 and service_unit_effort_recorder_current(e) and invoice_notice_actor_has(e.organization_id,e.legal_entity_id,$6,$7,'commercial.service_units.capture'))
      or invoice_notice_actor_has(e.organization_id,e.legal_entity_id,$6,$7,'commercial.service_units.decide'))
      then trim_scale(effort_hours)::text end as "effortHours",
    (select row_to_json(record) from (select ${reviewFields} from commercial_service_unit_reviews where evidence_id=e.id) record) as review from commercial_service_unit_evidence e
    where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and version_id=$4 and
    ($5::uuid is null or (created_at,id)<(select created_at,id from commercial_service_unit_evidence
     where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and version_id=$4 and id=$5))
    order by created_at desc,id desc limit 26`,[organizationId,legalEntityId,req.params.id,query.versionId,query.before??null,req.user.sub,req.user.activeRole]);
  return {records:rows.slice(0,25).map(evidenceReceipt),before:rows.length>25?rows[24].id:null};
}

export async function captureServiceUnits(client,req,input,audit) {
  const {organizationId,legalEntityId}=req.organizationScope;
  const keys=[organizationId,legalEntityId,req.params.id];
  const {rows:[eng]}=await client.query(`select contract_id from commercial_engagements
    where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='managed_service'`,keys);
  if (!eng) fail(404,'COMMERCIAL_NOT_FOUND','Managed-service engagement was not found.');
  const {rows:[prior]}=await client.query(`select ${receipt},trim_scale(effort_hours)::text as "effortHours",actor_id as actor,active_role as role,
    (effort_hours is null or service_unit_effort_recorder_current(e)) as "recorderCurrent"
    from commercial_service_unit_evidence e where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3
    and dimension_code=$4 and source_reference=$5`,[...keys,input.dimensionCode,input.sourceReference]);
  if (prior) {
    const {actor,role,recorderCurrent,...record}=prior;
    if (recorderCurrent && actor===req.user.sub && role===req.user.activeRole && input.quantity===record.quantity
      && (input.effortHours??null)===record.effortHours && input.serviceDate===record.serviceDate && input.versionId===record.versionId) return evidenceReceipt(record);
    fail(409,'SERVICE_UNIT_REFERENCE_USED','That reference already has evidence for this unit.');
  }
  const id=randomUUID();
  await client.query("select set_config('workos.service_unit_evidence',$1,true)",[JSON.stringify({actor:req.user.sub,operation:req.operationId,id})]);
  const {rows:[record]}=await client.query(`insert into commercial_service_unit_evidence
    (organization_id,legal_entity_id,engagement_id,contract_id,version_id,service_date,dimension_code,quantity,source_reference,id,actor_id,active_role,operation_id,effort_hours)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning ${receipt},trim_scale(effort_hours)::text as "effortHours"`,
    [...keys,eng.contract_id,input.versionId,input.serviceDate,input.dimensionCode,input.quantity,input.sourceReference,id,req.user.sub,req.user.activeRole,req.operationId,input.effortHours??null]);
  await audit(client,req,{module:'Commercial Drafting',action:'Recorded',entityType:'Managed Service Evidence',entityId:id,
    oldValue:null,newValue:{engagementId:req.params.id,versionId:input.versionId,dimensionCode:input.dimensionCode,quantity:input.quantity,serviceDate:input.serviceDate,sourceReference:input.sourceReference,...(input.effortHours?{effortHours:input.effortHours}:{})},
    source:'Web',details:'Delivered service quantity recorded.'});
  return evidenceReceipt(record);
}
