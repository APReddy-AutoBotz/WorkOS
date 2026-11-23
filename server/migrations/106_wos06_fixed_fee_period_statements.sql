insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_statement.sign','Commercial','Sign fixed-fee period statements','Sign reconciled fixed-fee management balances for a locked reporting period.',false);

create table commercial_fixed_fee_statements(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 period_id text not null references reporting_periods(id),revision integer not null check(revision>0),version integer not null check(version>0),
 report jsonb not null,token text not null check(token ~ '^[0-9a-f]{64}$'),reason text not null check(length(trim(reason)) between 3 and 1000),
 reduction_explanation text check(length(trim(reduction_explanation)) between 3 and 1000),
 actor_id uuid not null references users(id),active_role text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),
 unique(organization_id,legal_entity_id,engagement_id,period_id,version),unique(organization_id,legal_entity_id,engagement_id,period_id,revision)
);
create trigger immutable_fixed_fee_statement before update or delete on commercial_fixed_fee_statements
 for each row execute function reject_commercial_draft_rewrite();

-- Both the live forecast and the signature constraint verify complete daily coverage.
create function fixed_fee_elapsed_coverage(text,text,text,date,text)
returns table("applicableDays" integer,"missingDays" integer,"staleDays" integer,"earnedAmount" text)
language sql stable as $$
with terms as (
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
        and after_value->'terms'->>'effortPolicy' in ('0','1','2','3','4')) then amount end as "earnedAmount" from eligible cross join totals
$$;

-- Resolve statement amounts from the pinned evidence under the same entity and date.
create function fixed_fee_statement_amount(org text,entity text,eng text,day date,balance jsonb,allow_opening boolean)
returns numeric language plpgsql stable as $$
declare result numeric; pinned_ids jsonb:=balance->'sources';
begin
 if balance->>'date' is distinct from day::text or jsonb_typeof(pinned_ids) is distinct from 'array' then return null; end if;
 case balance->>'profile'
 when 'before_service' then
   if allow_opening and pinned_ids='[]' and exists(select from commercial_engagements where organization_id=org and legal_entity_id=entity
       and id=eng and starts_on>day) and not exists(select from commercial_amendments where organization_id=org
       and legal_entity_id=entity and entity_type='Engagement' and entity_id=eng and starts_on<=day and effective_on<=day) then result:=0;end if;
 when 'effort' then
   select (report->>'amount')::numeric into result from (select * from commercial_fixed_fee_progress_values
     where organization_id=org and legal_entity_id=entity and engagement_id=eng and through_date=day order by version desc limit 1) v
     where pinned_ids=jsonb_build_array(v.id) and fixed_fee_progress_basis(org,entity,eng,day) =
       (report-array['billableHours','nonBillableHours','verifiedHours','entries','unresolved','amount']);
 when 'elapsed' then
   with latest as (select distinct on(service_day) id,service_day,report from commercial_fixed_fee_elapsed_values
     where organization_id=org and legal_entity_id=entity and engagement_id=eng and service_day<=day order by service_day,version desc)
   select (select "earnedAmount"::numeric from fixed_fee_elapsed_coverage(org,entity,eng,day,
     (select currency from commercial_engagements where organization_id=org and legal_entity_id=entity and id=eng))) into result from latest
     having jsonb_agg(id order by service_day)=pinned_ids;
 when 'transition' then
   select (v.report->>'amount')::numeric+fixed_fee_progress_amount(t.allocation-(v.report->>'amount')::numeric,
      day-t.first_day+1,t.last_day-t.first_day+1,t.digits) into result
   from fixed_fee_transition_terms(org,entity,eng,day) t join commercial_fixed_fee_transition_approvals a
     on a.organization_id=org and a.legal_entity_id=entity and a.engagement_id=eng and a.policy_id=t.policy
   join lateral(select id,report from commercial_fixed_fee_progress_values where organization_id=org and legal_entity_id=entity
      and engagement_id=eng and through_date=t.closing_date order by version desc limit 1) v on v.id=a.snapshot_id
   where pinned_ids=jsonb_build_array(a.id,v.id) and day>=t.first_day;
 else return null;
 end case;
 return result;
end $$;

create function complete_fixed_fee_statement() returns trigger language plpgsql as $$
declare p reporting_periods%rowtype; prior commercial_fixed_fee_statements%rowtype; opening numeric; closing numeric; currency_code text;
begin
 select * into p from reporting_periods where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.period_id for share;
 select currency into currency_code from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and id=new.engagement_id and model='fixed_fee';
 select * into prior from commercial_fixed_fee_statements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and engagement_id=new.engagement_id and period_id=new.period_id and id<>new.id order by version desc limit 1;
 opening:=fixed_fee_statement_amount(new.organization_id,new.legal_entity_id,new.engagement_id,p.starts_on-1,new.report->'opening',true);
 closing:=fixed_fee_statement_amount(new.organization_id,new.legal_entity_id,new.engagement_id,p.ends_on,new.report->'closing',false);
 if p.id is null or p.status not in ('Financially Locked','Closed') or p.ends_on>(now() at time zone 'UTC')::date or p.revision<>new.revision
 or new.report->'period' is distinct from jsonb_build_object('id',p.id,'revision',p.revision,'status',p.status,'startsOn',p.starts_on,
    'endsOn',p.ends_on,'opening',p.starts_on-1,'frequency',p.frequency)
 or currency_code is null or new.report->>'currency' is distinct from currency_code or new.report->>'engagementId' is distinct from new.engagement_id
 or opening is null or closing is null or ((closing<opening) is distinct from (new.reduction_explanation is not null)) or (new.report->'opening'->>'amount')::numeric is distinct from opening
 or (new.report->'closing'->>'amount')::numeric is distinct from closing or (new.report->>'movement')::numeric is distinct from closing-opening
 or new.version<>coalesce(prior.version,0)+1 or (prior.id is not null and not exists(select from audit_logs where organization_id=new.organization_id
    and legal_entity_id=new.legal_entity_id and module='Organization Setup' and entity_type='Reporting Period' and entity_id=p.id
    and action='Reopen Financial Period' and (new_value->>'revision')::int>prior.revision and (new_value->>'revision')::int<p.revision))
 or new.active_role in ('Employee','TeamLead','CountryDirector','ProjectManager') or exists(select from unnest(array['commercial.contracts.view',
   'commercial.fixed_fee_cost.view','commercial.cost_candidates.view','employees.view','reports.view_utilization','commercial.fixed_fee_statement.sign']) k
   where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k) is not true)
 or not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id::text
   and active_role=new.active_role and operation_id=new.operation_id and module='Commercial Drafting' and entity_type='Fixed Fee Period Statement'
   and entity_id=new.id::text and action='Signed' and source='Web' and new_value=jsonb_build_object('periodId',p.id,'revision',new.revision,
   'version',new.version,'token',new.token,'report',new.report,'reason',new.reason,'reductionExplanation',new.reduction_explanation))
 then raise exception 'Locked period, retained balances, signer and matching audit required' using errcode='MFS01';end if;
 return null;
end $$;
create constraint trigger complete_fixed_fee_statement after insert on commercial_fixed_fee_statements
 deferrable initially deferred for each row execute function complete_fixed_fee_statement();
