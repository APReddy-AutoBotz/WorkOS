-- Explicit new-instance reminders only; no seed, backfill, role/grant or scheduler.
create function valid_approval_reminder_definition(d jsonb)returns boolean language plpgsql immutable as $$
declare t jsonb;k text;v text;expanded text;
begin
 if d is null then return true;end if;
 if jsonb_typeof(d)is distinct from'object'or(select count(*)from jsonb_object_keys(d))<>3 or not(d?&array['afterMinutes','locale','template'])or jsonb_typeof(d->'afterMinutes')is distinct from'number'or(d->>'afterMinutes')!~'^[0-9]+$'or(d->>'afterMinutes')::numeric not between 1 and 527039 or jsonb_typeof(d->'locale')is distinct from'string'or work_period_notice_units(d->>'locale')not between 1 and 100 or(d->>'locale')!~'^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'then return false;end if;
 t=d->'template';if jsonb_typeof(t)is distinct from'object'or(select count(*)from jsonb_object_keys(t))<>3 or not(t?&array['key','subject','body'])or t->>'key'is distinct from'approval.action_required'then return false;end if;
 foreach k in array array['subject','body']loop
  v=t->>k;if jsonb_typeof(t->k)is distinct from'string'or work_period_notice_units(v)not between 1 and(case when k='subject'then 200 else 8000 end)or btrim(v)<>v then return false;end if;
  expanded=regexp_replace(v,'\{\{\s*workerCode\s*\}\}',repeat('x',200),'g');expanded=regexp_replace(expanded,'\{\{\s*sourceRef\s*\}\}',repeat('x',239),'g');expanded=regexp_replace(expanded,'\{\{\s*stageNumber\s*\}\}','xx','g');expanded=regexp_replace(expanded,'\{\{\s*(pendingAt|reminderAt|dueAt)\s*\}\}',repeat('x',24),'g');
  if expanded~'[{}]'or work_period_notice_units(expanded)>(case when k='subject'then 1200 else 12000 end)then return false;end if;
 end loop;return true;
exception when others then return false;end $$;
create table approval_reminder_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,sequence integer not null check(sequence>0),previous_policy_id uuid references approval_reminder_policies(id),
 due_policy_id uuid not null references approval_due_policies(id),effective_from date not null,definition jsonb check(valid_approval_reminder_definition(definition)),
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason))between 1 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,sequence),unique(organization_id,legal_entity_id,request_id));
create table approval_reminder_templates(id uuid primary key,policy_id uuid not null unique references approval_reminder_policies(id),event_key text not null check(event_key='approval.action_required'),locale text not null,subject text not null,body text not null);
create table approval_reminder_bindings(origin text not null,instance_id uuid not null,policy_id uuid not null references approval_reminder_policies(id),primary key(origin,instance_id),foreign key(origin,instance_id)references approval_due_bindings(origin,instance_id));
create function approval_reminder_selected_policy(s approval_due_source_events,due_id uuid)returns uuid language plpgsql stable as $$declare p approval_reminder_policies;begin
 select * into p from approval_reminder_policies where organization_id=s.organization_id and legal_entity_id=s.legal_entity_id and due_policy_id=due_id and created_at<=s.instance_created_at and effective_from<=(s.instance_created_at at time zone'UTC')::date order by sequence desc limit 1;
 if p.id is null or p.definition is null then return null;end if;return p.id;
end $$;
create function retain_approval_reminder_binding()returns trigger language plpgsql as $$declare s approval_due_source_events;pid uuid;begin
 select * into s from approval_due_source_events where origin=new.origin and instance_id=new.instance_id and stage=0;pid=approval_reminder_selected_policy(s,new.policy_id);
 if pid is not null then insert into approval_reminder_bindings values(new.origin,new.instance_id,pid);end if;return null;
end $$;
create trigger retained_reminder_instance after insert on approval_due_bindings for each row execute function retain_approval_reminder_binding();
create table approval_reminder_runs(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,origin text not null check(origin in('Work','Material','Creation','Leave')),instance_id uuid not null,stage integer not null check(stage between 0 and 9),clock_id uuid references approval_due_clocks(id),policy_id uuid references approval_reminder_policies(id),sequence integer not null check(sequence>0),
 request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),actor_id uuid not null references users(id),active_role text not null,reason text not null check(length(btrim(reason))between 1 and 1000),operation_id text not null,correlation_id text not null,source_token text not null check(source_token~'^[a-f0-9]{64}$'),source_canonical text not null,outcome jsonb not null,created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,request_id),unique(origin,instance_id,sequence));
