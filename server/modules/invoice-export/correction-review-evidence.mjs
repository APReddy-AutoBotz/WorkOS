import { z } from 'zod';

const ids=z.object({originalId:z.string().uuid(),batchId:z.string().uuid()}).strict();
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode,code:'CORRECTION_REVIEW_EVIDENCE'});

export function registerCorrectionReviewEvidence(router,{handle,authorize,batch,envelope}){
  router.get('/batches/:originalId/correction-drafts/:batchId',handle(false,async(c,r)=>{
    if(!ids.safeParse(r.params).success || Object.keys(r.query).length) throw fail(400,'Select an original export and correction batch.');
    await authorize(c,r,'reversal');
    const {row:original}=await batch(c,r,r.params.originalId);
    const {batchId}=r.params;
    const header=(await c.query(
      `select b.id as "batchId", b.engagement_id as "engagementId", b.currency, b.owner_user_id as "ownerId",
        b.owner_role as "ownerRole", invoice_draft_owner_current(b) as "ownerCurrent",
        invoice_batch_governed_state(b.id) as state, correction_batch_lineage_hash(b.id) as "lineageHash",
        b.period_start::text as "periodStart",b.period_end::text as "periodEnd",trim_scale(sum(l.amount))::text total
       from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id
       where b.source_type='FULL_LINE_REVERSAL' and b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3
       group by b.id having bool_and(l.billing_evidence->>'originalBatchId'=$4)`,
      [batchId,original.organization_id,original.legal_entity_id,original.id])).rows[0];
    if(!header) throw fail(404,'Correction batch unavailable.');
    const lines=(await c.query(
      `select l.id as "lineId", l.sequence,l.item_id as "itemId",l.item_version as "itemVersion",ev.id as "eventId",ev.version as "eventVersion",
        ev.eligible_on::text as "eligibleOn",trim_scale(l.amount)::text amount,l.currency,
        ev.reversal_decision_id as "decisionId",ev.reverses_event_id as "originalEventId",
        l.billing_evidence->>'originalLineId' as "originalLineId",l.billing_evidence->>'artifactId' as "artifactId",
        l.billing_evidence->>'artifactSha256' as "artifactSha256",o.line_id is not null as reserved
       from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id
       left join invoice_draft_occupancies o on o.batch_id=l.batch_id and o.line_id=l.id and o.item_id=l.item_id and o.item_version=l.item_version
       where l.batch_id=$1 order by l.sequence`,[batchId])).rows;
    return {...await envelope(c,r),originalId:original.id,header,lines};
  }));
}
