-- Append-only, prospective billing decisions.
-- No role/user grants or buyer-specific policy are installed.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.tm_billing.view','Commercial','View T&M billing eligibility','View scoped T&M billing-safe approval and register evidence.',false),
 ('commercial.tm_billing.manage','Commercial','Manage T&M billing eligibility','Configure explicit review and request T&M eligibility in scope.',false),
 ('commercial.tm_billing.decide','Commercial','Decide T&M billing eligibility','Decide an explicitly assigned in-scope T&M eligibility stage.',false);

create function valid_tm_billing_eligibility_policy(d jsonb) returns boolean language plpgsql immutable as $$
begin
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','engagementId','stages','locale','templates','completionInApp']) or (select count(*) from jsonb_object_keys(d))<>6 or d->>'entityType' is distinct from 'TmBillingEligibility' or jsonb_typeof(d->'engagementId') is distinct from 'string' or length(btrim(d->>'engagementId')) not between 1 and 200 then return false;end if;
 if not valid_work_approval_definition((d-'engagementId')||jsonb_build_object('entityType','Timesheet','workerIds','[]'::jsonb)) then return false;end if;
 if exists(select 1 from jsonb_array_elements(d->'templates') t where regexp_replace(t->>'subject','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]' or regexp_replace(t->>'body','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]') then return false;end if;
 return true;
exception when others then return false;end $$;

create table tm_billing_eligibility_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,sequence int not null check(sequence>0),previous_id uuid references tm_billing_eligibility_policies(id),effective_from date not null,
 definition jsonb not null check(valid_tm_billing_eligibility_policy(definition)),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),unique(organization_id,legal_entity_id,engagement_id,sequence),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table tm_billing_eligibility_instances(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,snapshot_id uuid not null references commercial_tm_valuations(id),policy_id uuid not null references tm_billing_eligibility_policies(id),owner_user_id uuid not null references users(id),owner_role text not null,requester_user_id uuid not null references users(id),active_role text not null,
 request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),unique(organization_id,legal_entity_id,requester_user_id,request_id)
);
create index tm_billing_eligibility_snapshot_history on tm_billing_eligibility_instances(organization_id,legal_entity_id,snapshot_id,created_at,id);
create table tm_billing_eligibility_transitions(
 id uuid primary key,instance_id uuid not null references tm_billing_eligibility_instances(id),sequence int not null check(sequence between 1 and 10),stage int not null check(stage between 0 and 9),decision text not null check(decision in('Approved','Rejected')),
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(instance_id,sequence),unique(instance_id,request_id)
);
create table tm_billing_eligibility_invalidations(id uuid primary key,instance_id uuid not null unique references tm_billing_eligibility_instances(id),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(actor_id,request_id));

