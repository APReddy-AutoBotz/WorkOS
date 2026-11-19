// A correction review uses the same original-export scope as credit inspection.
export const correctionScopeAvailable = async c => (await c.query(
  "select to_regprocedure('correction_original_scope_current(invoice_draft_batches,uuid,text)') is not null as available",
)).rows[0].available;

export async function correctionApprovalBatch(c,r,id,lock) {
  const {organizationId,legalEntityId}=r.organizationScope;
  const match=(await c.query(
    "select 1 from invoice_draft_batches b where id=$1 and organization_id=$2 and legal_entity_id=$3 and to_jsonb(b)->>'source_type'='FULL_LINE_REVERSAL'",
    [id,organizationId,legalEntityId])).rowCount;
  if(!match) return null;
  const row=(await c.query(
    `select b.*,b.period_start::text period_start,b.period_end::text period_end,invoice_batch_governed_state(b.id) state,
      invoice_batch_source_current(b) current,invoice_batch_lineage_hash(b.id) lineage_hash from invoice_draft_batches b
      where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3 and correction_original_scope_current(b,$4,$5)
      ${lock?'for update of b':''}`,[id,organizationId,legalEntityId,r.user.sub,r.user.activeRole])).rows[0];
  if(!row) throw Object.assign(new Error('Scoped correction batch unavailable.'),{statusCode:404,code:'INVOICE_APPROVAL_SOURCE'});
  const lines=(await c.query(
    `select id,sequence,item_id,item_version,event_id,snapshot_id,source_type,currency,trim_scale(amount)::text amount,billing_evidence
     from invoice_draft_lines where batch_id=$1 order by sequence`,[id])).rows;
  const sum=(await c.query('select count(*)::int n,trim_scale(sum(amount))::text total from invoice_draft_lines where batch_id=$1',[id])).rows[0];
  return {row,lines,sum};
}
