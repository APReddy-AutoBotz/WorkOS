insert into role_permissions(role_name, permission_key, enabled)
values ('TeamLead', 'projects.view', true)
on conflict (role_name, permission_key) do update set
  enabled = true,
  updated_at = now();