create table tm_billing_eligibility_notices(
 id text primary key,instance_id uuid not null references tm_billing_eligibility_instances(id),transition_sequence int not null check(transition_sequence between 0 and 10),stage int not null check(stage between 0 and 9),event_key text not null check(event_key in('approval.action_required','approval.rejected_or_correction_required','approval.completed')),
 policy_class text not null check(policy_class in('ACTION_REQUIRED','INFORMATIONAL')),policy_id uuid not null references tm_billing_eligibility_policies(id),operation_id text not null,locale text not null,title text not null check(work_period_notice_units(title) between 1 and 1200),body text not null check(work_period_notice_units(body) between 1 and 12000),created_at timestamptz not null default clock_timestamp(),
 unique(instance_id,transition_sequence,event_key),check((event_key in('approval.action_required','approval.rejected_or_correction_required') and policy_class='ACTION_REQUIRED') or(event_key='approval.completed' and policy_class='INFORMATIONAL'))
);
create table tm_billing_eligibility_recipients(id uuid primary key,event_id text not null references tm_billing_eligibility_notices(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons) between 1 and 4 and reasons<@array['requester','commercial_change_owner','affected_worker','current_stage_approver']::text[]),in_app boolean not null,channel_decision text not null check(channel_decision in('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id));
create table tm_billing_eligibility_deliveries(id uuid primary key,recipient_id uuid not null unique references tm_billing_eligibility_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt int not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table tm_billing_eligibility_reads(recipient_id uuid primary key references tm_billing_eligibility_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
create table tm_billing_eligibility_notice_failures(id uuid primary key,instance_id uuid not null references tm_billing_eligibility_instances(id),transition_sequence int not null,code text not null check(code='INFORMATIONAL_NOTIFICATION_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence));

-- One immutable event and register item per current T&M source snapshot. No batch
-- line, current occupancy, reversal or supersession operation is introduced here.
create table billing_eligibility_events(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,client_id text not null,contract_id text not null,engagement_id text not null,source_type text not null check(source_type='TM_SNAPSHOT'),snapshot_id uuid not null references commercial_tm_valuations(id),instance_id uuid not null references tm_billing_eligibility_instances(id),decision_id uuid not null references tm_billing_eligibility_transitions(id),version int not null check(version=1),eligible_on date not null,currency text not null check(currency~'^[A-Z]{3}$'),amount numeric(20,4) not null check(amount>0),
 billing_evidence jsonb not null,actor_id uuid not null references users(id),active_role text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(snapshot_id),unique(instance_id),unique(decision_id),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),foreign key(organization_id,legal_entity_id,contract_id) references commercial_contracts(organization_id,legal_entity_id,id),foreign key(organization_id,legal_entity_id,client_id) references clients(organization_id,legal_entity_id,id)
);
create table approved_unbilled_items(id uuid primary key,event_id uuid not null unique references billing_eligibility_events(id),organization_id text not null,legal_entity_id text not null,version int not null check(version=1),created_at timestamptz not null default clock_timestamp());
do $$declare t text;begin foreach t in array array['tm_billing_eligibility_policies','tm_billing_eligibility_instances','tm_billing_eligibility_transitions','tm_billing_eligibility_invalidations','tm_billing_eligibility_notices','tm_billing_eligibility_recipients','tm_billing_eligibility_deliveries','tm_billing_eligibility_reads','tm_billing_eligibility_notice_failures','billing_eligibility_events','approved_unbilled_items'] loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;

create function tm_billing_actor_valid(org text,legal text,who uuid,role_name text,actor_kind text) returns boolean language plpgsql stable as $$
declare k text; keys text[];begin
 if actor_kind not in('manager','decider','viewer') or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id=who and u.status='Active' and r.name=role_name and s.organization_id=org and s.legal_entity_id=legal and s.active) then return false;end if;
 keys=array['commercial.contracts.view','commercial.tm_billing.view','employees.view','notifications.view'];
 if actor_kind='manager' then keys=keys||array['commercial.contracts.manage','commercial.tm_billing.manage'];elsif actor_kind='decider' then keys=keys||array['approvals.view','commercial.tm_billing.decide'];end if;
 foreach k in array keys loop
  if not exists(select 1 from role_permissions rp where rp.role_name=tm_billing_actor_valid.role_name and rp.permission_key=k and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=k) then return false;end if;
 end loop;return true;
end $$;

-- Observes only retained sources. The approval itself is separate and cannot be
-- inferred from a current work or commercial snapshot.
create function tm_billing_source_valid(org text,legal text,eng text,snapshot uuid) returns boolean language sql stable as $$
 select exists(select 1 from commercial_tm_valuations v
  join commercial_engagements e on e.organization_id=v.organization_id and e.legal_entity_id=v.legal_entity_id and e.id=v.engagement_id
  join work_submission_evidence s on s.id=v.submission_id and s.organization_id=v.organization_id and s.legal_entity_id=v.legal_entity_id
  join work_submission_decisions d on d.id=v.decision_id and d.submission_id=s.id and d.status='Approved'
  join timesheets h on h.id=s.timesheet_id and h.organization_id=v.organization_id and h.legal_entity_id=v.legal_entity_id
  join timesheet_entries x on x.id=v.entry_id and x.timesheet_id=h.id
  join commercial_tm_policy_versions p on p.id=v.policy_id and p.organization_id=v.organization_id and p.legal_entity_id=v.legal_entity_id and p.engagement_id=v.engagement_id
  where v.id=snapshot and v.organization_id=org and v.legal_entity_id=legal and v.engagement_id=eng and e.origin='manual' and e.model='time_and_materials' and e.billable and e.client_id is not null and e.contract_id is not null
   and h.status='Approved' and s.id=(select latest.id from work_submission_evidence latest where latest.organization_id=v.organization_id and latest.legal_entity_id=v.legal_entity_id and latest.timesheet_id=h.id order by latest.sequence desc limit 1) and x.hours>0 and x.billable and v.result->>'version'='governed-tm/1' and v.result->>'unit'='HOUR' and v.result->>'currency'=e.currency
   and (v.result->>'billableValue') ~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,4})?$' and (v.result->>'billableValue')::numeric>0
   and v.source_evidence->>'submissionId'=v.submission_id and v.source_evidence->>'decisionId'=v.decision_id and v.source_evidence->>'entryId'=v.entry_id::text and v.source_evidence->>'policyId'=v.policy_id::text and v.source_evidence->>'billingAdoptionId'=v.billing_adoption_id::text
   and exists(select 1 from jsonb_array_elements(s.entries) a where a->>'entryId'=x.id::text and a->>'kind'='governed' and a->>'projectId'=x.project_id and a->>'workDate'=to_char(x.work_date,'YYYY-MM-DD') and (a->>'hours')::numeric=x.hours and (a->>'billable')::boolean)
 )
$$;

-- All writable tables remain unavailable until the following command guards,
-- canonical inbox and commit-time cross-record validation are installed.
create function tm_billing_worker_visible(org text,legal text,snapshot uuid,who uuid,role_name text) returns boolean language sql stable as $$
 select coalesce((select rate_candidate_worker_visible(jsonb_build_object('organizationId',org,'legalEntityId',legal,'actorId',who,'activeRole',role_name),h.employee_id) from commercial_tm_valuations v join work_submission_evidence s on s.id=v.submission_id join timesheets h on h.id=s.timesheet_id where v.id=snapshot and v.organization_id=org and v.legal_entity_id=legal),false)
$$;

-- Lock the same existing scoped-worker witness used by cost-source controls;
-- this is an internal relationship check and exposes no cost value.
create function lock_tm_billing_worker_witness(org text,legal text,snapshot uuid,who uuid,role_name text) returns void language plpgsql as $$
declare c commercial_rate_candidates;begin
 select candidate.* into c from commercial_tm_valuations v join commercial_rate_adoptions a on a.id=v.cost_adoption_id and a.organization_id=v.organization_id and a.legal_entity_id=v.legal_entity_id join commercial_rate_candidates candidate on candidate.id=a.candidate_id and candidate.organization_id=a.organization_id and candidate.legal_entity_id=a.legal_entity_id where v.id=snapshot and v.organization_id=org and v.legal_entity_id=legal;
 if c.id is null or c.kind<>'cost' or c.binding_type<>'worker' then raise exception 'Scoped worker witness unavailable.' using errcode='TBE02';end if;
 perform lock_commercial_candidate_worker_witness(c,who,role_name);
end $$;

-- An owner who loses authority cannot revive an earlier pending review merely
-- by regaining it. Evidence is append-only and populated by scope changes only.
create table commercial_candidate_owner_losses(instance_id uuid primary key references commercial_candidate_approval_instances(id),cause text not null,detected_at timestamptz not null default clock_timestamp());
create table tm_billing_owner_losses(instance_id uuid primary key references tm_billing_eligibility_instances(id),cause text not null,detected_at timestamptz not null default clock_timestamp());
-- Pre-upgrade unadopted reviews have no retained authority-change history.
-- Preserve their decisions, but require a fresh review before any future action.
insert into commercial_candidate_owner_losses(instance_id,cause)
select i.id,'authority_history_unavailable_at_upgrade' from commercial_candidate_approval_instances i
where not exists(select 1 from commercial_candidate_approval_invalidations z where z.instance_id=i.id)
 and not exists(select 1 from commercial_candidate_approval_transitions t where t.instance_id=i.id and t.decision='Rejected')
 and not exists(select 1 from commercial_rate_adoptions a where a.approval_id=i.id);
create trigger immutable_commercial_owner_loss before update or delete on commercial_candidate_owner_losses for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_tm_billing_owner_loss before update or delete on tm_billing_owner_losses for each row execute function reject_commercial_draft_rewrite();
create function guard_commercial_owner_loss() returns trigger language plpgsql as $$begin if pg_trigger_depth()<2 then raise exception 'Owner-loss evidence is recorded only by scoped authority changes.' using errcode='TBE01';end if;return new;end $$;
create trigger guarded_commercial_owner_loss before insert on commercial_candidate_owner_losses for each row execute function guard_commercial_owner_loss();
create trigger guarded_tm_billing_owner_loss before insert on tm_billing_owner_losses for each row execute function guard_commercial_owner_loss();

create function tm_billing_review_current(i tm_billing_eligibility_instances) returns boolean language sql stable as $$
 select coalesce(tm_billing_source_valid(i.organization_id,i.legal_entity_id,i.engagement_id,i.snapshot_id),false)
  and exists(select 1 from tm_billing_eligibility_policies p where p.id=i.policy_id and p.organization_id=i.organization_id and p.legal_entity_id=i.legal_entity_id and p.engagement_id=i.engagement_id and p.effective_from<=(clock_timestamp() at time zone 'UTC')::date
   and p.id=(select q.id from tm_billing_eligibility_policies q where q.organization_id=i.organization_id and q.legal_entity_id=i.legal_entity_id and q.engagement_id=i.engagement_id and q.effective_from<=(clock_timestamp() at time zone 'UTC')::date order by q.sequence desc limit 1))
  and tm_billing_actor_valid(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role,'manager')
  and tm_billing_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'manager')
  and tm_billing_worker_visible(i.organization_id,i.legal_entity_id,i.snapshot_id,i.owner_user_id,i.owner_role)
  and tm_billing_worker_visible(i.organization_id,i.legal_entity_id,i.snapshot_id,i.requester_user_id,i.active_role)
  and not exists(select 1 from tm_billing_eligibility_invalidations x where x.instance_id=i.id)
  and not exists(select 1 from tm_billing_owner_losses x where x.instance_id=i.id)
$$;

create function guard_tm_billing_eligibility_append() returns trigger language plpgsql as $$
declare ctx jsonb;i tm_billing_eligibility_instances;p tm_billing_eligibility_policies;prior tm_billing_eligibility_policies;t tm_billing_eligibility_transitions;v commercial_tm_valuations;e commercial_engagements;source_worker text;worker_user uuid;stage_def jsonb;n int;evt billing_eligibility_events;expected jsonb;
begin
 begin ctx=nullif(current_setting('workos.tm_billing_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id where u.id::text=ctx->>'actorId' and u.status='Active' and r.name=ctx->>'activeRole' and sc.organization_id=ctx->>'organizationId' and sc.legal_entity_id=ctx->>'legalEntityId' and sc.active) then raise exception 'Use the authenticated scoped T&M billing command.' using errcode='TBE01';end if;
 if tg_table_name='tm_billing_eligibility_policies' then
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
  perform pg_advisory_xact_lock(hashtext('tm-billing-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));
  select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
  select * into prior from tm_billing_eligibility_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
  if new.id::text is distinct from ctx->>'eventId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not tm_billing_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or e.id is null or e.origin<>'manual' or e.model<>'time_and_materials' or not e.billable or new.definition->>'engagementId' is distinct from e.id or new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date or(prior.id is not null and new.effective_from<prior.effective_from) then raise exception 'Explicit current scoped eligibility policy required.' using errcode='TBE01';end if;
  for stage_def in select value from jsonb_array_elements(new.definition->'stages') loop perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');if not tm_billing_actor_valid(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role','decider') then raise exception 'Each named approver needs current separate eligibility authority.' using errcode='TBE01';end if;end loop;return new;
 elsif tg_table_name='tm_billing_eligibility_instances' then
  perform pg_advisory_xact_lock(hashtext('tm-billing-source:'||new.organization_id||':'||new.legal_entity_id||':'||new.snapshot_id::text));perform pg_advisory_xact_lock(hashtext('tm-billing-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role);
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role);
  select * into p from tm_billing_eligibility_policies where id=new.policy_id;select * into v from commercial_tm_valuations where id=new.snapshot_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id;
  if v.id is not null then perform lock_tm_billing_worker_witness(new.organization_id,new.legal_entity_id,new.snapshot_id,new.requester_user_id,new.active_role);perform lock_tm_billing_worker_witness(new.organization_id,new.legal_entity_id,new.snapshot_id,new.owner_user_id,new.owner_role);perform 1 from timesheets h join work_submission_evidence s on s.timesheet_id=h.id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where s.id=v.submission_id for share of h,te;end if;
  if new.id::text is distinct from ctx->>'instanceId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.requester_user_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not tm_billing_actor_valid(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role,'manager') or not tm_billing_review_current(new) or exists(select 1 from billing_eligibility_events where snapshot_id=new.snapshot_id) then raise exception 'The exact current scoped snapshot and policy are required.' using errcode='TBE02';end if;
  select h.employee_id into source_worker from timesheets h join work_submission_evidence s on s.timesheet_id=h.id where s.id=v.submission_id;
  if(select count(*) from users u join user_organization_scopes sc on sc.user_id=u.id where u.employee_record_id=source_worker and u.status='Active' and sc.organization_id=new.organization_id and sc.legal_entity_id=new.legal_entity_id and sc.active)<>1 then raise exception 'Affected worker account unavailable.' using errcode='TBE02';end if;
  select u.id into worker_user from users u join user_organization_scopes sc on sc.user_id=u.id where u.employee_record_id=source_worker and u.status='Active' and sc.organization_id=new.organization_id and sc.legal_entity_id=new.legal_entity_id and sc.active;
  for stage_def in select value from jsonb_array_elements(p.definition->'stages') loop perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');perform lock_tm_billing_worker_witness(new.organization_id,new.legal_entity_id,new.snapshot_id,(stage_def->>'userId')::uuid,stage_def->>'role');if (stage_def->>'userId')::uuid in(new.requester_user_id,worker_user) or not tm_billing_worker_visible(new.organization_id,new.legal_entity_id,new.snapshot_id,(stage_def->>'userId')::uuid,stage_def->>'role') or not tm_billing_actor_valid(new.organization_id,new.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role','decider') then raise exception 'Each named approver must be independent and currently authorized.' using errcode='TBE02';end if;end loop;
  if exists(select 1 from tm_billing_eligibility_instances x where x.organization_id=new.organization_id and x.legal_entity_id=new.legal_entity_id and x.snapshot_id=new.snapshot_id and not exists(select 1 from tm_billing_eligibility_invalidations z where z.instance_id=x.id) and not exists(select 1 from tm_billing_eligibility_transitions q join tm_billing_eligibility_policies pol on pol.id=x.policy_id where q.instance_id=x.id and(q.decision='Rejected' or q.sequence=jsonb_array_length(pol.definition->'stages')))) then raise exception 'A current snapshot review is already pending.' using errcode='TBE02';end if;return new;
 elsif tg_table_name='tm_billing_eligibility_reads' then
  if new.user_id::text is distinct from ctx->>'actorId' or not exists(select 1 from tm_billing_eligibility_recipients r join tm_billing_eligibility_notices ev on ev.id=r.event_id join tm_billing_eligibility_instances x on x.id=ev.instance_id where r.id=new.recipient_id and r.user_id=new.user_id and r.in_app and x.organization_id=ctx->>'organizationId' and x.legal_entity_id=ctx->>'legalEntityId') then raise exception 'Only the owned recipient can acknowledge.' using errcode='TBE01';end if;return new;
 elsif tg_table_name='tm_billing_eligibility_deliveries' then select x.* into i from tm_billing_eligibility_instances x join tm_billing_eligibility_notices ev on ev.instance_id=x.id join tm_billing_eligibility_recipients r on r.event_id=ev.id where r.id=new.recipient_id and r.in_app;
 elsif tg_table_name='tm_billing_eligibility_recipients' then select x.* into i from tm_billing_eligibility_instances x join tm_billing_eligibility_notices ev on ev.instance_id=x.id where ev.id=new.event_id;
 elsif tg_table_name='approved_unbilled_items' then select * into evt from billing_eligibility_events where id=new.event_id;select * into i from tm_billing_eligibility_instances where id=evt.instance_id;
 else select * into i from tm_billing_eligibility_instances where id=new.instance_id;end if;
 if i.id is null or i.id::text is distinct from ctx->>'instanceId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' then raise exception 'Scoped eligibility review is unavailable.' using errcode='TBE01';end if;
 if tg_table_name='tm_billing_eligibility_invalidations' then
  perform pg_advisory_xact_lock(hashtext('tm-billing-source:'||i.organization_id||':'||i.legal_entity_id||':'||i.snapshot_id::text));perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,i.snapshot_id,new.actor_id,new.active_role);
  select * into p from tm_billing_eligibility_policies where id=i.policy_id;select * into t from tm_billing_eligibility_transitions where instance_id=i.id order by sequence desc limit 1;
  if new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not tm_billing_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'manager') or not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,i.snapshot_id,new.actor_id,new.active_role) or t.decision='Rejected' or coalesce(t.sequence,0)>=jsonb_array_length(p.definition->'stages') then raise exception 'Only an authorized pending review may be invalidated.' using errcode='TBE02';end if;return new;
 elsif tg_table_name='tm_billing_eligibility_transitions' then
  perform pg_advisory_xact_lock(hashtext('tm-billing-source:'||i.organization_id||':'||i.legal_entity_id||':'||i.snapshot_id::text));perform pg_advisory_xact_lock(hashtext('tm-billing-policy:'||i.organization_id||':'||i.legal_entity_id||':'||i.engagement_id));perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role);
  select * into v from commercial_tm_valuations where id=i.snapshot_id;perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,i.snapshot_id,new.actor_id,new.active_role);perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,i.snapshot_id,i.requester_user_id,i.active_role);perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,i.snapshot_id,i.owner_user_id,i.owner_role);perform 1 from timesheets h join work_submission_evidence s on s.timesheet_id=h.id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where s.id=v.submission_id for share of h,te;
  select * into p from tm_billing_eligibility_policies where id=i.policy_id;select * into t from tm_billing_eligibility_transitions where instance_id=i.id order by sequence desc limit 1;n=coalesce(t.sequence,0);
  if new.decision='Approved' and n+1<jsonb_array_length(p.definition->'stages') then stage_def=p.definition->'stages'->(n+1);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,(stage_def->>'userId')::uuid,stage_def->>'role');perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,i.snapshot_id,(stage_def->>'userId')::uuid,stage_def->>'role');end if;
  select h.employee_id into source_worker from timesheets h join work_submission_evidence s on s.timesheet_id=h.id where s.id=v.submission_id;select u.id into worker_user from users u join user_organization_scopes sc on sc.user_id=u.id where u.employee_record_id=source_worker and u.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active order by u.id limit 1;
  if not tm_billing_review_current(i) or not tm_billing_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'manager') or t.decision='Rejected' or n>=jsonb_array_length(p.definition->'stages') or new.sequence<>n+1 or new.stage<>n or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.actor_id in(i.requester_user_id,worker_user) or new.actor_id::text is distinct from p.definition->'stages'->n->>'userId' or new.active_role is distinct from p.definition->'stages'->n->>'role' or not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,i.snapshot_id,new.actor_id,new.active_role) or not tm_billing_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'decider') then raise exception 'A current independent named decision is required.' using errcode='TBE02';end if;return new;
 elsif tg_table_name='billing_eligibility_events' then
  select * into p from tm_billing_eligibility_policies where id=i.policy_id;select * into t from tm_billing_eligibility_transitions where id=new.decision_id and instance_id=i.id;select * into v from commercial_tm_valuations where id=i.snapshot_id;select * into e from commercial_engagements where id=i.engagement_id and organization_id=i.organization_id and legal_entity_id=i.legal_entity_id;
  expected=jsonb_build_object('snapshotId',v.id,'engagementId',v.engagement_id,'policyId',v.policy_id,'submissionId',v.submission_id,'decisionId',v.decision_id,'entryId',v.entry_id,'billingAdoptionId',v.billing_adoption_id,'projectId',v.source_evidence->>'projectId','bindingId',v.source_evidence->>'bindingId','workDate',v.source_evidence->>'workDate','references',(select jsonb_agg(jsonb_build_object('entityType',ref->>'entityType','entityId',ref->>'entityId','lifecycleEventId',ref->>'lifecycleEventId','contractVersionId',ref->>'contractVersionId') order by ordinal) from jsonb_array_elements(v.source_evidence->'references') with ordinality q(ref,ordinal)),'currency',v.result->>'currency','amount',v.result->>'billableValue');
  if not tm_billing_review_current(i) or t.id is null or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or new.id::text is distinct from ctx->>'eventId' or new.organization_id<>i.organization_id or new.legal_entity_id<>i.legal_entity_id or new.engagement_id<>i.engagement_id or new.snapshot_id<>i.snapshot_id or new.client_id<>e.client_id or new.contract_id<>e.contract_id or new.currency<>v.result->>'currency' or new.amount<>(v.result->>'billableValue')::numeric or new.eligible_on<>(new.created_at at time zone 'UTC')::date or new.billing_evidence is distinct from expected or new.actor_id<>t.actor_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role<>t.active_role or new.active_role is distinct from ctx->>'activeRole' or new.operation_id<>t.operation_id or new.operation_id is distinct from ctx->>'operationId' then raise exception 'Only the exact final decision can create source-bound eligibility.' using errcode='TBE03';end if;return new;
 elsif tg_table_name='approved_unbilled_items' then
  if evt.id is null or new.organization_id<>evt.organization_id or new.legal_entity_id<>evt.legal_entity_id or new.id::text is distinct from ctx->>'itemId' then raise exception 'A single scoped event item is required.' using errcode='TBE03';end if;return new;
 end if;return new;
