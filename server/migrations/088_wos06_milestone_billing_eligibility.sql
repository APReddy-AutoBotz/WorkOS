-- Development sentinel: this migration must not run until the complete
-- source-specific guards, atomic commit validation and inbox are present.
do $$begin raise exception 'Milestone billing eligibility is incomplete';end$$;

-- Permission definitions are opt-in. No role, user or organization grant is created.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.milestone_billing.view','Commercial','View milestone billing review','View scoped milestone acceptance and eligibility evidence.',false),
 ('commercial.milestone_billing.manage','Commercial','Manage milestone billing review','Configure and request scoped milestone billing review.',false),
 ('commercial.milestone_billing.decide','Commercial','Decide milestone billing review','Decide a named scoped milestone billing review stage.',false);

create function valid_milestone_billing_policy(d jsonb) returns boolean language plpgsql immutable as $$
begin
 if jsonb_typeof(d) is distinct from 'object' or not(d ?& array['entityType','engagementId','evidenceKinds','stages','locale','templates','completionInApp'])
   or (select count(*) from jsonb_object_keys(d))<>7 or d->>'entityType' is distinct from 'MilestoneBillingEligibility'
   or jsonb_typeof(d->'engagementId') is distinct from 'string' or length(btrim(d->>'engagementId')) not between 1 and 200
   or jsonb_typeof(d->'evidenceKinds') is distinct from 'array' or jsonb_array_length(d->'evidenceKinds') not between 1 and 2
   or exists(select 1 from jsonb_array_elements(d->'evidenceKinds') k where jsonb_typeof(k)<>'string' or k#>>'{}' not in ('INTERNAL_ASSERTION','CLIENT_EVIDENCE_ASSERTION'))
   or (select count(distinct k) from jsonb_array_elements_text(d->'evidenceKinds') k)<>jsonb_array_length(d->'evidenceKinds') then return false;end if;
 if not valid_work_approval_definition((d-'engagementId'-'evidenceKinds')||jsonb_build_object('entityType','Timesheet','workerIds','[]'::jsonb)) then return false;end if;
 if exists(select 1 from jsonb_array_elements(d->'templates') t where regexp_replace(t->>'subject','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]' or regexp_replace(t->>'body','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]') then return false;end if;
 return true;
exception when others then return false;end $$;

create function valid_milestone_billing_evidence(e jsonb,kinds jsonb) returns boolean language plpgsql immutable as $$
declare row jsonb;authority text;port text;begin
 if jsonb_typeof(e) is distinct from 'array' or jsonb_typeof(kinds) is distinct from 'array' or jsonb_array_length(e)<>jsonb_array_length(kinds) then return false;end if;
 if exists(select 1 from jsonb_array_elements(e) x where jsonb_typeof(x) is distinct from 'object' or not(x ?& array['kind','reference','url']) or (select count(*) from jsonb_object_keys(x))<>3
    or jsonb_typeof(x->'kind') is distinct from 'string' or not(kinds ? (x->>'kind')) or jsonb_typeof(x->'reference') is distinct from 'string'
    or x->>'reference'<>btrim(x->>'reference') or length(x->>'reference') not between 1 and 200 or x->>'reference' ~ '[[:cntrl:]]'
    or jsonb_typeof(x->'url') is distinct from 'string' or length(x->>'url')>2048 or x->>'url' !~ '^https://([^/:?#@[:space:]]+|\[[0-9a-fA-F:.]+\])(:[0-9]{1,5})?([/?#][^[:space:]]*)?$') then return false;end if;
 for row in select value from jsonb_array_elements(e) loop
  authority=split_part(split_part(split_part(substr(row->>'url',9),'/',1),'?',1),'#',1);
  port=substring(authority from ':([0-9]{1,5})$');if port is not null and port::integer>65535 then return false;end if;
 end loop;
 return (select count(distinct x->>'kind') from jsonb_array_elements(e) x)=jsonb_array_length(e);
exception when others then return false;end $$;

create table milestone_billing_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 sequence integer not null check(sequence>0),previous_id uuid references milestone_billing_policies(id),effective_from date not null,
 definition jsonb not null check(valid_milestone_billing_policy(definition)),actor_id uuid not null references users(id),active_role text not null,
 reason text not null check(length(btrim(reason)) between 3 and 1000),request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,engagement_id,sequence),unique(organization_id,legal_entity_id,actor_id,request_id),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create table milestone_billing_instances(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,milestone_id text not null references commercial_milestones(id),
 policy_id uuid not null references milestone_billing_policies(id),owner_user_id uuid not null references users(id),owner_role text not null,
 requester_user_id uuid not null references users(id),active_role text not null,evidence jsonb not null,
 engagement_lifecycle_id text not null references commercial_lifecycle_events(id),contract_lifecycle_id text not null references commercial_lifecycle_events(id),
 request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),
 operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,requester_user_id,request_id),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create table milestone_billing_transitions(
 id uuid primary key,instance_id uuid not null references milestone_billing_instances(id),sequence integer not null check(sequence between 1 and 10),stage integer not null check(stage between 0 and 9),
 decision text not null check(decision in ('Approved','Rejected')),actor_id uuid not null references users(id),active_role text not null,
 request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),
 operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(instance_id,sequence),unique(instance_id,request_id)
);
create table milestone_billing_invalidations(
 id uuid primary key,instance_id uuid not null unique references milestone_billing_instances(id),actor_id uuid not null references users(id),active_role text not null,
 request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),
 operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(actor_id,request_id)
);
create table milestone_billing_owner_losses(instance_id uuid primary key references milestone_billing_instances(id),cause text not null,detected_at timestamptz not null default clock_timestamp());

