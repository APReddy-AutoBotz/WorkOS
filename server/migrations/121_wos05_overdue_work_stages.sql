-- A finished stage can cross its deadline between worker ticks. Its retained
-- transition time decides whether it was late even after the next stage starts.
create view work_approval_timed_stages as
select i.organization_id,i.legal_entity_id,i.id as instance_id,a.stage,i.policy_id,
       (p.definition->'stages'->a.stage->>'userId')::uuid as approver_id,
       (p.definition->>'escalationUserId')::uuid as escalation_id,
       coalesce(started.created_at,i.created_at) +
         make_interval(mins=>(p.definition->>'stageDueMinutes')::numeric::integer) as due_at,
       ended.created_at as decided_at
from work_approval_instances i
join work_approval_policy_versions p on p.id=i.policy_id
join work_approval_events a on a.instance_id=i.id and a.event_key='approval.action_required'
left join work_approval_transitions started on started.instance_id=i.id and started.sequence=a.stage
left join work_approval_transitions ended on ended.instance_id=i.id and ended.sequence=a.stage+1
where p.definition ? 'stageDueMinutes';

create table work_approval_overdue_stages (
  instance_id uuid not null references work_approval_instances(id),
  stage integer not null check(stage between 0 and 9),
  due_at timestamptz not null,
  detected_at timestamptz not null default clock_timestamp(),
  primary key(instance_id,stage)
);

create function guard_work_approval_overdue_stage() returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' then raise exception 'Overdue stage evidence is immutable.'; end if;
  new.detected_at := clock_timestamp();
  if not exists(select 1 from work_approval_timed_stages s
    where s.instance_id=new.instance_id and s.stage=new.stage and s.due_at=new.due_at
      and s.due_at < least(new.detected_at,coalesce(s.decided_at,new.detected_at))) then
    raise exception 'A retained stage must have exceeded its deadline.' using errcode='WGA05';
  end if;
  return new;
end $$;
create trigger guard_work_approval_overdue_stage before insert or update or delete on work_approval_overdue_stages
for each row execute function guard_work_approval_overdue_stage();