end $$;
do $$declare t text;begin foreach t in array array['tm_billing_eligibility_policies','tm_billing_eligibility_instances','tm_billing_eligibility_transitions','tm_billing_eligibility_invalidations','tm_billing_eligibility_notices','tm_billing_eligibility_recipients','tm_billing_eligibility_deliveries','tm_billing_eligibility_reads','tm_billing_eligibility_notice_failures','billing_eligibility_events','approved_unbilled_items'] loop execute format('create trigger guarded_%I before insert on %I for each row execute function guard_tm_billing_eligibility_append()',t,t);end loop;end $$;

-- The generic compatibility record never provides a second write authority.
create function guard_tm_billing_compatibility() returns trigger language plpgsql as $$
declare ctx jsonb;i tm_billing_eligibility_instances;p tm_billing_eligibility_policies;t tm_billing_eligibility_transitions;v commercial_tm_valuations;worker_id text;expected text;begin
 if tg_op='DELETE' then if old.entity_type='TmBillingEligibilityApproval' then raise exception 'T&M eligibility history cannot be deleted.' using errcode='TBE03';end if;return old;end if;
 if tg_op='UPDATE' and old.entity_type='TmBillingEligibilityApproval' and (new.entity_type,new.entity_id) is distinct from (old.entity_type,old.entity_id) then raise exception 'Eligibility approval identity cannot change.' using errcode='TBE03';end if;
 if new.entity_type<>'TmBillingEligibilityApproval' then return new;end if;
 begin ctx=nullif(current_setting('workos.tm_billing_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from tm_billing_eligibility_instances where id::text=new.entity_id;select * into p from tm_billing_eligibility_policies where id=i.policy_id;select * into t from tm_billing_eligibility_transitions where instance_id=i.id order by sequence desc limit 1;select * into v from commercial_tm_valuations where id=i.snapshot_id;
 select h.employee_id into worker_id from timesheets h join work_submission_evidence s on s.timesheet_id=h.id where s.id=v.submission_id;
 expected=case when exists(select 1 from tm_billing_eligibility_invalidations where instance_id=i.id) then 'Cancelled' when t.id is null then 'Pending' when t.decision='Rejected' then 'Rejected' when t.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if i.id is null or ctx is null or i.id::text is distinct from ctx->>'instanceId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.status is distinct from expected or new.subject_employee_id is distinct from worker_id or new.comments is not null or new.due_at is not null then raise exception 'Eligibility compatibility must follow its protected stage.' using errcode='TBE03';end if;return new;
end $$;
create trigger guarded_tm_billing_compatibility before insert or update or delete on approval_records for each row execute function guard_tm_billing_compatibility();

-- Pending/intermediate work never creates billing authority; final approval,
-- source-bound event and one register item must be present in one commit.
create function validate_tm_billing_review_commit() returns trigger language plpgsql as $$
declare i tm_billing_eligibility_instances;p tm_billing_eligibility_policies;v commercial_tm_valuations;last tm_billing_eligibility_transitions;ev tm_billing_eligibility_notices;rec tm_billing_eligibility_recipients;evt billing_eligibility_events;seq int;stage_no int;v_event_key text;approval_status text;worker_id text;worker_user uuid;expected_users uuid[];expected_reasons text[];u uuid;tmpl jsonb;op text;review_actor uuid;review_role text;audit_entity uuid;
begin
 if tg_table_name='tm_billing_eligibility_instances' then i=new;seq=0;stage_no=0;v_event_key='approval.action_required';op=i.operation_id;review_actor=i.requester_user_id;review_role=i.active_role;audit_entity=i.id;else select * into i from tm_billing_eligibility_instances where id=new.instance_id;seq=new.sequence;op=new.operation_id;review_actor=new.actor_id;review_role=new.active_role;audit_entity=new.id;end if;
 select * into p from tm_billing_eligibility_policies where id=i.policy_id;select * into v from commercial_tm_valuations where id=i.snapshot_id;select * into last from tm_billing_eligibility_transitions where instance_id=i.id order by sequence desc limit 1;
 if p.id is null or v.id is null or not tm_billing_review_current(i) then raise exception 'Billing source, owner or policy changed before commit.' using errcode='TBE04';end if;
 if tg_table_name='tm_billing_eligibility_transitions' and (not tm_billing_actor_valid(i.organization_id,i.legal_entity_id,review_actor,review_role,'decider') or not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,i.snapshot_id,review_actor,review_role)) then raise exception 'The named decider lost current scope before commit.' using errcode='TBE04';end if;
 approval_status=case when last.id is null then 'Pending' when last.decision='Rejected' then 'Rejected' when last.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if tg_table_name='tm_billing_eligibility_transitions' then if new.decision='Rejected' then v_event_key='approval.rejected_or_correction_required';stage_no=new.stage;elsif new.sequence<jsonb_array_length(p.definition->'stages') then v_event_key='approval.action_required';stage_no=new.sequence;else v_event_key='approval.completed';stage_no=new.stage;end if;end if;
 if not exists(select 1 from approval_records a where a.entity_type='TmBillingEligibilityApproval' and a.entity_id=i.id::text and a.status=approval_status and a.comments is null and a.due_at is null) then raise exception 'Generic approval and protected decision must converge.' using errcode='TBE04';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=review_actor::text and a.active_role=review_role and a.module='T&M Billing Eligibility' and a.action=(case when tg_table_name='tm_billing_eligibility_instances' then 'Request Review' else 'Decide Review' end) and a.entity_id=audit_entity::text and a.operation_id=op and a.new_value=jsonb_build_object('instanceId',i.id,'snapshotId',i.snapshot_id)) then raise exception 'Review and redacted audit must commit together.' using errcode='TBE04';end if;
 if approval_status='Approved' then
  select * into evt from billing_eligibility_events where instance_id=i.id and decision_id=last.id and snapshot_id=i.snapshot_id;
  if evt.id is null or not exists(select 1 from approved_unbilled_items item where item.event_id=evt.id and item.organization_id=i.organization_id and item.legal_entity_id=i.legal_entity_id) then raise exception 'Final approval requires one event and register item.' using errcode='TBE04';end if;
 elsif exists(select 1 from billing_eligibility_events where instance_id=i.id) then raise exception 'Pending or rejected decisions cannot create eligibility.' using errcode='TBE04';end if;
 select * into ev from tm_billing_eligibility_notices where instance_id=i.id and transition_sequence=seq and tm_billing_eligibility_notices.event_key=v_event_key;
 if v_event_key='approval.completed' and ev.id is null and exists(select 1 from tm_billing_eligibility_notice_failures where instance_id=i.id and transition_sequence=seq) then return null;end if;
 select x into tmpl from jsonb_array_elements(p.definition->'templates') x where x->>'key'=v_event_key;
 if ev.id is null or ev.stage<>stage_no or ev.policy_id<>p.id or ev.operation_id is distinct from op or ev.locale is distinct from p.definition->>'locale' or tmpl is null or ev.title is distinct from replace(replace(tmpl->>'subject','{{sourceRef}}','tm-eligibility/'||i.snapshot_id::text),'{{stageNumber}}',(stage_no+1)::text) or ev.body is distinct from replace(replace(tmpl->>'body','{{sourceRef}}','tm-eligibility/'||i.snapshot_id::text),'{{stageNumber}}',(stage_no+1)::text) or(select count(*) from tm_billing_eligibility_notices where instance_id=i.id and transition_sequence=seq)<>1 then raise exception 'One canonical sanitized stage event is required.' using errcode='TBE04';end if;
 if v_event_key='approval.action_required' then expected_users=array[(p.definition->'stages'->stage_no->>'userId')::uuid];
 else
  select h.employee_id into worker_id from timesheets h join work_submission_evidence s on s.timesheet_id=h.id where s.id=v.submission_id;
  if(select count(*) from users usr join user_organization_scopes sc on sc.user_id=usr.id where usr.employee_record_id=worker_id and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active)<>1 then raise exception 'Affected worker account unavailable.' using errcode='TBE04';end if;
  select usr.id into worker_user from users usr join user_organization_scopes sc on sc.user_id=usr.id where usr.employee_record_id=worker_id and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active;
  select array_agg(distinct x) into expected_users from unnest(case when v_event_key='approval.rejected_or_correction_required' then array[i.requester_user_id,i.owner_user_id,worker_user] else array[i.requester_user_id,worker_user] end)x where x is not null;
 end if;
 if(select count(*) from tm_billing_eligibility_recipients where event_id=ev.id)<>cardinality(expected_users) then raise exception 'The complete canonical recipient set is required.' using errcode='TBE04';end if;
 foreach u in array expected_users loop
  if not exists(select 1 from users usr join user_organization_scopes sc on sc.user_id=usr.id join user_roles ur on ur.user_id=usr.id join roles role on role.id=ur.role_id where usr.id=u and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='notifications.view')) and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='employees.view'))) then raise exception 'Required notification recipient is unavailable.' using errcode='TBE04';end if;
  if v_event_key='approval.action_required' and (not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,i.snapshot_id,u,p.definition->'stages'->stage_no->>'role') or not tm_billing_actor_valid(i.organization_id,i.legal_entity_id,u,p.definition->'stages'->stage_no->>'role','decider')) then raise exception 'Current-stage approver is unavailable.' using errcode='TBE04';end if;
  select * into rec from tm_billing_eligibility_recipients where event_id=ev.id and user_id=u;
  select array_agg(reason order by reason) into expected_reasons from(select 'current_stage_approver' reason where v_event_key='approval.action_required' union all select 'requester' where v_event_key<>'approval.action_required' and u=i.requester_user_id union all select 'commercial_change_owner' where v_event_key='approval.rejected_or_correction_required' and u=i.owner_user_id union all select 'affected_worker' where v_event_key<>'approval.action_required' and u=worker_user) q;
  if rec.id is null or(select array_agg(x order by x) from unnest(rec.reasons)x) is distinct from expected_reasons then raise exception 'Mandatory recipient reasons must be exact.' using errcode='TBE04';end if;
  if(v_event_key<>'approval.completed' and(not rec.in_app or rec.channel_decision<>'Required')) or(rec.in_app and not exists(select 1 from tm_billing_eligibility_deliveries d where d.recipient_id=rec.id and d.channel='InApp' and d.status='Delivered')) then raise exception 'Each required in-app recipient must commit.' using errcode='TBE04';end if;
 end loop;return null;
