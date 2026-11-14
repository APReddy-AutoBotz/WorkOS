-- No backfill, commercial valuation, default grant or historical pin inference.
create table work_submission_evidence (
 id text primary key,organization_id text not null,legal_entity_id text not null,
 timesheet_id uuid not null references timesheets(id) on delete restrict,
 sequence integer not null check(sequence>0),policy_version text not null check(policy_version='assignment-work-date/1'),
 entries jsonb not null check(jsonb_typeof(entries)='array' and jsonb_array_length(entries) between 1 and 100),
 period_references jsonb not null check(jsonb_typeof(period_references)='array'),
 actor_id uuid not null references users(id) on delete restrict,active_role text not null,source text not null,
 correlation_id text not null,operation_id text not null,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,timesheet_id,sequence),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict
);
create trigger immutable_work_submission_evidence before update or delete on work_submission_evidence
 for each row execute function reject_commercial_draft_rewrite();
create function validate_work_submission_scope() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from timesheets where id=new.timesheet_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and status='Submitted') then
  raise exception 'Submitted work scope is unavailable.' using errcode='23514';end if;
 return new;
end $$;
create trigger validate_work_submission_evidence before insert on work_submission_evidence for each row execute function validate_work_submission_scope();
-- New retained submissions cannot be rewritten by another current/future writer.
-- Rejection may move the source to correction; prior evidence remains immutable.
create function protect_retained_work_header() returns trigger language plpgsql as $$
begin
 if exists(select 1 from work_submission_evidence w where w.timesheet_id=old.id) and old.status in ('Submitted','Approved') then
  if tg_op='UPDATE' and old.status='Submitted' and new.status in ('Approved','Rejected')
   and (to_jsonb(new)-array['status','rejection_reason','approved_at','approved_by','rejected_at','rejected_by','updated_at'])=(to_jsonb(old)-array['status','rejection_reason','approved_at','approved_by','rejected_at','rejected_by','updated_at']) then return new;end if;
  raise exception 'Retained submitted work cannot be rewritten.' using errcode='WWP01';
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger retained_work_header before update or delete on timesheets for each row execute function protect_retained_work_header();
create function protect_retained_work_entry() returns trigger language plpgsql as $$
declare target uuid;
begin
 target=case when tg_op='INSERT' then new.timesheet_id else old.timesheet_id end;
 if tg_op='UPDATE' and new.timesheet_id is distinct from old.timesheet_id and exists(select 1 from timesheets t join work_submission_evidence w on w.timesheet_id=t.id where t.id=new.timesheet_id and t.status in ('Submitted','Approved')) then raise exception 'Retained submitted entries cannot be rewritten.' using errcode='WWP01';end if;
 if exists(select 1 from timesheets t join work_submission_evidence w on w.timesheet_id=t.id where t.id=target and t.status in ('Submitted','Approved')) then
  raise exception 'Retained submitted entries cannot be rewritten.' using errcode='WWP01';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger retained_work_entry before insert or update or delete on timesheet_entries for each row execute function protect_retained_work_entry();
create table work_submission_decisions (
 id text primary key,submission_id text not null references work_submission_evidence(id) on delete restrict,
 status text not null check(status in ('Approved','Rejected','Cancelled')),reason text,
 actor_id uuid not null references users(id) on delete restrict,active_role text not null,source text not null,
 correlation_id text not null,operation_id text not null,created_at timestamptz not null default now(),unique(submission_id)
);
create trigger immutable_work_submission_decisions before update or delete on work_submission_decisions
 for each row execute function reject_commercial_draft_rewrite();
