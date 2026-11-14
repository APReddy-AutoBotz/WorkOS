-- Additive capture-policy authority. No default policy, grants, rewritten work,
-- changed assignment-policy version, or inferred historical evidence.
create table work_capture_policy_versions (
 id text primary key,
 organization_id text not null,
 legal_entity_id text not null,
 sequence integer not null check(sequence>0),
 policy_version text not null check(policy_version='work-capture-rules/1'),
 effective_from date not null,
 minimum_increment numeric not null check(minimum_increment>0 and minimum_increment<=24 and scale(minimum_increment)<=4),
 daily_maximum numeric check(daily_maximum>0 and daily_maximum<=24 and scale(daily_maximum)<=4 and daily_maximum>=minimum_increment),
 weekly_maximum numeric check(weekly_maximum>0 and weekly_maximum<=168 and scale(weekly_maximum)<=4 and weekly_maximum>=minimum_increment),
 comment_required boolean not null,
 actor_id uuid not null references users(id) on delete restrict,
 active_role text not null, source text not null,
 correlation_id text not null, operation_id text not null,
 created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,sequence),
 unique(organization_id,legal_entity_id,effective_from),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict
);
create trigger immutable_work_capture_policy before update or delete on work_capture_policy_versions
 for each row execute function reject_commercial_draft_rewrite();
create function validate_capture_policy_append() returns trigger language plpgsql as $$
declare latest work_capture_policy_versions;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 select * into latest from work_capture_policy_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(latest.sequence,0)+1 or (latest.id is not null and new.effective_from<=latest.effective_from)
   or new.effective_from<(now() at time zone 'UTC')::date then
   raise exception 'Capture policy must append at a new prospective effective date.' using errcode='WCR01';
 end if;
 perform 1 from reporting_periods where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and frequency='Weekly' and starts_on=new.effective_from for share;
 if not found then
   raise exception 'Capture policy activation must align with an authoritative Weekly period start.' using errcode='WCR02';
 end if;
 return new;
end $$;
create trigger append_work_capture_policy before insert on work_capture_policy_versions for each row execute function validate_capture_policy_append();

-- An Open schedule cannot be used to move the activation boundary or reshape
-- an aggregate that already contains explicitly governed work.
create function protect_capture_weekly_boundary() returns trigger language plpgsql as $$
begin
 if old.frequency='Weekly' and (tg_op='DELETE' or (to_jsonb(new)-array['name','code','status','created_at','updated_at']) is distinct from (to_jsonb(old)-array['name','code','status','created_at','updated_at'])) then
   perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||old.organization_id||':'||old.legal_entity_id,0));
   if exists(select 1 from work_capture_policy_versions p where p.organization_id=old.organization_id and p.legal_entity_id=old.legal_entity_id and p.effective_from=old.starts_on)
     or exists(select 1 from timesheet_entries e join timesheets t on t.id=e.timesheet_id where t.organization_id=old.organization_id and t.legal_entity_id=old.legal_entity_id and e.work_date between old.starts_on and old.ends_on
       and exists(select 1 from work_capture_policy_versions p where p.organization_id=t.organization_id and p.legal_entity_id=t.legal_entity_id and p.effective_from<=e.work_date)) then
     raise exception 'Weekly capture policy boundaries with retained authority cannot be rewritten.' using errcode='23514';
   end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger capture_weekly_boundary before update or delete on reporting_periods for each row execute function protect_capture_weekly_boundary();

alter table work_submission_evidence add column capture_policy_references jsonb
 check(capture_policy_references is null or jsonb_typeof(capture_policy_references)='array');
create index ix_timesheet_entries_capture_date on timesheet_entries(work_date,timesheet_id);