end $$;
create constraint trigger complete_tm_billing_review_instance after insert on tm_billing_eligibility_instances deferrable initially deferred for each row execute function validate_tm_billing_review_commit();
create constraint trigger complete_tm_billing_review_transition after insert on tm_billing_eligibility_transitions deferrable initially deferred for each row execute function validate_tm_billing_review_commit();

create function complete_tm_billing_policy() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='T&M Billing Eligibility' and a.action='Configure Policy' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('policyId',new.id,'engagementId',new.engagement_id)) then raise exception 'Prospective policy and redacted audit must commit together.' using errcode='TBE04';end if;return null;
end $$;
create constraint trigger complete_tm_billing_policy after insert on tm_billing_eligibility_policies deferrable initially deferred for each row execute function complete_tm_billing_policy();
create function complete_tm_billing_invalidation() returns trigger language plpgsql as $$
declare i tm_billing_eligibility_instances;begin
 select * into i from tm_billing_eligibility_instances where id=new.instance_id;
 if not exists(select 1 from approval_records where entity_type='TmBillingEligibilityApproval' and entity_id=i.id::text and status='Cancelled') or not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='T&M Billing Eligibility' and a.action='Cancel Review' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('cancellationId',new.id,'instanceId',i.id)) then raise exception 'Review invalidation and redacted audit must commit together.' using errcode='TBE04';end if;return null;
