-- Explicit prospective named leave approvals. Empty migration: no policies, grants,
-- legacy source adoption, retrospective clocks, defaults or external delivery.
create function valid_leave_approval_definition(d jsonb)returns boolean language sql immutable as $$
 select coalesce(d->>'entityType'='LeaveRequest'and valid_work_approval_definition(d||jsonb_build_object('entityType','Timesheet')),false);
$$;
create table leave_approval_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,sequence integer not null check(sequence>0),effective_from date not null,
 definition jsonb not null check(valid_leave_approval_definition(definition)),actor_id uuid not null references users(id),active_role text not null,
 reason text not null check(length(btrim(reason))between 1 and 1000),created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,sequence),unique(organization_id,legal_entity_id,effective_from)
);
create table leave_approval_templates(id uuid primary key,policy_id uuid not null references leave_approval_policies(id),event_key text not null check(event_key in('approval.action_required','approval.rejected_or_correction_required','approval.completed')),locale text not null,subject text not null,body text not null,unique(policy_id,event_key));
create table leave_approval_instances(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,request_id text not null references leave_requests(id),employee_id text not null references employees(id),
 sequence integer not null check(sequence>0),policy_id uuid not null references leave_approval_policies(id),requester_user_id uuid not null references users(id),actor_id uuid not null references users(id),active_role text not null,
 source_snapshot jsonb not null,source_token text not null check(source_token~'^[a-f0-9]{64}$'),source_canonical text not null,operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(request_id,sequence)
);
create index leave_approval_source_history on leave_approval_instances(organization_id,legal_entity_id,request_id,sequence);
create table leave_approval_transitions(
 id uuid primary key,instance_id uuid not null references leave_approval_instances(id),sequence integer not null check(sequence between 1 and 10),stage integer not null check(stage between 0 and 9),decision text not null check(decision in('Approved','Rejected')),
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null,reason text not null check(length(btrim(reason))between 1 and 1000),operation_id text not null,outcome jsonb not null,created_at timestamptz not null default clock_timestamp(),unique(instance_id,sequence),unique(instance_id,request_id)
);
create table leave_approval_events(
 id text primary key,instance_id uuid not null references leave_approval_instances(id),transition_sequence integer not null check(transition_sequence between 0 and 10),stage integer not null check(stage between 0 and 9),event_key text not null,
 policy_class text not null,template_id uuid not null references leave_approval_templates(id),operation_id text not null,locale text not null,title text not null check(work_period_notice_units(title)between 1 and 1200),body text not null check(work_period_notice_units(body)between 1 and 12000),created_at timestamptz not null default clock_timestamp(),
 unique(instance_id,transition_sequence,event_key),check((event_key in('approval.action_required','approval.rejected_or_correction_required')and policy_class='ACTION_REQUIRED')or(event_key='approval.completed'and policy_class='INFORMATIONAL'))
);
create table leave_approval_recipients(id uuid primary key,event_id text not null references leave_approval_events(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons)between 1 and 3 and reasons<@array['requester','affected_worker','current_stage_approver']::text[]),in_app boolean not null,channel_decision text not null check(channel_decision in('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id));
create table leave_approval_deliveries(id uuid primary key,recipient_id uuid not null unique references leave_approval_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt integer not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table leave_approval_notification_failures(id uuid primary key,instance_id uuid not null references leave_approval_instances(id),transition_sequence integer not null,code text not null check(code='INFORMATIONAL_NOTIFICATION_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence));
create table leave_approval_reads(recipient_id uuid primary key references leave_approval_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
do $$declare t text;begin foreach t in array array['leave_approval_policies','leave_approval_templates','leave_approval_instances','leave_approval_transitions','leave_approval_events','leave_approval_recipients','leave_approval_deliveries','leave_approval_notification_failures','leave_approval_reads']loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;
create table leave_approval_cancellations(
 id uuid primary key,instance_id uuid not null unique references leave_approval_instances(id),actor_id uuid not null references users(id),active_role text not null,reason text,
 previous_status text not null check(previous_status in('Submitted','Approved')),operation_id text not null,created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_leave_approval_cancellations before update or delete on leave_approval_cancellations for each row execute function reject_commercial_draft_rewrite();
create function leave_source_snapshot(lr leave_requests)returns jsonb language sql immutable as $$
 select jsonb_build_object('id',lr.id,'employeeId',lr.employee_id,'leaveTypeId',lr.leave_type_id,'startsOn',lr.start_date::text,'endsOn',lr.end_date::text,'totalDaysExact',trim_scale(lr.total_days::numeric)::text,'reason',lr.reason,'calendarEvidenceId',lr.calendar_evidence_id);
$$;
create function leave_selected_approval_policy(org text,legal text,worker text)returns leave_approval_policies language plpgsql stable as $$declare p leave_approval_policies;begin
 select * into p from leave_approval_policies where organization_id=org and legal_entity_id=legal and effective_from<=(clock_timestamp()at time zone'UTC')::date order by sequence desc limit 1;
 if p.id is not null and p.definition->'workerIds'?worker then return p;end if;return null;
end $$;
create function leave_approval_current(instance_arg uuid)returns boolean language sql stable as $$
 select coalesce(exists(select 1 from leave_approval_instances i join leave_requests lr on lr.id=i.request_id where i.id=instance_arg and lr.status='Submitted'and i.sequence=(select max(sequence)from leave_approval_instances where request_id=i.request_id)and i.source_snapshot=leave_source_snapshot(lr)and not exists(select 1 from leave_approval_cancellations where instance_id=i.id)),false);
$$;
create function guard_leave_approval_append()returns trigger language plpgsql as $$
declare ctx jsonb;i leave_approval_instances;p leave_approval_policies;prior leave_approval_instances;lr leave_requests;n integer;terminal boolean;e employees;s text;
begin
 begin ctx=nullif(current_setting('workos.leave_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id where u.id=(ctx->>'actorId')::uuid and u.status='Active'and r.name=ctx->>'activeRole'and sc.organization_id=ctx->>'organizationId'and sc.legal_entity_id=ctx->>'legalEntityId'and sc.active)then raise exception 'Use the current scoped leave approval command.'using errcode='LGA01';end if;
 if tg_table_name='leave_approval_policies'then
  select * into p from leave_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
  if new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.sequence<>coalesce(p.sequence,0)+1 or new.effective_from<(clock_timestamp()at time zone'UTC')::date or(p.id is not null and new.effective_from<=p.effective_from)or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Append the exact prospective policy.'using errcode='LGA02';end if;return new;
 elsif tg_table_name='leave_approval_templates'then
  select * into p from leave_approval_policies where id=new.policy_id;
  if p.organization_id is distinct from ctx->>'organizationId'or p.legal_entity_id is distinct from ctx->>'legalEntityId'or not exists(select 1 from jsonb_array_elements(p.definition->'templates')t where t->>'key'=new.event_key and t->>'subject'=new.subject and t->>'body'=new.body)or new.locale is distinct from p.definition->>'locale'then raise exception 'Use the exact retained template.'using errcode='LGA01';end if;return new;
 elsif tg_table_name='leave_approval_instances'then
  select * into lr from leave_requests where id=new.request_id;select * into e from employees where id=lr.employee_id;
  select * into prior from leave_approval_instances where request_id=new.request_id order by sequence desc limit 1;
  if prior.id is null then select * into p from leave_selected_approval_policy(e.organization_id,e.legal_entity_id,e.id);else select * into p from leave_approval_policies where id=prior.policy_id;end if;
  if lr.id is null or lr.status<>'Submitted'or p.id is null or new.policy_id is distinct from p.id or new.sequence<>coalesce(prior.sequence,0)+1 or new.employee_id<>lr.employee_id or new.organization_id<>e.organization_id or new.legal_entity_id<>e.legal_entity_id or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.operation_id is distinct from ctx->>'operationId'or new.requester_user_id is distinct from coalesce(prior.requester_user_id,new.actor_id)or new.source_snapshot is distinct from leave_source_snapshot(lr)or new.source_token<>encode(digest(new.source_canonical,'sha256'),'hex')or new.source_canonical::jsonb is distinct from jsonb_build_object('version','leave-approval/1','policyId',new.policy_id,'requesterUserId',new.requester_user_id,'source',new.source_snapshot)or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Retain the exact current leave source, pinned route and actual revision time.'using errcode='LGA02';end if;return new;
 elsif tg_table_name='leave_approval_reads'then
  if ctx->>'actorId'is distinct from new.user_id::text or not exists(select 1 from leave_approval_recipients r join leave_approval_events ev on ev.id=r.event_id join leave_approval_instances w on w.id=ev.instance_id where r.id=new.recipient_id and r.user_id=new.user_id and r.in_app and w.organization_id=ctx->>'organizationId'and w.legal_entity_id=ctx->>'legalEntityId')then raise exception 'Read only the owned scoped recipient.'using errcode='LGA01';end if;return new;
 elsif tg_table_name='leave_approval_deliveries'then select w.* into i from leave_approval_instances w join leave_approval_events ev on ev.instance_id=w.id join leave_approval_recipients r on r.event_id=ev.id where r.id=new.recipient_id and r.in_app;
 elsif tg_table_name='leave_approval_recipients'then select w.* into i from leave_approval_instances w join leave_approval_events ev on ev.instance_id=w.id where ev.id=new.event_id;
 else select * into i from leave_approval_instances where id=new.instance_id;end if;
 if i.id is null or i.organization_id is distinct from ctx->>'organizationId'or i.legal_entity_id is distinct from ctx->>'legalEntityId'then raise exception 'Current leave source scope required.'using errcode='LGA01';end if;
 if tg_table_name='leave_approval_transitions'then
  select * into p from leave_approval_policies where id=i.policy_id;select count(*),coalesce(bool_or(outcome->>'status'<>'Pending'),false)into n,terminal from leave_approval_transitions where instance_id=i.id;
  s=case when new.decision='Rejected'then'Rejected'when new.sequence=jsonb_array_length(p.definition->'stages')then'Approved'else'Pending'end;
  if ctx->>'instanceId'is distinct from i.id::text or terminal or not leave_approval_current(i.id)or new.sequence<>n+1 or new.stage<>n or new.stage>=jsonb_array_length(p.definition->'stages')or new.actor_id::text is distinct from p.definition->'stages'->new.stage->>'userId'or new.active_role is distinct from p.definition->'stages'->new.stage->>'role'or ctx->>'actorId'is distinct from new.actor_id::text or ctx->>'activeRole'is distinct from new.active_role or ctx->>'operationId'is distinct from new.operation_id or new.actor_id=i.requester_user_id or exists(select 1 from users where id=new.actor_id and employee_record_id=i.employee_id)or new.outcome is distinct from jsonb_build_object('status',s,'sequence',new.sequence,'currentStage',case when s='Pending'then new.sequence else null end)or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Only the named current stage and exact current source may decide.'using errcode='LGA03';end if;
 elsif tg_table_name='leave_approval_cancellations'then
  select * into lr from leave_requests where id=i.request_id;
  if ctx->>'instanceId'is distinct from i.id::text or i.sequence is distinct from(select max(sequence)from leave_approval_instances where request_id=i.request_id)or lr.status is distinct from new.previous_status or ctx->>'actorId'is distinct from new.actor_id::text or ctx->>'activeRole'is distinct from new.active_role or ctx->>'operationId'is distinct from new.operation_id or ctx->>'action'is distinct from'Cancel'or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Retain the actual authorized cancellation.'using errcode='LGA03';end if;
 end if;return new;
end $$;
do $$declare t text;begin foreach t in array array['leave_approval_policies','leave_approval_templates','leave_approval_instances','leave_approval_transitions','leave_approval_events','leave_approval_recipients','leave_approval_deliveries','leave_approval_notification_failures','leave_approval_reads','leave_approval_cancellations']loop execute format('create trigger guarded_%I before insert on %I for each row execute function guard_leave_approval_append()',t,t);end loop;end $$;
create function guard_leave_governed_source()returns trigger language plpgsql as $$declare i leave_approval_instances;ctx jsonb;t leave_approval_transitions;begin
 select * into i from leave_approval_instances where request_id=old.id order by sequence desc limit 1;
 if i.id is null then if tg_op='DELETE'then return old;end if;return new;end if;
 if tg_op='DELETE'then raise exception 'Retain governed leave source/history.'using errcode='LGA03';end if;
 begin ctx=nullif(current_setting('workos.leave_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if new.employee_id is distinct from old.employee_id or new.id is distinct from old.id or ctx->>'organizationId'is distinct from i.organization_id or ctx->>'legalEntityId'is distinct from i.legal_entity_id then raise exception 'Governed leave identity/scope is immutable.'using errcode='LGA03';end if;
 if old.status='Submitted'and new.status='Submitted'and ctx->>'action'='Source'and new.comments is not distinct from old.comments and new.approver_id is not distinct from old.approver_id and new.approver_name is not distinct from old.approver_name and new.decided_at is not distinct from old.decided_at and new.submitted_at is not distinct from old.submitted_at and new.created_at is not distinct from old.created_at then return new;end if;
 if old.status in('Submitted','Approved')and new.status='Cancelled'and ctx->>'action'='Cancel'and exists(select 1 from leave_approval_cancellations x where x.instance_id=i.id and x.actor_id::text=ctx->>'actorId'and x.active_role=ctx->>'activeRole'and x.operation_id=ctx->>'operationId'and x.previous_status=old.status)and leave_source_snapshot(new)=leave_source_snapshot(old)then return new;end if;
 select * into t from leave_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if old.status='Submitted'and new.status in('Approved','Rejected')and ctx->>'instanceId'=i.id::text and ctx->>'action'='Decide'and t.outcome->>'status'=new.status and ctx->>'actorId'=t.actor_id::text and ctx->>'activeRole'=t.active_role and ctx->>'operationId'=t.operation_id and leave_source_snapshot(new)=i.source_snapshot and new.comments is not distinct from t.reason and new.approver_id is not distinct from(select coalesce(employee_record_id,id::text)from users where id=t.actor_id)and new.approver_name is not distinct from(select username from users where id=t.actor_id)then return new;end if;
 raise exception 'Use the exact governed leave source or final stage command.'using errcode='LGA03';
end $$;
create trigger governed_leave_source before update or delete on leave_requests for each row execute function guard_leave_governed_source();
create function validate_leave_source_commit()returns trigger language plpgsql as $$declare i leave_approval_instances;p leave_approval_policies;e employees;t leave_approval_transitions;state text;current_row leave_requests;begin
 select * into current_row from leave_requests where id=new.id;
 select * into e from employees where id=new.employee_id;select * into i from leave_approval_instances where request_id=new.id order by sequence desc limit 1;
 if i.id is null then
  if tg_op='INSERT'then select * into p from leave_selected_approval_policy(e.organization_id,e.legal_entity_id,e.id);if p.id is not null then raise exception 'New selected leave requires canonical source and initial handoff.'using errcode='LGA04';end if;end if;return null;
 end if;
 if leave_source_snapshot(current_row)is distinct from i.source_snapshot then raise exception 'Every source edit must retain a new exact governed revision.'using errcode='LGA04';end if;
 select * into t from leave_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 state=case when exists(select 1 from leave_approval_cancellations where instance_id=i.id)then'Cancelled'when t.outcome->>'status'='Approved'then'Approved'when t.outcome->>'status'='Rejected'then'Rejected'else'Submitted'end;
 if current_row.status is distinct from state then raise exception 'Leave source must converge with retained stages/cancellation.'using errcode='LGA04';end if;return null;
end $$;
create constraint trigger leave_source_commit after insert or update on leave_requests deferrable initially deferred for each row execute function validate_leave_source_commit();
create function guard_leave_compatibility_decision()returns trigger language plpgsql as $$declare i leave_approval_instances;t leave_approval_transitions;ctx jsonb;state text;begin
 if old.entity_type<>'LeaveRequest'then if tg_op='DELETE'then return old;end if;return new;end if;
 select * into i from leave_approval_instances where request_id=old.entity_id order by sequence desc limit 1;
 if i.id is null then if tg_op='DELETE'then return old;end if;return new;end if;
 if tg_op='DELETE'then raise exception 'Retain governed leave compatibility evidence.'using errcode='LGA03';end if;
 begin ctx=nullif(current_setting('workos.leave_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into t from leave_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 state=case when exists(select 1 from leave_approval_cancellations where instance_id=i.id)then'Cancelled'else coalesce(t.outcome->>'status','Pending')end;
 if ctx->>'instanceId'is distinct from i.id::text or new.status is distinct from state or new.due_at is not null then raise exception 'Use the exact canonical leave stage command.'using errcode='LGA03';end if;return new;
end $$;
create trigger governed_leave_compatibility before update or delete on approval_records for each row execute function guard_leave_compatibility_decision();
create function validate_leave_approval_commit()returns trigger language plpgsql as $$
declare i leave_approval_instances;p leave_approval_policies;lr leave_requests;t leave_approval_transitions;seq integer;stage_no integer;key text;ev leave_approval_events;worker_user uuid;ids uuid[];u uuid;r leave_approval_recipients;reasons text[];state text;
begin
 if tg_table_name='leave_approval_policies'then
  if(select count(*)from leave_approval_templates where policy_id=new.id)<>3 then raise exception 'Retain all three canonical templates atomically.'using errcode='LGA04';end if;return null;
 elsif tg_table_name='leave_approval_instances'then i=new;seq=0;stage_no=0;key='approval.action_required';
 else select * into i from leave_approval_instances where id=new.instance_id;seq=new.sequence;stage_no=new.stage;end if;
 select * into p from leave_approval_policies where id=i.policy_id;select * into lr from leave_requests where id=i.request_id;
 select * into t from leave_approval_transitions where instance_id=i.id order by sequence desc limit 1;state=coalesce(t.outcome->>'status','Pending');
 if not exists(select 1 from approval_records where entity_type='LeaveRequest'and entity_id=i.request_id and status=case when state='Pending'then'Pending'else state end and due_at is null)or lr.status is distinct from(case when state='Pending'then'Submitted'else state end) or leave_source_snapshot(lr)is distinct from i.source_snapshot then raise exception 'Exact leave source and compatibility outcome must converge atomically.'using errcode='LGA04';end if;
 if tg_table_name='leave_approval_transitions'then
  if new.decision='Rejected'then key='approval.rejected_or_correction_required';elsif new.sequence<jsonb_array_length(p.definition->'stages')then key='approval.action_required';stage_no=new.sequence;else key='approval.completed';end if;
 end if;
 select * into ev from leave_approval_events where instance_id=i.id and transition_sequence=seq and event_key=key;
 if key='approval.completed'and ev.id is null and exists(select 1 from leave_approval_notification_failures where instance_id=i.id and transition_sequence=seq)then return null;end if;
 if ev.id is null or ev.stage<>stage_no or not exists(select 1 from leave_approval_templates where id=ev.template_id and policy_id=p.id and event_key=key and locale=ev.locale)then raise exception 'Canonical leave stage event and retained template required.'using errcode='LGA04';end if;
 if key='approval.action_required'then ids=array[(p.definition->'stages'->stage_no->>'userId')::uuid];else
  if(select count(*)from users w join user_organization_scopes sc on sc.user_id=w.id where w.employee_record_id=i.employee_id and w.status='Active'and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active)<>1 then raise exception 'Affected leave worker account unavailable.'using errcode='LGA04';end if;
  select w.id into worker_user from users w join user_organization_scopes sc on sc.user_id=w.id where w.employee_record_id=i.employee_id and w.status='Active'and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active;
  select array_agg(distinct x)into ids from unnest(array[i.requester_user_id,worker_user])x;
 end if;
 if(select count(*)from leave_approval_recipients where event_id=ev.id)<>cardinality(ids)then raise exception 'Complete canonical leave recipient set required.'using errcode='LGA04';end if;
 foreach u in array ids loop
  select * into r from leave_approval_recipients where event_id=ev.id and user_id=u;reasons=case when key='approval.action_required'then array['current_stage_approver']else array[]::text[]end;
  if key<>'approval.action_required'and u=i.requester_user_id then reasons=array_append(reasons,'requester');end if;if key<>'approval.action_required'and u=worker_user then reasons=array_append(reasons,'affected_worker');end if;
  if r.id is null or not(r.reasons@>reasons and r.reasons<@reasons)or(key<>'approval.completed'and(not r.in_app or r.channel_decision<>'Required'))or(r.in_app and not exists(select 1 from leave_approval_deliveries where recipient_id=r.id))or(not r.in_app and exists(select 1 from leave_approval_deliveries where recipient_id=r.id))then raise exception 'Complete atomic leave recipient, reason and accepted delivery required.'using errcode='LGA04';end if;
 end loop;return null;
end $$;
create constraint trigger leave_approval_policy_commit after insert on leave_approval_policies deferrable initially deferred for each row execute function validate_leave_approval_commit();
create constraint trigger leave_approval_instance_commit after insert on leave_approval_instances deferrable initially deferred for each row execute function validate_leave_approval_commit();
create constraint trigger leave_approval_transition_commit after insert on leave_approval_transitions deferrable initially deferred for each row execute function validate_leave_approval_commit();
create index leave_approval_recipient_inbox on leave_approval_recipients(user_id,id);

-- Extend the existing explicit prospective due engine; no old-source backfill.
-- Empty prospective, explicitly configured elapsed-UTC clocks. No backfill/default/grant/scheduler.
create or replace function valid_approval_due_definition(d jsonb)returns boolean language plpgsql immutable as $$
declare x jsonb;k text;s text;expanded text;
begin
 if jsonb_typeof(d)is distinct from'object'or(select count(*)from jsonb_object_keys(d))<>8 or not(d?&array['workerIds','sourceKinds','clockBasis','cohort','dueAfterMinutes','target','locale','template'])or d->>'clockBasis'is distinct from'StagePendingUTC'or d->>'cohort'is distinct from'NewInstances'or jsonb_typeof(d->'dueAfterMinutes')is distinct from'number'or(d->>'dueAfterMinutes')!~'^[0-9]+$'or(d->>'dueAfterMinutes')::numeric not between 1 and 527040 or jsonb_typeof(d->'workerIds')is distinct from'array'or jsonb_array_length(d->'workerIds')>200 or jsonb_typeof(d->'sourceKinds')is distinct from'array'or jsonb_array_length(d->'sourceKinds')not between 1 and 4 or jsonb_typeof(d->'locale')is distinct from'string'or work_period_notice_units(d->>'locale')>100 or(d->>'locale')!~'^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'workerIds')v)<>jsonb_array_length(d->'workerIds')or(select count(distinct v)from jsonb_array_elements_text(d->'sourceKinds')v)<>jsonb_array_length(d->'sourceKinds')then return false;end if;
 for x in select value from jsonb_array_elements(d->'workerIds')loop if jsonb_typeof(x)is distinct from'string'or work_period_notice_units(x#>>'{}')not between 1 and 200 or btrim(x#>>'{}')<>x#>>'{}'then return false;end if;end loop;
 for x in select value from jsonb_array_elements(d->'sourceKinds')loop if jsonb_typeof(x)is distinct from'string'or x#>>'{}'not in('Work','Material','Creation','Leave')then return false;end if;end loop;
 x=d->'target';if jsonb_typeof(x)is distinct from'object'or(select count(*)from jsonb_object_keys(x))<>2 or not(x?&array['userId','role'])or jsonb_typeof(x->'userId')is distinct from'string'or(x->>'userId')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'or jsonb_typeof(x->'role')is distinct from'string'or work_period_notice_units(x->>'role')not between 1 and 100 or btrim(x->>'role')<>x->>'role'then return false;end if;
 x=d->'template';if jsonb_typeof(x)is distinct from'object'or(select count(*)from jsonb_object_keys(x))<>3 or not(x?&array['key','subject','body'])or x->>'key'is distinct from'approval.overdue_or_escalated'then return false;end if;
 foreach k in array array['subject','body']loop s=x->>k;if jsonb_typeof(x->k)is distinct from'string'or work_period_notice_units(s)not between 1 and(case when k='subject'then 200 else 8000 end)or btrim(s)<>s then return false;end if;expanded=s;expanded=regexp_replace(expanded,'\{\{\s*workerCode\s*\}\}',repeat('x',200),'g');expanded=regexp_replace(expanded,'\{\{\s*sourceRef\s*\}\}',repeat('x',239),'g');expanded=regexp_replace(expanded,'\{\{\s*stageNumber\s*\}\}','xx','g');expanded=regexp_replace(expanded,'\{\{\s*(pendingAt|dueAt)\s*\}\}',repeat('x',24),'g');if expanded~'[{}]'or work_period_notice_units(expanded)>(case when k='subject'then 1200 else 12000 end)then return false;end if;end loop;return true;
exception when others then return false;end $$;
create or replace view approval_due_source_events as
 select 'Work'::text origin,i.id instance_id,i.organization_id,i.legal_entity_id,i.employee_id,null::text project_id,i.timesheet_id::text source_ref,i.source_token,i.created_at instance_created_at,e.id source_event_id,e.stage,e.transition_sequence,e.created_at activated_at,(p.definition->'stages'->e.stage->>'userId')::uuid approver_user_id,p.definition->'stages'->e.stage->>'role' approver_role
 from work_approval_events e join work_approval_instances i on i.id=e.instance_id join work_approval_policy_versions p on p.id=i.policy_id where e.event_key='approval.action_required'
 union all select case when i.operation_kind='Creation'then'Creation'else'Material'end,i.id,i.organization_id,i.legal_entity_id,i.employee_id,i.project_id,i.assignment_id,i.source_token,i.created_at,e.id,e.stage,e.transition_sequence,e.created_at,(p.definition->'stages'->e.stage->>'userId')::uuid,p.definition->'stages'->e.stage->>'role'from assignment_approval_events e join assignment_approval_instances i on i.id=e.instance_id join assignment_approval_policies p on p.id=i.policy_id where e.event_key='approval.action_required'
 union all select 'Leave',i.id,i.organization_id,i.legal_entity_id,i.employee_id,null::text,i.request_id,i.source_token,i.created_at,e.id,e.stage,e.transition_sequence,e.created_at,(p.definition->'stages'->e.stage->>'userId')::uuid,p.definition->'stages'->e.stage->>'role'from leave_approval_events e join leave_approval_instances i on i.id=e.instance_id join leave_approval_policies p on p.id=i.policy_id where e.event_key='approval.action_required';
alter table approval_due_bindings drop constraint approval_due_bindings_origin_check;
alter table approval_due_bindings add check(origin in('Work','Material','Creation','Leave'));
create or replace function retain_approval_due_clock()returns trigger language plpgsql as $$declare s approval_due_source_events;p uuid;d integer;begin
 if new.event_key<>'approval.action_required'then return null;end if;
 select * into s from approval_due_source_events where source_event_id=new.id and origin=case when tg_table_name='work_approval_events'then'Work'when tg_table_name='leave_approval_events'then'Leave'else(select case when operation_kind='Creation'then'Creation'else'Material'end from assignment_approval_instances where id=new.instance_id)end;
 if s.stage=0 then p=approval_due_selected_policy(s);if p is not null then insert into approval_due_bindings values(s.origin,s.instance_id,p);end if;else select policy_id into p from approval_due_bindings where origin=s.origin and instance_id=s.instance_id;end if;
 if p is not null then select(definition->>'dueAfterMinutes')::integer into d from approval_due_policies where id=p;insert into approval_due_clocks values(gen_random_uuid(),s.origin,s.instance_id,s.source_event_id,s.stage,s.activated_at,s.activated_at+d*interval '1 minute',s.approver_user_id,s.approver_role);end if;return null;
end $$;
create or replace function approval_due_current(origin_arg text,instance_arg uuid,stage_arg integer)returns boolean language plpgsql stable as $$declare n integer;terminal boolean;i work_approval_instances;a assignment_approval_instances;l leave_approval_instances;begin
 if origin_arg='Leave'then
 select * into l from leave_approval_instances where id=instance_arg;select coalesce(max(sequence),0),coalesce(bool_or(outcome->>'status'<>'Pending'),false)into n,terminal from leave_approval_transitions where instance_id=instance_arg;return coalesce(l.id is not null and not terminal and stage_arg=n and leave_approval_current(l.id),false);end if;
 if origin_arg='Work'then
  select * into i from work_approval_instances where id=instance_arg;select coalesce(max(sequence),0),coalesce(bool_or(outcome->>'status'<>'Pending'),false)into n,terminal from work_approval_transitions where instance_id=instance_arg;
  return coalesce(i.id is not null and not terminal and stage_arg=n and exists(select 1 from timesheets t where t.id=i.timesheet_id and t.status='Submitted')and i.submission_id=(select id from work_submission_evidence where timesheet_id=i.timesheet_id order by sequence desc limit 1),false);
 end if;
 select * into a from assignment_approval_instances where id=instance_arg;select coalesce(max(sequence),0),coalesce(bool_or(outcome->>'status'<>'Pending'),false)into n,terminal from assignment_approval_transitions where instance_id=instance_arg;
 return coalesce(a.id is not null and origin_arg=case when a.operation_kind='Creation'then'Creation'else'Material'end and not terminal and stage_arg=n and case when a.operation_kind='Creation'then not exists(select 1 from project_allocations where id=a.assignment_id)and not exists(select 1 from assignment_versions where assignment_id=a.assignment_id)else exists(select 1 from project_allocations x where x.id=a.assignment_id and resource_assignment_revision(x)=a.source_revision)and a.source_version_id is not distinct from(select id from assignment_versions where assignment_id=a.assignment_id order by sequence desc limit 1)end,false);
end $$;
create trigger retained_leave_due_clock after insert on leave_approval_events for each row execute function retain_approval_due_clock();
