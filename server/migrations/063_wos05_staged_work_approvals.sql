-- Empty prospective configuration and immutable evidence; no grants/defaults,
-- legacy conversion, external delivery or protected reopen.
create table work_approval_policy_versions(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,sequence integer not null check(sequence>0),effective_from date not null,
 policy_version text not null check(policy_version='work-approval/1'),definition jsonb not null check(jsonb_typeof(definition)='object'),
 actor_id uuid not null references users(id),active_role text not null,reason text not null check(length(btrim(reason))between 1 and 1000),created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,sequence),unique(organization_id,legal_entity_id,effective_from)
);
create table work_approval_templates(
 id uuid primary key,policy_id uuid not null references work_approval_policy_versions(id),event_key text not null check(event_key in('approval.action_required','approval.rejected_or_correction_required','approval.completed')),
 locale text not null,subject text not null,body text not null,unique(policy_id,event_key)
);
create table work_approval_instances(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,timesheet_id uuid not null references timesheets(id),submission_id text not null unique references work_submission_evidence(id),
 submission_sequence integer not null check(submission_sequence>0),policy_id uuid not null references work_approval_policy_versions(id),employee_id text not null references employees(id),requester_user_id uuid not null references users(id),
 source_token text not null check(source_token~'^[a-f0-9]{64}$'),source_canonical text not null,created_at timestamptz not null default clock_timestamp(),foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id)
);
create index work_approval_source_history on work_approval_instances(organization_id,legal_entity_id,timesheet_id,submission_sequence desc);
create table work_approval_transitions(
 id uuid primary key,instance_id uuid not null references work_approval_instances(id),sequence integer not null check(sequence between 1 and 10),stage integer not null check(stage between 0 and 9),decision text not null check(decision in('Approved','Rejected')),
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason))between 1 and 1000),
 operation_id text not null,outcome jsonb not null,created_at timestamptz not null default clock_timestamp(),unique(instance_id,sequence),unique(instance_id,request_id)
);
create table work_approval_events(
 id text primary key,instance_id uuid not null references work_approval_instances(id),transition_sequence integer not null check(transition_sequence between 0 and 10),stage integer not null check(stage between 0 and 9),event_key text not null,
 policy_class text not null check(policy_class in('ACTION_REQUIRED','INFORMATIONAL')),template_id uuid not null references work_approval_templates(id),operation_id text not null,locale text not null,title text not null,body text not null,created_at timestamptz not null default clock_timestamp(),
 unique(instance_id,transition_sequence,event_key),check((event_key in('approval.action_required','approval.rejected_or_correction_required')and policy_class='ACTION_REQUIRED')or(event_key='approval.completed'and policy_class='INFORMATIONAL'))
);
create table work_approval_recipients(
 id uuid primary key,event_id text not null references work_approval_events(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons)between 1 and 3),in_app boolean not null,
 channel_decision text not null check(channel_decision in('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id)
);
create table work_approval_notification_failures(
 id uuid primary key,instance_id uuid not null references work_approval_instances(id),transition_sequence integer not null,code text not null check(code='INFORMATIONAL_NOTIFICATION_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence)
);
create table work_approval_reads(
 recipient_id uuid primary key references work_approval_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['work_approval_policy_versions','work_approval_templates','work_approval_instances','work_approval_transitions','work_approval_events','work_approval_recipients','work_approval_notification_failures','work_approval_reads']loop
 execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);
end loop;end $$;
create function guard_work_approval_append()returns trigger language plpgsql as $$
declare ctx jsonb;i work_approval_instances;p work_approval_policy_versions;last_stage integer;n integer;terminal boolean;s work_submission_evidence;
begin
 begin ctx=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users where id=(ctx->>'actorId')::uuid and status='Active')then raise exception 'Use the scoped work-approval command.'using errcode='WGA01';end if;
 if tg_table_name='work_approval_policy_versions'then
  select * into p from work_approval_policy_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
  if ctx->>'organizationId'is distinct from new.organization_id or ctx->>'legalEntityId'is distinct from new.legal_entity_id or ctx->>'actorId'is distinct from new.actor_id::text or ctx->>'activeRole'is distinct from new.active_role or new.sequence<>coalesce(p.sequence,0)+1 or new.effective_from<(clock_timestamp()at time zone'UTC')::date or(p.id is not null and new.effective_from<=p.effective_from)then raise exception 'Policy must append prospectively in its scoped sequence.'using errcode='WGA02';end if;return new;
 end if;
 if tg_table_name='work_approval_templates'then select * into p from work_approval_policy_versions where id=new.policy_id;
  if ctx->>'organizationId'is distinct from p.organization_id or ctx->>'legalEntityId'is distinct from p.legal_entity_id then raise exception 'Template policy scope unavailable.'using errcode='WGA01';end if;return new;
 end if;
 if tg_table_name='work_approval_instances'then
  select * into s from work_submission_evidence where id=new.submission_id;select * into p from work_approval_policy_versions where id=new.policy_id;
  if ctx->>'organizationId'is distinct from new.organization_id or ctx->>'legalEntityId'is distinct from new.legal_entity_id or s.timesheet_id<>new.timesheet_id or s.organization_id<>new.organization_id or s.legal_entity_id<>new.legal_entity_id or s.sequence<>new.submission_sequence or s.actor_id<>new.requester_user_id or p.organization_id<>new.organization_id or p.legal_entity_id<>new.legal_entity_id or not(p.definition->'workerIds'?new.employee_id)or not exists(select 1 from timesheets where id=new.timesheet_id and employee_id=new.employee_id and status='Submitted')or new.source_token<>encode(digest(new.source_canonical,'sha256'),'hex')then raise exception 'Work approval requires exact scoped submitted evidence.'using errcode='WGA01';end if;return new;
 end if;
 if tg_table_name='work_approval_reads'then
  if ctx->>'actorId'is distinct from new.user_id::text or not exists(select 1 from work_approval_recipients r join work_approval_events e on e.id=r.event_id join work_approval_instances w on w.id=e.instance_id where r.id=new.recipient_id and r.user_id=new.user_id and r.in_app and w.organization_id=ctx->>'organizationId'and w.legal_entity_id=ctx->>'legalEntityId')then raise exception 'Read only your scoped in-app receipt.'using errcode='WGA01';end if;return new;
 end if;
 if tg_table_name='work_approval_recipients'then select w.* into i from work_approval_instances w join work_approval_events e on e.instance_id=w.id where e.id=new.event_id;
 else select * into i from work_approval_instances where id=new.instance_id;end if;
 if i.id is null or ctx->>'organizationId'is distinct from i.organization_id or ctx->>'legalEntityId'is distinct from i.legal_entity_id then raise exception 'Approval evidence scope is unavailable.'using errcode='WGA01';end if;
 if tg_table_name='work_approval_transitions'then
  select * into p from work_approval_policy_versions where id=i.policy_id;
  select count(*),coalesce(bool_or(decision='Rejected'),false)into n,terminal from work_approval_transitions where instance_id=i.id;
  if terminal or new.sequence<>n+1 or new.stage<>n or new.stage>=jsonb_array_length(p.definition->'stages')or new.actor_id::text<>p.definition->'stages'->new.stage->>'userId'or new.active_role<>p.definition->'stages'->new.stage->>'role'or ctx->>'actorId'is distinct from new.actor_id::text or ctx->>'activeRole'is distinct from new.active_role or ctx->>'operationId'is distinct from new.operation_id or new.actor_id=i.requester_user_id or not exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=new.actor_id and r.name=new.active_role) or exists(select 1 from users where id=new.actor_id and employee_record_id=i.employee_id)or not exists(select 1 from timesheets t where t.id=i.timesheet_id and t.status='Submitted')then raise exception 'Only the current authorized stage can append a decision.'using errcode='WGA03';end if;
 end if;return new;