end $$;
create constraint trigger complete_tm_billing_invalidation after insert on tm_billing_eligibility_invalidations deferrable initially deferred for each row execute function complete_tm_billing_invalidation();

-- Canonical events and recipient rows are permitted only for their exact
-- protected source transition; they cannot be appended as a second route.
create function guard_tm_billing_notice_authority() returns trigger language plpgsql as $$
declare ctx jsonb;i tm_billing_eligibility_instances;p tm_billing_eligibility_policies;t tm_billing_eligibility_transitions;ev tm_billing_eligibility_notices;rec tm_billing_eligibility_recipients;v commercial_tm_valuations;worker_id text;worker_user uuid;expected_key text;expected_stage int;expected_op text;expected_actor uuid;expected_role text;expected_reasons text[];tmpl jsonb;pref boolean;expected_channel text;recipient_role text;
begin
 begin ctx=nullif(current_setting('workos.tm_billing_context',true),'')::jsonb;exception when others then ctx=null;end;
 if tg_table_name='tm_billing_eligibility_notices' then select * into i from tm_billing_eligibility_instances where id=new.instance_id;
 elsif tg_table_name='tm_billing_eligibility_notice_failures' then select * into i from tm_billing_eligibility_instances where id=new.instance_id;
 elsif tg_table_name='tm_billing_eligibility_recipients' then select * into ev from tm_billing_eligibility_notices where id=new.event_id;select * into i from tm_billing_eligibility_instances where id=ev.instance_id;
 else select * into rec from tm_billing_eligibility_recipients where id=new.recipient_id;select * into ev from tm_billing_eligibility_notices where id=rec.event_id;select * into i from tm_billing_eligibility_instances where id=ev.instance_id;end if;
 if i.id is null or ctx is null or i.id::text is distinct from ctx->>'instanceId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' then raise exception 'Owned scoped eligibility stage required.' using errcode='TBE01';end if;
 select * into p from tm_billing_eligibility_policies where id=i.policy_id;select * into v from commercial_tm_valuations where id=i.snapshot_id;
 if tg_table_name='tm_billing_eligibility_notices' or tg_table_name='tm_billing_eligibility_notice_failures' then
  if new.transition_sequence=0 then expected_key='approval.action_required';expected_stage=0;expected_op=i.operation_id;expected_actor=i.requester_user_id;expected_role=i.active_role;
  else select * into t from tm_billing_eligibility_transitions where instance_id=i.id and sequence=new.transition_sequence;
   if t.id is null then raise exception 'The exact retained transition is required.' using errcode='TBE03';end if;
   expected_key=case when t.decision='Rejected' then 'approval.rejected_or_correction_required' when t.sequence<jsonb_array_length(p.definition->'stages') then 'approval.action_required' else 'approval.completed' end;
   expected_stage=case when t.decision='Approved' and t.sequence<jsonb_array_length(p.definition->'stages') then t.sequence else t.stage end;expected_op=t.operation_id;expected_actor=t.actor_id;expected_role=t.active_role;
  end if;
  if expected_actor::text is distinct from ctx->>'actorId' or expected_role is distinct from ctx->>'activeRole' or expected_op is distinct from ctx->>'operationId' then raise exception 'The original transition actor is required.' using errcode='TBE01';end if;
  if tg_table_name='tm_billing_eligibility_notice_failures' then if expected_key<>'approval.completed' or exists(select 1 from tm_billing_eligibility_notices where instance_id=i.id and transition_sequence=new.transition_sequence) then raise exception 'Only an unavailable informational completion may be recorded.' using errcode='TBE03';end if;return new;end if;
  select x into tmpl from jsonb_array_elements(p.definition->'templates') x where x->>'key'=expected_key;
  if new.event_key<>expected_key or new.stage<>expected_stage or new.policy_id<>p.id or new.operation_id<>expected_op or new.locale is distinct from p.definition->>'locale' or tmpl is null or new.title is distinct from replace(replace(tmpl->>'subject','{{sourceRef}}','tm-eligibility/'||i.snapshot_id::text),'{{stageNumber}}',(expected_stage+1)::text) or new.body is distinct from replace(replace(tmpl->>'body','{{sourceRef}}','tm-eligibility/'||i.snapshot_id::text),'{{stageNumber}}',(expected_stage+1)::text) or exists(select 1 from tm_billing_eligibility_notice_failures where instance_id=i.id and transition_sequence=new.transition_sequence) then raise exception 'The one sanitized canonical event is required.' using errcode='TBE03';end if;return new;
 end if;
 if ev.transition_sequence=0 then expected_actor=i.requester_user_id;expected_role=i.active_role;else select * into t from tm_billing_eligibility_transitions where instance_id=i.id and sequence=ev.transition_sequence;expected_actor=t.actor_id;expected_role=t.active_role;end if;
 if expected_actor::text is distinct from ctx->>'actorId' or expected_role is distinct from ctx->>'activeRole' or ev.operation_id is distinct from ctx->>'operationId' then raise exception 'The original event actor is required.' using errcode='TBE01';end if;
 if tg_table_name='tm_billing_eligibility_deliveries' then if rec.id is null or not rec.in_app then raise exception 'Only the exact in-app recipient may be delivered.' using errcode='TBE03';end if;return new;end if;
 select h.employee_id into worker_id from timesheets h join work_submission_evidence s on s.timesheet_id=h.id where s.id=v.submission_id;
 if(select count(*) from users usr join user_organization_scopes sc on sc.user_id=usr.id where usr.employee_record_id=worker_id and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active)<>1 then raise exception 'Affected worker unavailable.' using errcode='TBE04';end if;
 select usr.id into worker_user from users usr join user_organization_scopes sc on sc.user_id=usr.id where usr.employee_record_id=worker_id and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active;
 select role.name into recipient_role from users usr join user_organization_scopes sc on sc.user_id=usr.id join user_roles ur on ur.user_id=usr.id join roles role on role.id=ur.role_id where usr.id=new.user_id and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='notifications.view')) and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='employees.view')) order by role.name limit 1;
 if recipient_role is null then raise exception 'Named recipient is unavailable.' using errcode='TBE04';end if;
 perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.user_id,recipient_role);
 select array_agg(reason order by reason) into expected_reasons from(select 'current_stage_approver' reason where ev.event_key='approval.action_required' and new.user_id::text=p.definition->'stages'->ev.stage->>'userId' union all select 'requester' where ev.event_key<>'approval.action_required' and new.user_id=i.requester_user_id union all select 'commercial_change_owner' where ev.event_key='approval.rejected_or_correction_required' and new.user_id=i.owner_user_id union all select 'affected_worker' where ev.event_key<>'approval.action_required' and new.user_id=worker_user) q;
 if ev.event_key='approval.completed' then
  select n.in_app into pref from notification_preferences n join users usr on usr.employee_record_id=n.employee_id where usr.id=new.user_id and n.event_type=ev.event_key for share of n;
  expected_channel=case when not(p.definition->>'completionInApp')::boolean then 'SuppressedPolicy' when pref is false then 'SuppressedPreference' else 'Enabled' end;
 else expected_channel='Required';end if;
 if expected_reasons is null or(select array_agg(x order by x) from unnest(new.reasons)x) is distinct from expected_reasons or new.channel_decision<>expected_channel or new.in_app is distinct from (expected_channel in('Required','Enabled')) then raise exception 'Only the exact canonical recipients and channel decisions are allowed.' using errcode='TBE04';end if;return new;