create table milestone_billing_notices(
 id text primary key,instance_id uuid not null references milestone_billing_instances(id),transition_sequence integer not null check(transition_sequence between 0 and 10),stage integer not null check(stage between 0 and 9),
 event_key text not null check(event_key in ('approval.action_required','approval.rejected_or_correction_required','approval.completed')),
 policy_class text not null check(policy_class in ('ACTION_REQUIRED','INFORMATIONAL')),policy_id uuid not null references milestone_billing_policies(id),
 operation_id text not null,locale text not null,title text not null check(work_period_notice_units(title) between 1 and 1200),body text not null check(work_period_notice_units(body) between 1 and 12000),
 created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence,event_key),
 check((event_key in ('approval.action_required','approval.rejected_or_correction_required') and policy_class='ACTION_REQUIRED') or(event_key='approval.completed' and policy_class='INFORMATIONAL'))
);
create table milestone_billing_recipients(
 id uuid primary key,event_id text not null references milestone_billing_notices(id),user_id uuid not null references users(id),
 reasons text[] not null check(cardinality(reasons) between 1 and 3 and reasons<@array['requester','commercial_change_owner','current_stage_approver']::text[]),
 in_app boolean not null,channel_decision text not null check(channel_decision in ('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id)
);
create table milestone_billing_deliveries(id uuid primary key,recipient_id uuid not null unique references milestone_billing_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt integer not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table milestone_billing_reads(recipient_id uuid primary key references milestone_billing_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
create table milestone_billing_notice_failures(id uuid primary key,instance_id uuid not null references milestone_billing_instances(id),transition_sequence integer not null,code text not null check(code='INFORMATIONAL_NOTIFICATION_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence));
do $$declare t text;begin foreach t in array array['milestone_billing_policies','milestone_billing_instances','milestone_billing_transitions','milestone_billing_invalidations','milestone_billing_owner_losses','milestone_billing_notices','milestone_billing_recipients','milestone_billing_deliveries','milestone_billing_reads','milestone_billing_notice_failures'] loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;

-- The discriminator is bound to the event by a composite FK. Existing rows and
-- existing T&M insert commands retain the same source type and guard behavior.
alter table billing_eligibility_events drop constraint billing_eligibility_events_source_type_check;
alter table billing_eligibility_events alter column snapshot_id drop not null,alter column instance_id drop not null,alter column decision_id drop not null;
alter table billing_eligibility_events add column milestone_instance_id uuid references milestone_billing_instances(id),add column milestone_decision_id uuid references milestone_billing_transitions(id);
alter table billing_eligibility_events add constraint billing_event_source_identity check(
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and instance_id is not null and decision_id is not null and milestone_instance_id is null and milestone_decision_id is null)
 or(source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null and instance_id is null and decision_id is null and milestone_instance_id is not null and milestone_decision_id is not null));
alter table billing_eligibility_events add constraint billing_event_id_source_unique unique(id,source_type);
create unique index milestone_event_instance_unique on billing_eligibility_events(milestone_instance_id) where source_type='MILESTONE_ACCEPTANCE';
create unique index milestone_event_source_unique on billing_eligibility_events(organization_id,legal_entity_id,(billing_evidence->>'milestoneId')) where source_type='MILESTONE_ACCEPTANCE';
alter table approved_unbilled_items add column source_type text not null default 'TM_SNAPSHOT';
alter table approved_unbilled_items add constraint register_event_source_fk foreign key(event_id,source_type) references billing_eligibility_events(id,source_type);
drop trigger guarded_billing_eligibility_events on billing_eligibility_events;
create trigger guarded_billing_eligibility_events before insert on billing_eligibility_events for each row when(new.source_type='TM_SNAPSHOT') execute function guard_tm_billing_eligibility_append();
drop trigger guarded_approved_unbilled_items on approved_unbilled_items;
create trigger guarded_approved_unbilled_items before insert on approved_unbilled_items for each row when(new.source_type='TM_SNAPSHOT') execute function guard_tm_billing_eligibility_append();

create function milestone_billing_actor_valid(org text,legal text,who uuid,role_name text,kind text) returns boolean language plpgsql stable as $$
declare k text;keys text[];begin
 if kind not in ('viewer','manager','decider') or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id=who and u.status='Active' and r.name=role_name and s.organization_id=org and s.legal_entity_id=legal and s.active) then return false;end if;
 keys=array['commercial.contracts.view','commercial.milestone_billing.view','employees.view','notifications.view'];
 if kind='manager' then keys=keys||array['commercial.contracts.manage','commercial.milestone_billing.manage'];elsif kind='decider' then keys=keys||array['approvals.view','commercial.milestone_billing.decide'];end if;
 foreach k in array keys loop if not exists(select 1 from role_permissions rp where rp.role_name=milestone_billing_actor_valid.role_name and rp.permission_key=k and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=k) then return false;end if;end loop;return true;
end $$;


-- A user assertion is evidence to review, not verification by an outside party.
-- Current lifecycle identities are pinned and amendments fail closed until a
-- source-specific amended milestone version is available.
create function milestone_billing_source_valid(org text,legal text,eng text,milestone text,eng_lifecycle text,contract_lifecycle text) returns boolean language sql stable as $$
 select exists(select 1 from commercial_milestones m join commercial_engagements e on e.id=m.engagement_id and e.organization_id=m.organization_id and e.legal_entity_id=m.legal_entity_id
  join commercial_lifecycle_events el on el.id=eng_lifecycle and el.organization_id=e.organization_id and el.legal_entity_id=e.legal_entity_id and el.entity_type='Engagement' and el.entity_id=e.id
  join commercial_lifecycle_events cl on cl.id=contract_lifecycle and cl.organization_id=e.organization_id and cl.legal_entity_id=e.legal_entity_id and cl.entity_type='Contract' and cl.entity_id=e.contract_id
  where m.id=milestone and m.organization_id=org and m.legal_entity_id=legal and m.engagement_id=eng and e.origin='manual' and e.model='milestone' and e.billable
   and e.client_id is not null and e.contract_id is not null and e.contract_version_id is not null and m.amount>0 and m.currency=e.currency and m.due_on between e.starts_on and e.ends_on
   and el.state='Active' and cl.state='Active' and el.contract_version_id=e.contract_version_id and cl.contract_version_id=e.contract_version_id
   and el.id=(select id from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal and entity_type='Engagement' and entity_id=e.id order by sequence desc limit 1)
   and cl.id=(select id from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal and entity_type='Contract' and entity_id=e.contract_id order by sequence desc limit 1)
   and not exists(select 1 from commercial_amendments a where a.organization_id=org and a.legal_entity_id=legal and ((a.entity_type='Engagement' and a.entity_id=e.id) or(a.entity_type='Contract' and a.entity_id=e.contract_id)))
 )
$$;

create function milestone_billing_review_current(i milestone_billing_instances) returns boolean language sql stable as $$
 select milestone_billing_source_valid(i.organization_id,i.legal_entity_id,i.engagement_id,i.milestone_id,i.engagement_lifecycle_id,i.contract_lifecycle_id)
  and exists(select 1 from milestone_billing_policies p where p.id=i.policy_id and p.organization_id=i.organization_id and p.legal_entity_id=i.legal_entity_id and p.engagement_id=i.engagement_id
   and p.effective_from<=(clock_timestamp() at time zone 'UTC')::date and p.id=(select id from milestone_billing_policies where organization_id=i.organization_id and legal_entity_id=i.legal_entity_id and engagement_id=i.engagement_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by effective_from desc,sequence desc limit 1)
   and valid_milestone_billing_evidence(i.evidence,p.definition->'evidenceKinds'))
  and milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'manager')
  and milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role,'manager')
  and not exists(select 1 from milestone_billing_invalidations z where z.instance_id=i.id)
  and not exists(select 1 from milestone_billing_owner_losses z where z.instance_id=i.id)
$$;

-- The development sentinel above remains in force until these guards and
-- their deferred transaction/inbox validation have been completed and tested.
create function guard_milestone_billing_append() returns trigger language plpgsql as $$
declare ctx jsonb;i milestone_billing_instances;p milestone_billing_policies;prior milestone_billing_policies;t milestone_billing_transitions;e commercial_engagements;m commercial_milestones;ev billing_eligibility_events;notice milestone_billing_notices;rec milestone_billing_recipients;stage_def jsonb;template jsonb;n integer;recipient_role text;expected_reasons text[];expected_channel text;pref boolean;
begin
 begin ctx=nullif(current_setting('workos.milestone_billing_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id where u.id::text=ctx->>'actorId' and u.status='Active' and r.name=ctx->>'activeRole' and sc.organization_id=ctx->>'organizationId' and sc.legal_entity_id=ctx->>'legalEntityId' and sc.active) then raise exception 'Use the authenticated scoped milestone billing command.' using errcode='MBE01';end if;
 if tg_table_name='milestone_billing_policies' then
  perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
  perform pg_advisory_xact_lock(hashtext('milestone-billing-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
  select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
  select * into prior from milestone_billing_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
  if new.id::text is distinct from ctx->>'policyId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or e.id is null or e.origin<>'manual' or e.model<>'milestone' or not e.billable or new.definition->>'engagementId' is distinct from e.id or new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date or(prior.id is not null and new.effective_from<prior.effective_from) then raise exception 'Explicit current scoped milestone policy required.' using errcode='MBE01';end if;
  for stage_def in select value from jsonb_array_elements(new.definition->'stages') loop perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');if not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role','decider') then raise exception 'Each named approver needs current separate eligibility authority.' using errcode='MBE01';end if;end loop;return new;
 elsif tg_table_name='milestone_billing_instances' then
  perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
  perform pg_advisory_xact_lock(hashtext('milestone-billing-source:'||new.organization_id||':'||new.legal_entity_id||':'||new.milestone_id));
  perform pg_advisory_xact_lock(hashtext('milestone-billing-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role);perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role);
  select * into p from milestone_billing_policies where id=new.policy_id;
  if new.id::text is distinct from ctx->>'instanceId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.requester_user_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not milestone_billing_review_current(new) or exists(select 1 from billing_eligibility_events where milestone_instance_id in(select id from milestone_billing_instances where milestone_id=new.milestone_id)) then raise exception 'An exact current milestone, named owner, policy and explicit evidence are required.' using errcode='MBE02';end if;
  for stage_def in select value from jsonb_array_elements(p.definition->'stages') loop perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');if (stage_def->>'userId')::uuid=new.requester_user_id or not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role','decider') then raise exception 'Each named approver must be independent and currently authorized.' using errcode='MBE02';end if;end loop;
  if exists(select 1 from milestone_billing_instances x where x.organization_id=new.organization_id and x.legal_entity_id=new.legal_entity_id and x.milestone_id=new.milestone_id and not exists(select 1 from milestone_billing_invalidations z where z.instance_id=x.id) and not exists(select 1 from milestone_billing_owner_losses z where z.instance_id=x.id) and not exists(select 1 from milestone_billing_transitions q join milestone_billing_policies pol on pol.id=x.policy_id where q.instance_id=x.id and(q.decision='Rejected' or q.sequence=jsonb_array_length(pol.definition->'stages')))) then raise exception 'A current milestone review is already pending.' using errcode='MBE02';end if;return new;
 elsif tg_table_name='milestone_billing_reads' then
  if new.user_id::text is distinct from ctx->>'actorId' or not exists(select 1 from milestone_billing_recipients rec join milestone_billing_notices notice on notice.id=rec.event_id join milestone_billing_instances x on x.id=notice.instance_id where rec.id=new.recipient_id and rec.user_id=new.user_id and rec.in_app and x.organization_id=ctx->>'organizationId' and x.legal_entity_id=ctx->>'legalEntityId') then raise exception 'Only the owned recipient may acknowledge.' using errcode='MBE01';end if;return new;
 elsif tg_table_name='milestone_billing_deliveries' then select x.* into i from milestone_billing_instances x join milestone_billing_notices notice on notice.instance_id=x.id join milestone_billing_recipients rec on rec.event_id=notice.id where rec.id=new.recipient_id and rec.in_app;
 elsif tg_table_name='milestone_billing_recipients' then select x.* into i from milestone_billing_instances x join milestone_billing_notices notice on notice.instance_id=x.id where notice.id=new.event_id;
 elsif tg_table_name='approved_unbilled_items' then select * into ev from billing_eligibility_events where id=new.event_id;select * into i from milestone_billing_instances where id=ev.milestone_instance_id;
 elsif tg_table_name='billing_eligibility_events' then select * into i from milestone_billing_instances where id=new.milestone_instance_id;
 else select * into i from milestone_billing_instances where id=new.instance_id;end if;
 if i.id is null or i.id::text is distinct from ctx->>'instanceId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' then raise exception 'Scoped milestone review is unavailable.' using errcode='MBE01';end if;
 if tg_table_name='milestone_billing_invalidations' then
  perform pg_advisory_xact_lock(hashtext('milestone-billing-source:'||i.organization_id||':'||i.legal_entity_id||':'||i.milestone_id));perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);
  select * into p from milestone_billing_policies where id=i.policy_id;select * into t from milestone_billing_transitions where instance_id=i.id order by sequence desc limit 1;
  if new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'manager') or t.decision='Rejected' or coalesce(t.sequence,0)>=jsonb_array_length(p.definition->'stages') then raise exception 'Only an authorized pending review may be invalidated.' using errcode='MBE02';end if;return new;
 elsif tg_table_name='milestone_billing_transitions' then
  perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||i.organization_id||':'||i.legal_entity_id,0));perform pg_advisory_xact_lock(hashtext('milestone-billing-source:'||i.organization_id||':'||i.legal_entity_id||':'||i.milestone_id));perform pg_advisory_xact_lock(hashtext('milestone-billing-policy:'||i.organization_id||':'||i.legal_entity_id||':'||i.engagement_id));
  perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role);
  select * into p from milestone_billing_policies where id=i.policy_id;select * into t from milestone_billing_transitions where instance_id=i.id order by sequence desc limit 1;n=coalesce(t.sequence,0);
  if not milestone_billing_review_current(i) or t.decision='Rejected' or n>=jsonb_array_length(p.definition->'stages') or new.sequence<>n+1 or new.stage<>n or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.actor_id=i.requester_user_id or new.actor_id::text is distinct from p.definition->'stages'->n->>'userId' or new.active_role is distinct from p.definition->'stages'->n->>'role' or not milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'decider') then raise exception 'A current independent named decision is required.' using errcode='MBE02';end if;return new;
 elsif tg_table_name='billing_eligibility_events' then
  new.created_at=clock_timestamp();
  select * into p from milestone_billing_policies where id=i.policy_id;select * into t from milestone_billing_transitions where id=new.milestone_decision_id and instance_id=i.id;select * into m from commercial_milestones where id=i.milestone_id;select * into e from commercial_engagements where id=i.engagement_id and organization_id=i.organization_id and legal_entity_id=i.legal_entity_id;
  if not milestone_billing_review_current(i) or t.id is null or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or new.id::text is distinct from ctx->>'eventId' or new.organization_id<>i.organization_id or new.legal_entity_id<>i.legal_entity_id or new.engagement_id<>i.engagement_id or new.client_id<>e.client_id or new.contract_id<>e.contract_id or new.currency<>m.currency or new.amount<>m.amount or new.eligible_on<>(new.created_at at time zone 'UTC')::date or new.billing_evidence is distinct from jsonb_build_object('milestoneId',m.id,'sourceVersion',1,'engagementId',e.id,'contractVersionId',e.contract_version_id,'engagementLifecycleId',i.engagement_lifecycle_id,'contractLifecycleId',i.contract_lifecycle_id,'dueOn',to_char(m.due_on,'YYYY-MM-DD'),'evidence',i.evidence,'ownerUserId',i.owner_user_id,'ownerRole',i.owner_role,'policyId',i.policy_id,'decisionId',t.id,'currency',m.currency,'amount',trim_scale(m.amount)::text) or new.actor_id<>t.actor_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role<>t.active_role or new.active_role is distinct from ctx->>'activeRole' or new.operation_id<>t.operation_id or new.operation_id is distinct from ctx->>'operationId' then raise exception 'Only the exact final milestone decision can establish billing eligibility.' using errcode='MBE03';end if;return new;
 elsif tg_table_name='approved_unbilled_items' then
  if ev.id is null or ev.source_type<>'MILESTONE_ACCEPTANCE' or new.source_type<>ev.source_type or new.organization_id<>ev.organization_id or new.legal_entity_id<>ev.legal_entity_id or new.id::text is distinct from ctx->>'itemId' then raise exception 'A single scoped milestone event item is required.' using errcode='MBE03';end if;return new;
 elsif tg_table_name='milestone_billing_notices' then
  select * into p from milestone_billing_policies where id=i.policy_id;select * into t from milestone_billing_transitions where instance_id=i.id and sequence=new.transition_sequence;select value into template from jsonb_array_elements(p.definition->'templates') where value->>'key'=new.event_key;
  if new.id is distinct from ctx->>'noticeId' or new.policy_id<>i.policy_id or new.operation_id is distinct from ctx->>'operationId' or new.locale is distinct from p.definition->>'locale' or template is null
   or(new.transition_sequence=0 and(new.event_key<>'approval.action_required' or new.stage<>0 or new.operation_id<>i.operation_id or i.requester_user_id::text is distinct from ctx->>'actorId' or i.active_role is distinct from ctx->>'activeRole'))
   or(new.transition_sequence>0 and(t.id is null or t.operation_id<>new.operation_id or t.actor_id::text is distinct from ctx->>'actorId' or t.active_role is distinct from ctx->>'activeRole'
     or(t.decision='Rejected' and(new.event_key<>'approval.rejected_or_correction_required' or new.stage<>t.stage))
     or(t.decision='Approved' and t.sequence<jsonb_array_length(p.definition->'stages') and(new.event_key<>'approval.action_required' or new.stage<>t.sequence))
     or(t.decision='Approved' and t.sequence=jsonb_array_length(p.definition->'stages') and(new.event_key<>'approval.completed' or new.stage<>t.stage))))
   or new.title is distinct from replace(replace(template->>'subject','{{sourceRef}}','milestone/'||i.milestone_id),'{{stageNumber}}',(new.stage+1)::text)
   or new.body is distinct from replace(replace(template->>'body','{{sourceRef}}','milestone/'||i.milestone_id),'{{stageNumber}}',(new.stage+1)::text) then raise exception 'Only the exact configured notice may be emitted.' using errcode='MBE03';end if;return new;
 elsif tg_table_name='milestone_billing_recipients' then
  select * into notice from milestone_billing_notices where id=new.event_id;select * into p from milestone_billing_policies where id=i.policy_id;
  recipient_role=case when notice.event_key='approval.action_required' then p.definition->'stages'->notice.stage->>'role' when new.user_id=i.requester_user_id then i.active_role else i.owner_role end;
  perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.user_id,recipient_role);
  expected_reasons=case when notice.event_key='approval.action_required' then array['current_stage_approver']::text[] when notice.event_key='approval.completed' then array['requester']::text[] when new.user_id=i.requester_user_id and new.user_id=i.owner_user_id then array['commercial_change_owner','requester']::text[] when new.user_id=i.requester_user_id then array['requester']::text[] else array['commercial_change_owner']::text[] end;
  select n.in_app into pref from notification_preferences n join users u on u.employee_record_id=n.employee_id where u.id=new.user_id and n.event_type=notice.event_key;
  expected_channel=case when notice.event_key<>'approval.completed' then 'Required' when not (p.definition->>'completionInApp')::boolean then 'SuppressedPolicy' when pref=false then 'SuppressedPreference' else 'Enabled' end;
  if notice.id is null or notice.id is distinct from ctx->>'noticeId' or not milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,new.user_id,recipient_role,case when notice.event_key='approval.action_required' then 'decider' else 'manager' end)
   or(notice.event_key='approval.action_required' and new.user_id::text is distinct from p.definition->'stages'->notice.stage->>'userId')
   or(notice.event_key='approval.rejected_or_correction_required' and new.user_id not in(i.requester_user_id,i.owner_user_id))
   or(notice.event_key='approval.completed' and new.user_id<>i.requester_user_id)
   or new.reasons<>expected_reasons or new.channel_decision<>expected_channel or new.in_app<>(expected_channel in('Required','Enabled')) then raise exception 'Only configured current recipients may receive milestone notices.' using errcode='MBE03';end if;return new;
 elsif tg_table_name='milestone_billing_deliveries' then
  select * into rec from milestone_billing_recipients where id=new.recipient_id;select * into notice from milestone_billing_notices where id=rec.event_id;
  if notice.id is distinct from ctx->>'noticeId' or not rec.in_app then raise exception 'Only an in-app recipient may be delivered.' using errcode='MBE03';end if;return new;
 elsif tg_table_name='milestone_billing_notice_failures' then
  select * into p from milestone_billing_policies where id=i.policy_id;select * into t from milestone_billing_transitions where instance_id=i.id and sequence=new.transition_sequence;
  if t.id is null or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') then raise exception 'Only informational completion may record a notice failure.' using errcode='MBE03';end if;return new;
 end if;
 -- Deferred commit validation remains unimplemented; the sentinel remains.
 raise exception 'Milestone billing operation is not implemented.' using errcode='MBE03';
