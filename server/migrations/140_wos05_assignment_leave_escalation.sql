-- A breach refers to the immutable action that opened the stage. Capture the database
-- deadline before a late decision can remove that stage from the current queue.
create table assignment_leave_deadline_breaches (
  id uuid primary key default gen_random_uuid(),
  assignment_event_id text unique references assignment_approval_events(id),
  leave_event_id text unique references leave_approval_events(id),
  due_at timestamptz not null,
  observed_at timestamptz not null,
  check (num_nonnulls(assignment_event_id,leave_event_id)=1 and due_at<observed_at)
);

create function guard_assignment_leave_deadline_breach() returns trigger language plpgsql as $$
declare current_clock record;
begin
  if tg_op<>'INSERT' then raise exception 'Stage breach evidence is immutable.'; end if;
  select c.due_at,clock_timestamp() as observed_at into current_clock
    from assignment_leave_open_stage_clocks c
    where (c.origin='Leave' and c.event_id=new.leave_event_id)
       or (c.origin='Assignment' and c.event_id=new.assignment_event_id);
  if not found or current_clock.due_at>=current_clock.observed_at then return null; end if;
  new.due_at:=current_clock.due_at;
  new.observed_at:=current_clock.observed_at;
  return new;
end $$;
create trigger guard_assignment_leave_deadline_breach before insert or update or delete on assignment_leave_deadline_breaches
for each row execute function guard_assignment_leave_deadline_breach();

create function capture_late_assignment_leave_decision() returns trigger language plpgsql as $$
declare source_origin text;
begin
  source_origin:=case when tg_table_name='leave_approval_transitions' then 'Leave' else 'Assignment' end;
  insert into assignment_leave_deadline_breaches(assignment_event_id,leave_event_id)
    select case when c.origin='Assignment' then c.event_id end,case when c.origin='Leave' then c.event_id end
    from assignment_leave_open_stage_clocks c where c.origin=source_origin and c.instance_id=new.instance_id
      and c.stage=new.stage and c.due_at<new.created_at
    on conflict do nothing;
  return new;
end $$;
create trigger capture_late_assignment_decision before insert on assignment_approval_transitions
for each row execute function capture_late_assignment_leave_decision();
create trigger capture_late_leave_decision before insert on leave_approval_transitions
for each row execute function capture_late_assignment_leave_decision();

create function valid_approval_escalation_target(d jsonb) returns boolean
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select not (d ? 'escalationUserId') or (d ? 'stageDueMinutes' and
    jsonb_typeof(d->'escalationUserId')='string' and
    d->>'escalationUserId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$');
$$;
create or replace function valid_assignment_approval_definition(d jsonb)returns boolean language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
 if not valid_approval_escalation_target(d) or not valid_approval_stage_reminder(d) or not valid_approval_stage_duration(d) or not valid_work_approval_definition((d-'escalationUserId'-'reminderLeadMinutes'-'stageDueMinutes'-'materialFields'-'creationRequired')||jsonb_build_object('entityType','Timesheet')) or d->>'entityType'is distinct from'Assignment' or jsonb_typeof(d->'materialFields')is distinct from'array' or jsonb_array_length(d->'materialFields')not between 0 and 7 or(jsonb_array_length(d->'materialFields')=0 and not(d?'creationRequired'))or(d?'creationRequired'and jsonb_typeof(d->'creationRequired')is distinct from'boolean') or length(d->>'locale')>100 then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'materialFields')v)<>jsonb_array_length(d->'materialFields')then return false;end if;
 for k in select jsonb_array_elements_text(d->'materialFields')loop if k not in('billable','comment','endsOn','quantityExact','role','startsOn','status')then return false;end if;end loop;return true;
exception when others then return false;end $$;

create or replace function valid_leave_approval_definition(d jsonb)returns boolean language sql immutable set search_path = pg_catalog, public, pg_temp as $$
 select coalesce(d->>'entityType'='LeaveRequest'and valid_approval_escalation_target(d) and valid_approval_stage_reminder(d) and valid_approval_stage_duration(d) and valid_work_approval_definition((d-'escalationUserId'-'reminderLeadMinutes'-'stageDueMinutes')||jsonb_build_object('entityType','Timesheet')),false);
$$;

