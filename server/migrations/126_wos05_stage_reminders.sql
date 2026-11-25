alter table work_approval_policy_versions drop constraint work_approval_definition_shape;
alter table work_approval_policy_versions add constraint work_approval_definition_shape check (
  valid_work_approval_definition(definition - 'stageDueMinutes' - 'escalationUserId' - 'overdueTemplate' - 'reminderLeadMinutes')
  and case when definition ? 'reminderLeadMinutes' then
    case when definition ? 'stageDueMinutes' and jsonb_typeof(definition->'reminderLeadMinutes')='number'
      then (definition->>'reminderLeadMinutes')::numeric between 1 and (definition->>'stageDueMinutes')::numeric-1
        and trunc((definition->>'reminderLeadMinutes')::numeric)=(definition->>'reminderLeadMinutes')::numeric
      else false end
    else true end
  and (not (definition ? 'overdueTemplate') or (
    definition ? 'stageDueMinutes' and jsonb_typeof(definition->'overdueTemplate')='object'
    and (definition->'overdueTemplate') ?& array['key','subject','body']
    and (definition->'overdueTemplate') - array['key','subject','body'] = '{}'::jsonb
    and jsonb_typeof(definition->'overdueTemplate'->'key')='string'
    and definition->'overdueTemplate'->>'key'='approval.overdue_or_escalated'
    and jsonb_typeof(definition->'overdueTemplate'->'subject')='string'
    and jsonb_typeof(definition->'overdueTemplate'->'body')='string'
    and length(btrim(definition->'overdueTemplate'->>'subject')) between 1 and 200
    and length(btrim(definition->'overdueTemplate'->>'body')) between 1 and 8000
  ))
  and (not (definition ? 'escalationUserId') or (
    definition ? 'stageDueMinutes' and jsonb_typeof(definition->'escalationUserId')='string'
    and (definition->>'escalationUserId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  ))
  and case when definition ? 'stageDueMinutes' then
    case when jsonb_typeof(definition->'stageDueMinutes') = 'number' then
      (definition->>'stageDueMinutes')::numeric between 1 and 2147483647
      and trunc((definition->>'stageDueMinutes')::numeric) = (definition->>'stageDueMinutes')::numeric
    else false end
  else true end
);


-- The reminder delivers the original localized action request again. Each original
-- in-app recipient can receive one reminder and acknowledge it independently.
create table work_approval_stage_reminders (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null unique references work_approval_recipients(id),
  created_at timestamptz not null default clock_timestamp()
);

create view work_approval_reminder_candidates as
select r.id as recipient_id,i.id as instance_id,s.stage,s.due_at,
       s.due_at - make_interval(mins=>(p.definition->>'reminderLeadMinutes')::numeric::integer) as remind_at
from work_approval_timed_stages s
join work_approval_instances i on i.id=s.instance_id
join work_approval_policy_versions p on p.id=s.policy_id
join work_approval_events ev on ev.instance_id=s.instance_id and ev.stage=s.stage and ev.event_key='approval.action_required'
join work_approval_recipients r on r.event_id=ev.id and r.user_id=s.approver_id and r.in_app
join timesheets t on t.id=i.timesheet_id and t.organization_id=i.organization_id and t.legal_entity_id=i.legal_entity_id
join users approver on approver.id=r.user_id
left join employees actor on actor.id=approver.employee_record_id
join employees worker on worker.id=i.employee_id
where s.decided_at is null and p.definition ? 'reminderLeadMinutes' and t.status='Submitted'
  and i.submission_id=(select latest.id from work_submission_evidence latest where latest.timesheet_id=t.id
    and latest.organization_id=i.organization_id and latest.legal_entity_id=i.legal_entity_id order by latest.sequence desc limit 1)
  and r.user_id<>i.requester_user_id and worker.id is distinct from actor.id and worker.id is distinct from actor.employee_id
  and (p.definition->'stages'->s.stage->>'role'<>'TeamLead' or worker.reporting_manager_id in (actor.id,actor.employee_id))
  and (p.definition->'stages'->s.stage->>'role'<>'ProjectManager' or exists(select from timesheet_entries entry
    join projects project on project.id=entry.project_id and project.organization_id=i.organization_id and project.legal_entity_id=i.legal_entity_id
    where entry.timesheet_id=t.id and project.manager_id in (actor.id,actor.employee_id)))
  and not exists (select from unnest(array['timesheets.approve','timesheets.submit','projects.view','approvals.view','employees.view','notifications.view']) permission
    where invoice_notice_actor_has(i.organization_id,i.legal_entity_id,r.user_id,p.definition->'stages'->s.stage->>'role',permission) is not true)
  and invoice_historical_worker_visible(i.organization_id,i.legal_entity_id,i.employee_id,r.user_id,p.definition->'stages'->s.stage->>'role');

create function guard_work_approval_stage_reminder() returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' then raise exception 'Reminder receipts are immutable.'; end if;
  perform 1 from work_approval_instances i join work_approval_events ev on ev.instance_id=i.id
    join work_approval_recipients r on r.event_id=ev.id where r.id=new.recipient_id for update of i;
  new.created_at:=clock_timestamp();
  if not exists(select from work_approval_reminder_candidates c where c.recipient_id=new.recipient_id
    and new.created_at>=c.remind_at and new.created_at<c.due_at) then
    return null;
  end if;
  return new;
end $$;
create trigger guard_work_approval_stage_reminder before insert or update or delete on work_approval_stage_reminders
for each row execute function guard_work_approval_stage_reminder();

create view work_approval_reminder_inbox as
select d.id,r.user_id,i.organization_id,i.legal_entity_id,i.employee_id,i.timesheet_id,i.submission_id,
       i.id as instance_id,ev.transition_sequence,ev.id as event_id,ev.event_key,ev.operation_id,ev.policy_class,
       ev.template_id,ev.locale,ev.title,ev.body,r.reasons,r.channel_decision,d.created_at
from work_approval_stage_reminders d join work_approval_recipients r on r.id=d.recipient_id
join work_approval_events ev on ev.id=r.event_id join work_approval_instances i on i.id=ev.instance_id;

create or replace function guard_work_approval_overdue_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 if tg_op<>'INSERT' then raise exception 'Read evidence is immutable.'; end if;
 ctx:=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
 if ctx->>'actorId' is distinct from new.user_id::text or not exists(select 1 from (select id,user_id,organization_id,legal_entity_id from work_approval_overdue_inbox
 union all select id,user_id,organization_id,legal_entity_id from work_approval_reminder_inbox) receipt
 where id=new.recipient_id and user_id=new.user_id and organization_id=ctx->>'organizationId' and legal_entity_id=ctx->>'legalEntityId')
 then raise exception 'Read only your scoped timed notice.' using errcode='WGA01'; end if;
 return new;
end $$;
