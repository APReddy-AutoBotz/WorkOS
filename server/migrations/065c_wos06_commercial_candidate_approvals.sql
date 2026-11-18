-- Empty opt-in decision capabilities and append-only commercial approval evidence.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.rate_approvals.decide','Commercial','Decide billing candidate approvals','Decide an explicitly assigned scoped billing candidate approval.',false),
 ('commercial.cost_approvals.decide','Commercial','Decide cost candidate approvals','Decide an explicitly assigned scoped confidential cost candidate approval.',false);

create function valid_commercial_approval_definition(d jsonb) returns boolean language plpgsql immutable as $$
begin
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','kind','candidateId','stages','locale','templates','completionInApp']) or (select count(*) from jsonb_object_keys(d))<>7 or d->>'entityType' is distinct from 'CommercialCandidate' or jsonb_typeof(d->'kind') is distinct from 'string' or d->>'kind' not in ('billing','cost') or jsonb_typeof(d->'candidateId') is distinct from 'string' or d->>'candidateId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return false;end if;
 if not valid_work_approval_definition((d-'kind'-'candidateId')||jsonb_build_object('entityType','Timesheet','workerIds','[]'::jsonb)) then return false;end if;
 if exists(select 1 from jsonb_array_elements(d->'templates')t where regexp_replace(t->>'subject','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]' or regexp_replace(t->>'body','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]') then return false;end if;
 return true;
exception when others then return false;end $$;

create table commercial_candidate_approval_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,candidate_id uuid not null references commercial_rate_candidates(id),sequence int not null check(sequence>0),previous_id uuid references commercial_candidate_approval_policies(id),
 effective_from date not null,definition jsonb not null check(valid_commercial_approval_definition(definition)),actor_id uuid not null references users(id),active_role text not null,
 reason text not null check(length(btrim(reason)) between 3 and 1000),request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,candidate_id,sequence),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table commercial_candidate_approval_instances(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,candidate_id uuid not null references commercial_rate_candidates(id),owner_event_id uuid not null references commercial_candidate_owners(id),policy_id uuid not null references commercial_candidate_approval_policies(id),
 requester_user_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,requester_user_id,request_id)
);
create index commercial_candidate_approval_source_history on commercial_candidate_approval_instances(organization_id,legal_entity_id,candidate_id,created_at,id);
create table commercial_candidate_approval_transitions(
 id uuid primary key,instance_id uuid not null references commercial_candidate_approval_instances(id),sequence int not null check(sequence between 1 and 10),stage int not null check(stage between 0 and 9),decision text not null check(decision in ('Approved','Rejected')),
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 unique(instance_id,sequence),unique(instance_id,request_id)
);
create table commercial_candidate_approval_events(
 id text primary key,instance_id uuid not null references commercial_candidate_approval_instances(id),transition_sequence int not null check(transition_sequence between 0 and 10),stage int not null check(stage between 0 and 9),
 event_key text not null check(event_key in ('approval.action_required','approval.rejected_or_correction_required','approval.completed')),policy_class text not null check(policy_class in ('ACTION_REQUIRED','INFORMATIONAL')),
 policy_id uuid not null references commercial_candidate_approval_policies(id),operation_id text not null,locale text not null,title text not null check(work_period_notice_units(title) between 1 and 1200),body text not null check(work_period_notice_units(body) between 1 and 12000),created_at timestamptz not null default clock_timestamp(),
 unique(instance_id,transition_sequence,event_key),check((event_key in ('approval.action_required','approval.rejected_or_correction_required') and policy_class='ACTION_REQUIRED') or(event_key='approval.completed' and policy_class='INFORMATIONAL'))
);
create table commercial_candidate_approval_recipients(
 id uuid primary key,event_id text not null references commercial_candidate_approval_events(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons) between 1 and 4 and reasons<@array['requester','commercial_change_owner','affected_worker','current_stage_approver']::text[]),
 in_app boolean not null,channel_decision text not null check(channel_decision in ('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id)
);
create table commercial_candidate_approval_deliveries(id uuid primary key,recipient_id uuid not null unique references commercial_candidate_approval_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt int not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table commercial_candidate_approval_reads(recipient_id uuid primary key references commercial_candidate_approval_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
create table commercial_candidate_approval_invalidations(id uuid primary key,instance_id uuid not null unique references commercial_candidate_approval_instances(id),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(actor_id,request_id));
create table commercial_candidate_approval_notification_failures(id uuid primary key,instance_id uuid not null references commercial_candidate_approval_instances(id),transition_sequence int not null,code text not null check(code='INFORMATIONAL_NOTIFICATION_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence));
do $$declare t text;begin foreach t in array array['commercial_candidate_approval_policies','commercial_candidate_approval_instances','commercial_candidate_approval_transitions','commercial_candidate_approval_events','commercial_candidate_approval_recipients','commercial_candidate_approval_deliveries','commercial_candidate_approval_reads','commercial_candidate_approval_invalidations','commercial_candidate_approval_notification_failures'] loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;

-- Canonical inbox already requires employees.view; no additional grant is implied.
create function commercial_approval_inbox_identity_valid(org text,legal text,candidate commercial_rate_candidates,who uuid,role_name text) returns boolean language plpgsql stable as $$
begin
 if not valid_candidate_owner(org,legal,candidate,who,role_name) then return false;end if;
 return exists(select 1 from role_permissions rp where rp.role_name=commercial_approval_inbox_identity_valid.role_name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key='employees.view');
end $$;

-- Current source is an observation; no historical owner or candidate is changed.
create function commercial_candidate_approval_is_current(i commercial_candidate_approval_instances) returns boolean language sql stable as $$
 select exists(select 1 from commercial_rate_candidates c join commercial_candidate_owners o on o.id=i.owner_event_id and o.candidate_id=c.id join commercial_candidate_approval_policies p on p.id=i.policy_id and p.candidate_id=c.id
  where c.id=i.candidate_id and c.organization_id=i.organization_id and c.legal_entity_id=i.legal_entity_id
    and o.organization_id=i.organization_id and o.legal_entity_id=i.legal_entity_id and p.organization_id=i.organization_id and p.legal_entity_id=i.legal_entity_id
    and p.effective_from<=(clock_timestamp() at time zone 'UTC')::date
    and c.id=(select id from commercial_rate_candidates where organization_id=c.organization_id and legal_entity_id=c.legal_entity_id and stream_id=c.stream_id order by sequence desc limit 1)
    and o.id=(select id from commercial_candidate_owners where organization_id=i.organization_id and legal_entity_id=i.legal_entity_id and candidate_id=i.candidate_id order by sequence desc limit 1)
    and p.id=(select id from commercial_candidate_approval_policies where organization_id=i.organization_id and legal_entity_id=i.legal_entity_id and candidate_id=i.candidate_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by sequence desc limit 1)
    and commercial_approval_inbox_identity_valid(i.organization_id,i.legal_entity_id,c,o.owner_user_id,o.owner_role)
    and not exists(select 1 from commercial_candidate_approval_invalidations x where x.instance_id=i.id))
$$;
create function commercial_candidate_decider_valid(org text, legal text, candidate commercial_rate_candidates, who uuid, role_name text) returns boolean language plpgsql stable as $$
declare k text;begin
 if not commercial_approval_inbox_identity_valid(org,legal,candidate,who,role_name) then return false;end if;
 foreach k in array array['approvals.view',case candidate.kind when 'billing' then 'commercial.rate_approvals.decide' else 'commercial.cost_approvals.decide' end] loop
  if not exists(select 1 from role_permissions rp where rp.role_name=commercial_candidate_decider_valid.role_name and rp.permission_key=k and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=k) then return false;end if;
 end loop;return true;
end $$;
create function commercial_candidate_manager_valid(org text,legal text,candidate commercial_rate_candidates,who uuid,role_name text) returns boolean language plpgsql stable as $$
declare k text;begin
 if candidate.organization_id<>org or candidate.legal_entity_id<>legal or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id=who and u.status='Active' and r.name=role_name and s.organization_id=org and s.legal_entity_id=legal and s.active) then return false;end if;
 foreach k in array case candidate.kind when 'billing' then array['commercial.contracts.view','commercial.contracts.manage','commercial.rate_candidates.view','commercial.rate_candidates.manage'] else array['commercial.contracts.view','commercial.cost_candidates.view','commercial.cost_candidates.manage','employees.view'] end loop
  if not exists(select 1 from role_permissions rp where rp.role_name=commercial_candidate_manager_valid.role_name and rp.permission_key=k and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=k) then return false;end if;
 end loop;
 if candidate.kind='cost' and not rate_candidate_worker_visible(jsonb_build_object('actorId',who,'activeRole',role_name,'organizationId',org,'legalEntityId',legal),candidate.binding_id) then return false;end if;
 return true;
end $$;

create function lock_commercial_candidate_identity(org text,legal text,who uuid,role_name text) returns void language plpgsql as $$begin
 perform u.id from users u where u.id=who for share;
 perform ur.user_id from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=who and r.name=role_name for share of ur,r;
 perform s.user_id from user_organization_scopes s where s.user_id=who and s.organization_id=org and s.legal_entity_id=legal for share;
 perform rp.permission_key from role_permissions rp where rp.role_name=lock_commercial_candidate_identity.role_name order by rp.permission_key for share;
 perform g.permission_key from user_permission_grants g where g.user_id=who order by g.permission_key for share;
end $$;

-- Hold the existing worker-scope witness until the command commits. This does
-- not add visibility; it prevents a concurrent relationship removal from making
-- a just-authorized cost decision stale before its receipt is retained.
create function lock_commercial_candidate_worker_witness(candidate commercial_rate_candidates,who uuid,role_name text) returns void language plpgsql as $$
declare u users;target employees;actor employees;before_ids text[];after_ids text[];n int:=0;
begin
 if candidate.kind<>'cost' then return;end if;
 select * into u from users where id=who;
 perform e.id from employees e where e.id in (candidate.binding_id,u.employee_record_id) order by e.id for share;
 select * into target from employees where id=candidate.binding_id;
 select * into actor from employees where id=u.employee_record_id;
 if target.id is null then raise exception 'Scoped worker unavailable.' using errcode='CCA02';end if;
 if role_name='TeamLead' then
  loop
   with recursive chain as(select id,reporting_manager_id from employees where id=candidate.binding_id and organization_id=candidate.organization_id and legal_entity_id=candidate.legal_entity_id union select e.id,e.reporting_manager_id from employees e join chain x on e.id=x.reporting_manager_id where e.organization_id=candidate.organization_id and e.legal_entity_id=candidate.legal_entity_id)select coalesce(array_agg(id order by id),array[]::text[]) into before_ids from chain;
   perform e.id from employees e where e.id=any(before_ids) order by e.id for share;
   with recursive chain as(select id,reporting_manager_id from employees where id=candidate.binding_id and organization_id=candidate.organization_id and legal_entity_id=candidate.legal_entity_id union select e.id,e.reporting_manager_id from employees e join chain x on e.id=x.reporting_manager_id where e.organization_id=candidate.organization_id and e.legal_entity_id=candidate.legal_entity_id)select coalesce(array_agg(id order by id),array[]::text[]) into after_ids from chain;
   exit when before_ids=after_ids;
   n=n+1;if n>=3 then raise exception 'Worker relationship changed.' using errcode='CCA02';end if;
  end loop;
 elsif role_name='CountryDirector' then
  if actor.id is not null and (lower(actor.designation) in ('country director','regional lead','director') or lower(actor.department)='regional leadership') and target.primary_country_director_id=actor.primary_country_director_id then return;end if;
  perform m.employee_id from employee_country_director_map m where m.employee_id=target.id and actor.id is not null and (lower(actor.designation) in ('country director','regional lead','director') or lower(actor.department)='regional leadership') and m.country_director_id=actor.primary_country_director_id for share;
  if not found then raise exception 'Worker relationship unavailable.' using errcode='CCA02';end if;
 elsif role_name='ProjectManager' and target.id is distinct from u.employee_record_id and target.employee_id is distinct from actor.employee_id then
  perform a.employee_id from project_allocations a join projects p on p.id=a.project_id where a.employee_id=target.id and p.organization_id=candidate.organization_id and p.legal_entity_id=candidate.legal_entity_id and p.manager_id in(actor.id,actor.employee_id) limit 1 for share of a,p;
  if not found then raise exception 'Worker relationship unavailable.' using errcode='CCA02';end if;
 end if;
end $$;

create function guard_commercial_candidate_approval_append() returns trigger language plpgsql as $$
declare ctx jsonb;i commercial_candidate_approval_instances;p commercial_candidate_approval_policies;c commercial_rate_candidates;o commercial_candidate_owners;last commercial_candidate_approval_transitions;subject_user uuid;subject_role text;n int;stage_def jsonb;
begin
 begin ctx=nullif(current_setting('workos.commercial_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id::text=ctx->>'actorId' and u.status='Active' and r.name=ctx->>'activeRole' and s.organization_id=ctx->>'organizationId' and s.legal_entity_id=ctx->>'legalEntityId' and s.active) then raise exception 'Use the scoped commercial approval command.' using errcode='CCA01';end if;
 if tg_table_name='commercial_candidate_approval_policies' then
  select * into c from commercial_rate_candidates where id=new.candidate_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
  if c.id is not null then perform pg_advisory_xact_lock(hashtext('rate-candidate:'||new.organization_id||':'||new.legal_entity_id||':'||c.stream_id::text));perform pg_advisory_xact_lock(hashtext('candidate-owner:'||new.organization_id||':'||new.legal_entity_id||':'||c.id::text));end if;
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);if c.id is not null then perform lock_commercial_candidate_worker_witness(c,new.actor_id,new.active_role);end if;
  select * into p from commercial_candidate_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and candidate_id=new.candidate_id order by sequence desc limit 1;
  if c.id is null or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not commercial_candidate_manager_valid(new.organization_id,new.legal_entity_id,c,new.actor_id,new.active_role) or new.definition->>'candidateId'<>new.candidate_id::text or new.definition->>'kind'<>c.kind or new.sequence<>coalesce(p.sequence,0)+1 or new.previous_id is distinct from p.id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date then raise exception 'Explicit current scoped commercial policy required.' using errcode='CCA01';end if;
  for stage_def in select value from jsonb_array_elements(new.definition->'stages') loop perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');perform lock_commercial_candidate_worker_witness(c,(stage_def->>'userId')::uuid,stage_def->>'role');if not commercial_candidate_decider_valid(new.organization_id,new.legal_entity_id,c,(stage_def->>'userId')::uuid,stage_def->>'role') then raise exception 'Every named approver must retain independent source and decision authority.' using errcode='CCA01';end if;end loop;return new;
 elsif tg_table_name='commercial_candidate_approval_instances' then
  select * into c from commercial_rate_candidates where id=new.candidate_id;select * into p from commercial_candidate_approval_policies where id=new.policy_id;select * into o from commercial_candidate_owners where id=new.owner_event_id;
  if c.id is not null then perform pg_advisory_xact_lock(hashtext('rate-candidate:'||new.organization_id||':'||new.legal_entity_id||':'||c.stream_id::text));perform pg_advisory_xact_lock(hashtext('candidate-owner:'||new.organization_id||':'||new.legal_entity_id||':'||c.id::text));end if;
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role);if c.id is not null then perform lock_commercial_candidate_worker_witness(c,new.requester_user_id,new.active_role);end if;if o.id is not null then perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,o.owner_user_id,o.owner_role);if c.id is not null then perform lock_commercial_candidate_worker_witness(c,o.owner_user_id,o.owner_role);end if;end if;
  if c.id is null or p.id is null or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.requester_user_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not commercial_candidate_manager_valid(new.organization_id,new.legal_entity_id,c,new.requester_user_id,new.active_role) or not commercial_candidate_approval_is_current(new) then raise exception 'The exact current candidate, owner and policy are required.' using errcode='CCA02';end if;
  if not commercial_approval_inbox_identity_valid(new.organization_id,new.legal_entity_id,c,new.requester_user_id,new.active_role) then raise exception 'Requester must retain scoped source and inbox access.' using errcode='CCA01';end if;
  if c.kind='cost' then
   if(select count(*) from users u join user_organization_scopes sc on sc.user_id=u.id where u.employee_record_id=c.binding_id and u.status='Active' and sc.organization_id=new.organization_id and sc.legal_entity_id=new.legal_entity_id and sc.active)<>1 then raise exception 'Affected worker account is unavailable.' using errcode='CCA02';end if;
   select u.id into subject_user from users u join user_organization_scopes sc on sc.user_id=u.id where u.employee_record_id=c.binding_id and u.status='Active' and sc.organization_id=new.organization_id and sc.legal_entity_id=new.legal_entity_id and sc.active;
  end if;
  for stage_def in select value from jsonb_array_elements(p.definition->'stages') loop
   perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');perform lock_commercial_candidate_worker_witness(c,(stage_def->>'userId')::uuid,stage_def->>'role');
   if (stage_def->>'userId')::uuid=new.requester_user_id or (subject_user is not null and (stage_def->>'userId')::uuid=subject_user) or not commercial_candidate_decider_valid(new.organization_id,new.legal_entity_id,c,(stage_def->>'userId')::uuid,stage_def->>'role') then raise exception 'A distinct current scoped approver is required at every stage.' using errcode='CCA02';end if;
  end loop;
  if exists(select 1 from commercial_candidate_approval_instances x where x.organization_id=new.organization_id and x.legal_entity_id=new.legal_entity_id and x.candidate_id=new.candidate_id and x.owner_event_id=new.owner_event_id and x.policy_id=new.policy_id and not exists(select 1 from commercial_candidate_approval_transitions t where t.instance_id=x.id and(t.decision='Rejected' or t.sequence=jsonb_array_length(p.definition->'stages'))) and not exists(select 1 from commercial_candidate_approval_invalidations z where z.instance_id=x.id)) then raise exception 'Current review is already pending.' using errcode='CCA02';end if;return new;
 elsif tg_table_name='commercial_candidate_approval_reads' then
  if new.user_id::text is distinct from ctx->>'actorId' or not exists(select 1 from commercial_candidate_approval_recipients r join commercial_candidate_approval_events e on e.id=r.event_id join commercial_candidate_approval_instances a on a.id=e.instance_id where r.id=new.recipient_id and r.user_id=new.user_id and r.in_app and a.organization_id=ctx->>'organizationId' and a.legal_entity_id=ctx->>'legalEntityId') then raise exception 'Only the owned recipient may acknowledge.' using errcode='CCA01';end if;return new;
 elsif tg_table_name='commercial_candidate_approval_deliveries' then select a.* into i from commercial_candidate_approval_instances a join commercial_candidate_approval_events e on e.instance_id=a.id join commercial_candidate_approval_recipients r on r.event_id=e.id where r.id=new.recipient_id and r.in_app;
 elsif tg_table_name='commercial_candidate_approval_recipients' then select a.* into i from commercial_candidate_approval_instances a join commercial_candidate_approval_events e on e.instance_id=a.id where e.id=new.event_id;
 else select * into i from commercial_candidate_approval_instances where id=new.instance_id;end if;
 if i.id is null or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or i.id::text is distinct from ctx->>'instanceId' then raise exception 'Approval scope is unavailable.' using errcode='CCA01';end if;
 if tg_table_name='commercial_candidate_approval_invalidations' then
  select * into c from commercial_rate_candidates where id=i.candidate_id;select * into p from commercial_candidate_approval_policies where id=i.policy_id;
  perform pg_advisory_xact_lock(hashtext('rate-candidate:'||i.organization_id||':'||i.legal_entity_id||':'||c.stream_id::text));perform pg_advisory_xact_lock(hashtext('candidate-owner:'||i.organization_id||':'||i.legal_entity_id||':'||c.id::text));
  perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);perform lock_commercial_candidate_worker_witness(c,new.actor_id,new.active_role);select * into last from commercial_candidate_approval_transitions where instance_id=i.id order by sequence desc limit 1;
  if new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not commercial_candidate_manager_valid(i.organization_id,i.legal_entity_id,c,new.actor_id,new.active_role) or last.decision='Rejected' or coalesce(last.sequence,0)>=jsonb_array_length(p.definition->'stages') or exists(select 1 from commercial_candidate_approval_invalidations where instance_id=i.id) then raise exception 'Only a scoped pending commercial review may be cancelled.' using errcode='CCA02';end if;return new;
 end if;
 if tg_table_name='commercial_candidate_approval_transitions' then
  select * into c from commercial_rate_candidates where id=i.candidate_id;select * into p from commercial_candidate_approval_policies where id=i.policy_id;select * into o from commercial_candidate_owners where id=i.owner_event_id;
  perform pg_advisory_xact_lock(hashtext('rate-candidate:'||i.organization_id||':'||i.legal_entity_id||':'||c.stream_id::text));perform pg_advisory_xact_lock(hashtext('candidate-owner:'||i.organization_id||':'||i.legal_entity_id||':'||c.id::text));
  perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,o.owner_user_id,o.owner_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);perform lock_commercial_candidate_worker_witness(c,new.actor_id,new.active_role);perform lock_commercial_candidate_worker_witness(c,o.owner_user_id,o.owner_role);perform lock_commercial_candidate_worker_witness(c,i.requester_user_id,i.active_role);
  select * into last from commercial_candidate_approval_transitions where instance_id=i.id order by sequence desc limit 1;n=coalesce(last.sequence,0);
  if c.kind='cost' then
   select u.id into subject_user from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=c.binding_id and u.status='Active' and s.organization_id=i.organization_id and s.legal_entity_id=i.legal_entity_id and s.active order by u.id limit 1;
   select r.name into subject_role from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=subject_user and (exists(select 1 from role_permissions rp where rp.role_name=r.name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=subject_user and g.permission_key='employees.view')) and (exists(select 1 from role_permissions rp where rp.role_name=r.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=subject_user and g.permission_key='notifications.view')) order by r.name limit 1;
   if subject_user is not null and subject_role is not null then perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,subject_user,subject_role);end if;
  end if;
  if new.decision='Approved' and n+1<jsonb_array_length(p.definition->'stages') then stage_def=p.definition->'stages'->(n+1);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');perform lock_commercial_candidate_worker_witness(c,(stage_def->>'userId')::uuid,stage_def->>'role');end if;
  if not commercial_candidate_approval_is_current(i) or last.decision='Rejected' or n>=jsonb_array_length(p.definition->'stages') or new.sequence<>n+1 or new.stage<>n or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.actor_id=i.requester_user_id or new.actor_id=subject_user or new.actor_id::text is distinct from p.definition->'stages'->n->>'userId' or new.active_role is distinct from p.definition->'stages'->n->>'role' or not commercial_candidate_decider_valid(i.organization_id,i.legal_entity_id,c,new.actor_id,new.active_role) then raise exception 'A current named independent decision is required.' using errcode='CCA02';end if;
 end if;return new;
