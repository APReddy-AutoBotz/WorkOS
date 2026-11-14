-- WOS-03: organization-owned audit records have no legal-entity owner.
-- Preserve all existing rows and allow only null/null, organization/null, or
-- organization/legal-entity scope combinations.
alter table audit_logs drop constraint audit_logs_scope_pair_check;
alter table audit_logs add constraint audit_logs_scope_pair_check
  check (legal_entity_id is null or organization_id is not null);
alter table audit_logs add constraint audit_logs_scope_organization_fk
  foreign key (organization_id) references organizations(id) on delete restrict;

insert into permission_definitions(permission_key, module, label, description, protected)
values (
  'audit.organization.view',
  'Admin',
  'Organization Audit View',
  'Read organization-scoped audit records through an explicit per-organization user grant.',
  true
)
on conflict (permission_key) do update set
  module = excluded.module,
  label = excluded.label,
  description = excluded.description,
  protected = true;

insert into role_permissions(role_name, permission_key, enabled)
select r.role_name, 'audit.organization.view', false
from (values ('Admin'), ('HR'), ('CountryDirector'), ('ProjectManager'), ('TeamLead'), ('Employee')) as r(role_name)
on conflict (role_name, permission_key) do update set
  enabled = false,
  updated_by = null,
  updated_at = now();

create table organization_audit_grants (
  id text primary key default ('organization-audit-grant-' || gen_random_uuid()::text),
  organization_id text not null references organizations(id) on delete restrict,
  user_id uuid not null references users(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  granted_by_active_role text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_audit_grants_user_org_idx
  on organization_audit_grants (user_id, organization_id);