end $$;
do $$declare t text;begin foreach t in array array['tm_billing_eligibility_notices','tm_billing_eligibility_recipients','tm_billing_eligibility_deliveries','tm_billing_eligibility_notice_failures'] loop execute format('create trigger authority_%I before insert on %I for each row execute function guard_tm_billing_notice_authority()',t,t);end loop;end $$;

-- Preserve the existing source/owner/policy checks and add only durable owner-loss invalidation.
create or replace function commercial_candidate_approval_is_current(i commercial_candidate_approval_instances) returns boolean language sql stable as $$
 select exists(select 1 from commercial_rate_candidates c join commercial_candidate_owners o on o.id=i.owner_event_id and o.candidate_id=c.id join commercial_candidate_approval_policies p on p.id=i.policy_id and p.candidate_id=c.id
  where c.id=i.candidate_id and c.organization_id=i.organization_id and c.legal_entity_id=i.legal_entity_id
    and o.organization_id=i.organization_id and o.legal_entity_id=i.legal_entity_id and p.organization_id=i.organization_id and p.legal_entity_id=i.legal_entity_id
    and p.effective_from<=(clock_timestamp() at time zone 'UTC')::date
    and c.id=(select id from commercial_rate_candidates where organization_id=c.organization_id and legal_entity_id=c.legal_entity_id and stream_id=c.stream_id order by sequence desc limit 1)
    and o.id=(select id from commercial_candidate_owners where organization_id=i.organization_id and legal_entity_id=i.legal_entity_id and candidate_id=i.candidate_id order by sequence desc limit 1)
    and p.id=(select id from commercial_candidate_approval_policies where organization_id=i.organization_id and legal_entity_id=i.legal_entity_id and candidate_id=i.candidate_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by sequence desc limit 1)
    and commercial_approval_inbox_identity_valid(i.organization_id,i.legal_entity_id,c,o.owner_user_id,o.owner_role)
    and not exists(select 1 from commercial_candidate_approval_invalidations x where x.instance_id=i.id)
    and not exists(select 1 from commercial_candidate_owner_losses x where x.instance_id=i.id))