end $$;
do $$declare t text;begin foreach t in array array['commercial_candidate_approval_policies','commercial_candidate_approval_instances','commercial_candidate_approval_transitions','commercial_candidate_approval_events','commercial_candidate_approval_recipients','commercial_candidate_approval_deliveries','commercial_candidate_approval_reads','commercial_candidate_approval_invalidations','commercial_candidate_approval_notification_failures'] loop execute format('create trigger guarded_%I before insert on %I for each row execute function guard_commercial_candidate_approval_append()',t,t);end loop;end $$;

-- No generic compatibility writer may create or decide this domain outside its exact transaction.
create function guard_commercial_candidate_compatibility() returns trigger language plpgsql as $$
declare ctx jsonb;i commercial_candidate_approval_instances;t commercial_candidate_approval_transitions;p commercial_candidate_approval_policies;c commercial_rate_candidates;expected text;begin
 if tg_op='DELETE' then if old.entity_type='CommercialCandidateApproval' then raise exception 'Commercial approval history cannot be deleted.' using errcode='CCA03';end if;return old;end if;
 if tg_op='UPDATE' and old.entity_type='CommercialCandidateApproval' and (new.entity_type,new.entity_id) is distinct from (old.entity_type,old.entity_id) then raise exception 'Commercial approval identity cannot change.' using errcode='CCA03';end if;
 if new.entity_type<>'CommercialCandidateApproval' then return new;end if;
 begin ctx=nullif(current_setting('workos.commercial_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from commercial_candidate_approval_instances where id::text=new.entity_id;select * into p from commercial_candidate_approval_policies where id=i.policy_id;select * into c from commercial_rate_candidates where id=i.candidate_id;select * into t from commercial_candidate_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 expected=case when exists(select 1 from commercial_candidate_approval_invalidations where instance_id=i.id) then 'Cancelled' when t.id is null then 'Pending' when t.decision='Rejected' then 'Rejected' when t.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if i.id is null or ctx is null or i.id::text is distinct from ctx->>'instanceId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.status is distinct from expected or new.subject_employee_id is distinct from (case when c.kind='cost' then c.binding_id else null end) or new.comments is not null or new.due_at is not null then raise exception 'Commercial compatibility must follow its exact protected stage.' using errcode='CCA03';end if;return new;
end $$;
create trigger guarded_commercial_candidate_compatibility before insert or update or delete on approval_records for each row execute function guard_commercial_candidate_compatibility();

create function validate_commercial_candidate_approval_commit() returns trigger language plpgsql as $$
declare i commercial_candidate_approval_instances;p commercial_candidate_approval_policies;c commercial_rate_candidates;o commercial_candidate_owners;ev commercial_candidate_approval_events;rec commercial_candidate_approval_recipients;last commercial_candidate_approval_transitions;seq int;stage_no int;v_event_key text;state text;worker_user uuid;expected_users uuid[];expected_reasons text[];u uuid;tmpl jsonb;expected_operation text;
begin
 if tg_table_name='commercial_candidate_approval_instances' then i=new;seq=0;stage_no=0;v_event_key='approval.action_required';else select * into i from commercial_candidate_approval_instances where id=new.instance_id;seq=new.sequence;end if;
 select * into p from commercial_candidate_approval_policies where id=i.policy_id;select * into c from commercial_rate_candidates where id=i.candidate_id;select * into o from commercial_candidate_owners where id=i.owner_event_id;select * into last from commercial_candidate_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if p.id is null or c.id is null or o.id is null or not commercial_candidate_approval_is_current(i) then raise exception 'Candidate, owner or policy changed before commit.' using errcode='CCA04';end if;
 state=case when last.id is null then 'Pending' when last.decision='Rejected' then 'Rejected' when last.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if tg_table_name='commercial_candidate_approval_transitions' then if new.decision='Rejected' then v_event_key='approval.rejected_or_correction_required';stage_no=new.stage;elsif new.sequence<jsonb_array_length(p.definition->'stages') then v_event_key='approval.action_required';stage_no=new.sequence;else v_event_key='approval.completed';stage_no=new.stage;end if;end if;
 if not exists(select 1 from approval_records a where a.entity_type='CommercialCandidateApproval' and a.entity_id=i.id::text and a.status=state and a.comments is null and a.due_at is null) then raise exception 'Commercial generic approval and stage must converge.' using errcode='CCA04';end if;
 select * into ev from commercial_candidate_approval_events where instance_id=i.id and transition_sequence=seq and commercial_candidate_approval_events.event_key=v_event_key;
 if v_event_key='approval.completed' and ev.id is null and exists(select 1 from commercial_candidate_approval_notification_failures where instance_id=i.id and transition_sequence=seq) then return null;end if;
 select t into tmpl from jsonb_array_elements(p.definition->'templates') t where t->>'key'=v_event_key;
 expected_operation=case when tg_table_name='commercial_candidate_approval_instances' then i.operation_id else new.operation_id end;
 if ev.id is null or ev.stage<>stage_no or ev.policy_id<>p.id or ev.operation_id is distinct from expected_operation or ev.locale is distinct from p.definition->>'locale' or tmpl is null or ev.title is distinct from replace(replace(tmpl->>'subject','{{sourceRef}}','commercial-candidate/'||i.candidate_id::text),'{{stageNumber}}',(stage_no+1)::text) or ev.body is distinct from replace(replace(tmpl->>'body','{{sourceRef}}','commercial-candidate/'||i.candidate_id::text),'{{stageNumber}}',(stage_no+1)::text) or (select count(*) from commercial_candidate_approval_events where instance_id=i.id and transition_sequence=seq)<>1 then raise exception 'Exactly one sanitized canonical stage event is required.' using errcode='CCA04';end if;
 if v_event_key='approval.action_required' then expected_users=array[(p.definition->'stages'->stage_no->>'userId')::uuid];
 else
  if c.kind='cost' then
   if(select count(*) from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=c.binding_id and u.status='Active' and s.organization_id=i.organization_id and s.legal_entity_id=i.legal_entity_id and s.active)<>1 then raise exception 'Affected worker account unavailable.' using errcode='CCA04';end if;
   select u.id into worker_user from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=c.binding_id and u.status='Active' and s.organization_id=i.organization_id and s.legal_entity_id=i.legal_entity_id and s.active;
  end if;
  select array_agg(distinct x) into expected_users from unnest(case when v_event_key='approval.rejected_or_correction_required' then array[i.requester_user_id,o.owner_user_id,worker_user] else array[i.requester_user_id,worker_user] end)x where x is not null;
 end if;
 if(select count(*) from commercial_candidate_approval_recipients where event_id=ev.id)<>cardinality(expected_users) then raise exception 'The complete canonical recipient set is required.' using errcode='CCA04';end if;
 foreach u in array expected_users loop
  if not exists(select 1 from users usr join user_organization_scopes sc on sc.user_id=usr.id join user_roles ur on ur.user_id=usr.id join roles role on role.id=ur.role_id where usr.id=u and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='notifications.view')) and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='employees.view'))) then raise exception 'Required notification recipient is no longer available.' using errcode='CCA04';end if;
  if v_event_key='approval.action_required' and not commercial_candidate_decider_valid(i.organization_id,i.legal_entity_id,c,u,p.definition->'stages'->stage_no->>'role') then raise exception 'Current-stage approver is unavailable.' using errcode='CCA04';end if;
  if v_event_key<>'approval.action_required' and u=i.requester_user_id and not commercial_approval_inbox_identity_valid(i.organization_id,i.legal_entity_id,c,u,i.active_role) then raise exception 'Requester source access is unavailable.' using errcode='CCA04';end if;
  select * into rec from commercial_candidate_approval_recipients where event_id=ev.id and user_id=u;
  select array_agg(reason order by reason) into expected_reasons from (select 'current_stage_approver' reason where v_event_key='approval.action_required' union all select 'requester' where v_event_key<>'approval.action_required' and u=i.requester_user_id union all select 'commercial_change_owner' where v_event_key='approval.rejected_or_correction_required' and u=o.owner_user_id union all select 'affected_worker' where v_event_key<>'approval.action_required' and u=worker_user) q;
  if rec.id is null or (select array_agg(x order by x) from unnest(rec.reasons)x) is distinct from expected_reasons then raise exception 'Mandatory recipient reasons must be exact.' using errcode='CCA04';end if;
  if (v_event_key<>'approval.completed' and (not rec.in_app or rec.channel_decision<>'Required')) or (rec.in_app and not exists(select 1 from commercial_candidate_approval_deliveries d where d.recipient_id=rec.id and d.channel='InApp' and d.status='Delivered')) then raise exception 'Every required in-app recipient must commit.' using errcode='CCA04';end if;
 end loop;return null;
end $$;
create constraint trigger complete_commercial_candidate_approval_instance after insert on commercial_candidate_approval_instances deferrable initially deferred for each row execute function validate_commercial_candidate_approval_commit();
create constraint trigger complete_commercial_candidate_approval_transition after insert on commercial_candidate_approval_transitions deferrable initially deferred for each row execute function validate_commercial_candidate_approval_commit();

create function complete_commercial_candidate_invalidation() returns trigger language plpgsql as $$
declare i commercial_candidate_approval_instances;begin
 select * into i from commercial_candidate_approval_instances where id=new.instance_id;
 if not exists(select 1 from approval_records where entity_type='CommercialCandidateApproval' and entity_id=i.id::text and status='Cancelled') or not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Commercial Approval' and a.action='Cancel Request' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('cancellationId',new.id,'instanceId',i.id)) then raise exception 'Commercial cancellation and redacted audit must commit together.' using errcode='CCA04';end if;return null;
end $$;
create constraint trigger complete_commercial_candidate_invalidation after insert on commercial_candidate_approval_invalidations deferrable initially deferred for each row execute function complete_commercial_candidate_invalidation();