create view assignment_leave_overdue_sources as
with sources as (
 select b.id as breach_id,b.due_at,ev.stage,ev.id as action_event_id,
   case when i.operation_kind='Creation' then 'Creation' else 'Material' end as kind,
   i.id as instance_id,i.organization_id,i.legal_entity_id,i.employee_id,i.requester_user_id,
   i.assignment_id,i.source_token,null::text as request_id,null::integer as revision,p.definition
 from assignment_leave_deadline_breaches b join assignment_approval_events ev on ev.id=b.assignment_event_id
 join assignment_approval_instances i on i.id=ev.instance_id join assignment_approval_policies p on p.id=i.policy_id
 union all
 select b.id,b.due_at,ev.stage,ev.id,'Leave',i.id,i.organization_id,i.legal_entity_id,i.employee_id,i.requester_user_id,
   null,i.source_token,i.request_id,i.sequence,p.definition
 from assignment_leave_deadline_breaches b join leave_approval_events ev on ev.id=b.leave_event_id
 join leave_approval_instances i on i.id=ev.instance_id join leave_approval_policies p on p.id=i.policy_id
)
select s.*, (definition->'stages'->stage->>'userId')::uuid as named_id,definition->'stages'->stage->>'role' as held_role,
  (definition->>'escalationUserId')::uuid as escalation_id from sources s;

