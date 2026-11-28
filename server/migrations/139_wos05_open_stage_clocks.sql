-- Current stage clocks serve reporting and reminder delivery from the same pinned evidence.
create view assignment_leave_open_stage_clocks as
with pending as (
  select case when i.operation_kind='Creation' then 'Creation' else 'Material' end as kind,
    i.id as instance_id,i.organization_id,i.legal_entity_id,i.employee_id,i.requester_user_id,
    null::text as request_id,p.definition,e.stage,e.id as event_id,coalesce(t.created_at,i.created_at) as opened_at
  from assignment_approval_instances i
  join assignment_approval_policies p on p.id=i.policy_id
  join assignment_approval_events e on e.instance_id=i.id and e.event_key='approval.action_required'
  left join assignment_approval_transitions t on t.instance_id=i.id and t.sequence=e.stage and t.decision='Approved'
  left join project_allocations a on a.id=i.assignment_id
  left join lateral (select v.id,v.source_revision from assignment_versions v where v.assignment_id=i.assignment_id
    and v.organization_id=i.organization_id and v.legal_entity_id=i.legal_entity_id order by v.sequence desc limit 1) latest on true
  where p.definition ? 'stageDueMinutes' and (e.stage=0 or t.id is not null)
    and not exists (select from assignment_approval_transitions n where n.instance_id=i.id and n.stage=e.stage)
    and (case when i.operation_kind='Creation' then a.id is null and latest.id is null
         else a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.employee_id=i.employee_id
           and a.project_id=i.project_id and resource_assignment_revision(a)=i.source_revision
           and latest.id is not distinct from i.source_version_id and (latest.id is null or latest.source_revision=i.source_revision) end)
  union all
  select 'Leave',i.id,i.organization_id,i.legal_entity_id,i.employee_id,i.requester_user_id,
    i.request_id,p.definition,e.stage,e.id,coalesce(t.created_at,i.created_at)
  from leave_approval_instances i
  join leave_approval_policies p on p.id=i.policy_id
  join leave_approval_events e on e.instance_id=i.id and e.event_key='approval.action_required'
  left join leave_approval_transitions t on t.instance_id=i.id and t.sequence=e.stage and t.decision='Approved'
  where p.definition ? 'stageDueMinutes' and leave_approval_current(i.id) and (e.stage=0 or t.id is not null)
    and not exists (select from leave_approval_transitions n where n.instance_id=i.id and n.stage=e.stage)
)
select pending.*, case when kind='Leave' then 'Leave' else 'Assignment' end as origin,
  opened_at + interval '1 minute' * (definition->>'stageDueMinutes')::integer as due_at
from pending;

create or replace view assignment_leave_reminder_candidates as
with actors as (
  select c.*, r.id as recipient_id, r.user_id, (definition->'stages'->stage->>'userId')::uuid as named,
    definition->'stages'->stage->>'role' as role_name
  from assignment_leave_open_stage_clocks c
  join lateral (
    select a.id,a.user_id from assignment_approval_recipients a where c.origin='Assignment' and a.event_id=c.event_id
      and a.in_app and a.channel_decision='Required'
    union all
    select l.id,l.user_id from leave_approval_recipients l where c.origin='Leave' and l.event_id=c.event_id
      and l.in_app and l.channel_decision='Required'
  ) r on true
  where definition ? 'reminderLeadMinutes'
    and (c.origin<>'Leave' or (select count(distinct au.user_id)=1 and bool_and(au.user_id is not null and
      au.user_id::text not in (r.user_id::text,c.definition->'stages'->c.stage->>'userId')) from audit_logs au
      where au.module='Leave' and au.action='Submit Leave' and au.entity_type='LeaveRequest' and au.entity_id=c.request_id
        and au.organization_id=c.organization_id and au.legal_entity_id=c.legal_entity_id))
)
select kind,recipient_id,organization_id,legal_entity_id,due_at,
  due_at - interval '1 minute' * (definition->>'reminderLeadMinutes')::integer as remind_at
from actors where named<>requester_user_id and user_id<>requester_user_id
  and not exists (select from users u where u.id in (named,user_id) and actors.employee_id in (u.employee_record_id,u.employee_id))
  and canonical_delegation_instance_account(named,role_name,kind,instance_id)
  and canonical_delegation_instance_account(user_id,role_name,kind,instance_id)
  and canonical_stage_actor(kind,instance_id,stage,named,user_id,role_name);