$$;

-- Observe only changes that can invalidate a current commercial owner. These
-- triggers do not grant privileges or alter accounts; they retain a terminal
-- stale marker for unadopted/pending work when the owner actually loses scope.
create function record_commercial_owner_authority_loss() returns trigger language plpgsql as $$
declare changed_user uuid;changed_role text;begin
 if tg_table_name in('users','user_roles','user_organization_scopes','user_permission_grants') then
  if tg_table_name='users' then if tg_op='DELETE' then changed_user=old.id;else changed_user=new.id;end if;
  else if tg_op='DELETE' then changed_user=old.user_id;elsif tg_op='UPDATE' and old.user_id is distinct from new.user_id then changed_user=null;else changed_user=new.user_id;end if;end if;
 elsif tg_table_name='role_permissions' then if tg_op='DELETE' then changed_role=old.role_name;elsif tg_op='UPDATE' and old.role_name is distinct from new.role_name then changed_role=null;else changed_role=new.role_name;end if;
 elsif tg_table_name='roles' then if tg_op='DELETE' then changed_role=old.name;else changed_role=old.name;end if;end if;
 insert into commercial_candidate_owner_losses(instance_id,cause)
 select i.id,tg_table_name from commercial_candidate_approval_instances i join commercial_candidate_owners own on own.id=i.owner_event_id join commercial_rate_candidates candidate on candidate.id=i.candidate_id
 where (changed_user is null or own.owner_user_id=changed_user) and (changed_role is null or own.owner_role=changed_role)
  and not exists(select 1 from commercial_candidate_approval_invalidations z where z.instance_id=i.id)
  and not exists(select 1 from commercial_candidate_approval_transitions t where t.instance_id=i.id and t.decision='Rejected')
  and not exists(select 1 from commercial_rate_adoptions a where a.approval_id=i.id)
  and not commercial_approval_inbox_identity_valid(i.organization_id,i.legal_entity_id,candidate,own.owner_user_id,own.owner_role)
 on conflict(instance_id) do nothing;
 insert into tm_billing_owner_losses(instance_id,cause)
 select i.id,tg_table_name from tm_billing_eligibility_instances i
 where (changed_user is null or i.owner_user_id=changed_user) and (changed_role is null or i.owner_role=changed_role)
  and not exists(select 1 from tm_billing_eligibility_invalidations z where z.instance_id=i.id)
  and not exists(select 1 from tm_billing_eligibility_transitions t where t.instance_id=i.id and t.decision='Rejected')
  and not exists(select 1 from billing_eligibility_events e where e.instance_id=i.id)
  and (not tm_billing_actor_valid(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role,'manager') or not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,i.snapshot_id,i.owner_user_id,i.owner_role))
 on conflict(instance_id) do nothing;
 return null;