end $$;
do $$declare t text;begin foreach t in array array['work_approval_policy_versions','work_approval_templates','work_approval_instances','work_approval_transitions','work_approval_events','work_approval_recipients','work_approval_notification_failures','work_approval_reads']loop
 execute format('create trigger guarded_%I before insert on %I for each row execute function guard_work_approval_append()',t,t);
end loop;end $$;
create function require_governed_work_outcome()returns trigger language plpgsql as $$
declare i work_approval_instances;p work_approval_policy_versions;last work_approval_transitions;ctx jsonb;
begin
 if old.status<>'Submitted'or new.status not in('Approved','Rejected')then return new;end if;
 select w.* into i from work_approval_instances w join work_submission_evidence s on s.id=w.submission_id where w.timesheet_id=old.id and w.submission_id=(select id from work_submission_evidence where timesheet_id=old.id order by sequence desc limit 1)order by w.submission_sequence desc limit 1;
 if i.id is null then return new;end if;
 select * into p from work_approval_policy_versions where id=i.policy_id;select * into last from work_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 begin ctx=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx->>'instanceId'is distinct from i.id::text or ctx->>'actorId'is distinct from last.actor_id::text or last.decision is distinct from new.status or(new.status='Approved'and last.sequence<>jsonb_array_length(p.definition->'stages'))or i.submission_id is distinct from(select id from work_submission_evidence where timesheet_id=old.id order by sequence desc limit 1)then raise exception 'Use the exact governed current-stage work decision.'using errcode='WGA04';end if;return new;
