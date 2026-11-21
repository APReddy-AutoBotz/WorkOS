import { loadScheduledApprovalBatch } from '../invoice-approval/milestone-batch.mjs';

// Uses the same scoped source predicate as review; the database still has to
// verify the final approval, byte content, occupancy, and actor at commit.
export const loadScheduledExportBatch = async (c, r, batchId, lock, model) => {
  const { row: b, sum } = await loadScheduledApprovalBatch(c, r, batchId, lock, model);
  const lines = (
    await c.query(
      `select l.id as "lineId",l.sequence,l.item_id as "itemId",l.item_version as "itemVersion",l.event_id as "eventId",l.source_type as "sourceType",l.currency,trim_scale(l.amount)::text amount,l.billing_evidence::text as "evidenceJson",ev.eligible_on::text as "eligibleDate" from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id and ev.source_type=l.source_type where l.batch_id=$1 and l.source_type=$2 order by l.sequence`,
      [b.id,b.source_type],
    )
  ).rows;
  if (lines.length !== sum.n)
    throw Object.assign(new Error('Batch contains an unsupported source.'), {
      statusCode: 409,
      code: 'INVOICE_CSV_SOURCE',
    });
  const source = {
    batchId: b.id,
    clientId: b.client_id,
    contractId: b.contract_id,
    engagementId: b.engagement_id,
    currency: b.currency,
    periodStart: b.period_start,
    periodEnd: b.period_end,
    periodBasis: b.period_basis,
    ownerUserId: b.owner_user_id,
    ownerRole: b.owner_role,
    lines,
  };
  const review =
    (
      await c.query(
        `select i.*,invoice_batch_approval_pin_current(i) current,t.id as final_transition_id from invoice_batch_approval_instances i join invoice_batch_approval_policies p on p.id=i.policy_id join invoice_batch_approval_transitions t on t.instance_id=i.id and t.sequence=jsonb_array_length(p.definition->'stages') and t.decision='Approved' where i.batch_id=$1 order by i.sequence desc limit 1`,
        [b.id],
      )
    ).rows[0] ?? null;
  if (model === 'fixed_fee' && lines.length) {
    const result = await c.query('select fixed_fee_invoice_csv_bytes(b) payload from invoice_draft_batches b where b.id=$1', [b.id]);
    source.payload = result.rows[0].payload;
  }
  return { row: b, source, review };
};
