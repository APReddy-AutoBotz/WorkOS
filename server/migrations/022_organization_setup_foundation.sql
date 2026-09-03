-- WOS-02: organization, legal-entity and setup foundation.
-- This migration is append-only and safe for both fresh installs and WOS-01A upgrades.

create table if not exists organizations (
  id text primary key,
  code text not null unique,
  name text not null,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists legal_entities (
  id text primary key,
  organization_id text not null references organizations(id) on delete restrict,
  code text not null,
  name text not null,
  country_code text,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  check (effective_to is null or effective_to >= effective_from)
);

insert into organizations (id, code, name, effective_from)
values ('org-default', 'DEFAULT', 'Default Organization', date '1970-01-01')
on conflict (id) do nothing;
insert into legal_entities (id, organization_id, code, name, effective_from)
values ('legal-default', 'org-default', 'DEFAULT', 'Default Legal Entity', date '1970-01-01')
on conflict (id) do nothing;

create table if not exists user_organization_scopes (
  user_id uuid not null references users(id) on delete cascade,
  organization_id text not null references organizations(id) on delete restrict,
  legal_entity_id text not null references legal_entities(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, organization_id, legal_entity_id)
);

insert into user_organization_scopes (user_id, organization_id, legal_entity_id)
select id, 'org-default', 'legal-default' from users
on conflict do nothing;

alter table employees add column if not exists organization_id text references organizations(id) on delete restrict;
alter table employees add column if not exists legal_entity_id text references legal_entities(id) on delete restrict;
alter table clients add column if not exists organization_id text references organizations(id) on delete restrict;
alter table clients add column if not exists legal_entity_id text references legal_entities(id) on delete restrict;
alter table projects add column if not exists organization_id text references organizations(id) on delete restrict;
alter table projects add column if not exists legal_entity_id text references legal_entities(id) on delete restrict;
alter table project_allocations add column if not exists organization_id text references organizations(id) on delete restrict;
alter table timesheets add column if not exists organization_id text references organizations(id) on delete restrict;

update employees set organization_id = 'org-default', legal_entity_id = 'legal-default'
where organization_id is null or legal_entity_id is null;
update clients set organization_id = 'org-default', legal_entity_id = 'legal-default'
where organization_id is null or legal_entity_id is null;
update projects set organization_id = 'org-default', legal_entity_id = 'legal-default'
where organization_id is null or legal_entity_id is null;
update project_allocations pa set organization_id = p.organization_id from projects p
where pa.project_id = p.id and pa.organization_id is null;
update timesheets t set organization_id = e.organization_id from employees e
where t.employee_id = e.id and t.organization_id is null;

alter table employees alter column organization_id set not null;
alter table employees alter column legal_entity_id set not null;
alter table clients alter column organization_id set not null;
alter table clients alter column legal_entity_id set not null;
alter table projects alter column organization_id set not null;
alter table projects alter column legal_entity_id set not null;
alter table project_allocations alter column organization_id set not null;
alter table timesheets alter column organization_id set not null;

alter table employees drop constraint if exists employees_employee_id_key;
alter table employees drop constraint if exists employees_email_key;
alter table clients drop constraint if exists clients_name_key;
alter table projects drop constraint if exists projects_project_code_key;
create unique index if not exists uq_employees_org_employee_id on employees(organization_id, employee_id);
create unique index if not exists uq_employees_org_email on employees(organization_id, lower(email));
create unique index if not exists uq_clients_org_name on clients(organization_id, lower(name));
create unique index if not exists uq_projects_org_code on projects(organization_id, project_code);
create index if not exists idx_projects_org_legal on projects(organization_id, legal_entity_id);
create index if not exists idx_employees_org_legal on employees(organization_id, legal_entity_id);

create table if not exists organization_catalog_items (
  id text primary key default ('org-item-' || gen_random_uuid()::text),
  organization_id text not null references organizations(id) on delete restrict,
  legal_entity_id text references legal_entities(id) on delete restrict,
  catalog_type text not null check (catalog_type in ('business_unit','department','cost_centre','practice','location','region','worker_type')),
  code text not null,
  name text not null,
  parent_id text references organization_catalog_items(id) on delete restrict,
  active boolean not null default true,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, catalog_type, code, effective_from),
  check (effective_to is null or effective_to >= effective_from),
  check (parent_id is null or parent_id <> id)
);
create index if not exists idx_org_catalog_lookup on organization_catalog_items(organization_id, catalog_type, active, effective_from desc);

