// Classify each immutable register item once using its current occupancy.
// Cancelled batches have already released their occupancy. Credits retain their sign.
export async function readFixedFeeBillingBalances(client, scope, engagementId) {
  const args = [...scope, engagementId];
  const engagement = await client.query(
    "select id from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='fixed_fee'", args);
  if (!engagement.rowCount) return null;

  const {rows} = await client.query(`
    with register as (
      select ev.currency, ev.amount, ev.source_type,
        case when confirmation.id is not null then 'Confirmed'
             when artifact.id is not null then 'Exported'
             when occ.line_id is not null then 'Reserved'
             else 'Available' end as status
      from billing_eligibility_events ev
      join approved_unbilled_items item on item.event_id=ev.id and item.source_type=ev.source_type
        and item.organization_id=ev.organization_id and item.legal_entity_id=ev.legal_entity_id
      left join invoice_draft_occupancies occ on occ.item_id=item.id and occ.item_version=item.version
      left join invoice_csv_artifacts artifact on artifact.batch_id=occ.batch_id
        and artifact.organization_id=ev.organization_id and artifact.legal_entity_id=ev.legal_entity_id
      left join invoice_batch_confirmations confirmation on confirmation.artifact_id=artifact.id
        and confirmation.batch_id=occ.batch_id and confirmation.artifact_sha256=artifact.sha256
      where ev.organization_id=$1 and ev.legal_entity_id=$2 and ev.engagement_id=$3
        and (ev.source_type='FIXED_FEE_INSTALLMENT' or (ev.source_type='FULL_LINE_REVERSAL' and exists(
          select 1 from billing_eligibility_events original where original.id=ev.reverses_event_id
            and original.source_type='FIXED_FEE_INSTALLMENT' and original.organization_id=ev.organization_id
            and original.legal_entity_id=ev.legal_entity_id and original.engagement_id=ev.engagement_id
            and original.currency=ev.currency)))
    )
    select currency,status,count(*) filter(where source_type='FIXED_FEE_INSTALLMENT')::int as installments,
      count(*) filter(where source_type='FULL_LINE_REVERSAL')::int as credits,
      trim_scale(coalesce(sum(amount) filter(where source_type='FIXED_FEE_INSTALLMENT'),0))::text as gross,
      trim_scale(coalesce(sum(amount) filter(where source_type='FULL_LINE_REVERSAL'),0))::text as adjustments,
      trim_scale(sum(amount))::text as net
    from register group by currency,status order by currency,case status
      when 'Available' then 1 when 'Reserved' then 2 when 'Exported' then 3 else 4 end`,args);
  return rows;
}
