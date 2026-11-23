import {decimalDifference} from '../../../shared/work-hours.mjs';

import {inspectProgressEvidence} from './fixed-fee-progress.mjs';

async function closingEvidence(client,req,scope,through,currency) {
  const {report,token,latest}=await inspectProgressEvidence(client,req,{through},scope);
  let status='matched';
  if (!report) status='inactive';
  else if (report.amount===null) status='incomplete';
  else if (!latest) status='missing';
  else if (latest.source_token!==token || latest.report.currency!==currency || latest.report.amount!==report.amount) status='stale';
  const earnedAmount=status==='matched'?latest.report.amount:null;
  return {status,latest,earnedAmount};
}

async function transitionPreview(client,terms,closing) {
  const {rows:[values]}=await client.query(`select trim_scale($1::numeric-$2::numeric)::text residual,
    trim_scale($2::numeric+fixed_fee_progress_amount($1::numeric-$2::numeric,$3,$4,$5))::text amount
    where $1::numeric >= $2::numeric`,[terms.allocation,closing.earnedAmount,terms.elapsed,terms.days,terms.digits]);
  if (!values?.amount) return {closingStatus:'incompatible'};
  return {preview:{policyId:terms.id,closingDate:terms.closingDate,snapshotId:closing.latest.id,
    closingAmount:closing.earnedAmount,residual:values.residual,amount:values.amount,startsOn:terms.startsOn,endsOn:terms.endsOn}};
}

async function transitionTerms(client,args) {
  const {rows:[terms]}=await client.query(`select policy id,closing_date::text as "closingDate",first_day::text as "startsOn",
    last_day::text as "endsOn",allocation::text,digits,currency,last_day-first_day+1 days,greatest(1,$4::date-first_day+1) elapsed
    from fixed_fee_transition_terms($1,$2,$3,$4::date)`,args);
  return terms;
}

async function reviewedTransition(client,terms,closing,args) {
  const result=await transitionPreview(client,terms,closing);
  if (!result.preview) return result;
  const {rows:[approval]}=await client.query(`select id from commercial_fixed_fee_transition_approvals
    where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and policy_id=$4 and snapshot_id=$5`,
    [...args.slice(0,3),terms.id,closing.latest.id]);
  return {preview:{...result.preview,approvalId:approval?.id??null}};
}

export async function policyRevenue(client,req,scope,args,currency,expectedRevenue) {
  const {rows:[history]}=await client.query(`select (array_agg(active order by sequence desc))[1] current,bool_or(active) previous
    from (select sequence,coalesce(after_value->'terms'->>'effortPolicy','disabled')<>'disabled' active
      from commercial_amendments where organization_id=$1 and legal_entity_id=$2 and entity_type='Engagement'
        and entity_id=$3 and effective_on<=$4::date) amendments`,args);
  if (history.current) {
    const {status,latest,earnedAmount}=await closingEvidence(client,req,scope,args[3],currency);
    let scheduled;
    if (earnedAmount!==null) {
      const terms=await transitionTerms(client,args);
      if (terms) scheduled=(await reviewedTransition(client,terms,{latest,earnedAmount},args)).preview;
    }
    return {profile:'effort',...(scheduled?{scheduled}:{}),status,version:latest?.version??null,snapshotId:latest?.id??null,earnedAmount,
      remainingRevenue:earnedAmount!==null && expectedRevenue!=null?decimalDifference(expectedRevenue,earnedAmount):null};
  }
  if (history.previous) {
    const result={profile:'transition',earnedAmount:null,remainingRevenue:null};
    const terms=await transitionTerms(client,args);
    if (!terms) return result;
    const closing=await closingEvidence(client,req,scope,terms.closingDate,currency);
    if (closing.earnedAmount===null) return {...result,closingStatus:closing.status};
    const reviewed=await reviewedTransition(client,terms,closing,args);
    if (!reviewed.preview?.approvalId) return {...result,...reviewed};
    const earnedAmount=reviewed.preview.amount;
    return {...result,...reviewed,earnedAmount,remainingRevenue:expectedRevenue!=null?decimalDifference(expectedRevenue,earnedAmount):null};
  }
  return {profile:'elapsed',...await earnedRevenue(client,args,currency,expectedRevenue)};
}

// An elapsed policy can change coverage only at a term or lifecycle boundary.
// Count applicable days by interval, and verify each retained daily value separately.
export async function earnedRevenue(client,args,currency,expectedRevenue) {
  const {rows:[coverage]}=await client.query(`with terms as (
    select effective_on,starts_on,ends_on from commercial_amendments where organization_id=$1
      and legal_entity_id=$2 and entity_type='Engagement' and entity_id=$3 and effective_on<=$4::date
  ), boundaries(day) as (
    select $4::date+1 union select effective_on from terms union select starts_on from terms
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
    case when days>0 and days=present and stale=0 and not exists(select from commercial_amendments
      where organization_id=$1 and legal_entity_id=$2 and entity_type='Engagement' and entity_id=$3 and effective_on<=$4::date
        and after_value->'terms'->>'effortPolicy' in ('0','1','2','3','4')) then amount end as "earnedAmount" from eligible cross join totals`,[...args,currency]);
  return {...coverage,remainingRevenue:coverage.earnedAmount!==null && expectedRevenue!=null
    ? decimalDifference(expectedRevenue,coverage.earnedAmount) : null};
}