create table approval_reminder_events(id text primary key,clock_id uuid not null unique references approval_due_clocks(id),run_id uuid not null unique references approval_reminder_runs(id),policy_id uuid not null references approval_reminder_policies(id),event_key text not null check(event_key='approval.action_required'),policy_class text not null check(policy_class='ACTION_REQUIRED'),template_id uuid not null references approval_reminder_templates(id),operation_id text not null,correlation_id text not null,locale text not null,title text not null check(work_period_notice_units(title)between 1 and 1200),body text not null check(work_period_notice_units(body)between 1 and 12000),created_at timestamptz not null default clock_timestamp());
create table approval_reminder_recipients(id uuid primary key,event_id text not null references approval_reminder_events(id),user_id uuid not null references users(id),reasons text[] not null check(reasons=array['current_stage_approver']::text[]),in_app boolean not null check(in_app),channel_decision text not null check(channel_decision='Required'),unique(event_id,user_id));
create table approval_reminder_deliveries(id uuid primary key,recipient_id uuid not null unique references approval_reminder_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),operation_id text not null,correlation_id text not null,attempt integer not null check(attempt=1),created_at timestamptz not null default clock_timestamp());
create table approval_reminder_reads(recipient_id uuid primary key references approval_reminder_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());

create function guard_approval_reminder_append()returns trigger language plpgsql as $$
declare ctx jsonb;s approval_due_source_events;p approval_reminder_policies;dp approval_due_policies;r approval_reminder_runs;expected uuid;
begin
 if tg_table_name='approval_reminder_bindings'then
  select * into s from approval_due_source_events where origin=new.origin and instance_id=new.instance_id and stage=0;select policy_id into expected from approval_due_bindings where origin=new.origin and instance_id=new.instance_id;expected=approval_reminder_selected_policy(s,expected);
  if expected is null or new.policy_id is distinct from expected then raise exception 'Only exact prospective reminder cohorts may bind.'using errcode='ARM02';end if;return new;
 end if;
 begin ctx=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles ro on ro.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id where u.id=(ctx->>'actorId')::uuid and u.status='Active'and ro.name=ctx->>'activeRole'and sc.organization_id=ctx->>'organizationId'and sc.legal_entity_id=ctx->>'legalEntityId'and sc.active)then raise exception 'Use the current scoped reminder command.'using errcode='ARM01';end if;
 if tg_table_name='approval_reminder_policies'then
  select * into p from approval_reminder_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;select * into dp from approval_due_policies where id=new.due_policy_id;
  if dp.id is null or dp.organization_id is distinct from new.organization_id or dp.legal_entity_id is distinct from new.legal_entity_id or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.operation_id is distinct from ctx->>'operationId'or new.sequence<>coalesce(p.sequence,0)+1 or new.previous_policy_id is distinct from p.id or new.effective_from<(clock_timestamp()at time zone'UTC')::date or(p.id is not null and new.effective_from<p.effective_from)or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()or(new.definition is not null and(new.definition->>'afterMinutes')::integer>=(dp.definition->>'dueAfterMinutes')::integer)then raise exception 'Append an explicit prospective linked reminder policy.'using errcode='ARM02';end if;return new;
 elsif tg_table_name='approval_reminder_templates'then
  select * into p from approval_reminder_policies where id=new.policy_id;
  if p.id is null or p.definition is null or p.organization_id is distinct from ctx->>'organizationId'or p.legal_entity_id is distinct from ctx->>'legalEntityId'or new.locale is distinct from p.definition->>'locale'or new.subject is distinct from p.definition->'template'->>'subject'or new.body is distinct from p.definition->'template'->>'body'then raise exception 'Retain the exact configured reminder template.'using errcode='ARM02';end if;return new;
 elsif tg_table_name='approval_reminder_runs'then
  select * into s from approval_due_source_events where origin=new.origin and instance_id=new.instance_id order by stage desc limit 1;
  if s.instance_id is null or new.organization_id is distinct from s.organization_id or new.legal_entity_id is distinct from s.legal_entity_id or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.operation_id is distinct from ctx->>'operationId'or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()or new.source_token<>encode(digest(new.source_canonical,'sha256'),'hex')or new.sequence<>(select coalesce(max(sequence),0)+1 from approval_reminder_runs where origin=new.origin and instance_id=new.instance_id)then raise exception 'Use exact current scoped reminder evaluation.'using errcode='ARM03';end if;return new;
 elsif tg_table_name='approval_reminder_events'then select * into r from approval_reminder_runs where id=new.run_id;
 elsif tg_table_name='approval_reminder_recipients'then select x.* into r from approval_reminder_runs x join approval_reminder_events e on e.run_id=x.id where e.id=new.event_id;
 else
  select x.* into r from approval_reminder_runs x join approval_reminder_events e on e.run_id=x.id join approval_reminder_recipients n on n.event_id=e.id where n.id=new.recipient_id;
  if tg_table_name='approval_reminder_reads'then if ctx->>'actorId'is distinct from new.user_id::text or not exists(select 1 from approval_reminder_recipients where id=new.recipient_id and user_id=new.user_id)then raise exception 'Read only your exact reminder recipient.'using errcode='ARM01';end if;end if;
 end if;
 if r.id is null or r.organization_id is distinct from ctx->>'organizationId'or r.legal_entity_id is distinct from ctx->>'legalEntityId'then raise exception 'Reminder scope is unavailable.'using errcode='ARM01';end if;return new;