-- Final guard for present and future SQL writers. The application obtains these
-- same locks before validation. Deferred checks see the complete replacement,
-- not an intermediate delete/insert or partially replaced weekly grid.
create function assert_capture_date_open(organization text, legal_entity text, at_date date) returns void language plpgsql as $$
begin
 if not exists(select 1 from work_capture_policy_versions p where p.organization_id=organization and p.legal_entity_id=legal_entity and p.effective_from<=at_date) then return; end if;
 perform 1 from reporting_periods p where p.organization_id=organization and p.legal_entity_id=legal_entity
   and at_date between p.starts_on and p.ends_on order by p.frequency,p.starts_on,p.id for share;
 if not exists(select 1 from reporting_periods p where p.organization_id=organization and p.legal_entity_id=legal_entity and p.frequency='Weekly' and at_date between p.starts_on and p.ends_on)
   or exists(select 1 from reporting_periods p where p.organization_id=organization and p.legal_entity_id=legal_entity and at_date between p.starts_on and p.ends_on and p.status<>'Open')
   or exists(select p.frequency from reporting_periods p where p.organization_id=organization and p.legal_entity_id=legal_entity and at_date between p.starts_on and p.ends_on group by p.frequency having count(*)>1) then
   raise exception 'Effective capture policy requires open authoritative reporting periods for old and new content dates.' using errcode='WCR05';
 end if;
