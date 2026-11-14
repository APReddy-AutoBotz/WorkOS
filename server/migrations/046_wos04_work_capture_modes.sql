-- Explicit scoped presentation enablement. No default adoption, grants or work rewrite.
create table work_capture_mode_versions (
 id text primary key,
 organization_id text not null,
 legal_entity_id text not null,
 sequence integer not null check(sequence>0),
 policy_version text not null check(policy_version='work-capture-modes/1'),
 enabled_modes text[] not null check(enabled_modes in (array['weekly'],array['daily'],array['weekly','daily'])),
 actor_id uuid not null references users(id) on delete restrict,
 active_role text not null, source text not null,
 correlation_id text not null, operation_id text not null,
 created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,sequence),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict
);
create trigger immutable_work_capture_modes before update or delete on work_capture_mode_versions
 for each row execute function reject_commercial_draft_rewrite();
create function validate_capture_mode_append() returns trigger language plpgsql as $$
declare latest integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 select sequence into latest from work_capture_mode_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(latest,0)+1 then
  raise exception 'Capture modes must append the next scoped version.' using errcode='WCM01';
 end if;
 return new;
end $$;
create trigger append_work_capture_modes before insert on work_capture_mode_versions
 for each row execute function validate_capture_mode_append();

-- A revision of the complete physical header and entries, not an authentication
-- token. PostgreSQL JSONB text preserves decimals that JavaScript cannot represent.
create function work_capture_write_token(target uuid) returns text language sql stable as $$
 select encode(digest(convert_to(jsonb_build_object('header',to_jsonb(t),'entries',
  coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from timesheet_entries e where e.timesheet_id=t.id),'[]'::jsonb))::text,'UTF8'),'sha256'),'hex')
 from timesheets t where t.id=target
$$;
