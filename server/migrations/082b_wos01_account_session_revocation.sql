-- Each account-wide event advances the generation exactly once. The existing
-- append-only guard retains the event independently of account lifecycle changes.
alter table public.session_revocations drop constraint session_revocations_source_check,
  drop constraint session_revocations_reason_check,
  add constraint session_revocation_kind check (
    (source = 'Web' and reason = 'Logout') or
    (source = 'Database' and reason = 'AccountRevocation' and expires_at = 'infinity')
  );
create index session_account_generation_idx on public.session_revocations(user_id)
  where reason = 'AccountRevocation';

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
  perform 1 from public.users where id = target for update;
  if not found then raise exception 'Account or expected session generation did not match'; end if;
  select count(*)::integer + 1 into next_generation from public.session_revocations
    where user_id = target and reason = 'AccountRevocation';
  if expected_generation is distinct from next_generation - 1 then
    raise exception 'Account or expected session generation did not match';
  end if;
  insert into public.session_revocations(session_hash, user_id, active_role, source, reason, expires_at)
    values (encode(sha256(convert_to('account-generation:' || target || ':' || next_generation, 'UTF8')), 'hex'),
      target, operator_role, 'Database', 'AccountRevocation', 'infinity');

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