end $$;

do $$declare name text;begin foreach name in array array['milestone_billing_policies','milestone_billing_instances','milestone_billing_transitions','milestone_billing_invalidations','milestone_billing_notices','milestone_billing_recipients','milestone_billing_deliveries','milestone_billing_reads','milestone_billing_notice_failures'] loop execute format('create trigger guarded_%I before insert on %I for each row execute function guard_milestone_billing_append()',name,name);end loop;end $$;
create trigger guarded_milestone_eligibility_events before insert on billing_eligibility_events for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function guard_milestone_billing_append();
create trigger guarded_milestone_unbilled_items before insert on approved_unbilled_items for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function guard_milestone_billing_append();

create function validate_milestone_billing_commit() returns trigger language plpgsql as $$
declare i milestone_billing_instances;p milestone_billing_policies;last milestone_billing_transitions;notice milestone_billing_notices;rec milestone_billing_recipients;event billing_eligibility_events;seq integer;stage_no integer;v_event_key text;state text;op text;actor uuid;actor_role text;audit_id uuid;expected_users uuid[];expected_reasons text[];who uuid;template jsonb;pref boolean;expected_channel text;
begin
 if tg_table_name='milestone_billing_instances' then i=new;seq=0;stage_no=0;v_event_key='approval.action_required';op=i.operation_id;actor=i.requester_user_id;actor_role=i.active_role;audit_id=i.id;
 else select * into i from milestone_billing_instances where id=new.instance_id;seq=new.sequence;op=new.operation_id;actor=new.actor_id;actor_role=new.active_role;audit_id=new.id;end if;
 select * into p from milestone_billing_policies where id=i.policy_id;select * into last from milestone_billing_transitions where instance_id=i.id order by sequence desc limit 1;
 if p.id is null or not milestone_billing_review_current(i) then raise exception 'Milestone source, owner or policy changed before commit.' using errcode='MBE04';end if;
 if tg_table_name='milestone_billing_transitions' and not milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,actor,actor_role,'decider') then raise exception 'Named approver lost authority before commit.' using errcode='MBE04';end if;
 state=case when last.id is null then 'Pending' when last.decision='Rejected' then 'Rejected' when last.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if tg_table_name='milestone_billing_transitions' then if new.decision='Rejected' then v_event_key='approval.rejected_or_correction_required';stage_no=new.stage;elsif new.sequence<jsonb_array_length(p.definition->'stages') then v_event_key='approval.action_required';stage_no=new.sequence;else v_event_key='approval.completed';stage_no=new.stage;end if;end if;
 if not exists(select 1 from approval_records a where a.entity_type='MilestoneBillingEligibilityApproval' and a.entity_id=i.id::text and a.status=state and a.comments is null and a.due_at is null) then raise exception 'Compatibility and protected decision must converge.' using errcode='MBE04';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=actor::text and a.active_role=actor_role and a.module='Milestone Billing Eligibility' and a.action=(case when tg_table_name='milestone_billing_instances' then 'Request Review' else 'Decide Review' end) and a.entity_id=audit_id::text and a.operation_id=op and a.new_value=jsonb_build_object('instanceId',i.id,'milestoneId',i.milestone_id)) then raise exception 'Review and redacted audit must commit together.' using errcode='MBE04';end if;
 if state='Approved' then
  select * into event from billing_eligibility_events where milestone_instance_id=i.id and milestone_decision_id=last.id and source_type='MILESTONE_ACCEPTANCE';
  if event.id is null or not exists(select 1 from approved_unbilled_items item where item.event_id=event.id and item.source_type=event.source_type and item.organization_id=i.organization_id and item.legal_entity_id=i.legal_entity_id) then raise exception 'Final approval requires one event and register item.' using errcode='MBE04';end if;
 elsif exists(select 1 from billing_eligibility_events where milestone_instance_id=i.id) then raise exception 'Pending or rejected decisions cannot create eligibility.' using errcode='MBE04';end if;
 select * into notice from milestone_billing_notices where instance_id=i.id and transition_sequence=seq and milestone_billing_notices.event_key=v_event_key;
 if v_event_key='approval.completed' and notice.id is null and exists(select 1 from milestone_billing_notice_failures where instance_id=i.id and transition_sequence=seq) then return null;end if;
 select value into template from jsonb_array_elements(p.definition->'templates') where value->>'key'=v_event_key;
 if notice.id is null or notice.stage<>stage_no or notice.policy_id<>p.id or notice.operation_id is distinct from op or notice.locale is distinct from p.definition->>'locale' or template is null or notice.title is distinct from replace(replace(template->>'subject','{{sourceRef}}','milestone/'||i.milestone_id),'{{stageNumber}}',(stage_no+1)::text) or notice.body is distinct from replace(replace(template->>'body','{{sourceRef}}','milestone/'||i.milestone_id),'{{stageNumber}}',(stage_no+1)::text) then raise exception 'One configured canonical notice is required.' using errcode='MBE04';end if;
 if v_event_key='approval.action_required' then expected_users=array[(p.definition->'stages'->stage_no->>'userId')::uuid];
 elsif v_event_key='approval.rejected_or_correction_required' then select array_agg(distinct x order by x) into expected_users from unnest(array[i.requester_user_id,i.owner_user_id])x;
 else expected_users=array[i.requester_user_id];end if;
 if (select array_agg(user_id order by user_id) from milestone_billing_recipients where event_id=notice.id) is distinct from expected_users then raise exception 'Every expected recipient must be recorded atomically.' using errcode='MBE04';end if;
 foreach who in array expected_users loop
  select * into rec from milestone_billing_recipients where event_id=notice.id and user_id=who;
  expected_reasons=case when v_event_key='approval.action_required' then array['current_stage_approver']::text[] when v_event_key='approval.completed' then array['requester']::text[] when who=i.requester_user_id and who=i.owner_user_id then array['commercial_change_owner','requester']::text[] when who=i.requester_user_id then array['requester']::text[] else array['commercial_change_owner']::text[] end;
  select n.in_app into pref from notification_preferences n join users u on u.employee_record_id=n.employee_id where u.id=who and n.event_type=v_event_key;
  expected_channel=case when v_event_key<>'approval.completed' then 'Required' when not (p.definition->>'completionInApp')::boolean then 'SuppressedPolicy' when pref=false then 'SuppressedPreference' else 'Enabled' end;
  if rec.reasons<>expected_reasons or rec.channel_decision<>expected_channel or rec.in_app<>(expected_channel in ('Required','Enabled')) or(rec.in_app and not exists(select 1 from milestone_billing_deliveries d where d.recipient_id=rec.id)) or(not rec.in_app and exists(select 1 from milestone_billing_deliveries d where d.recipient_id=rec.id)) then raise exception 'Recipient reasons and required delivery must match.' using errcode='MBE04';end if;
 end loop;return null;
