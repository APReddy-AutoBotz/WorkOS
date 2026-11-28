-- Existing policy rows carry no deadline. Only an explicitly timed version starts a clock.
create function valid_approval_stage_duration(d jsonb) returns boolean
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case
    when not (d ? 'stageDueMinutes') then true
    when jsonb_typeof(d->'stageDueMinutes') is distinct from 'number' then false
    else (d->>'stageDueMinutes')::numeric between 1 and 2147483647
      and trunc((d->>'stageDueMinutes')::numeric)=(d->>'stageDueMinutes')::numeric
  end;
$$;

create or replace function valid_assignment_approval_definition(d jsonb)returns boolean language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
 if not valid_approval_stage_duration(d) or not valid_work_approval_definition((d-'stageDueMinutes'-'materialFields'-'creationRequired')||jsonb_build_object('entityType','Timesheet')) or d->>'entityType'is distinct from'Assignment' or jsonb_typeof(d->'materialFields')is distinct from'array' or jsonb_array_length(d->'materialFields')not between 0 and 7 or(jsonb_array_length(d->'materialFields')=0 and not(d?'creationRequired'))or(d?'creationRequired'and jsonb_typeof(d->'creationRequired')is distinct from'boolean') or length(d->>'locale')>100 then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'materialFields')v)<>jsonb_array_length(d->'materialFields')then return false;end if;
 for k in select jsonb_array_elements_text(d->'materialFields')loop if k not in('billable','comment','endsOn','quantityExact','role','startsOn','status')then return false;end if;end loop;return true;
exception when others then return false;end $$;

create or replace function valid_leave_approval_definition(d jsonb)returns boolean language sql immutable set search_path = pg_catalog, public, pg_temp as $$
 select coalesce(d->>'entityType'='LeaveRequest'and valid_approval_stage_duration(d) and valid_work_approval_definition((d-'stageDueMinutes')||jsonb_build_object('entityType','Timesheet')),false);
$$;