end $$;
create constraint trigger tm_owner_loss_users after update or delete on users deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_user_roles after insert or update or delete on user_roles deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_scopes after insert or update or delete on user_organization_scopes deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_user_grants after insert or update or delete on user_permission_grants deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_role_permissions after insert or update or delete on role_permissions deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_roles after update or delete on roles deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_employees after update or delete on employees deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_allocations after insert or update or delete on project_allocations deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_project_manager after update or delete on projects deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_country_map after insert or update or delete on employee_country_director_map deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();
create constraint trigger tm_owner_loss_directors after update or delete on country_directors deferrable initially deferred for each row execute function record_commercial_owner_authority_loss();

-- The preceding adoption insert guard remains authoritative. At commit, also
-- recheck the pinned owner after any account/scope changes in the transaction.
create function revalidate_commercial_adoption_owner() returns trigger language plpgsql as $$
declare i commercial_candidate_approval_instances;begin
 select * into i from commercial_candidate_approval_instances where id=new.approval_id;
 if i.id is null or not commercial_candidate_approval_is_current(i) then raise exception 'The adopted approval owner changed before commit.' using errcode='CRA02';end if;return null;
end $$;
create constraint trigger revalidate_commercial_adoption_owner after insert on commercial_rate_adoptions deferrable initially deferred for each row execute function revalidate_commercial_adoption_owner();
