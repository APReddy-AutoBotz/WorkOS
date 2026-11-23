import {z} from 'zod';
import {assertElapsedReadScope} from './fixed-fee-elapsed.mjs';
import {fail} from './contracts.mjs';

export const elapsedPeriodQuery=z.object({from:z.string().date(),through:z.string().date()}).strict()
  .refine(({from,through})=>from<=through && Date.parse(through)-Date.parse(from)<=365*86400000);

export async function reconcileElapsedPeriod(client,req,{from,through},scope) {
  await assertElapsedReadScope(client,req,scope);
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id,from,through];
  const {rows:[period]}=await client.query(`with engagement as (
    select currency from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3
      and model='fixed_fee' and $5::date<=(now() at time zone 'UTC')::date
  ), evidence as materialized (
    select e.currency,$4::date+i service_day,fixed_fee_elapsed_report($1,$2,$3,$4::date+i) applicable,
      s.id,s.version,s.report retained
    from engagement e cross join generate_series(0,$5::date-$4::date) i
    left join lateral (select id,version,report from commercial_fixed_fee_elapsed_values
      where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and service_day=$4::date+i
      order by version desc limit 1) s on true
  ), classified as (
    select *,case when retained is null then case when applicable is null then 'inapplicable' else 'missing' end
      when applicable is distinct from retained or retained->>'currency' is distinct from currency then 'stale'
      else 'matched' end status from evidence
  )
  select currency,count(*) filter(where status='matched')::int matched,count(*) filter(where status='missing')::int missing,
    count(*) filter(where status='stale')::int stale,count(*) filter(where status='inapplicable')::int inapplicable,
    case when bool_and(status in ('matched','inapplicable')) then trim_scale(sum((retained->>'amount')::numeric)
      filter(where status='matched'))::text end amount,
    jsonb_agg(jsonb_build_object('serviceDay',service_day,'status',status,'snapshotId',id,'version',version,
      'retainedAmount',retained->>'amount','applicableAmount',applicable->>'amount') order by service_day) days
  from classified group by currency`,args);
  if (!period) fail(404,'ELAPSED_PERIOD_UNAVAILABLE','Choose a scoped fixed-fee engagement and a period ending today or earlier.');
  return {engagementId:req.params.id,from,through,...period};
}
