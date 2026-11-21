alter table public.users add column session_generation integer not null default 0
  check (session_generation >= 0);

-- Deployment-wide authority. Grant execution only to designated incident responders.
create function public.revoke_account_sessions(target uuid, expected_generation integer, incident_reference text)
returns integer language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  next_generation integer;
  operator_role text := coalesce(nullif(current_setting('role'), 'none'), session_user);
begin
  if incident_reference is null or length(trim(incident_reference)) not between 1 and 200 then
    raise exception 'An incident or change reference is required';
  end if;
  update public.users set session_generation = session_generation + 1
    where id = target and session_generation = expected_generation
    returning session_generation into next_generation;
  if not found then raise exception 'Account or expected session generation did not match'; end if;

  insert into public.audit_logs (user_id, user_name, user_role, active_role, source, module, action,
    entity_type, entity_id, old_value, new_value, reason, details, created_at)
  values (session_user, session_user, operator_role, operator_role, 'Database', 'Auth', 'RevokeAccountSessions',
    'User', target::text, jsonb_build_object('generation', expected_generation),
    jsonb_build_object('generation', next_generation), trim(incident_reference),
    'Revoked all existing application sessions for the account.', clock_timestamp());
  return next_generation;
end;
$$;
revoke all on function public.revoke_account_sessions(uuid, integer, text) from public;
