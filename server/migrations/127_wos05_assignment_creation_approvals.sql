-- Explicit creation gating, no adopted buyer values, grants or source backfill.
-- The legacy discriminator is an immutable interpretation of existing proposals.
alter table assignment_approval_instances add column operation_kind text not null default 'MaterialChange' check(operation_kind in('MaterialChange','Creation'));
create function valid_assignment_creation_definition(d jsonb)returns boolean language plpgsql immutable as $$
begin
 if jsonb_typeof(d)is distinct from'object'or(select count(*)from jsonb_object_keys(d))<>8 or not(d?&array['role','quantityUnit','quantityExact','startsOn','endsOn','billable','status','comment'])then return false;end if;
 return coalesce(d->>'quantityUnit'='percentage'and jsonb_typeof(d->'quantityExact')='string'and length(d->>'quantityExact')between 1 and 100 and d->>'quantityExact'~'^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'and(d->>'quantityExact')::numeric between 0 and 200 and valid_capability_date(d->>'startsOn')and valid_capability_date(d->>'endsOn')and d->>'endsOn'>=d->>'startsOn'and jsonb_typeof(d->'billable')='boolean'and d->>'status'in('Active','Paused','Completed')and(d->'role'='null'::jsonb or(jsonb_typeof(d->'role')='string'and valid_capability_label(d->>'role')))and(d->'comment'='null'::jsonb or(jsonb_typeof(d->'comment')='string'and work_period_notice_units(d->>'comment')between 1 and 3000 and btrim(d->>'comment')=d->>'comment')),false);
exception when others then return false;end $$;

create or replace function valid_assignment_approval_definition(d jsonb)returns boolean language plpgsql immutable as $$
declare k text;
begin
 if not valid_work_approval_definition((d-'materialFields'-'creationRequired')||jsonb_build_object('entityType','Timesheet')) or d->>'entityType'is distinct from'Assignment' or jsonb_typeof(d->'materialFields')is distinct from'array' or jsonb_array_length(d->'materialFields')not between 0 and 7 or(jsonb_array_length(d->'materialFields')=0 and not(d?'creationRequired'))or(d?'creationRequired'and jsonb_typeof(d->'creationRequired')is distinct from'boolean') or length(d->>'locale')>100 then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'materialFields')v)<>jsonb_array_length(d->'materialFields')then return false;end if;
 for k in select jsonb_array_elements_text(d->'materialFields')loop if k not in('billable','comment','endsOn','quantityExact','role','startsOn','status')then return false;end if;end loop;return true;
exception when others then return false;end $$;

