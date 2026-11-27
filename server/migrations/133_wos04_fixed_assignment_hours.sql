alter table project_allocations add column fixed_hours numeric
 check (fixed_hours is null or (fixed_hours >= 0 and length(trim_scale(fixed_hours)::text) <= 100 and fixed_hours < 'Infinity'::numeric and end_date - start_date between 0 and 365));

-- Existing percentage sources must retain the revision recorded by historical evidence.
create or replace function resource_assignment_revision(a project_allocations) returns text language sql stable as $$
 select encode(digest(convert_to((((case when a.fixed_hours is null then to_jsonb(a)-'fixed_hours' else to_jsonb(a) end)-array['start_date','end_date','created_at','updated_at']) || jsonb_build_object(
 'start_date',to_char(a.start_date,'YYYY-MM-DD'),'end_date',to_char(a.end_date,'YYYY-MM-DD'),
 'created_at',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'updated_at',to_char(a.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text,'UTF8'),'sha256'),'hex');
$$;

create or replace function assignment_version_snapshot(a project_allocations) returns jsonb language sql stable as $$
 select (resource_assignment_snapshot(a)-'percentageExact') || jsonb_build_object(
  'quantityUnit',case when a.fixed_hours is null then 'percentage' else 'hours' end,
  'quantityExact',trim_scale(coalesce(a.fixed_hours,a.percentage))::text);
$$;

alter table assignment_versions drop constraint assignment_versions_check,
 add constraint assignment_versions_snapshot_check check (
  jsonb_typeof(snapshot)='object' and snapshot->>'assignmentId'=assignment_id
  and snapshot->>'quantityUnit' in ('percentage','hours')
 );

-- A unit change is material whenever the buyer governs assignment quantity.
create or replace function assignment_requires_approval(before jsonb,after jsonb,d jsonb)
returns boolean language sql immutable as $$
 select exists(select 1 from jsonb_array_elements_text(d->'materialFields') k
  where before->k is distinct from after->k
  or (k='quantityExact' and before->'quantityUnit' is distinct from after->'quantityUnit'));
$$;

create or replace function valid_assignment_creation_definition(d jsonb)returns boolean language plpgsql immutable as $$
begin
 if jsonb_typeof(d)is distinct from'object'or(select count(*)from jsonb_object_keys(d))<>8 or not(d?&array['role','quantityUnit','quantityExact','startsOn','endsOn','billable','status','comment'])then return false;end if;
 return coalesce(d->>'quantityUnit' in ('hours','percentage')and jsonb_typeof(d->'quantityExact')='string'and length(d->>'quantityExact')between 1 and 100 and d->>'quantityExact'~'^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'and(d->>'quantityUnit'='hours' or (d->>'quantityExact')::numeric <= 200) and valid_capability_date(d->>'startsOn')and valid_capability_date(d->>'endsOn')and d->>'endsOn'>=d->>'startsOn'and jsonb_typeof(d->'billable')='boolean'and d->>'status'in('Active','Paused','Completed')and(d->'role'='null'::jsonb or(jsonb_typeof(d->'role')='string'and valid_capability_label(d->>'role')))and(d->'comment'='null'::jsonb or(jsonb_typeof(d->'comment')='string'and work_period_notice_units(d->>'comment')between 1 and 3000 and btrim(d->>'comment')=d->>'comment')),false);
exception when others then return false;end $$;
