insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_forecast.record','Commercial','Record fixed-fee forecasts','Retain remaining effort and labor cost estimates against inspected actuals.',false);

create table commercial_fixed_fee_forecasts (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, engagement_id text not null,
 through_date date not null, version integer not null check(version>0), request_id uuid not null,
 evidence_token text not null check(evidence_token ~ '^[0-9a-f]{64}$'),report jsonb not null,
 reason text not null check(length(trim(reason)) between 3 and 1000),actor_id uuid not null references users(id),
 active_role text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 check ((jsonb_typeof(report)='object' and report->>'engagementId'=engagement_id and (report->>'through')::date=through_date
   and report->>'currency' ~ '^[A-Z]{3}$' and report->>'remainingHours' ~ '^(0|[1-9][0-9]{0,13})([.][0-9]{1,4})?$'
   and report->>'remainingCost' ~ '^(0|[1-9][0-9]{0,13})([.][0-9]{1,4})?$'
   and jsonb_typeof(report->'hoursComplete')='boolean' and jsonb_typeof(report->'costComplete')='boolean'
   and (report->>'actualHours')::numeric>=0 and (report->>'actualCost')::numeric>=0
   and case when (report->>'hoursComplete')::boolean then (report->>'estimatedHours')::numeric=(report->>'actualHours')::numeric+(report->>'remainingHours')::numeric
     else report->'estimatedHours'='null'::jsonb end
   and case when (report->>'costComplete')::boolean then (report->>'estimatedCost')::numeric=(report->>'actualCost')::numeric+(report->>'remainingCost')::numeric
     else report->'estimatedCost'='null'::jsonb end) is true),
 unique(organization_id,legal_entity_id,engagement_id,through_date,version),
 unique(organization_id,legal_entity_id,actor_id,request_id),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create trigger immutable_fixed_fee_forecast before update or delete on commercial_fixed_fee_forecasts
 for each row execute function reject_commercial_draft_rewrite();
create function complete_fixed_fee_forecast() returns trigger language plpgsql as $$
begin
 if new.active_role in ('Employee','TeamLead','CountryDirector','ProjectManager') or
    exists(select from unnest(array['commercial.fixed_fee_forecast.record','employees.view','reports.view_utilization',
        'commercial.contracts.view','commercial.cost_candidates.view','commercial.fixed_fee_cost.view']) permission
      where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,permission) is not true)
    or not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
      and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and entity_id=new.id::text
      and module='Commercial Drafting' and entity_type='Fixed Fee Completion Forecast' and action='Recorded' and source='Web'
      and new_value=jsonb_build_object('engagementId',new.engagement_id,'through',new.through_date,'version',new.version)) then
   raise exception 'Current forecast authority and matching audit required' using errcode='MEC01';end if;
 return null;
end $$;
create constraint trigger complete_fixed_fee_forecast after insert on commercial_fixed_fee_forecasts deferrable initially deferred
 for each row execute function complete_fixed_fee_forecast();
