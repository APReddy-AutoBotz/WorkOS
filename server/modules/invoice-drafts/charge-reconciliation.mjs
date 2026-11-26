const chargePopulation = `where ev.organization_id=$1 and ev.legal_entity_id=$2 and ($3::text is null or ev.engagement_id=$3)
        and ($5::date is null or ev.eligible_on between $5 and $6)
        and (ev.source_type=$4 or (ev.source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') and exists(
          select 1 from billing_eligibility_events original where original.id=ev.reverses_event_id
            and original.source_type=$4 and original.organization_id=ev.organization_id
            and original.legal_entity_id=ev.legal_entity_id and original.engagement_id=ev.engagement_id
            and original.currency=ev.currency)))`;

// Classify each immutable register item once using its current occupancy.
// Cancelled batches have already released their occupancy. Credits retain their sign.
export async function readChargeBalances(client, scope, engagementId, source, model, range=null) {
  const args = [...scope,engagementId,source,range?.start ?? null,range?.end ?? null];
  if (engagementId!==null) {
    const engagement = await client.query(
    "select id from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3 and model=$4", [...scope,engagementId,model]);
    if (!engagement.rowCount) return null;
  }

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
      ${chargePopulation}
    )
    select currency,status,count(*) filter(where source_type=$4)::int as charges,
      count(*) filter(where source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT'))::int as credits,
      trim_scale(coalesce(sum(amount) filter(where source_type=$4),0))::text as gross,
      trim_scale(coalesce(sum(amount) filter(where source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT')),0))::text as adjustments,
      trim_scale(sum(amount))::text as net
    from register group by currency,status order by currency,case status
      when 'Available' then 1 when 'Reserved' then 2 when 'Exported' then 3 else 4 end`,args);
  return rows;
}

// Use the pinned installment schedule or approved reversal as the independent source.
// Compare before aggregating so an offsetting credit cannot conceal a bad charge.
const chargeSources = {
  FIXED_FEE_INSTALLMENT: `(select (v.installments->((ev.billing_evidence->>'installment')::int-1)->>'amount')::numeric amount,v.currency
    from commercial_contract_versions v where v.id=ev.billing_evidence->>'contractVersionId' and v.contract_id=ev.contract_id
      and v.organization_id=$1 and v.legal_entity_id=$2)`,
  RETAINER_PERIOD: `(select (s.evidence->'price'->'periodPrice'->>'total')::numeric as amount,v.currency
    from commercial_retainer_statements s join commercial_retainer_reviews r on r.statement_id=s.id
      and r.organization_id=s.organization_id and r.legal_entity_id=s.legal_entity_id
      and r.source_hash=s.source_hash and r.decision='Approved'
    join commercial_contract_versions v on v.id=s.version_id and v.contract_id=s.contract_id
      and v.organization_id=s.organization_id and v.legal_entity_id=s.legal_entity_id
    where s.organization_id=$1 and s.legal_entity_id=$2 and s.contract_id=ev.contract_id
      and s.id=(ev.billing_evidence->>'statementId')::uuid and r.id=ev.retainer_review_id)`,
  MANAGED_SERVICE_UNIT: `(select round(s.quantity*(unit->>'unitPrice')::numeric,(unit->>'billingPrecision')::int) as amount,v.currency
    from commercial_service_unit_evidence s join commercial_service_unit_reviews r on r.evidence_id=s.id and r.decision='Accepted'
    join commercial_contract_versions v on v.id=s.version_id and v.contract_id=s.contract_id
      and v.organization_id=s.organization_id and v.legal_entity_id=s.legal_entity_id
    cross join lateral jsonb_array_elements(v.service_dimensions) unit
    where s.organization_id=$1 and s.legal_entity_id=$2 and s.engagement_id=ev.engagement_id and s.contract_id=ev.contract_id
      and s.id=(ev.billing_evidence->>'evidenceId')::uuid and r.id=ev.service_review_id and unit->>'code'=s.dimension_code)`,
  MANAGED_SERVICE_PERIOD: `(select r.amount,r.currency from commercial_service_period_reviews r
    where r.organization_id=$1 and r.legal_entity_id=$2 and r.contract_id=ev.contract_id
      and r.id=ev.service_period_review_id and r.decision='Approved')`,
};

export async function readChargeControls(client, scope, engagementId, source, range=null) {
  const {rows} = await client.query(`
    with population as (
      select ev.* from billing_eligibility_events ev ${chargePopulation}
    ), batch_controls as (
      select l.batch_id,count(*) line_count,sum(l.amount) line_total
      from invoice_draft_lines l
      where l.organization_id=$1 and l.legal_entity_id=$2
        and l.batch_id in (
          select occ.batch_id from population ev
          join approved_unbilled_items item on item.event_id=ev.id and item.organization_id=$1 and item.legal_entity_id=$2
          join invoice_draft_occupancies occ on occ.item_id=item.id and occ.item_version=item.version
        )
      group by l.batch_id
    ), compared as (
      select ev.currency, ev.amount, ev.source_type,
        case when ev.source_type=$4 then charge.amount else credit.amount end as source_amount,
        case when ev.source_type=$4 then charge.currency else credit.currency end as source_currency,
        item.id as item_id, item.version=ev.version as item_matches,
        occ.line_id as occupied, l.id as line_id, l.amount as line_amount,l.currency as line_currency,
        l.event_id=ev.id and l.item_version=item.version and l.billing_evidence=ev.billing_evidence
          and l.eligibility_source_type=ev.source_type and l.batch_id=occ.batch_id as line_matches,
        b.id as batch_id,b.currency as batch_currency,
        art.id as artifact_id, art.total=bc.line_total and art.line_count=bc.line_count
          and art.currency=ev.currency and art.sha256=encode(digest(art.payload,'sha256'),'hex') as artifact_matches,
        cf.id as confirmation_id,cf.artifact_id=art.id and cf.artifact_sha256=art.sha256
          and cf.total=art.total and cf.currency=art.currency as confirmation_matches
      from population ev
      left join lateral ${chargeSources[source]} charge on ev.source_type=$4
      left join lateral invoice_credit_source(case when ev.source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT')
        then (ev.billing_evidence->>'reviewId')::uuid end) credit on credit.final_decision=ev.reversal_decision_id
        and credit.original_event=ev.reverses_event_id and credit.organization_id=$1
        and credit.legal_entity_id=$2 and credit.engagement_id=ev.engagement_id
      left join approved_unbilled_items item on item.event_id=ev.id and item.source_type=ev.source_type
        and item.organization_id=$1 and item.legal_entity_id=$2
      left join invoice_draft_occupancies occ on occ.item_id=item.id and occ.item_version=item.version
      left join invoice_draft_lines l on l.id=occ.line_id and l.item_id=item.id
        and l.organization_id=$1 and l.legal_entity_id=$2
      left join invoice_draft_batches b on b.id=occ.batch_id and b.organization_id=$1
        and b.legal_entity_id=$2 and b.engagement_id=ev.engagement_id and b.source_type=l.source_type
        and not exists(select 1 from invoice_draft_cancellations x where x.batch_id=b.id)
      left join batch_controls bc on bc.batch_id=occ.batch_id
      left join invoice_csv_artifacts art on art.batch_id=occ.batch_id and art.organization_id=$1 and art.legal_entity_id=$2
      left join invoice_batch_confirmations cf on cf.batch_id=occ.batch_id and cf.organization_id=$1 and cf.legal_entity_id=$2
    ), checks as (
    select currency,boundary,observed,matches
    from compared cross join lateral (values
      ('Source',true,case when source_currency=currency then source_amount end,source_currency=currency and source_amount=amount),
      ('Eligibility event',true,amount,true),
      ('Register item',true,case when item_id is not null then amount end,item_matches),
      ('Current occupancy',occupied is not null,amount,item_matches and line_id is not null),
      ('Current line',occupied is not null,case when line_currency=currency then line_amount end,line_matches and line_amount=amount and line_currency=currency),
      ('Batch membership',occupied is not null,case when batch_id is not null and batch_currency=currency then line_amount end,
        batch_id is not null and batch_currency=currency and line_matches and line_currency=currency and line_amount=amount),
      ('Exported line',artifact_id is not null,case when line_currency=currency then line_amount end,artifact_matches and line_matches and line_currency=currency and line_amount=amount),
      ('Confirmed line',confirmation_id is not null,case when line_currency=currency then line_amount end,confirmation_matches and artifact_matches and line_matches and line_currency=currency and line_amount=amount)
    ) as b(boundary,applicable,observed,matches)
    where applicable
    union all
    select ev.currency,'Released historical line',case when l.currency=ev.currency then l.amount end,
      cancelled.id is not null and l.amount=ev.amount and l.currency=ev.currency
        and l.event_id=ev.id and l.eligibility_source_type=ev.source_type and l.billing_evidence=ev.billing_evidence
    from population ev join approved_unbilled_items item on item.event_id=ev.id
      and item.organization_id=$1 and item.legal_entity_id=$2
    join invoice_draft_lines l on l.item_id=item.id and l.item_version=item.version
      and l.organization_id=$1 and l.legal_entity_id=$2
    left join invoice_draft_cancellations cancelled on cancelled.batch_id=l.batch_id
      and cancelled.organization_id=$1 and cancelled.legal_entity_id=$2
    where not exists(select 1 from invoice_draft_occupancies current where current.line_id=l.id)
    )
    select currency,boundary,count(*)::int as expected,
      count(observed)::int as observed,trim_scale(coalesce(sum(observed),0))::text as amount,
      count(*) filter(where matches is not true)::int as exceptions
    from checks group by currency,boundary order by currency,min(array_position(
      array['Source','Eligibility event','Register item','Current occupancy','Current line','Batch membership','Exported line','Confirmed line','Released historical line'],boundary))`, [...scope,engagementId,source,range?.start ?? null,range?.end ?? null]);
  return rows;
}