end $$;
do $$declare t text;begin foreach t in array array['approval_reminder_policies','approval_reminder_templates','approval_reminder_bindings','approval_reminder_runs','approval_reminder_events','approval_reminder_recipients','approval_reminder_deliveries','approval_reminder_reads']loop
 execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);
 execute format('create trigger guarded_%I before insert on %I for each row execute function guard_approval_reminder_append()',t,t);
end loop;end $$;
create function validate_approval_reminder_policy_commit()returns trigger language plpgsql as $$begin
 if new.definition is null then
  if exists(select 1 from approval_reminder_templates where policy_id=new.id)then raise exception 'Disabled prospective reminder has no template.'using errcode='ARM03';end if;
 elsif not exists(select 1 from approval_reminder_templates where policy_id=new.id and event_key='approval.action_required'and locale=new.definition->>'locale'and subject=new.definition->'template'->>'subject'and body=new.definition->'template'->>'body')then raise exception 'Complete retained reminder template required.'using errcode='ARM03';end if;return null;
end $$;
create constraint trigger approval_reminder_policy_commit after insert on approval_reminder_policies deferrable initially deferred for each row execute function validate_approval_reminder_policy_commit();

create function validate_approval_reminder_commit()returns trigger language plpgsql as $$
declare e approval_reminder_events;c approval_due_clocks;p approval_reminder_policies;s approval_due_source_events;n approval_reminder_recipients;ids uuid[];uid uuid;checked timestamptz;reminder_at timestamptz;canonical jsonb;
begin
 canonical=new.source_canonical::jsonb;
 if canonical->>'origin'is distinct from new.origin or canonical->>'instanceId'is distinct from new.instance_id::text or(canonical->>'stage')::integer is distinct from new.stage or new.outcome->>'sourceToken'is distinct from new.source_token or new.outcome->>'state'is distinct from canonical->>'state'or new.outcome->>'eventKey'is distinct from canonical->>'eventKey'or new.outcome->>'state'not in('Unconfigured','Waiting','Ready','Notified','Overdue','Terminal','Stale')or new.outcome->>'disposition'not in('Emitted','Existing','NoEvent')then raise exception 'Retain the exact reminder outcome.'using errcode='ARM03';end if;
 if new.outcome->>'disposition'='NoEvent'and(new.outcome->>'eventId'is not null or new.outcome->>'eventKey'is not null or new.outcome->>'state'in('Ready','Notified'))then raise exception 'Suppressed reminder cannot claim delivery.'using errcode='ARM03';end if;
 if new.outcome->>'disposition'='Existing'and not exists(select 1 from approval_reminder_events where id=new.outcome->>'eventId'and clock_id=new.clock_id and policy_id=new.policy_id)then raise exception 'Retain the exact existing reminder.'using errcode='ARM03';end if;
 if new.outcome->>'disposition'<>'Emitted'then
  if exists(select 1 from approval_reminder_events where run_id=new.id)then raise exception 'Suppressed reminder must not emit.'using errcode='ARM03';end if;return null;
 end if;
 select * into e from approval_reminder_events where run_id=new.id;select * into c from approval_due_clocks where id=new.clock_id;select pol.* into p from approval_reminder_policies pol join approval_reminder_bindings b on b.policy_id=pol.id where b.origin=new.origin and b.instance_id=new.instance_id;
 select * into s from approval_due_source_events where origin=c.origin and source_event_id=c.source_event_id;checked=(new.outcome->>'checkedAt')::timestamptz;reminder_at=c.activated_at+(p.definition->>'afterMinutes')::integer*interval '1 minute';
 if e.id is null or c.id is null or p.id is null or p.definition is null or new.policy_id is distinct from p.id or new.outcome->>'state'<>'Ready'or new.outcome->>'eventKey'<>'approval.action_required'or new.outcome->>'eventId'is distinct from e.id or e.id is distinct from 'approval-reminder/'||c.id||'/approval.action_required/'||new.operation_id or c.origin<>new.origin or c.instance_id<>new.instance_id or c.stage<>new.stage or s.organization_id<>new.organization_id or s.legal_entity_id<>new.legal_entity_id or not approval_due_current(c.origin,c.instance_id,c.stage)or c.activated_at<p.created_at or clock_timestamp()<reminder_at or clock_timestamp()>=c.due_at or checked>new.created_at or checked<date_trunc('milliseconds',reminder_at)or checked>=c.due_at or abs(extract(epoch from new.created_at-checked))>60 or e.clock_id<>c.id or e.policy_id<>p.id or e.operation_id<>new.operation_id or e.correlation_id<>new.correlation_id or not exists(select 1 from approval_reminder_templates where id=e.template_id and policy_id=p.id and locale=e.locale)then raise exception 'Emit only the exact ready current retained stage.'using errcode='ARM03';end if;
 ids=canonical_stage_recipients(c.origin,c.instance_id,c.stage,c.approver_user_id,clock_timestamp());
 if(cardinality(ids)=2)is distinct from(canonical?'delegatedApprover')or(canonical?'delegatedApprover'and not exists(select 1 from canonical_delegation_bindings b join canonical_delegations d on d.id=b.delegation_id where b.origin=c.origin and b.instance_id=c.instance_id and b.stage=c.stage and b.id::text=canonical->'delegatedApprover'->>'bindingId'and d.id::text=canonical->'delegatedApprover'->>'delegationId'and d.definition->>'delegateUserId'=canonical->'delegatedApprover'->>'userId'and d.definition->>'role'=canonical->'delegatedApprover'->>'role'and canonical_delegation_eligible(b,clock_timestamp())))then raise exception 'Retain exact current delegated recipient provenance.'using errcode='ARM03';end if;
 if(select count(*)from approval_reminder_recipients where event_id=e.id)<>cardinality(ids)or jsonb_array_length(canonical->'recipientReasons')<>cardinality(ids)then raise exception 'Complete current-stage reminder recipients required.'using errcode='ARM03';end if;
 foreach uid in array ids loop
  if not canonical_delegation_instance_account(uid,c.approver_role,c.origin,c.instance_id)then raise exception 'Current reminder recipient authority unavailable.'using errcode='ARM03';end if;
  select * into n from approval_reminder_recipients where event_id=e.id and user_id=uid;
  if n.id is null or n.reasons is distinct from array['current_stage_approver']::text[]or not exists(select 1 from jsonb_array_elements(canonical->'recipientReasons')v where v->>'userId'=uid::text and v->'reasons'='["current_stage_approver"]'::jsonb)or not exists(select 1 from approval_reminder_deliveries where recipient_id=n.id and operation_id=new.operation_id and correlation_id=new.correlation_id)then raise exception 'Atomic exact reminder recipient/reason/delivery required.'using errcode='ARM03';end if;
 end loop;return null;
end $$;
create constraint trigger approval_reminder_commit after insert on approval_reminder_runs deferrable initially deferred for each row execute function validate_approval_reminder_commit();
create index approval_reminder_policy_due on approval_reminder_policies(due_policy_id,sequence desc);
create index approval_reminder_run_instance on approval_reminder_runs(origin,instance_id,sequence desc);
create index approval_reminder_recipient_inbox on approval_reminder_recipients(user_id,id);
