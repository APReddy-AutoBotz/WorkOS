import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
export const approvalBatchModel = async (c, r, batchId, includeRetainer=false, includeService=false) => {
  const row = (
    await c.query(
      `select e.model from invoice_draft_batches b join commercial_engagements e on e.id=b.engagement_id and e.organization_id=b.organization_id and e.legal_entity_id=b.legal_entity_id where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3 and coalesce(to_jsonb(b)->>'source_type','TM_SNAPSHOT') in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE'${includeRetainer ? ",'RETAINER_PERIOD'" : ''}${includeService ? ",'MANAGED_SERVICE_UNIT'" : ''})`,
      [batchId, r.organizationScope.organizationId, r.organizationScope.legalEntityId],
    )
  ).rows[0];
  if (!row) throw fail(404, 'INVOICE_APPROVAL_SOURCE', 'Scoped invoice batch unavailable.');
  return row.model;
};
export const milestoneBatchModel=async(c,r,id)=>(await approvalBatchModel(c,r,id))==='milestone';
export const loadMilestoneApprovalBatch = async (c, r, batchId, lock = false, model='milestone') => {
  const config={
    milestone:['milestone_invoice_batch_source_current','milestone_invoice_lineage_hash','MILESTONE_ACCEPTANCE','commercial.milestone_billing.view'],
    retainer:['retainer_invoice_batch_source_current','retainer_invoice_lineage_hash','RETAINER_PERIOD','commercial.retainer_eligibility.issue'],
    managed_service:['service_unit_invoice_batch_source_current','service_unit_invoice_lineage_hash','MANAGED_SERVICE_UNIT','commercial.service_units.issue'],
  }[model];
  if (!config) throw fail(404,'INVOICE_APPROVAL_SOURCE','Unsupported engagement.');
  const [current,lineage,source,permission]=config;
  await assertCommercialAuthority(c,r,permission);
  const b = (
    await c.query(
      `select b.*,b.period_start::text period_start,b.period_end::text period_end,invoice_batch_governed_state(b.id) state,${current}(b,$4,$5) current,${lineage}(b.id) lineage_hash from invoice_draft_batches b join commercial_engagements e on e.id=b.engagement_id and e.organization_id=b.organization_id and e.legal_entity_id=b.legal_entity_id where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3 and e.model=$6${lock ? ' for update of b' : ''}`,
      [
        batchId,
        r.organizationScope.organizationId,
        r.organizationScope.legalEntityId,
        r.user.sub,
        r.user.activeRole,model,
      ],
    )
  ).rows[0];
  if (!b || b.source_type !== source)
    throw fail(404, 'INVOICE_APPROVAL_SOURCE', 'Scoped invoice batch unavailable.');
  const lines = (
    await c.query(
      "select l.id,l.sequence,l.item_id,l.item_version,l.event_id,l.snapshot_id,l.source_type,l.currency,l.amount::text,l.billing_evidence from invoice_draft_lines l where l.batch_id=$1 and l.source_type=$2 order by l.sequence",
      [b.id,source],
    )
  ).rows;
  const sum = (
    await c.query(
      'select count(*)::int n,trim_scale(coalesce(sum(amount),0))::text total from invoice_draft_lines where batch_id=$1',
      [b.id],
    )
  ).rows[0];
  if (lines.length !== sum.n)
    throw fail(409, 'INVOICE_APPROVAL_SOURCE', 'Batch contains an unsupported source.');
  return { row: b, lines, sum };
};