end $$;
create function lock_capture_entry_writer() returns trigger language plpgsql as $$
declare previous_header timesheets; next_header timesheets; key text;
begin
 if tg_op<>'INSERT' then select * into previous_header from timesheets where id=old.timesheet_id; end if;
 if tg_op<>'DELETE' then select * into next_header from timesheets where id=new.timesheet_id; end if;
 for key in select distinct 'commercial-lifecycle:'||v.organization_id||':'||v.legal_entity_id from
   (values(previous_header.organization_id,previous_header.legal_entity_id),(next_header.organization_id,next_header.legal_entity_id)) v(organization_id,legal_entity_id)
   where v.organization_id is not null order by 1 loop perform pg_advisory_xact_lock(hashtextextended(key,0)); end loop;
 for key in select distinct v.worker from (values(previous_header.employee_id),(next_header.employee_id)) v(worker)
   where v.worker is not null order by 1 loop perform pg_advisory_xact_lock(hashtextextended(key,0)); end loop;
 if tg_op<>'INSERT' and previous_header.id is not null then
   perform assert_capture_date_open(previous_header.organization_id,previous_header.legal_entity_id,old.work_date);
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger capture_entry_writer_lock before insert or update or delete on timesheet_entries for each row execute function lock_capture_entry_writer();
create function assert_capture_header_policy(target uuid) returns void language plpgsql as $$
declare header timesheets; invalid boolean; at_date date;
begin
 select * into header from timesheets where id=target;
 if header.id is null then return; end if;
 for at_date in select distinct e.work_date from timesheet_entries e where e.timesheet_id=header.id order by e.work_date loop
   perform assert_capture_date_open(header.organization_id,header.legal_entity_id,at_date);
 end loop;
 if exists(select 1 from timesheet_entries e where e.timesheet_id=header.id
   and exists(select 1 from work_capture_policy_versions p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.effective_from<=e.work_date)
   and (not exists(select 1 from reporting_periods p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.frequency='Weekly' and e.work_date between p.starts_on and p.ends_on)
     or exists(select 1 from reporting_periods p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and e.work_date between p.starts_on and p.ends_on and p.status<>'Open'))) then
   raise exception 'Effective capture policy requires open authoritative reporting periods.' using errcode='WCR05';
 end if;
 select exists(select 1 from timesheet_entries e join lateral (
   select p.* from work_capture_policy_versions p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.effective_from<=e.work_date order by p.effective_from desc limit 1
 ) p on true where e.timesheet_id=header.id and (mod(e.hours,p.minimum_increment)<>0 or (p.comment_required and e.hours>0 and btrim(coalesce(e.remark,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')=''))) into invalid;
 if invalid then raise exception 'Work entry violates its effective increment or comment policy.' using errcode='WCR03'; end if;
 -- All headers and all current work states count exactly once. Caller-provided
 -- week_ending is not authority for an aggregate limit.
 with affected as (select distinct p.id,p.starts_on,p.ends_on from timesheet_entries e join reporting_periods p on p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.frequency='Weekly' and e.work_date between p.starts_on and p.ends_on where e.timesheet_id=header.id),
 quantities as (select p.id period_id,e.work_date,sum(e.hours) daily_total from affected p join timesheet_entries e on e.work_date between p.starts_on and p.ends_on join timesheets t on t.id=e.timesheet_id and t.organization_id=header.organization_id and t.legal_entity_id=header.legal_entity_id and t.employee_id=header.employee_id group by p.id,e.work_date),
 totals as (select *,sum(daily_total) over(partition by period_id) weekly_total from quantities)
 select exists(select 1 from totals q join lateral (select p.daily_maximum,p.weekly_maximum from work_capture_policy_versions p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.effective_from<=q.work_date order by p.effective_from desc limit 1) p on true
   where (p.daily_maximum is not null and q.daily_total>p.daily_maximum) or (p.weekly_maximum is not null and q.weekly_total>p.weekly_maximum)) into invalid;
 if invalid then raise exception 'Worker aggregate exceeds the effective daily or Weekly period limit.' using errcode='WCR04'; end if;
 return;
end $$;
create function validate_capture_entry_state() returns trigger language plpgsql as $$
begin
 perform assert_capture_header_policy(case when tg_op='DELETE' then old.timesheet_id else new.timesheet_id end);
 return null;
end $$;
create constraint trigger capture_entry_state after insert or update or delete on timesheet_entries deferrable initially deferred for each row execute function validate_capture_entry_state();

create function lock_capture_header_writer() returns trigger language plpgsql as $$
declare previous_header timesheets; next_header timesheets; key text; at_date date;
begin
 if tg_op<>'INSERT' then previous_header=old; end if;
 if tg_op<>'DELETE' then next_header=new; end if;
 for key in select distinct 'commercial-lifecycle:'||v.organization_id||':'||v.legal_entity_id from
   (values(previous_header.organization_id,previous_header.legal_entity_id),(next_header.organization_id,next_header.legal_entity_id)) v(organization_id,legal_entity_id)
   where v.organization_id is not null order by 1 loop perform pg_advisory_xact_lock(hashtextextended(key,0)); end loop;
 for key in select distinct v.worker from (values(previous_header.employee_id),(next_header.employee_id)) v(worker)
   where v.worker is not null order by 1 loop perform pg_advisory_xact_lock(hashtextextended(key,0)); end loop;
 if tg_op='DELETE' or (tg_op='UPDATE' and
   (to_jsonb(new)-array['status','rejection_reason','submitted_at','approved_at','approved_by','rejected_at','rejected_by','updated_at']) is distinct from
   (to_jsonb(old)-array['status','rejection_reason','submitted_at','approved_at','approved_by','rejected_at','rejected_by','updated_at'])) then
   for at_date in select distinct e.work_date from timesheet_entries e where e.timesheet_id=old.id order by e.work_date loop
     perform assert_capture_date_open(old.organization_id,old.legal_entity_id,at_date);
   end loop;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger capture_header_writer_lock before insert or update or delete on timesheets for each row execute function lock_capture_header_writer();
create function validate_capture_header_state() returns trigger language plpgsql as $$
begin
 -- Decision-only updates use retained evidence, never today's new policy.
 if tg_op='INSERT' then perform assert_capture_header_policy(new.id);
 elsif new.employee_id is distinct from old.employee_id or new.organization_id is distinct from old.organization_id or new.legal_entity_id is distinct from old.legal_entity_id then
   perform assert_capture_header_policy(new.id);
 end if;
 return null;
end $$;
create constraint trigger capture_header_state after insert or update on timesheets deferrable initially deferred for each row execute function validate_capture_header_state();
