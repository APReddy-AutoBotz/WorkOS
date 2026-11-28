-- Keep the due-time constraint from migration 137 and validate optional advance notice.
create function valid_approval_stage_reminder(d jsonb) returns boolean
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case
    when not (d ? 'reminderLeadMinutes') then true
    when not (d ? 'stageDueMinutes') or not valid_approval_stage_duration(d) then false
    when jsonb_typeof(d->'reminderLeadMinutes') is distinct from 'number' then false
    else (d->>'reminderLeadMinutes')::numeric >= 1
      and (d->>'reminderLeadMinutes')::numeric < (d->>'stageDueMinutes')::numeric
      and trunc((d->>'reminderLeadMinutes')::numeric) = (d->>'reminderLeadMinutes')::numeric
  end;
$$;

create or replace function valid_assignment_approval_definition(d jsonb)returns boolean language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
 if not valid_approval_stage_reminder(d) or not valid_approval_stage_duration(d) or not valid_work_approval_definition((d-'reminderLeadMinutes'-'stageDueMinutes'-'materialFields'-'creationRequired')||jsonb_build_object('entityType','Timesheet')) or d->>'entityType'is distinct from'Assignment' or jsonb_typeof(d->'materialFields')is distinct from'array' or jsonb_array_length(d->'materialFields')not between 0 and 7 or(jsonb_array_length(d->'materialFields')=0 and not(d?'creationRequired'))or(d?'creationRequired'and jsonb_typeof(d->'creationRequired')is distinct from'boolean') or length(d->>'locale')>100 then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'materialFields')v)<>jsonb_array_length(d->'materialFields')then return false;end if;
 for k in select jsonb_array_elements_text(d->'materialFields')loop if k not in('billable','comment','endsOn','quantityExact','role','startsOn','status')then return false;end if;end loop;return true;
exception when others then return false;end $$;

create or replace function valid_leave_approval_definition(d jsonb)returns boolean language sql immutable set search_path = pg_catalog, public, pg_temp as $$
 select coalesce(d->>'entityType'='LeaveRequest'and valid_approval_stage_reminder(d) and valid_approval_stage_duration(d) and valid_work_approval_definition((d-'reminderLeadMinutes'-'stageDueMinutes')||jsonb_build_object('entityType','Timesheet')),false);
$$;

create table assignment_leave_stage_reminders (
  id uuid primary key default gen_random_uuid(),
  assignment_recipient_id uuid unique references assignment_approval_recipients(id),
  leave_recipient_id uuid unique references leave_approval_recipients(id),
  created_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(assignment_recipient_id,leave_recipient_id)=1)
);

create view assignment_leave_reminder_candidates as
with pending as (
  select case when i.operation_kind='Creation' then 'Creation' else 'Material' end as kind,
    i.id,i.organization_id,i.legal_entity_id,i.employee_id,i.requester_user_id,
    p.definition,e.stage,r.user_id,r.id as recipient_id,coalesce(t.created_at,i.created_at) as opened_at
  from assignment_approval_instances i
  join assignment_approval_policies p on p.id=i.policy_id
  join assignment_approval_events e on e.instance_id=i.id and e.event_key='approval.action_required'
  join assignment_approval_recipients r on r.event_id=e.id and r.in_app and r.channel_decision='Required'
  left join assignment_approval_transitions t on t.instance_id=i.id and t.sequence=e.stage and t.decision='Approved'
  left join project_allocations a on a.id=i.assignment_id
  left join lateral (select v.id,v.source_revision from assignment_versions v where v.assignment_id=i.assignment_id
    and v.organization_id=i.organization_id and v.legal_entity_id=i.legal_entity_id order by v.sequence desc limit 1) latest on true
  where p.definition ? 'reminderLeadMinutes' and (e.stage=0 or t.id is not null)
    and not exists (select from assignment_approval_transitions n where n.instance_id=i.id and n.stage=e.stage)
    and (case when i.operation_kind='Creation' then a.id is null and latest.id is null
         else a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.employee_id=i.employee_id
           and a.project_id=i.project_id and resource_assignment_revision(a)=i.source_revision
           and latest.id is not distinct from i.source_version_id and (latest.id is null or latest.source_revision=i.source_revision) end)
  union all
  select 'Leave',i.id,i.organization_id,i.legal_entity_id,i.employee_id,i.requester_user_id,
    p.definition,e.stage,r.user_id,r.id,coalesce(t.created_at,i.created_at)
  from leave_approval_instances i
  join leave_approval_policies p on p.id=i.policy_id
  join leave_approval_events e on e.instance_id=i.id and e.event_key='approval.action_required'
  join leave_approval_recipients r on r.event_id=e.id and r.in_app and r.channel_decision='Required'
  left join leave_approval_transitions t on t.instance_id=i.id and t.sequence=e.stage and t.decision='Approved'
  where p.definition ? 'reminderLeadMinutes' and leave_approval_current(i.id) and (e.stage=0 or t.id is not null)
    and not exists (select from leave_approval_transitions n where n.instance_id=i.id and n.stage=e.stage)
    and (select count(distinct au.user_id)=1 and bool_and(au.user_id is not null and au.user_id::text not in
         (r.user_id::text,p.definition->'stages'->e.stage->>'userId')) from audit_logs au
         where au.module='Leave' and au.action='Submit Leave' and au.entity_type='LeaveRequest' and au.entity_id=i.request_id
           and au.organization_id=i.organization_id and au.legal_entity_id=i.legal_entity_id)
), actors as (
  select pending.*, (definition->'stages'->stage->>'userId')::uuid as named,
    definition->'stages'->stage->>'role' as role_name,
    opened_at + interval '1 minute' * (definition->>'stageDueMinutes')::integer as due_at
  from pending
)
select kind,recipient_id,organization_id,legal_entity_id,due_at,
  due_at - interval '1 minute' * (definition->>'reminderLeadMinutes')::integer as remind_at
