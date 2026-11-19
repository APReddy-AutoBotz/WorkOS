import { createHash } from 'node:crypto';
import { CREDIT_CSV_SCHEMA,renderCreditCsv } from '../../../shared/correction-invoice-csv.mjs';
import { correctionBatchHeader } from '../invoice-approval/correction-batch.mjs';

export function correctionArtifact(source){
  const {text,...control}=renderCreditCsv(source);
  const bytes=Buffer.from(text,'utf8');
  return {...control,bytes,schemaVersion:CREDIT_CSV_SCHEMA,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export async function correctionExportBatch(c,r,id,lock){
  const row=await correctionBatchHeader(c,r,id,lock);
  if(!row) return null;
  if(!['Approved','Exported','Billed/Confirmed'].includes(row.state))throw Object.assign(new Error('Approved correction export unavailable.'),{statusCode:404,code:'CREDIT_EXPORT_SOURCE'});
  const lines=(await c.query(`select l.id as "lineId",l.sequence,l.item_id as "itemId",l.item_version as "itemVersion",ev.id as "eventId",
    ev.version as "eventVersion",ev.eligible_on::text as "eligibleDate",l.source_type as "sourceType",l.currency,trim_scale(l.amount)::text amount,
    ev.reversal_decision_id as "decisionId",ev.reverses_event_id as "originalEventId",l.billing_evidence->>'originalBatchId' as "originalBatchId",
    l.billing_evidence->>'artifactId' as "originalArtifactId",l.billing_evidence->>'artifactSha256' as "originalArtifactSha256",
    l.billing_evidence->>'originalLineId' as "originalLineId",(l.billing_evidence->>'originalItemVersion')::int as "originalItemVersion"
    from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id where l.batch_id=$1 order by l.sequence`,[id])).rows;
  const review=(await c.query(`select i.*,invoice_batch_approval_pin_current(i) current,t.id final_transition_id
    from invoice_batch_approval_instances i join invoice_batch_approval_policies p on p.id=i.policy_id
    join invoice_batch_approval_transitions t on t.instance_id=i.id and t.decision='Approved' and t.sequence=jsonb_array_length(p.definition->'stages')
    where i.batch_id=$1 order by i.sequence desc limit 1`,[id])).rows[0]??null;
  return {row,review,source:{batchId:id,clientId:row.client_id,contractId:row.contract_id,engagementId:row.engagement_id,currency:row.currency,periodStart:row.period_start,periodEnd:row.period_end,lines}};
}