end $$;
create trigger governed_work_outcome before update of status on timesheets for each row execute function require_governed_work_outcome();

create function valid_work_approval_definition(d jsonb)returns boolean language plpgsql immutable as $$
declare x jsonb;t jsonb;
begin
 if jsonb_typeof(d)<>'object'or not(d?&array['entityType','workerIds','stages','locale','templates','completionInApp'])or(select count(*)from jsonb_object_keys(d))<>6 or jsonb_typeof(d->'entityType')is distinct from 'string'or d->>'entityType'<>'Timesheet'or jsonb_typeof(d->'workerIds')<>'array'or jsonb_array_length(d->'workerIds')not between 0 and 200 or jsonb_typeof(d->'stages')<>'array'or jsonb_array_length(d->'stages')not between 1 and 10 or jsonb_typeof(d->'templates')<>'array'or jsonb_array_length(d->'templates')<>3 or jsonb_typeof(d->'completionInApp')<>'boolean'or jsonb_typeof(d->'locale')is distinct from 'string'or d->>'locale'!~'^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'workerIds')v)<>jsonb_array_length(d->'workerIds')then return false;end if;
 for x in select value from jsonb_array_elements(d->'workerIds')loop if jsonb_typeof(x)<>'string'or length(x#>>'{}')not between 1 and 200 then return false;end if;end loop;
 for x in select value from jsonb_array_elements(d->'stages')loop
  if jsonb_typeof(x)<>'object'or not(x?&array['userId','role'])or(select count(*)from jsonb_object_keys(x))<>2 or jsonb_typeof(x->'userId')is distinct from 'string'or jsonb_typeof(x->'role')is distinct from 'string'or x->>'userId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'or length(btrim(x->>'role'))not between 1 and 100 then return false;end if;
 end loop;
 if(select count(distinct v->>'key')from jsonb_array_elements(d->'templates')v)<>3 then return false;end if;
 for t in select value from jsonb_array_elements(d->'templates')loop
  if jsonb_typeof(t)<>'object'or not(t?&array['key','subject','body'])or(select count(*)from jsonb_object_keys(t))<>3 or jsonb_typeof(t->'key')is distinct from 'string'or jsonb_typeof(t->'subject')is distinct from 'string'or jsonb_typeof(t->'body')is distinct from 'string'or t->>'key'not in('approval.action_required','approval.rejected_or_correction_required','approval.completed')or length(btrim(t->>'subject'))not between 1 and 200 or length(btrim(t->>'body'))not between 1 and 8000 then return false;end if;
 end loop;return true;
exception when others then return false;
end $$;
alter table work_approval_policy_versions add constraint work_approval_definition_shape check(valid_work_approval_definition(definition));
alter table work_approval_recipients add constraint work_approval_recipient_reasons check(reasons<@array['requester','affected_worker','current_stage_approver']::text[]);

-- A source submission and an adopted instance must converge in the same commit.
-- Existing submitted work is never retroactively assigned an instance.
create function require_new_work_approval_instance()returns trigger language plpgsql as $$
declare p work_approval_policy_versions;t timesheets;
begin
 select * into t from timesheets where id=new.timesheet_id;
 select v.* into p from work_approval_policy_versions v where v.organization_id=new.organization_id and v.legal_entity_id=new.legal_entity_id and v.effective_from<=(new.created_at at time zone'UTC')::date and v.created_at<=new.created_at order by v.sequence desc limit 1;
 if p.id is not null and p.definition->'workerIds'?t.employee_id and not exists(select 1 from work_approval_instances where submission_id=new.id and policy_id=p.id)then raise exception 'New submitted work must retain its selected staged policy instance.'using errcode='WGA05';end if;return null;
end $$;
create constraint trigger new_work_approval_instance after insert on work_submission_evidence deferrable initially deferred for each row execute function require_new_work_approval_instance();

create function validate_work_approval_commit()returns trigger language plpgsql as $$
declare i work_approval_instances;p work_approval_policy_versions;t timesheets;last work_approval_transitions;ev work_approval_events;seq integer;stage_no integer;key text;worker_user uuid;expected_users uuid[];u uuid;expected_reasons text[];r work_approval_recipients;
begin
 if tg_table_name='work_approval_instances'then i=new;seq=0;stage_no=0;key='approval.action_required';else
  select * into i from work_approval_instances where id=new.instance_id;seq=new.sequence;
 end if;
 select * into p from work_approval_policy_versions where id=i.policy_id;select * into t from timesheets where id=i.timesheet_id;select * into last from work_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if(last.id is null and t.status<>'Submitted')or(last.decision='Rejected'and t.status<>'Rejected')or(last.decision='Approved'and last.sequence=jsonb_array_length(p.definition->'stages')and t.status<>'Approved')or(last.decision='Approved'and last.sequence<jsonb_array_length(p.definition->'stages')and t.status<>'Submitted')then raise exception 'Source and staged outcome must commit atomically.'using errcode='WGA05';end if;
 if tg_table_name='work_approval_transitions'then
  if new.decision='Rejected'then key='approval.rejected_or_correction_required';stage_no=new.stage;
  elsif new.sequence<jsonb_array_length(p.definition->'stages')then key='approval.action_required';stage_no=new.sequence;
  else key='approval.completed';stage_no=new.stage;end if;
 end if;
 select * into ev from work_approval_events where instance_id=i.id and transition_sequence=seq and event_key=key;
 if not exists(select 1 from approval_records a where a.entity_type='Timesheet'and a.entity_id=t.id::text and a.status=case when last.decision='Rejected'then 'Rejected'when last.decision='Approved'and last.sequence=jsonb_array_length(p.definition->'stages')then 'Approved'else 'Pending'end)then raise exception 'Compatibility and governed approval outcomes must converge.'using errcode='WGA05';end if;
 if key in('approval.completed','approval.rejected_or_correction_required')and not exists(select 1 from work_submission_decisions d where d.submission_id=i.submission_id and d.status=last.decision and d.actor_id=last.actor_id)then raise exception 'Terminal work decision history is required.'using errcode='WGA05';end if;
 if key='approval.completed'and ev.id is null and exists(select 1 from work_approval_notification_failures where instance_id=i.id and transition_sequence=seq)then return null;end if;
 if ev.id is null or ev.stage<>stage_no or not exists(select 1 from work_approval_templates where id=ev.template_id and policy_id=p.id and event_key=key)then raise exception 'The canonical transition event/template must commit once.'using errcode='WGA05';end if;
 if key='approval.action_required'then expected_users=array[(p.definition->'stages'->stage_no->>'userId')::uuid];
 else
  if(select count(*)from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=i.employee_id and u.status='Active'and s.organization_id=i.organization_id and s.legal_entity_id=i.legal_entity_id and s.active)<>1 then raise exception 'The required affected worker relationship is unavailable.'using errcode='WGA05';end if;
  select u.id into worker_user from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=i.employee_id and u.status='Active'and s.organization_id=i.organization_id and s.legal_entity_id=i.legal_entity_id and s.active;
  select array_agg(distinct x)into expected_users from unnest(array[i.requester_user_id,worker_user])x;
 end if;
 if(select count(*)from work_approval_recipients where event_id=ev.id)<>cardinality(expected_users)then raise exception 'Canonical recipient set is incomplete or redirected.'using errcode='WGA05';end if;
 foreach u in array expected_users loop
  select * into r from work_approval_recipients where event_id=ev.id and user_id=u;
  expected_reasons=case when key='approval.action_required'then array['current_stage_approver']else array[]::text[]end;
  if key<>'approval.action_required'and u=i.requester_user_id then expected_reasons=array_append(expected_reasons,'requester');end if;
  if key<>'approval.action_required'and u=worker_user then expected_reasons=array_append(expected_reasons,'affected_worker');end if;
  if r.id is null or not(r.reasons@>expected_reasons and r.reasons<@expected_reasons)or(key<>'approval.completed'and(not r.in_app or r.channel_decision<>'Required'))then raise exception 'Protected in-app recipient/reason persistence must be atomic.'using errcode='WGA05';end if;
 end loop;
 if key in('approval.completed','approval.rejected_or_correction_required')and not exists(select 1 from work_submission_decisions d where d.submission_id=i.submission_id and d.status=last.decision and d.actor_id=last.actor_id)then raise exception 'Terminal work decision history is required.'using errcode='WGA05';end if;return null;
end $$;
create constraint trigger work_approval_instance_commit after insert on work_approval_instances deferrable initially deferred for each row execute function validate_work_approval_commit();
create constraint trigger work_approval_transition_commit after insert on work_approval_transitions deferrable initially deferred for each row execute function validate_work_approval_commit();
