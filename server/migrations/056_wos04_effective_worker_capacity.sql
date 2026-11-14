-- Explicit adopted capacity; never backfill from legacy40/5/52 estimates.
create function capacity_weekly_hours(value jsonb) returns numeric language sql immutable as $$
 select coalesce(sum(q::numeric),0) from jsonb_array_elements_text(value->'hoursByWeekdayExact')q;
$$;
create function valid_capacity_profile(value jsonb) returns boolean language plpgsql immutable as $$
declare q jsonb;baseline numeric;percentage numeric;
begin
 if jsonb_typeof(value) is distinct from 'object' or value-array['fullTimeWeeklyHoursExact','partTimePercentExact','hoursByWeekdayExact','utilizationEligible','workerGroupId','calendarOverrideId']<>'{}'::jsonb
   or not(value ?& array['fullTimeWeeklyHoursExact','partTimePercentExact','hoursByWeekdayExact','utilizationEligible','workerGroupId','calendarOverrideId']) then return false;end if;
 for q in select value->'fullTimeWeeklyHoursExact' union all select value->'partTimePercentExact' loop
  if jsonb_typeof(q) is distinct from 'string' or char_length(q#>>'{}')>100 or q#>>'{}' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' then return false;end if;
 end loop;
 baseline=(value->>'fullTimeWeeklyHoursExact')::numeric;percentage=(value->>'partTimePercentExact')::numeric;
 if baseline<=0 or baseline>168 or percentage<0 or percentage>100 or jsonb_typeof(value->'hoursByWeekdayExact') is distinct from 'array' or jsonb_array_length(value->'hoursByWeekdayExact')<>7 or jsonb_typeof(value->'utilizationEligible') is distinct from 'boolean' then return false;end if;
 for q in select * from jsonb_array_elements(value->'hoursByWeekdayExact') loop
  if jsonb_typeof(q) is distinct from 'string' or char_length(q#>>'{}')>100 or q#>>'{}' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' or (q#>>'{}')::numeric<0 or (q#>>'{}')::numeric>24 then return false;end if;
 end loop;
 for q in select value->'workerGroupId' union all select value->'calendarOverrideId' loop
  if q<>'null'::jsonb and (jsonb_typeof(q) is distinct from 'string' or char_length(q#>>'{}') not between 1 and 200 or btrim(q#>>'{}')<>q#>>'{}' or q#>>'{}' ~ '[\x01-\x1f\x7f-\x9f]') then return false;end if;
 end loop;
 return capacity_weekly_hours(value)=baseline*percentage/100;
exception when others then return false;
end $$;
create table worker_capacity_versions(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,employee_id text not null,
 sequence integer not null check(sequence>0),effective_from date not null,contract_version text not null check(contract_version='worker-capacity/1'),
 definition jsonb not null check(valid_capacity_profile(definition)),weekly_hours numeric not null check(weekly_hours=capacity_weekly_hours(definition)),
 worker_group_id text,calendar_override_id text,actor_id text not null,active_role text not null,source text not null check(source='Web'),
 reason text not null check(char_length(btrim(reason)) between 1 and 1000),created_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,employee_id) references employees(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,worker_group_id) references organization_catalog_items(organization_id,id) on delete restrict,
 foreign key(organization_id,calendar_override_id) references working_calendars(organization_id,id) on delete restrict,
 check((definition->>'workerGroupId') is not distinct from worker_group_id),check((definition->>'calendarOverrideId') is not distinct from calendar_override_id),
 unique(organization_id,legal_entity_id,employee_id,sequence),unique(organization_id,legal_entity_id,employee_id,effective_from)
);
create function guard_worker_capacity_version() returns trigger language plpgsql as $$
declare prior worker_capacity_versions;
begin
 perform 1 from employees where id=new.employee_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id for update;
 select * into prior from worker_capacity_versions where employee_id=new.employee_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.effective_from<(clock_timestamp() at time zone 'UTC')::date or (prior.id is not null and new.effective_from<=prior.effective_from) then raise exception 'Capacity profile version changed or is not prospective.' using errcode='WCP01';end if;
 if new.worker_group_id is not null and not exists(select 1 from organization_catalog_items g where g.id=new.worker_group_id and g.organization_id=new.organization_id and (g.legal_entity_id is null or g.legal_entity_id=new.legal_entity_id) and g.catalog_type='business_unit' and g.active and new.effective_from between g.effective_from and coalesce(g.effective_to,'infinity'::date)) then raise exception 'Capacity worker group is unavailable.' using errcode='WCP02';end if;
 if new.calendar_override_id is not null and not exists(select 1 from working_calendars c left join organization_catalog_items g on g.id=c.worker_group_id and g.organization_id=c.organization_id where c.id=new.calendar_override_id and c.organization_id=new.organization_id and c.active and new.effective_from between c.effective_from and coalesce(c.effective_to,'infinity'::date) and ((c.applicability_type='legal_entity' and c.legal_entity_id=new.legal_entity_id) or (c.applicability_type='worker_group' and (g.legal_entity_id is null or g.legal_entity_id=new.legal_entity_id)) or (c.applicability_type='country' and exists(select 1 from legal_entity_profile_versions p where p.legal_entity_id=new.legal_entity_id and p.organization_id=new.organization_id and p.country_code=c.country_code and p.status='Active' and new.effective_from between p.effective_from and coalesce(p.effective_to,'infinity'::date))))) then raise exception 'Capacity calendar override is unavailable.' using errcode='WCP02';end if;
 return new;
end $$;
create trigger guarded_worker_capacity_version before insert on worker_capacity_versions for each row execute function guard_worker_capacity_version();
create trigger immutable_worker_capacity_version before update or delete on worker_capacity_versions for each row execute function reject_commercial_draft_rewrite();
create table worker_capacity_evidence(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,employee_id text not null,sequence integer not null check(sequence>0),
 starts_on date not null,ends_on date not null check(ends_on>=starts_on and ends_on-starts_on<366),calculation_version text not null check(calculation_version='worker-capacity/1'),
 input_canonical text not null check(jsonb_typeof(input_canonical::jsonb)='object'),source_token text not null check(source_token=encode(digest(convert_to(input_canonical,'UTF8'),'sha256'),'hex')),
 result jsonb not null check(coalesce(jsonb_typeof(result)='object' and result ?& array['calculationVersion','employeeId','startsOn','endsOn','sourceToken','totals','days','status','profileIds','reasonCodes'] and result->>'calculationVersion'=calculation_version and result->>'employeeId'=employee_id and result->>'startsOn'=to_char(starts_on,'YYYY-MM-DD') and result->>'endsOn'=to_char(ends_on,'YYYY-MM-DD') and result->>'sourceToken'=source_token,false)),
 actor_id text not null,active_role text not null,source text not null check(source='Web'),reason text not null check(char_length(btrim(reason)) between 1 and 1000),created_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,employee_id) references employees(organization_id,legal_entity_id,id) on delete restrict,
 unique(organization_id,legal_entity_id,employee_id,sequence)
);
create trigger immutable_worker_capacity_evidence before update or delete on worker_capacity_evidence for each row execute function reject_commercial_draft_rewrite();