create table assignment_leave_overdue_attempts (
  breach_id uuid not null references assignment_leave_deadline_breaches(id),
  attempt integer not null check (attempt>0),
  failure text check(failure='RECIPIENT_UNAVAILABLE'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(breach_id,attempt)
);
create unique index assignment_leave_overdue_success on assignment_leave_overdue_attempts(breach_id) where failure is null;
create table assignment_leave_overdue_receipts (
  id uuid primary key default gen_random_uuid(),breach_id uuid not null,attempt integer not null,
  user_id uuid not null references users(id), reasons text[] not null,
  template_id uuid not null default 'cd24c38c-8195-46db-b94e-0ad675e6f5c4',locale text not null default 'en',
  title text not null,body text not null,unique(breach_id,user_id),
  foreign key(breach_id,attempt) references assignment_leave_overdue_attempts(breach_id,attempt)
);

create function assignment_leave_independent_recipient(s assignment_leave_overdue_sources,uid uuid)
returns boolean language sql stable as $$
 select uid<>s.requester_user_id and not exists(select from users u where u.id=uid and s.employee_id in(u.employee_record_id,u.employee_id))
 and (s.kind<>'Leave' or (select count(distinct a.user_id)=1 and bool_and(a.user_id is not null and a.user_id<>uid::text)
 from audit_logs a where a.organization_id=s.organization_id and a.legal_entity_id=s.legal_entity_id and a.module='Leave'
 and a.action='Submit Leave' and a.entity_type='LeaveRequest' and a.entity_id=s.request_id));
$$;

create function guard_assignment_leave_overdue_attempt() returns trigger language plpgsql as $$
declare s assignment_leave_overdue_sources; prior assignment_leave_overdue_attempts;
begin
 if tg_op<>'INSERT' then raise exception 'Delivery attempt evidence is immutable.'; end if;
 perform 1 from assignment_leave_deadline_breaches where id=new.breach_id for update;
 select * into strict s from assignment_leave_overdue_sources where breach_id=new.breach_id;
 select * into prior from assignment_leave_overdue_attempts where breach_id=new.breach_id order by attempt desc limit 1;
 new.attempt:=coalesce(prior.attempt,0)+1;
 new.created_at:=clock_timestamp();
 if prior.attempt is not null and (prior.failure is null or new.created_at<prior.created_at+
    interval '1 minute'*power(2,least(prior.attempt-1,6))) then return null; end if;
 if new.failure is not null then return new; end if;
 if canonical_delegation_instance_account(s.named_id,s.held_role,s.kind,s.instance_id) is not true
   or assignment_leave_independent_recipient(s,s.named_id) is not true
   or (s.escalation_id is not null and not exists (
     select from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=s.escalation_id
       and invoice_notice_actor_has(s.organization_id,s.legal_entity_id,s.escalation_id,r.name,'employees.view')
       and invoice_notice_actor_has(s.organization_id,s.legal_entity_id,s.escalation_id,r.name,'notifications.view')
       and (s.kind<>'Leave' or invoice_notice_actor_has(s.organization_id,s.legal_entity_id,s.escalation_id,r.name,'leave.self_service'))
       and invoice_historical_worker_visible(s.organization_id,s.legal_entity_id,s.employee_id,s.escalation_id,r.name)
   )) then raise exception 'Mandatory scoped recipient unavailable.' using errcode='WGA05'; end if;
 return new;
end $$;
create trigger guard_assignment_leave_overdue_attempt before insert or update or delete on assignment_leave_overdue_attempts
for each row execute function guard_assignment_leave_overdue_attempt();

create function deliver_assignment_leave_overdue() returns trigger language plpgsql as $$
declare s assignment_leave_overdue_sources;
begin
 if new.failure is not null then return null; end if;
 select * into strict s from assignment_leave_overdue_sources where breach_id=new.breach_id;
 insert into assignment_leave_overdue_receipts(breach_id,attempt,user_id,reasons,title,body)
 select new.breach_id,new.attempt,uid,array_agg(distinct reason order by reason),
   'Approval stage overdue',
   format('Stage %s for %s exceeded its deadline.',s.stage+1,coalesce(s.assignment_id,s.request_id))
 from (
   select s.named_id as uid,'current_stage_approver' as reason
   union all select s.escalation_id,'escalation_target' where s.escalation_id is not null
   union all select (d.definition->>'delegateUserId')::uuid,'current_stage_approver'
   from canonical_delegation_bindings b join canonical_delegations d on d.id=b.delegation_id
   where b.origin=s.kind and b.instance_id=s.instance_id and b.stage=s.stage
     and canonical_delegation_eligible(b,new.created_at)
     and assignment_leave_independent_recipient(s,(d.definition->>'delegateUserId')::uuid)
 ) recipients group by uid;
 return null;
end $$;
create trigger deliver_assignment_leave_overdue after insert on assignment_leave_overdue_attempts
for each row execute function deliver_assignment_leave_overdue();

create function guard_assignment_leave_overdue_receipt() returns trigger language plpgsql as $$
begin
 if tg_op<>'INSERT' or pg_trigger_depth()<>2 then raise exception 'Overdue receipts require a recorded delivery.'; end if;
 return new;
end $$;
create trigger guard_assignment_leave_overdue_receipt before insert or update or delete on assignment_leave_overdue_receipts
for each row execute function guard_assignment_leave_overdue_receipt();
create view assignment_leave_overdue_inbox as
select r.id,r.user_id,s.organization_id,s.legal_entity_id,s.employee_id,s.instance_id,s.assignment_id,s.source_token,s.request_id,s.revision,
  case s.kind when 'Material' then 'assignment-approval' when 'Creation' then 'assignment-creation-approval' else 'leave-approval' end kind,
  (case when s.kind='Leave' then 'leave-approval/' else 'assignment-approval/' end)||s.instance_id||'/'||s.stage||
    '/approval.overdue_or_escalated/deadline' as event_id,
  s.stage,s.stage as transition_sequence,'approval.overdue_or_escalated'::text as event_key,'CONTROL_MANDATORY'::text as policy_class,
  r.template_id,'deadline'::text as operation_id,r.locale,
  r.title,r.body,r.reasons,'Required'::text as channel_decision,a.created_at
from assignment_leave_overdue_receipts r join assignment_leave_overdue_sources s on s.breach_id=r.breach_id
join assignment_leave_overdue_attempts a on a.breach_id=r.breach_id and a.attempt=r.attempt;

create table assignment_leave_overdue_reads (
 recipient_id uuid primary key references assignment_leave_overdue_receipts(id),user_id uuid not null references users(id),
 read_at timestamptz not null default clock_timestamp()
);
create function guard_assignment_leave_overdue_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 if tg_op<>'INSERT' then raise exception 'Acknowledgement evidence is immutable.'; end if;
 ctx:=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
 if ctx->>'actorId' is distinct from new.user_id::text or not exists (
   select from assignment_leave_overdue_inbox r where r.id=new.recipient_id and r.user_id=new.user_id
   and r.organization_id=ctx->>'organizationId' and r.legal_entity_id=ctx->>'legalEntityId'
 ) then raise exception 'Read only your scoped overdue notice.' using errcode='WGA01'; end if;
 new.read_at:=clock_timestamp(); return new;
end $$;
create trigger guard_assignment_leave_overdue_read before insert or update or delete on assignment_leave_overdue_reads
for each row execute function guard_assignment_leave_overdue_read();
create view assignment_leave_overdue_pending as
select s.breach_id,s.organization_id,s.legal_entity_id,s.due_at
from assignment_leave_overdue_sources s left join lateral (
 select a.created_at,a.attempt,a.failure from assignment_leave_overdue_attempts a
 where a.breach_id=s.breach_id order by attempt desc limit 1
) last on true where last.attempt is null or (last.failure is not null and
 last.created_at+interval '1 minute'*power(2,least(last.attempt-1,6))<=now());
