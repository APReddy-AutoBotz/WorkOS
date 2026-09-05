-- WOS-02: complete working-calendar applicability and holiday authority.
-- Existing legal-entity calendars retain their identifiers and worker links.

create extension if not exists btree_gist;

alter table working_calendars add column if not exists applicability_type text;
alter table working_calendars add column if not exists country_code text;
alter table working_calendars add column if not exists country_authority_legal_entity_id text;
alter table working_calendars add column if not exists worker_group_id text;

update working_calendars set applicability_type='legal_entity'
where applicability_type is null;
alter table working_calendars alter column applicability_type set not null;

create unique index if not exists uq_legal_entities_org_id_country
  on legal_entities(organization_id,id,country_code);
create unique index if not exists uq_organization_catalog_org_id
  on organization_catalog_items(organization_id,id);
create unique index if not exists uq_working_calendars_org_id
  on working_calendars(organization_id,id);

alter table working_calendars drop constraint if exists working_calendars_applicability_check;
alter table working_calendars add constraint working_calendars_applicability_check check (
  (applicability_type='legal_entity' and legal_entity_id is not null and country_code is null
    and country_authority_legal_entity_id is null and worker_group_id is null)
  or (applicability_type='country' and legal_entity_id is null and country_code ~ '^[A-Z]{2}$'
    and country_authority_legal_entity_id is not null and worker_group_id is null)
  or (applicability_type='worker_group' and legal_entity_id is null and country_code is null
    and country_authority_legal_entity_id is null and worker_group_id is not null)
);
alter table working_calendars drop constraint if exists working_calendars_country_authority_fk;
alter table working_calendars add constraint working_calendars_country_authority_fk
  foreign key(organization_id,country_authority_legal_entity_id,country_code)
  references legal_entities(organization_id,id,country_code) on delete restrict;
alter table working_calendars drop constraint if exists working_calendars_worker_group_fk;
alter table working_calendars add constraint working_calendars_worker_group_fk
  foreign key(organization_id,worker_group_id)
  references organization_catalog_items(organization_id,id) on delete restrict;
create or replace function enforce_working_calendar_worker_group() returns trigger language plpgsql as $$
begin
  if new.applicability_type='worker_group' and not exists (
    select 1 from organization_catalog_items i
    where i.id=new.worker_group_id and i.organization_id=new.organization_id
      and i.catalog_type='business_unit' and i.active=true
  ) then
    raise exception 'Invalid authoritative worker group' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists working_calendars_worker_group_authority on working_calendars;
create trigger working_calendars_worker_group_authority before insert or update of organization_id,applicability_type,worker_group_id
  on working_calendars for each row execute function enforce_working_calendar_worker_group();

alter table working_calendars drop constraint if exists working_calendars_organization_id_code_effective_from_key;
drop index if exists uq_working_calendar_scope_version;
create unique index uq_working_calendar_scope_version on working_calendars(
  organization_id,applicability_type,coalesce(legal_entity_id,''),coalesce(country_code,''),
  coalesce(worker_group_id,''),code,effective_from
);
alter table working_calendars drop constraint if exists working_calendar_versions_no_overlap;
alter table working_calendars add constraint working_calendar_versions_no_overlap exclude using gist (
  organization_id with =,applicability_type with =,coalesce(legal_entity_id,'') with =,
  coalesce(country_code,'') with =,coalesce(worker_group_id,'') with =,code with =,
  daterange(effective_from,coalesce(effective_to + 1,'infinity'::date),'[)') with &&
);

create table if not exists working_calendar_holidays (
  id text primary key default ('calendar-holiday-version-' || gen_random_uuid()::text),
  holiday_id text not null default ('calendar-holiday-' || gen_random_uuid()::text),
  organization_id text not null,
  calendar_id text not null,
  holiday_date date not null,
  label text not null,
  holiday_type text not null check (holiday_type in ('Public','Company')),
  active boolean not null default true,
  effective_from date not null,
  effective_to date,
  created_by uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (length(btrim(label)) between 1 and 150),
  check (effective_to is null or effective_to >= effective_from),
  foreign key(organization_id,calendar_id) references working_calendars(organization_id,id) on delete restrict,
  unique(organization_id,calendar_id,holiday_id,effective_from)
);
alter table working_calendar_holidays drop constraint if exists working_calendar_holiday_date_authority_no_overlap;
alter table working_calendar_holidays add constraint working_calendar_holiday_date_authority_no_overlap exclude using gist (
  organization_id with =,calendar_id with =,holiday_date with =,
  daterange(effective_from,coalesce(effective_to + 1,'infinity'::date),'[)') with &&
) where (active);
create index if not exists idx_working_calendar_holiday_resolution
  on working_calendar_holidays(organization_id,calendar_id,holiday_date,effective_from desc);