end $$;
create constraint trigger complete_milestone_billing_instance after insert on milestone_billing_instances deferrable initially deferred for each row execute function validate_milestone_billing_commit();
create constraint trigger complete_milestone_billing_transition after insert on milestone_billing_transitions deferrable initially deferred for each row execute function validate_milestone_billing_commit();

create function validate_milestone_billing_policy_audit() returns trigger language plpgsql as $$begin
 if not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Milestone Billing Eligibility' and a.action='Configure Policy' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('policyId',new.id,'engagementId',new.engagement_id)) then raise exception 'Policy and redacted audit must commit together.' using errcode='MBE04';end if;return null;end $$;
create constraint trigger complete_milestone_billing_policy after insert on milestone_billing_policies deferrable initially deferred for each row execute function validate_milestone_billing_policy_audit();

create function validate_milestone_billing_invalidation_audit() returns trigger language plpgsql as $$
declare i milestone_billing_instances;begin
 select * into i from milestone_billing_instances where id=new.instance_id;
 if i.id is null or not milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'manager') or not exists(select 1 from approval_records a where a.entity_type='MilestoneBillingEligibilityApproval' and a.entity_id=i.id::text and a.status='Cancelled') or exists(select 1 from billing_eligibility_events where milestone_instance_id=i.id)
  or not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Milestone Billing Eligibility' and a.action='Cancel Review' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('instanceId',i.id,'milestoneId',i.milestone_id)) then raise exception 'Cancellation, compatibility and audit must commit together.' using errcode='MBE04';end if;return null;
