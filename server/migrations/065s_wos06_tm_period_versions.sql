create table commercial_tm_period_versions (
  id uuid primary key,
  organization_id text not null,
  legal_entity_id text not null,
  engagement_id text not null,
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  sequence integer not null check (sequence > 0),
  calculation_version text not null check (calculation_version = 'tm-period-margin/1'),
  membership_key text not null check (membership_key ~ '^[0-9a-f]{64}$'),
  valuation_ids uuid[] not null check (cardinality(valuation_ids) > 0),
  worker_ids text[] not null check (cardinality(worker_ids) > 0),
  totals jsonb not null check (jsonb_typeof(totals) = 'array' and jsonb_array_length(totals) > 0),
  actor_id uuid not null references users(id),
  active_role text not null,
  operation_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),
  unique (organization_id,legal_entity_id,engagement_id,starts_on,ends_on,sequence),
  unique (organization_id,legal_entity_id,engagement_id,starts_on,ends_on,membership_key)
);
create trigger immutable_tm_period_version before update or delete on commercial_tm_period_versions
for each row execute function reject_commercial_draft_rewrite();

create function require_tm_period_audit() returns trigger language plpgsql as $$
begin
  if new.sequence <> (select coalesce(max(sequence),0)+1 from commercial_tm_period_versions
    where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id
    and starts_on=new.starts_on and ends_on=new.ends_on and id<>new.id) then
    raise exception 'Period sequence changed' using errcode='CTM03';
  end if;
  if not commercial_tm_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,false) then
    raise exception 'Current valuation authority required' using errcode='CTM01';
  end if;
  if not exists (
    with entries as (
      select v.id,v.result,t.employee_id from commercial_tm_valuations v
      join work_submission_evidence s on s.id=v.submission_id and s.organization_id=v.organization_id and s.legal_entity_id=v.legal_entity_id
      join timesheets t on t.id=s.timesheet_id and t.organization_id=s.organization_id and t.legal_entity_id=s.legal_entity_id
      where v.organization_id=new.organization_id and v.legal_entity_id=new.legal_entity_id and v.engagement_id=new.engagement_id
        and (v.source_evidence->>'workDate')::date between new.starts_on and new.ends_on
    ), by_currency as (
      select result->>'currency' currency,count(*) n,sum((result->>'hoursExact')::numeric) hours,
        sum((result->>'billableValue')::numeric) billable,sum((result->>'costValue')::numeric) cost,
        sum((result->>'marginValue')::numeric) margin from entries group by result->>'currency'
    ), checked as (
      select *, case when billable>0 then sign(margin)*(div(abs(margin)*10000,billable)
        + case when mod(abs(margin)*10000,billable)*2>=billable then 1 else 0 end) end as basis_points from by_currency
    )
    select 1 where (select array_agg(id order by id) from entries)=new.valuation_ids
      and (select count(distinct employee_id) from entries)=cardinality(new.worker_ids)
      and (select bool_and(employee_id=any(new.worker_ids)) from entries)
      and (select jsonb_agg(jsonb_build_object('currency',currency,'entryCount',n::text,'hours',hours::text,
        'billable',billable::text,'cost',cost::text,'margin',margin::text,'marginPercent',
        case when basis_points is not null then (trim_scale(basis_points) * 0.01)::text end) order by currency)
        from checked)=new.totals
  ) then raise exception 'Period membership or totals changed' using errcode='CTM03'; end if;
  if not exists (
    select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id
    and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.operation_id=new.operation_id
    and a.module='T&M Valuation' and a.action='Retain Period' and a.entity_id=new.id::text
    and a.new_value=jsonb_build_object('engagementId',new.engagement_id,'sequence',new.sequence,'membershipKey',new.membership_key)
  ) then raise exception 'Retained period requires matching audit evidence' using errcode='CTM03'; end if;
  return null;
end $$;
create constraint trigger complete_tm_period_version after insert on commercial_tm_period_versions
deferrable initially deferred for each row execute function require_tm_period_audit();
