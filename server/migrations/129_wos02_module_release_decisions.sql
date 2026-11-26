create table module_release_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id),
  environment text not null check (environment ~ '^[a-z][a-z0-9_-]{0,62}$'),
  module text not null check (module in ('teams','leave','notifications','entra','planning')),
  revision integer not null check (revision > 0),
  enabled boolean not null,
  evidence text not null check (length(btrim(evidence)) between 1 and 1000),
  owner_id uuid not null references users(id),
  activated_at timestamptz not null default clock_timestamp(),
  unique (organization_id, environment, module, revision)
);

create function prevent_module_release_edit() returns trigger language plpgsql as $$
begin
  raise exception 'Record a new module release decision to change its state';
end;
$$;
create trigger module_release_history before update or delete on module_release_decisions
for each row execute function prevent_module_release_edit();

insert into permission_definitions(permission_key, module, label, description, protected)
values ('releases.manage', 'Admin', 'Manage module releases',
        'Record activation decisions for optional modules in the current organization and environment.', true);
insert into role_permissions(role_name, permission_key, enabled)
values ('Admin', 'releases.manage', true);
