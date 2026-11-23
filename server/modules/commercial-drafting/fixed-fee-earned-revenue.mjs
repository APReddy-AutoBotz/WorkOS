import {decimalDifference} from '../../../shared/work-hours.mjs';

// An elapsed policy can change coverage only at a term or lifecycle boundary.
// Count applicable days by interval, and verify each retained daily value separately.
export async function earnedRevenue(client,args,currency,expectedRevenue) {
  const {rows:[coverage]}=await client.query(`with terms as (
    select effective_on,starts_on,ends_on from commercial_amendments where organization_id=$1
      and legal_entity_id=$2 and entity_type='Engagement' and entity_id=$3 and effective_on<=$4::date
  ), boundaries as (
    select $4::date+1 day union select effective_on from terms union select starts_on from terms
    union select ends_on+1 from terms where ends_on<$4::date
    union select l.effective_on from commercial_lifecycle_events l join commercial_engagements e
      on e.organization_id=l.organization_id and e.legal_entity_id=l.legal_entity_id and e.id=$3
    where l.organization_id=$1 and l.legal_entity_id=$2 and l.effective_on<=$4::date
      and ((l.entity_type='Engagement' and l.entity_id=e.id) or (l.entity_type='Contract' and l.entity_id=e.contract_id))
  ), spans as (
    select day,lead(day) over(order by day) until_day from boundaries where day<=$4::date+1
  ), eligible as (
    select coalesce(sum(until_day-day),0)::int days from spans
    where until_day is not null and fixed_fee_elapsed_report($1,$2,$3,day) is not null
  ), latest as (
    select distinct on (service_day) service_day,report from commercial_fixed_fee_elapsed_values
      where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and service_day<=$4::date
      order by service_day,version desc
  ), evidence as materialized (
    select report,fixed_fee_elapsed_report($1,$2,$3,service_day) applicable from latest
  ), totals as (
    select count(applicable)::int present,count(*) filter(where report is distinct from applicable or report->>'currency'<>$5)::int stale,
      trim_scale(sum((report->>'amount')::numeric))::text amount from evidence
  )
  select days as "applicableDays",days-present as "missingDays",stale as "staleDays",
    case when days>0 and days=present and stale=0 then amount end as "earnedAmount" from eligible cross join totals`,[...args,currency]);
  return {...coverage,remainingRevenue:coverage.earnedAmount!==null && expectedRevenue!=null
    ? decimalDifference(expectedRevenue,coverage.earnedAmount) : null};
}
