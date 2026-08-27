insert into role_permissions(role_name, permission_key, enabled)
values ('Employee', 'allocations.view', false)
on conflict (role_name, permission_key) do update set
  enabled = false,
  updated_at = now();