end $$;
create constraint trigger complete_milestone_billing_invalidation after insert on milestone_billing_invalidations deferrable initially deferred for each row execute function validate_milestone_billing_invalidation_audit();

-- Once a pending owner's authority is lost, later restoration cannot silently
-- reactivate the original review. Historical events and decisions stay intact.
create function record_milestone_billing_owner_loss() returns trigger language plpgsql as $$begin
 insert into milestone_billing_owner_losses(instance_id,cause)
 select i.id,'current_owner_authority_lost' from milestone_billing_instances i join milestone_billing_policies p on p.id=i.policy_id
 where not milestone_billing_actor_valid(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role,'manager')
  and not exists(select 1 from milestone_billing_invalidations z where z.instance_id=i.id)
  and not exists(select 1 from milestone_billing_transitions t where t.instance_id=i.id and(t.decision='Rejected' or t.sequence=jsonb_array_length(p.definition->'stages')))
 on conflict(instance_id) do nothing;return null;
end $$;
create trigger guarded_milestone_owner_loss before insert on milestone_billing_owner_losses for each row execute function guard_commercial_owner_loss();
create constraint trigger milestone_owner_loss_users after update or delete on users deferrable initially deferred for each row execute function record_milestone_billing_owner_loss();
create constraint trigger milestone_owner_loss_roles after update or delete on roles deferrable initially deferred for each row execute function record_milestone_billing_owner_loss();
create constraint trigger milestone_owner_loss_user_roles after insert or update or delete on user_roles deferrable initially deferred for each row execute function record_milestone_billing_owner_loss();
create constraint trigger milestone_owner_loss_scopes after insert or update or delete on user_organization_scopes deferrable initially deferred for each row execute function record_milestone_billing_owner_loss();
create constraint trigger milestone_owner_loss_user_grants after insert or update or delete on user_permission_grants deferrable initially deferred for each row execute function record_milestone_billing_owner_loss();
create constraint trigger milestone_owner_loss_role_permissions after insert or update or delete on role_permissions deferrable initially deferred for each row execute function record_milestone_billing_owner_loss();

