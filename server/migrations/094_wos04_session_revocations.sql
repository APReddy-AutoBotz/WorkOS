-- Identity sessions belong to a user across their authorized organization scopes.
-- Retain actor identifiers without a user FK so account deletion cannot erase revocation evidence.
create table session_revocations (
  session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null,
  active_role text not null,
  source text not null default 'Web' check (source = 'Web'),
  reason text not null default 'Logout' check (reason = 'Logout'),
  expires_at timestamptz not null,
  revoked_at timestamptz not null default clock_timestamp(),
  operation_id text
);
create index session_revocations_user_time on session_revocations(user_id, revoked_at);
create function reject_session_revocation_rewrite() returns trigger language plpgsql as $$
begin
  raise exception 'Session revocation evidence is append-only.' using errcode='55000';
end $$;
create trigger immutable_session_revocations before update or delete on session_revocations
for each row execute function reject_session_revocation_rewrite();
