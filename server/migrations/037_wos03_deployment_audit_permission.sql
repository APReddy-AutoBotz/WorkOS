insert into permission_definitions(permission_key, module, label, description, protected)
values (
  'audit.deployment.view',
  'Admin',
  'Deployment Audit View',
  'Read null-scope deployment audit records through an explicit individual user grant.',
  true
)
on conflict (permission_key) do update set
  module = excluded.module,
  label = excluded.label,
  description = excluded.description,
  protected = true;

insert into role_permissions(role_name, permission_key, enabled)
select r.role_name, 'audit.deployment.view', false
from (values ('Admin'), ('HR'), ('CountryDirector'), ('ProjectManager'), ('TeamLead'), ('Employee')) as r(role_name)
on conflict (role_name, permission_key) do update set
  enabled = false,
  updated_by = null,
  updated_at = now();