-- The generic compatibility projection is not an independent decision path.
create function guard_milestone_billing_compatibility() returns trigger language plpgsql as $$
declare ctx jsonb;i milestone_billing_instances;p milestone_billing_policies;t milestone_billing_transitions;expected text;begin
 if tg_op='DELETE' then if old.entity_type='MilestoneBillingEligibilityApproval' then raise exception 'Milestone review history cannot be deleted.' using errcode='MBE03';end if;return old;end if;
 if tg_op='UPDATE' and old.entity_type='MilestoneBillingEligibilityApproval' and(new.entity_type,new.entity_id) is distinct from(old.entity_type,old.entity_id) then raise exception 'Milestone review identity cannot change.' using errcode='MBE03';end if;
 if new.entity_type<>'MilestoneBillingEligibilityApproval' then return new;end if;
 begin ctx=nullif(current_setting('workos.milestone_billing_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from milestone_billing_instances where id::text=new.entity_id;select * into p from milestone_billing_policies where id=i.policy_id;select * into t from milestone_billing_transitions where instance_id=i.id order by sequence desc limit 1;
 expected=case when exists(select 1 from milestone_billing_invalidations where instance_id=i.id) then 'Cancelled' when t.id is null then 'Pending' when t.decision='Rejected' then 'Rejected' when t.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if i.id is null or ctx is null or i.id::text is distinct from ctx->>'instanceId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.status is distinct from expected or new.subject_employee_id is not null or new.comments is not null or new.due_at is not null then raise exception 'Milestone compatibility must follow its protected stage.' using errcode='MBE03';end if;return new;
end $$;
create trigger guarded_milestone_billing_compatibility before insert or update or delete on approval_records for each row execute function guard_milestone_billing_compatibility();
