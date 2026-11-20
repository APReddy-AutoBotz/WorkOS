// Project only the billing side of the retained valuation for this invoice line.
export async function readInvoiceLinePricing(client, batch, lineId) {
  const {rows} = await client.query(`
    select l.id as "lineId", l.batch_id as "batchId", v.id as "snapshotId",
      v.policy_id as "policyId", p.effective_from::text as "policyEffectiveFrom",
      v.billing_adoption_id as "billingAdoptionId", rc.id as "rateCandidateId",
      rc.effective_from::text as "rateFrom", rc.effective_to::text as "rateTo",
      v.source_evidence->>'workDate' as "workDate", v.result->>'version' as version,
      l.currency, v.result->>'hoursExact' as hours, v.result->>'billingRateExact' as rate,
      v.result->>'unroundedBillableExact' as "rawAmount", v.result->>'capAmount' as ceiling,
      coalesce(v.result->>'billableAfterCapExact',v.result->>'unroundedBillableExact') as "roundingBasis",
      p.definition->>'rounding' as rounding, (p.definition->>'precision')::int as precision,
      v.result->>'billableValue' as amount
    from invoice_draft_lines l
    join commercial_tm_valuations v on v.id=l.snapshot_id and v.organization_id=$3 and v.legal_entity_id=$4 and v.engagement_id=$5
    join commercial_tm_policy_versions p on p.id=v.policy_id and p.engagement_id=v.engagement_id
        and p.organization_id=v.organization_id and p.legal_entity_id=v.legal_entity_id
    join commercial_rate_adoptions a on a.id=v.billing_adoption_id and a.organization_id=$3 and a.legal_entity_id=$4
    join commercial_rate_candidates rc on rc.id=a.candidate_id and rc.kind='billing' and rc.organization_id=$3 and rc.legal_entity_id=$4
    where l.batch_id=$1 and l.id=$2 and l.currency=v.result->>'currency' and l.amount=(v.result->>'billableValue')::numeric
      and l.billing_evidence->>'policyId'=v.policy_id::text and l.billing_evidence->>'billingAdoptionId'=v.billing_adoption_id::text`,
    [batch.id,lineId,batch.organization_id,batch.legal_entity_id,batch.engagement_id]);
  return rows[0] ?? null;
}