create table if not exists working_calendars (
  id text primary key default ('calendar-' || gen_random_uuid()::text),
  organization_id text not null references organizations(id) on delete restrict,
  legal_entity_id text references legal_entities(id) on delete restrict,
  code text not null,
  name text not null,
  timezone text not null default 'UTC',
  working_days smallint[] not null default array[1,2,3,4,5],
  hours_per_day numeric(5,2) not null default 8,
  effective_from date not null,
  effective_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, code, effective_from),
  check (hours_per_day > 0 and hours_per_day <= 24),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists reporting_periods (
  id text primary key default ('period-' || gen_random_uuid()::text),
  organization_id text not null references organizations(id) on delete restrict,
  legal_entity_id text references legal_entities(id) on delete restrict,
  code text not null,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'Open' check (status in ('Planned','Open','Locked','Closed')),
  created_at timestamptz not null default now(),
  unique (organization_id, code),
  check (ends_on >= starts_on)
);

create table if not exists terminology_versions (
  id text primary key default ('terms-' || gen_random_uuid()::text),
  organization_id text not null references organizations(id) on delete restrict,
  terms jsonb not null default '{}'::jsonb,
  effective_from date not null,
  effective_to date,
  created_by uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (organization_id, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists worker_profiles (
  employee_id text primary key references employees(id) on delete restrict,
  organization_id text not null references organizations(id) on delete restrict,
  legal_entity_id text not null references legal_entities(id) on delete restrict,
  worker_type_id text references organization_catalog_items(id) on delete restrict,
  working_calendar_id text references working_calendars(id) on delete restrict,
  lifecycle_status text not null default 'Active' check (lifecycle_status in ('Draft','Active','On Leave','Disabled','Exited')),
  effective_from date not null,
  effective_to date,
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists organization_history (
  id bigserial primary key, organization_id text not null references organizations(id) on delete restrict,
  effective_from date not null, effective_to date, snapshot jsonb not null,
  actor_id uuid references users(id) on delete restrict, created_at timestamptz not null default now(),
  unique (organization_id, effective_from), check (effective_to is null or effective_to >= effective_from)
);
create table if not exists worker_history (
  id bigserial primary key, employee_id text not null references employees(id) on delete restrict,
  organization_id text not null references organizations(id) on delete restrict,
  effective_from date not null, effective_to date, status text not null, snapshot jsonb not null,
  actor_id uuid references users(id) on delete restrict, created_at timestamptz not null default now(),
  unique (employee_id, effective_from), check (effective_to is null or effective_to >= effective_from)
);

insert into worker_profiles (employee_id, organization_id, legal_entity_id, lifecycle_status, effective_from)
select id, organization_id, legal_entity_id,
  case status when 'Exited' then 'Exited' when 'On Leave' then 'On Leave' else 'Active' end,
  coalesce(joining_date, created_at::date, date '1970-01-01')
from employees on conflict (employee_id) do nothing;
insert into worker_history (employee_id, organization_id, effective_from, status, snapshot)
select e.id, e.organization_id, wp.effective_from, wp.lifecycle_status, to_jsonb(e)
from employees e join worker_profiles wp on wp.employee_id=e.id on conflict do nothing;

insert into organization_history (organization_id, effective_from, snapshot)
select id, effective_from, to_jsonb(o) from organizations o on conflict do nothing;

create index if not exists idx_worker_history_resolution on worker_history(employee_id, effective_from desc, effective_to);
create index if not exists idx_calendar_resolution on working_calendars(organization_id, code, effective_from desc, effective_to);
