-- Deployment-wide policy. The buyer records the existing effective value on upgrade.
create table deployment_session_policy (
  singleton boolean primary key default true check (singleton),
  lifetime_ms bigint not null check (lifetime_ms between 1 and 8640000000000000)
);

create function audit_session_lifetime_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  previous_ms bigint;
  operator_role text := coalesce(nullif(current_setting('role'), 'none'), session_user);
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'The deployment session policy must be retained';
  end if;
  if tg_op = 'UPDATE' then
    previous_ms := old.lifetime_ms;
    if previous_ms = new.lifetime_ms then return null; end if;
  end if;
  insert into public.audit_logs
    (user_id, user_name, user_role, active_role, source, module, action, entity_type,
     entity_id, old_value, new_value, details, created_at)
  values (session_user, session_user, operator_role, operator_role, 'Database', 'Auth',
    'SetSessionLifetime', 'DeploymentSessionPolicy', 'production',
    case when previous_ms is not null then jsonb_build_object('lifetimeMs', previous_ms) end,
    jsonb_build_object('lifetimeMs', new.lifetime_ms), 'Recorded the production session lifetime.', clock_timestamp());
  return null;
end;
$$;

revoke all on function audit_session_lifetime_change() from public;

create trigger record_session_lifetime after insert or update on deployment_session_policy
  for each row execute function audit_session_lifetime_change();
create trigger retain_session_policy before delete or truncate on deployment_session_policy
  for each statement execute function audit_session_lifetime_change();
