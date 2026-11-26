alter table work_approval_policy_versions drop constraint work_approval_definition_shape;
alter table work_approval_policy_versions add constraint work_approval_definition_shape check (
  valid_work_approval_definition(definition - 'stageDueMinutes' - 'escalationUserId' - 'overdueTemplate')
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

create table work_approval_overdue_attempts(
  instance_id uuid not null, stage integer not null, attempt integer not null check(attempt>0),
  created_at timestamptz not null default clock_timestamp(), failure text check(failure='RECIPIENT_UNAVAILABLE'),
  approver_receipt uuid unique, escalation_receipt uuid unique,
  template_id uuid,locale text,title text,body text,
  primary key(instance_id,stage,attempt),
  foreign key(instance_id,stage) references work_approval_overdue_stages(instance_id,stage),
  check((failure is null)=(approver_receipt is not null)),
  check((failure is null)=(template_id is not null and locale is not null and title is not null and body is not null))
);
create unique index work_approval_overdue_delivered_once on work_approval_overdue_attempts(instance_id,stage) where failure is null;
create function guard_work_approval_overdue_attempt() returns trigger language plpgsql as $$
declare src work_approval_timed_stages; prior work_approval_overdue_attempts; instance work_approval_instances; policy work_approval_policy_versions; held text;
begin
  if tg_op<>'INSERT' then raise exception 'Delivery attempts are immutable.'; end if;
  perform 1 from work_approval_overdue_stages where instance_id=new.instance_id and stage=new.stage for update;
  select * into src from work_approval_timed_stages where instance_id=new.instance_id and stage=new.stage;
  select * into prior from work_approval_overdue_attempts where instance_id=new.instance_id and stage=new.stage order by attempt desc limit 1;
  if src.instance_id is null or new.attempt<>coalesce(prior.attempt,0)+1 or (prior.attempt is not null and prior.failure is null)
    or (new.escalation_receipt is not null)<>(new.failure is null and src.escalation_id is not null and src.escalation_id<>src.approver_id)
    or new.escalation_receipt=new.approver_receipt then raise exception 'Invalid overdue delivery evidence.' using errcode='WGA05'; end if;
  if new.failure is null then
    select * into instance from work_approval_instances where id=new.instance_id;
    select * into policy from work_approval_policy_versions where id=instance.policy_id;
    held:=policy.definition->'stages'->new.stage->>'role';
    if new.template_id is distinct from (case when policy.definition ? 'overdueTemplate' then policy.id else '0525e4f1-2f48-48b7-bdc6-3774721b5c0c'::uuid end)
      or new.locale is distinct from (case when policy.definition ? 'overdueTemplate' then policy.definition->>'locale' else 'en' end)
      or exists(select from unnest(array['timesheets.approve','timesheets.submit','projects.view','approvals.view','employees.view','notifications.view']) k
        where invoice_notice_actor_has(src.organization_id,src.legal_entity_id,src.approver_id,held,k) is not true)
      or invoice_historical_worker_visible(src.organization_id,src.legal_entity_id,instance.employee_id,src.approver_id,held) is not true
      or (src.escalation_id is not null and not exists(select from user_roles ur join roles r on r.id=ur.role_id
        where ur.user_id=src.escalation_id and invoice_notice_actor_has(src.organization_id,src.legal_entity_id,src.escalation_id,r.name,'notifications.view')
          and invoice_historical_worker_visible(src.organization_id,src.legal_entity_id,instance.employee_id,src.escalation_id,r.name))) then
      raise exception 'Required scoped overdue recipient or template unavailable.' using errcode='WGA05';
    end if;
  end if;
  new.created_at:=clock_timestamp();
  return new;
end $$;
create trigger guard_work_approval_overdue_attempt before insert or update or delete on work_approval_overdue_attempts
for each row execute function guard_work_approval_overdue_attempt();

create view work_approval_overdue_inbox as
select s.organization_id,s.legal_entity_id,i.employee_id,i.timesheet_id,i.submission_id,
       a.instance_id,a.stage,a.template_id,a.locale,a.title,a.body,a.created_at,r.*
from work_approval_overdue_attempts a join work_approval_timed_stages s using(instance_id,stage)
join work_approval_instances i on i.id=a.instance_id
cross join lateral (values
  (a.approver_receipt,s.approver_id,case when s.approver_id=s.escalation_id then array['current_stage_approver','escalation_target'] else array['current_stage_approver'] end),
  (a.escalation_receipt,s.escalation_id,array['escalation_target'])
) r(id,user_id,reasons)
where a.failure is null and r.id is not null;

create table work_approval_overdue_reads(
 recipient_id uuid primary key,user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp()
);
create function guard_work_approval_overdue_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 if tg_op<>'INSERT' then raise exception 'Read evidence is immutable.'; end if;
 ctx:=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
 if ctx->>'actorId' is distinct from new.user_id::text or not exists(select 1 from work_approval_overdue_inbox
 where id=new.recipient_id and user_id=new.user_id and organization_id=ctx->>'organizationId' and legal_entity_id=ctx->>'legalEntityId')
 then raise exception 'Read only your scoped overdue notice.' using errcode='WGA01'; end if;
 return new;
end $$;
create trigger guard_work_approval_overdue_read before insert or update or delete on work_approval_overdue_reads
for each row execute function guard_work_approval_overdue_read();
