insert into role_permissions(role_name, permission_key, enabled)
values ('HR', 'imports.manage', false)
on conflict (role_name, permission_key) do update set
  enabled = false,
  updated_at = now();