from actors where named<>requester_user_id and user_id<>requester_user_id
  and not exists (select from users u where u.id in (named,user_id) and actors.employee_id in (u.employee_record_id,u.employee_id))
  and canonical_delegation_instance_account(named,role_name,kind,id)
  and canonical_delegation_instance_account(user_id,role_name,kind,id)
  and canonical_stage_actor(kind,id,stage,named,user_id,role_name);

create function guard_assignment_leave_stage_reminder() returns trigger language plpgsql as $$
begin
  if tg_op<>'INSERT' then raise exception 'Stage reminder evidence is immutable.'; end if;
  new.created_at := clock_timestamp();
  if not exists (select from assignment_leave_reminder_candidates c
    where c.recipient_id=coalesce(new.assignment_recipient_id,new.leave_recipient_id)
      and (c.kind='Leave')=(new.leave_recipient_id is not null)
      and new.created_at>=c.remind_at and new.created_at<c.due_at) then return null; end if;
  return new;
end $$;
create trigger guard_assignment_leave_stage_reminder before insert or update or delete on assignment_leave_stage_reminders
for each row execute function guard_assignment_leave_stage_reminder();

create view assignment_leave_reminder_inbox as
select d.id,d.created_at,r.user_id,i.organization_id,i.legal_entity_id,i.employee_id,
  case when i.operation_kind='Creation' then 'assignment-creation-approval' else 'assignment-approval' end as kind,
  ev.id as event_id,i.id as instance_id,i.assignment_id,i.source_token,null::text as request_id,null::integer as revision,
  ev.transition_sequence,ev.stage,ev.event_key,ev.policy_class,ev.template_id,ev.operation_id,ev.locale,ev.title,ev.body,r.reasons,r.channel_decision
from assignment_leave_stage_reminders d join assignment_approval_recipients r on r.id=d.assignment_recipient_id
join assignment_approval_events ev on ev.id=r.event_id join assignment_approval_instances i on i.id=ev.instance_id
union all
select d.id,d.created_at,r.user_id,i.organization_id,i.legal_entity_id,i.employee_id,'leave-approval',
  ev.id,i.id,null,null,i.request_id,i.sequence,ev.transition_sequence,ev.stage,ev.event_key,ev.policy_class,ev.template_id,
  ev.operation_id,ev.locale,ev.title,ev.body,r.reasons,r.channel_decision
from assignment_leave_stage_reminders d join leave_approval_recipients r on r.id=d.leave_recipient_id
join leave_approval_events ev on ev.id=r.event_id join leave_approval_instances i on i.id=ev.instance_id;

create table assignment_leave_reminder_reads (
  recipient_id uuid primary key references assignment_leave_stage_reminders(id),
  user_id uuid not null references users(id), read_at timestamptz not null default clock_timestamp()
);
create function guard_assignment_leave_reminder_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
  if tg_op<>'INSERT' then raise exception 'Read evidence is immutable.'; end if;
  ctx := nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
  if new.user_id::text is distinct from ctx->>'actorId' or not exists (
    select from assignment_leave_reminder_inbox r where r.id=new.recipient_id and r.user_id=new.user_id
      and r.organization_id=ctx->>'organizationId' and r.legal_entity_id=ctx->>'legalEntityId'
  ) then raise exception 'Read only your scoped stage reminder.' using errcode='WGA01'; end if;
  new.read_at := clock_timestamp();
  return new;
end $$;
create trigger guard_assignment_leave_reminder_read before insert or update or delete on assignment_leave_reminder_reads
for each row execute function guard_assignment_leave_reminder_read();
