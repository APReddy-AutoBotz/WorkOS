-- WOS-02: effective-dated organization profile and legal-entity administration.
-- Profile facts are versioned so later administrative changes do not rewrite history.

create table if not exists organization_profile_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete restrict,
  name text not null,
  legal_name text not null,
  product_display_name text not null,
  support_contact text not null,
  default_locale text not null,
  default_time_zone text not null,
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  fiscal_year_start text not null check (fiscal_year_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  default_week_start smallint not null check (default_week_start between 0 and 6),
  effective_from date not null,
  effective_to date,
  created_by uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (organization_id, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);

alter table organization_profile_versions drop constraint if exists organization_profile_versions_no_overlap;
alter table organization_profile_versions add constraint organization_profile_versions_no_overlap
  exclude using gist (organization_id with =, daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') with &&);

insert into organization_profile_versions
  (organization_id, name, legal_name, product_display_name, support_contact, default_locale,
   default_time_zone, base_currency, fiscal_year_start, default_week_start, effective_from)
select o.id, o.name, o.name, o.name, 'support@example.invalid', 'en-US', 'UTC', 'USD', '01-01', 1, o.effective_from
from organizations o
where not exists (select 1 from organization_profile_versions p where p.organization_id=o.id);

create table if not exists legal_entity_profile_versions (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id text not null,
  organization_id text not null,
  legal_name text not null,
  registration_identifier text,
  tax_identifier text,
  reporting_currency text not null check (reporting_currency ~ '^[A-Z]{3}$'),
  address jsonb not null check (jsonb_typeof(address)='object'),
  effective_from date not null,
  effective_to date,
  created_by uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (legal_entity_id, effective_from),
  foreign key (organization_id, legal_entity_id)
    references legal_entities(organization_id, id) on delete restrict,
  check (effective_to is null or effective_to >= effective_from)
);

alter table legal_entity_profile_versions drop constraint if exists legal_entity_profile_versions_no_overlap;
alter table legal_entity_profile_versions add constraint legal_entity_profile_versions_no_overlap
  exclude using gist (legal_entity_id with =, daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') with &&);

insert into legal_entity_profile_versions
  (legal_entity_id, organization_id, legal_name, reporting_currency, address, effective_from)
select le.id, le.organization_id, le.name, 'USD',
  jsonb_build_object('line1','Not configured','city','Not configured','countryCode',coalesce(le.country_code,'US')),
  le.effective_from
from legal_entities le
where not exists (select 1 from legal_entity_profile_versions p where p.legal_entity_id=le.id);

create unique index if not exists uq_legal_entity_registration_identity
  on legal_entity_profile_versions (organization_id, registration_identifier)
  where registration_identifier is not null and effective_to is null;
create unique index if not exists uq_legal_entity_tax_identity
  on legal_entity_profile_versions (organization_id, tax_identifier)
  where tax_identifier is not null and effective_to is null;

create index if not exists idx_organization_profile_resolution
  on organization_profile_versions (organization_id, effective_from desc);
create index if not exists idx_legal_entity_profile_resolution
  on legal_entity_profile_versions (organization_id, legal_entity_id, effective_from desc);
