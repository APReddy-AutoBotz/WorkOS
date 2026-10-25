-- Empty, opt-in, existing-assignment updates only. No grants/defaults/backfill.
create function valid_assignment_approval_definition(d jsonb)returns boolean language plpgsql immutable as $$
declare k text;
begin
 if not valid_work_approval_definition((d-'materialFields')||jsonb_build_object('entityType','Timesheet')) or d->>'entityType'<>'Assignment' or jsonb_typeof(d->'materialFields')is distinct from'array' or jsonb_array_length(d->'materialFields')not between 1 and 7 or length(d->>'locale')>100 then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'materialFields')v)<>jsonb_array_length(d->'materialFields')then return false;end if;
 for k in select jsonb_array_elements_text(d->'materialFields')loop if k not in('billable','comment','endsOn','quantityExact','role','startsOn','status')then return false;end if;end loop;return true;
exception when others then return false;end $$;
create table assignment_approval_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,sequence integer not null check(sequence>0),effective_from date not null,
 definition jsonb not null check(valid_assignment_approval_definition(definition)),actor_id uuid not null references users(id),active_role text not null,
 reason text not null check(length(btrim(reason))between 1 and 1000),created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,sequence),unique(organization_id,legal_entity_id,effective_from)
);
create table assignment_approval_templates(id uuid primary key,policy_id uuid not null references assignment_approval_policies(id),event_key text not null check(event_key in('approval.action_required','approval.rejected_or_correction_required','approval.completed')),locale text not null,subject text not null,body text not null,unique(policy_id,event_key));
create table assignment_approval_instances(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,assignment_id text not null,employee_id text not null references employees(id),project_id text not null references projects(id),
 policy_id uuid not null references assignment_approval_policies(id),requester_user_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null,
 source_revision text not null check(source_revision~'^[a-f0-9]{64}$'),source_version_id uuid references assignment_versions(id),before_snapshot jsonb not null,proposed_definition jsonb not null,
 source_token text not null check(source_token~'^[a-f0-9]{64}$'),source_canonical text not null,reason text not null check(length(btrim(reason))between 1 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,requester_user_id,request_id)
);
create index assignment_approval_source_history on assignment_approval_instances(organization_id,legal_entity_id,assignment_id,created_at,id);
create table assignment_approval_transitions(
 id uuid primary key,instance_id uuid not null references assignment_approval_instances(id),sequence integer not null check(sequence between 1 and 10),stage integer not null check(stage between 0 and 9),decision text not null check(decision in('Approved','Rejected')),
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null,reason text not null check(length(btrim(reason))between 1 and 1000),operation_id text not null,outcome jsonb not null,created_at timestamptz not null default clock_timestamp(),unique(instance_id,sequence),unique(instance_id,request_id)
);
create table assignment_approval_events(
 id text primary key,instance_id uuid not null references assignment_approval_instances(id),transition_sequence integer not null check(transition_sequence between 0 and 10),stage integer not null check(stage between 0 and 9),event_key text not null,
 policy_class text not null,template_id uuid not null references assignment_approval_templates(id),operation_id text not null,locale text not null,title text not null check(work_period_notice_units(title)between 1 and 1200),body text not null check(work_period_notice_units(body)between 1 and 12000),created_at timestamptz not null default clock_timestamp(),
 unique(instance_id,transition_sequence,event_key),check((event_key in('approval.action_required','approval.rejected_or_correction_required')and policy_class='ACTION_REQUIRED')or(event_key='approval.completed'and policy_class='INFORMATIONAL'))
);
create table assignment_approval_recipients(id uuid primary key,event_id text not null references assignment_approval_events(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons)between 1 and 3 and reasons<@array['requester','affected_worker','current_stage_approver']::text[]),in_app boolean not null,channel_decision text not null check(channel_decision in('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id));
create table assignment_approval_deliveries(id uuid primary key,recipient_id uuid not null unique references assignment_approval_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt integer not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table assignment_approval_notification_failures(id uuid primary key,instance_id uuid not null references assignment_approval_instances(id),transition_sequence integer not null,code text not null check(code='INFORMATIONAL_NOTIFICATION_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence));
create table assignment_approval_reads(recipient_id uuid primary key references assignment_approval_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
do $$declare t text;begin foreach t in array array['assignment_approval_policies','assignment_approval_templates','assignment_approval_instances','assignment_approval_transitions','assignment_approval_events','assignment_approval_recipients','assignment_approval_deliveries','assignment_approval_notification_failures','assignment_approval_reads']loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;
create function assignment_material_policy(org text,legal text,worker text)returns assignment_approval_policies language plpgsql stable as $$
declare p assignment_approval_policies;
begin
 select * into p from assignment_approval_policies v where v.organization_id=org and v.legal_entity_id=legal and v.effective_from<=(clock_timestamp()at time zone'UTC')::date order by v.sequence desc limit 1;
 if p.id is not null and p.definition->'workerIds'?worker then return p;end if;return null;
end $$;
create function assignment_requires_approval(before jsonb,after jsonb,d jsonb)returns boolean language sql immutable as $$ select exists(select 1 from jsonb_array_elements_text(d->'materialFields')k where before->k is distinct from after->k); $$;
create function guard_assignment_material_source()returns trigger language plpgsql as $$
declare p assignment_approval_policies;oldp assignment_approval_policies;i assignment_approval_instances;t assignment_approval_transitions;ctx jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||old.organization_id||':'||old.legal_entity_id,0));
 select * into p from assignment_material_policy(old.organization_id,old.legal_entity_id,old.employee_id);
 if tg_op='DELETE'then if p.id is not null then raise exception 'Selected assignment deletion has no governed source transition.'using errcode='ASA01';end if;return old;end if;
 select * into oldp from assignment_material_policy(new.organization_id,new.legal_entity_id,new.employee_id);
 if (p.id is not null or oldp.id is not null)and(old.employee_id<>new.employee_id or old.project_id<>new.project_id or old.organization_id<>new.organization_id or old.legal_entity_id<>new.legal_entity_id)then raise exception 'Selected assignment identity transfer is unavailable.'using errcode='ASA01';end if;
 if p.id is null or not assignment_requires_approval(assignment_version_snapshot(old),assignment_version_snapshot(new),p.definition)then return new;end if;
 begin ctx=nullif(current_setting('workos.assignment_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from assignment_approval_instances where id=(ctx->>'instanceId')::uuid;
 select * into t from assignment_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if i.id is null or i.assignment_id<>old.id or i.organization_id<>old.organization_id or i.legal_entity_id<>old.legal_entity_id or resource_assignment_revision(old)<>i.source_revision or assignment_version_snapshot(old)<>i.before_snapshot or assignment_version_snapshot(new)<>i.before_snapshot||i.proposed_definition or t.decision is distinct from'Approved' or t.sequence is distinct from(select jsonb_array_length(definition->'stages')from assignment_approval_policies where id=i.policy_id)or ctx->>'actorId'is distinct from t.actor_id::text or ctx->>'activeRole'is distinct from t.active_role then raise exception 'Material assignment change requires its exact final governed approval.'using errcode='ASA01';end if;
 return new;
end $$;
create trigger guarded_assignment_material_source before update or delete on project_allocations for each row execute function guard_assignment_material_source();
create function guard_assignment_approval_append()returns trigger language plpgsql as $$
declare ctx jsonb;i assignment_approval_instances;p assignment_approval_policies;a project_allocations;t assignment_approval_transitions;n integer;terminal boolean;v uuid;
begin
 begin ctx=nullif(current_setting('workos.assignment_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id=(ctx->>'actorId')::uuid and u.status='Active'and r.name=ctx->>'activeRole'and s.organization_id=ctx->>'organizationId'and s.legal_entity_id=ctx->>'legalEntityId'and s.active)then raise exception 'Use the scoped assignment approval command.'using errcode='ASA02';end if;
 if tg_table_name='assignment_approval_policies'then
  select * into p from assignment_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
  if new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.sequence<>coalesce(p.sequence,0)+1 or new.effective_from<(clock_timestamp()at time zone'UTC')::date or(p.id is not null and new.effective_from<=p.effective_from)then raise exception 'Append the current prospective policy sequence.'using errcode='ASA02';end if;return new;
 elsif tg_table_name='assignment_approval_templates'then select * into p from assignment_approval_policies where id=new.policy_id;if p.organization_id is distinct from ctx->>'organizationId'or p.legal_entity_id is distinct from ctx->>'legalEntityId'then raise exception 'Template scope unavailable.'using errcode='ASA02';end if;return new;
 elsif tg_table_name='assignment_approval_instances'then
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
  if terminal or new.sequence<>n+1 or new.stage<>n or new.stage>=jsonb_array_length(p.definition->'stages')or new.actor_id::text is distinct from p.definition->'stages'->new.stage->>'userId'or new.active_role is distinct from p.definition->'stages'->new.stage->>'role'or ctx->>'actorId'is distinct from new.actor_id::text or ctx->>'activeRole'is distinct from new.active_role or ctx->>'operationId'is distinct from new.operation_id or new.actor_id=i.requester_user_id or exists(select 1 from users where id=new.actor_id and employee_record_id=i.employee_id)or not exists(select 1 from project_allocations source_row where source_row.id=i.assignment_id and source_row.organization_id=i.organization_id and source_row.legal_entity_id=i.legal_entity_id and resource_assignment_revision(source_row)=i.source_revision)then raise exception 'Only the current named stage and exact source can decide.'using errcode='ASA03';end if;
 end if;return new;
end $$;
do $$declare t text;begin foreach t in array array['assignment_approval_policies','assignment_approval_templates','assignment_approval_instances','assignment_approval_transitions','assignment_approval_events','assignment_approval_recipients','assignment_approval_deliveries','assignment_approval_notification_failures','assignment_approval_reads']loop execute format('create trigger guarded_%I before insert on %I for each row execute function guard_assignment_approval_append()',t,t);end loop;end $$;
create function guard_assignment_compatibility_decision()returns trigger language plpgsql as $$
declare ctx jsonb;i assignment_approval_instances;t assignment_approval_transitions;p assignment_approval_policies;
begin
 if old.entity_type<>'AssignmentProposal'then if tg_op='DELETE'then return old;end if;return new;end if;
 if tg_op='DELETE'then raise exception 'Retain governed compatibility evidence.'using errcode='ASA03';end if;
 select * into i from assignment_approval_instances where id::text=old.entity_id;
 select * into t from assignment_approval_transitions where instance_id=i.id order by sequence desc limit 1;select * into p from assignment_approval_policies where id=i.policy_id;
 begin ctx=nullif(current_setting('workos.assignment_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if i.id is null or ctx->>'instanceId'is distinct from i.id::text or ctx->>'actorId'is distinct from t.actor_id::text or new.status is distinct from(case when t.decision='Rejected'then'Rejected'when t.sequence=jsonb_array_length(p.definition->'stages')then'Approved'else'Pending'end)then raise exception 'Use the exact governed assignment stage command.'using errcode='ASA03';end if;return new;
end $$;
create trigger governed_assignment_compatibility before update or delete on approval_records for each row execute function guard_assignment_compatibility_decision();
create function validate_assignment_approval_commit()returns trigger language plpgsql as $$
declare i assignment_approval_instances;p assignment_approval_policies;t assignment_approval_transitions;a project_allocations;seq integer;stage_no integer;key text;ev assignment_approval_events;worker_user uuid;users uuid[];u uuid;r assignment_approval_recipients;reasons text[];state text;
begin
 if tg_table_name='assignment_approval_instances'then i=new;seq=0;stage_no=0;key='approval.action_required';else select * into i from assignment_approval_instances where id=new.instance_id;seq=new.sequence;end if;
 select * into p from assignment_approval_policies where id=i.policy_id;select * into t from assignment_approval_transitions where instance_id=i.id order by sequence desc limit 1;select * into a from project_allocations where id=i.assignment_id;
 state=case when t.decision='Rejected'then'Rejected'when t.sequence=jsonb_array_length(p.definition->'stages')then'Approved'else'Pending'end;
 if not exists(select 1 from approval_records where entity_type='AssignmentProposal'and entity_id=i.id::text and status=state)then raise exception 'Compatibility approval must converge atomically.'using errcode='ASA04';end if;
 if state='Approved'then
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
create constraint trigger assignment_approval_instance_commit after insert on assignment_approval_instances deferrable initially deferred for each row execute function validate_assignment_approval_commit();
create constraint trigger assignment_approval_transition_commit after insert on assignment_approval_transitions deferrable initially deferred for each row execute function validate_assignment_approval_commit();