create function guard_assignment_creation_source()returns trigger language plpgsql as $$
declare p assignment_approval_policies;i assignment_approval_instances;t assignment_approval_transitions;ctx jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 -- INSERT ... ON CONFLICT UPDATE of an existing identity remains an update;
 -- its material/identity and overlap guards still execute normally.
 if exists(select 1 from project_allocations where id=new.id)then return new;end if;
 select * into p from assignment_material_policy(new.organization_id,new.legal_entity_id,new.employee_id);
 if p.id is null or p.definition->'creationRequired'is distinct from'true'::jsonb then return new;end if;
 begin ctx=nullif(current_setting('workos.assignment_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from assignment_approval_instances where id=(ctx->>'instanceId')::uuid;
 select * into t from assignment_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if i.id is null or i.operation_kind<>'Creation'or i.assignment_id<>new.id or i.organization_id<>new.organization_id or i.legal_entity_id<>new.legal_entity_id or i.employee_id<>new.employee_id or i.project_id<>new.project_id or assignment_version_snapshot(new)is distinct from jsonb_build_object('assignmentId',i.assignment_id,'employeeId',i.employee_id,'projectId',i.project_id)||i.proposed_definition or t.decision is distinct from'Approved'or t.sequence is distinct from(select jsonb_array_length(definition->'stages')from assignment_approval_policies where id=i.policy_id)or ctx->>'actorId'is distinct from t.actor_id::text or ctx->>'activeRole'is distinct from t.active_role or ctx->>'organizationId'is distinct from i.organization_id or ctx->>'legalEntityId'is distinct from i.legal_entity_id then raise exception 'Assignment creation requires its exact final governed approval.'using errcode='ASA01';end if;return new;
end $$;
create trigger guarded_assignment_creation_source before insert on project_allocations for each row execute function guard_assignment_creation_source();

create or replace function guard_assignment_approval_append()returns trigger language plpgsql as $$
declare ctx jsonb;i assignment_approval_instances;p assignment_approval_policies;a project_allocations;t assignment_approval_transitions;n integer;terminal boolean;v uuid;
begin
 begin ctx=nullif(current_setting('workos.assignment_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id=(ctx->>'actorId')::uuid and u.status='Active'and r.name=ctx->>'activeRole'and s.organization_id=ctx->>'organizationId'and s.legal_entity_id=ctx->>'legalEntityId'and s.active)then raise exception 'Use the scoped assignment approval command.'using errcode='ASA02';end if;
 if tg_table_name='assignment_approval_policies'then
  select * into p from assignment_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
  if not(new.definition?'creationRequired')and p.definition?'creationRequired'then new.definition=new.definition||jsonb_build_object('creationRequired',p.definition->'creationRequired');end if;
  if new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.sequence<>coalesce(p.sequence,0)+1 or new.effective_from<(clock_timestamp()at time zone'UTC')::date or(p.id is not null and new.effective_from<=p.effective_from)then raise exception 'Append the current prospective policy sequence.'using errcode='ASA02';end if;return new;
 elsif tg_table_name='assignment_approval_templates'then select * into p from assignment_approval_policies where id=new.policy_id;if p.organization_id is distinct from ctx->>'organizationId'or p.legal_entity_id is distinct from ctx->>'legalEntityId'then raise exception 'Template scope unavailable.'using errcode='ASA02';end if;return new;
 elsif tg_table_name='assignment_approval_instances'then
  if new.operation_kind='Creation'then
   select * into p from assignment_material_policy(new.organization_id,new.legal_entity_id,new.employee_id);
   if new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.requester_user_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.operation_id is distinct from ctx->>'operationId'or p.id is null or new.policy_id is distinct from p.id or p.definition->'creationRequired'is distinct from'true'::jsonb or new.before_snapshot is distinct from'null'::jsonb or new.source_version_id is not null or not valid_assignment_creation_definition(new.proposed_definition)or exists(select 1 from project_allocations where id=new.assignment_id)or exists(select 1 from assignment_versions where assignment_id=new.assignment_id)or new.source_token<>encode(digest(new.source_canonical,'sha256'),'hex')or new.source_canonical::jsonb is distinct from jsonb_build_object('operationKind','Creation','assignmentId',new.assignment_id,'employeeId',new.employee_id,'projectId',new.project_id,'before',null,'sourceRevision',new.source_revision,'sourceVersionId',null,'policyId',new.policy_id,'definition',new.proposed_definition)then raise exception 'Creation request requires exact absent scoped source and adopted policy.'using errcode='ASA02';end if;return new;
  end if;
  select * into a from project_allocations where id=new.assignment_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
  select * into p from assignment_material_policy(new.organization_id,new.legal_entity_id,new.employee_id);
  select id into v from assignment_versions where assignment_id=new.assignment_id order by sequence desc limit 1;
  if a.id is null or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.requester_user_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.operation_id is distinct from ctx->>'operationId'or new.employee_id<>a.employee_id or new.project_id<>a.project_id or new.policy_id is distinct from p.id or new.source_revision<>resource_assignment_revision(a)or new.before_snapshot<>assignment_version_snapshot(a)or new.source_version_id is distinct from v or not assignment_requires_approval(new.before_snapshot,new.before_snapshot||new.proposed_definition,p.definition)or new.source_token<>encode(digest(new.source_canonical,'sha256'),'hex')then raise exception 'Proposal requires exact current scoped material source/policy.'using errcode='ASA02';end if;return new;
 elsif tg_table_name='assignment_approval_reads'then
  if ctx->>'actorId'is distinct from new.user_id::text or not exists(select 1 from assignment_approval_recipients r join assignment_approval_events e on e.id=r.event_id join assignment_approval_instances w on w.id=e.instance_id where r.id=new.recipient_id and r.user_id=new.user_id and r.in_app and w.organization_id=ctx->>'organizationId'and w.legal_entity_id=ctx->>'legalEntityId')then raise exception 'Read only your scoped recipient evidence.'using errcode='ASA02';end if;return new;
 elsif tg_table_name='assignment_approval_deliveries'then select w.* into i from assignment_approval_instances w join assignment_approval_events e on e.instance_id=w.id join assignment_approval_recipients r on r.event_id=e.id where r.id=new.recipient_id and r.in_app;
 elsif tg_table_name='assignment_approval_recipients'then select w.* into i from assignment_approval_instances w join assignment_approval_events e on e.instance_id=w.id where e.id=new.event_id;
 else select * into i from assignment_approval_instances where id=new.instance_id;end if;
 if i.id is null or i.organization_id is distinct from ctx->>'organizationId'or i.legal_entity_id is distinct from ctx->>'legalEntityId'then raise exception 'Approval source scope unavailable.'using errcode='ASA02';end if;
 if tg_table_name='assignment_approval_transitions'then
  select * into p from assignment_approval_policies where id=i.policy_id;
  select count(*),coalesce(bool_or(decision='Rejected'),false)into n,terminal from assignment_approval_transitions where instance_id=i.id;
  if terminal or new.sequence<>n+1 or new.stage<>n or new.stage>=jsonb_array_length(p.definition->'stages')or new.actor_id::text is distinct from p.definition->'stages'->new.stage->>'userId'or new.active_role is distinct from p.definition->'stages'->new.stage->>'role'or ctx->>'actorId'is distinct from new.actor_id::text or ctx->>'activeRole'is distinct from new.active_role or ctx->>'operationId'is distinct from new.operation_id or new.actor_id=i.requester_user_id or exists(select 1 from users where id=new.actor_id and employee_record_id=i.employee_id)or(i.operation_kind='MaterialChange'and not exists(select 1 from project_allocations source_row where source_row.id=i.assignment_id and source_row.organization_id=i.organization_id and source_row.legal_entity_id=i.legal_entity_id and resource_assignment_revision(source_row)=i.source_revision))or(i.operation_kind='Creation'and(exists(select 1 from project_allocations where id=i.assignment_id)or exists(select 1 from assignment_versions where assignment_id=i.assignment_id)))then raise exception 'Only the current named stage and exact source can decide.'using errcode='ASA03';end if;
 end if;return new;
end $$;
create or replace function validate_assignment_approval_commit()returns trigger language plpgsql as $$
declare i assignment_approval_instances;p assignment_approval_policies;t assignment_approval_transitions;a project_allocations;seq integer;stage_no integer;key text;ev assignment_approval_events;worker_user uuid;users uuid[];u uuid;r assignment_approval_recipients;reasons text[];state text;
begin
 if tg_table_name='assignment_approval_instances'then i=new;seq=0;stage_no=0;key='approval.action_required';else select * into i from assignment_approval_instances where id=new.instance_id;seq=new.sequence;end if;
 select * into p from assignment_approval_policies where id=i.policy_id;select * into t from assignment_approval_transitions where instance_id=i.id order by sequence desc limit 1;select * into a from project_allocations where id=i.assignment_id;
 state=case when t.decision='Rejected'then'Rejected'when t.sequence=jsonb_array_length(p.definition->'stages')then'Approved'else'Pending'end;
 if not exists(select 1 from approval_records where entity_type='AssignmentProposal'and entity_id=i.id::text and status=state)then raise exception 'Compatibility approval must converge atomically.'using errcode='ASA04';end if;
 if i.operation_kind='Creation'then
  if state='Approved'then
   if assignment_version_snapshot(a)is distinct from jsonb_build_object('assignmentId',i.assignment_id,'employeeId',i.employee_id,'projectId',i.project_id)||i.proposed_definition or not exists(select 1 from assignment_versions v where v.assignment_id=i.assignment_id and v.organization_id=i.organization_id and v.legal_entity_id=i.legal_entity_id and v.sequence=1 and v.change_kind='Created'and v.source_revision=resource_assignment_revision(a)and v.actor_id=t.actor_id::text and v.reason=i.reason)or(select count(*)from assignment_versions where assignment_id=i.assignment_id)<>1 then raise exception 'Final creation and exact V1 must commit together.'using errcode='ASA04';end if;
  elsif a.id is not null or exists(select 1 from assignment_versions where assignment_id=i.assignment_id)then raise exception 'Non-final creation cannot allocate or reserve capacity.'using errcode='ASA04';end if;
 elsif state='Approved'then
  if assignment_version_snapshot(a)is distinct from i.before_snapshot||i.proposed_definition or not exists(select 1 from assignment_versions v where v.assignment_id=i.assignment_id and v.organization_id=i.organization_id and v.legal_entity_id=i.legal_entity_id and v.source_revision=resource_assignment_revision(a)and v.actor_id=t.actor_id::text and v.reason=i.reason)then raise exception 'Final assignment/version outcome must commit together.'using errcode='ASA04';end if;
 elsif resource_assignment_revision(a)is distinct from i.source_revision then raise exception 'Non-final assignment source must stay unchanged.'using errcode='ASA04';end if;
 if tg_table_name='assignment_approval_transitions'then stage_no=new.stage;if new.decision='Rejected'then key='approval.rejected_or_correction_required';elsif new.sequence<jsonb_array_length(p.definition->'stages')then key='approval.action_required';stage_no=new.sequence;else key='approval.completed';end if;end if;
 select * into ev from assignment_approval_events where instance_id=i.id and transition_sequence=seq and event_key=key;
 if key='approval.completed'and ev.id is null and exists(select 1 from assignment_approval_notification_failures where instance_id=i.id and transition_sequence=seq)then return null;end if;
 if ev.id is null or ev.stage<>stage_no or not exists(select 1 from assignment_approval_templates where id=ev.template_id and policy_id=p.id and event_key=key)then raise exception 'Canonical stage event/template is required.'using errcode='ASA04';end if;
 if key='approval.action_required'then users=array[(p.definition->'stages'->stage_no->>'userId')::uuid];else
  if(select count(*)from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=i.employee_id and u.status='Active'and s.organization_id=i.organization_id and s.legal_entity_id=i.legal_entity_id and s.active)<>1 then raise exception 'Affected worker relationship unavailable.'using errcode='ASA04';end if;
  select u.id into worker_user from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=i.employee_id and u.status='Active'and s.organization_id=i.organization_id and s.legal_entity_id=i.legal_entity_id and s.active;select array_agg(distinct x)into users from unnest(array[i.requester_user_id,worker_user])x;
 end if;
 if(select count(*)from assignment_approval_recipients where event_id=ev.id)<>cardinality(users)then raise exception 'Complete protected recipient set required.'using errcode='ASA04';end if;
 foreach u in array users loop
  select * into r from assignment_approval_recipients where event_id=ev.id and user_id=u;reasons=case when key='approval.action_required'then array['current_stage_approver']else array[]::text[]end;
  if key<>'approval.action_required'and u=i.requester_user_id then reasons=array_append(reasons,'requester');end if;if key<>'approval.action_required'and u=worker_user then reasons=array_append(reasons,'affected_worker');end if;
  if r.id is null or not(r.reasons@>reasons and r.reasons<@reasons)or(key<>'approval.completed'and(not r.in_app or r.channel_decision<>'Required'))or(r.in_app and not exists(select 1 from assignment_approval_deliveries where recipient_id=r.id))or(not r.in_app and exists(select 1 from assignment_approval_deliveries where recipient_id=r.id))then raise exception 'Complete canonical recipient/reason/delivery evidence required.'using errcode='ASA04';end if;
 end loop;return null;
end $$;
