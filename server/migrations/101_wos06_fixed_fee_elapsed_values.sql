insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_elapsed.record','Commercial','Retain fixed-fee elapsed values','Retain the operational value of an approved fixed-fee service day.',false);

-- Difference of rounded cumulative amounts reconciles daily values to the rounded allocation.
create function fixed_fee_elapsed_amount(allocation numeric, digits integer, day_number integer, days integer)
returns numeric language sql immutable strict as $$
 select case when allocation>=0 and digits between 0 and 4 and day_number between 1 and days then
   trim_scale((div(2*allocation*power(10::numeric,digits)*day_number+days,2::numeric*days)
    -div(2*allocation*power(10::numeric,digits)*(day_number-1)+days,2::numeric*days))*power(0.1::numeric,digits)) end
$$;

create function fixed_fee_elapsed_report(org text,entity text,eng text,service_day date)
returns jsonb language sql stable as $$
 with terms as (
  select a.*,e.currency,l.id lifecycle_id,parent.id parent_lifecycle_id
  from commercial_engagements e
  join lateral (select * from commercial_amendments
    where organization_id=org and legal_entity_id=entity and entity_type='Engagement' and entity_id=eng
      and effective_on<=service_day order by sequence desc limit 1) a on true
  join lateral (select id,state from commercial_lifecycle_events where organization_id=org and legal_entity_id=entity
    and entity_type='Engagement' and entity_id=eng and effective_on<=service_day order by sequence desc limit 1) l on l.state='Active'
  join lateral (select id,state from commercial_lifecycle_events where organization_id=org and legal_entity_id=entity
    and entity_type='Contract' and entity_id=e.contract_id and effective_on<=service_day order by sequence desc limit 1) parent on parent.state='Active'
  where e.organization_id=org and e.legal_entity_id=entity and e.id=eng and e.model='fixed_fee'
    and service_day<=(now() at time zone 'UTC')::date and service_day between a.starts_on and a.ends_on
    and a.after_value->'terms'->>'elapsedTimePolicy' in ('0','1','2','3','4')
    and nullif(trim(a.approval_reference),'') is not null
 ), basis as (
  select *, (after_value->'terms'->>'elapsedTimePolicy')::int digits,
   (service_day-starts_on+1) day_number,(ends_on-starts_on+1) days from terms
 )
 select jsonb_build_object('serviceDay',service_day,'engagementId',eng,'policyVersion',id,'contractVersionId',contract_version_id,
 'lifecycleId',lifecycle_id,'parentLifecycleId',parent_lifecycle_id,'approvalReference',approval_reference,'policyOwner',actor_id,'effectiveFrom',effective_on,
 'startsOn',starts_on,'endsOn',ends_on,'currency',currency,'allocation',trim_scale(budget)::text,'precision',digits,
 'rounding','HALF_UP','profile','elapsed_service_days_v1','serviceDays',days,'dayNumber',day_number,
 'amount',fixed_fee_elapsed_amount(budget,digits,day_number,days)::text)
 from basis
$$;

create table commercial_fixed_fee_elapsed_values (
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 service_day date not null,version integer not null check(version>0),report jsonb not null,actor_id uuid not null references users(id),active_role text not null,
 operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),
 unique(organization_id,legal_entity_id,engagement_id,service_day,version)
);
create trigger immutable_fixed_fee_elapsed before update or delete on commercial_fixed_fee_elapsed_values
 for each row execute function reject_commercial_draft_rewrite();
create function complete_fixed_fee_elapsed() returns trigger language plpgsql as $$
begin
 if new.active_role in ('Employee','TeamLead','CountryDirector','ProjectManager') or
    exists(select from unnest(array['commercial.contracts.view','commercial.fixed_fee_cost.view','commercial.cost_candidates.view','employees.view','reports.view_utilization','commercial.fixed_fee_elapsed.record']) p
      where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,p) is not true)
    or new.version<>(select coalesce(max(v.version),0)+1 from commercial_fixed_fee_elapsed_values v where v.organization_id=new.organization_id and v.legal_entity_id=new.legal_entity_id and v.engagement_id=new.engagement_id and v.service_day=new.service_day and v.id<>new.id)
    or new.report is distinct from fixed_fee_elapsed_report(new.organization_id,new.legal_entity_id,new.engagement_id,new.service_day)
    or not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
      and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and entity_id=new.id::text
      and module='Commercial Drafting' and entity_type='Fixed Fee Elapsed Value' and action='Recorded' and source='Web'
      and new_value=jsonb_build_object('engagementId',new.engagement_id,'serviceDay',new.service_day,'policyVersion',new.report->>'policyVersion')) then
   raise exception 'Approved elapsed policy, recording authority and matching audit required' using errcode='MEC01';end if;
 return null;
end $$;
create constraint trigger complete_fixed_fee_elapsed after insert on commercial_fixed_fee_elapsed_values deferrable initially deferred
 for each row execute function complete_fixed_fee_elapsed();
