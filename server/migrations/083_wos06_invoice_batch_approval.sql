-- Local development safeguard: remove only after protected transitions,
-- canonical recipients, authorization guards and acceptance tests exist.
do $$ begin raise exception 'Invoice batch approval migration is incomplete'; end $$;

-- Prospective, explicit policy definitions only; no buyer-specific policies or
-- role/user permission grants are installed by this additive migration.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.invoice_approval.manage','Commercial','Manage invoice batch approvals','Configure prospective scoped invoice batch approval and submit Drafts.',false),
 ('commercial.invoice_approval.decide','Commercial','Decide invoice batch approvals','Decide an explicitly assigned current scoped invoice batch approval stage.',false);

create function valid_invoice_batch_approval_policy(d jsonb) returns boolean language plpgsql immutable as $$
begin
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','engagementId','stages','locale','templates','completionInApp']) or (select count(*) from jsonb_object_keys(d))<>6 or d->>'entityType' is distinct from 'InvoiceBatch' or jsonb_typeof(d->'engagementId') is distinct from 'string' or length(btrim(d->>'engagementId')) not between 1 and 200 then return false;end if;
 if not valid_work_approval_definition((d-'engagementId')||jsonb_build_object('entityType','Timesheet','workerIds','[]'::jsonb)) then return false;end if;
 if exists(select 1 from jsonb_array_elements(d->'templates') t where regexp_replace(t->>'subject','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]' or regexp_replace(t->>'body','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]') then return false;end if;
 return true;
exception when others then return false;end $$;

-- All rows below retain decisions and source pins; state and occupancy are
-- computed from protected append-only history, not supplied by a caller.
create table invoice_batch_approval_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,sequence int not null check(sequence>0),previous_id uuid references invoice_batch_approval_policies(id),effective_from date not null,
 definition jsonb not null check(valid_invoice_batch_approval_policy(definition)),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),unique(organization_id,legal_entity_id,engagement_id,sequence),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table invoice_batch_approval_instances(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,batch_id uuid not null references invoice_draft_batches(id),sequence int not null check(sequence>0),policy_id uuid not null references invoice_batch_approval_policies(id),owner_user_id uuid not null references users(id),owner_role text not null,preparer_user_id uuid not null references users(id),preparer_role text not null,requester_user_id uuid not null references users(id),active_role text not null,
 line_count int not null check(line_count>0),lineage_hash text not null check(lineage_hash~'^[a-f0-9]{64}$'),currency text not null check(currency~'^[A-Z]{3}$'),total numeric not null check(total>0),
 request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,requester_user_id,request_id),unique(batch_id,sequence)
);
create index invoice_batch_approval_history on invoice_batch_approval_instances(organization_id,legal_entity_id,batch_id,created_at,id);
create table invoice_batch_approval_transitions(
 id uuid primary key,instance_id uuid not null references invoice_batch_approval_instances(id),sequence int not null check(sequence between 1 and 10),stage int not null check(stage between 0 and 9),decision text not null check(decision in('Approved','Rejected')),
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(instance_id,sequence),unique(instance_id,request_id)
);
create table invoice_batch_approval_invalidations(
 id uuid primary key,instance_id uuid not null unique references invoice_batch_approval_instances(id),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(actor_id,request_id)
);
create table invoice_batch_approval_notices(
 id text primary key,instance_id uuid not null references invoice_batch_approval_instances(id),transition_sequence int not null check(transition_sequence between 0 and 10),stage int not null check(stage between 0 and 9),event_key text not null check(event_key in('approval.action_required','approval.rejected_or_correction_required','approval.completed')),
 policy_class text not null check(policy_class in('ACTION_REQUIRED','INFORMATIONAL')),policy_id uuid not null references invoice_batch_approval_policies(id),operation_id text not null,locale text not null,title text not null check(work_period_notice_units(title) between 1 and 1200),body text not null check(work_period_notice_units(body) between 1 and 12000),created_at timestamptz not null default clock_timestamp(),
 unique(instance_id,transition_sequence,event_key),check((event_key in('approval.action_required','approval.rejected_or_correction_required') and policy_class='ACTION_REQUIRED') or(event_key='approval.completed' and policy_class='INFORMATIONAL'))
);
create table invoice_batch_approval_recipients(
 id uuid primary key,event_id text not null references invoice_batch_approval_notices(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons) between 1 and 4 and reasons<@array['requester','invoice_batch_owner','finance_preparer','current_stage_approver']::text[]),in_app boolean not null,channel_decision text not null check(channel_decision in('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id)
);
create table invoice_batch_approval_deliveries(id uuid primary key,recipient_id uuid not null unique references invoice_batch_approval_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt int not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table invoice_batch_approval_reads(recipient_id uuid primary key references invoice_batch_approval_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
create table invoice_batch_approval_notice_failures(id uuid primary key,instance_id uuid not null references invoice_batch_approval_instances(id),transition_sequence int not null,code text not null check(code='INFORMATIONAL_NOTIFICATION_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),unique(instance_id,transition_sequence));
do $$declare t text;begin foreach t in array array['invoice_batch_approval_policies','invoice_batch_approval_instances','invoice_batch_approval_transitions','invoice_batch_approval_invalidations','invoice_batch_approval_notices','invoice_batch_approval_recipients','invoice_batch_approval_deliveries','invoice_batch_approval_reads','invoice_batch_approval_notice_failures'] loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;

-- A deterministic pin covers retained line identity and whole source lineage.
-- It does not authorize a decision; the locked server/DB command must also
-- revalidate current policy, actor, owner, every source and every occupancy.
create function invoice_batch_lineage_hash(batch uuid) returns text language sql stable as $$
 select encode(digest(coalesce(jsonb_agg(jsonb_build_object('sequence',l.sequence,'lineId',l.id,'itemId',l.item_id,'itemVersion',l.item_version,'eventId',l.event_id,'snapshotId',l.snapshot_id,'currency',l.currency,'amount',trim_scale(l.amount)::text,'evidence',l.billing_evidence) order by l.sequence),'[]'::jsonb)::text,'sha256'),'hex') from invoice_draft_lines l where l.batch_id=batch
$$;
create function invoice_batch_source_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select invoice_draft_owner_current(b) and not exists(select 1 from invoice_draft_cancellations x where x.batch_id=b.id)
 and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id)
 and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id and o.item_id=l.item_id and o.item_version=l.item_version
 where l.batch_id=b.id and (o.line_id is null or not tm_billing_source_valid(b.organization_id,b.legal_entity_id,b.engagement_id,l.snapshot_id)))
$$;

create function invoice_batch_approval_actor_valid(org text,legal text,who uuid,role_name text,kind text) returns boolean language plpgsql stable as $$
declare k text;keys text[];begin
 if kind not in('manager','submitter','decider') or not invoice_draft_actor_valid(org,legal,who,role_name,'view') then return false;end if;
 keys=case kind when 'manager' then array['commercial.contracts.manage','commercial.invoice_approval.manage'] when 'submitter' then array['commercial.invoice_drafts.prepare','commercial.invoice_approval.manage'] else array['approvals.view','commercial.invoice_approval.decide'] end;
 foreach k in array keys loop
  if not exists(select 1 from role_permissions rp where rp.role_name=invoice_batch_approval_actor_valid.role_name and rp.permission_key=k and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=k) then return false;end if;
 end loop;return true;
end $$;

-- The latest retained instance governs the batch; an invalidated or rejected
-- review returns to Draft only before cancellation. Final approval is terminal.
create function invoice_batch_governed_state(batch uuid) returns text language plpgsql stable as $$
declare i invoice_batch_approval_instances;p invoice_batch_approval_policies;last_decision text;n int;begin
 if exists(select 1 from invoice_draft_cancellations where batch_id=batch) then return 'Cancelled';end if;
 select * into i from invoice_batch_approval_instances where batch_id=batch order by sequence desc limit 1;
 if i.id is null then return 'Draft';end if;
 select * into p from invoice_batch_approval_policies where id=i.policy_id;
 select count(*)::int into n from invoice_batch_approval_transitions where instance_id=i.id;
 select decision into last_decision from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if last_decision='Approved' and n=jsonb_array_length(p.definition->'stages') then return 'Approved';end if;
 if last_decision='Rejected' or exists(select 1 from invoice_batch_approval_invalidations where instance_id=i.id) then return 'Draft';end if;
 return 'Under Review';
end $$;

create function invoice_batch_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select exists(select 1 from invoice_draft_batches b where b.id=i.batch_id and b.organization_id=i.organization_id and b.legal_entity_id=i.legal_entity_id
 and b.owner_user_id=i.owner_user_id and b.owner_role=i.owner_role and b.preparer_user_id=i.preparer_user_id and b.preparer_role=i.preparer_role and b.currency=i.currency
 and invoice_batch_source_current(b)
 and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter')
 and i.line_count=(select count(*) from invoice_draft_lines l where l.batch_id=b.id)
 and i.total=(select sum(l.amount) from invoice_draft_lines l where l.batch_id=b.id) and i.lineage_hash=invoice_batch_lineage_hash(b.id)
 and not exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and (not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,i.requester_user_id,i.active_role) or not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,i.owner_user_id,i.owner_role))))
$$;
create function invoice_batch_approval_review_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select invoice_batch_governed_state(i.batch_id)='Under Review' and invoice_batch_approval_pin_current(i)
$$;

-- Existing Draft commands cannot change the retained line set after review is
-- submitted; cancellation requires the review to have been atomically retired.
create function guard_invoice_batch_review_boundary() returns trigger language plpgsql as $$
declare state text;begin
 state=invoice_batch_governed_state(new.batch_id);
 if tg_table_name='invoice_draft_lines' and state<>'Draft' then raise exception 'A reviewed batch cannot acquire another line.' using errcode='IBA02';end if;
 if tg_table_name='invoice_draft_cancellations' and state='Under Review' then raise exception 'The active review must be cancelled in the same transaction.' using errcode='IBA02';end if;
 return new;
end $$;
create trigger invoice_batch_review_line_boundary before insert on invoice_draft_lines for each row execute function guard_invoice_batch_review_boundary();
create trigger invoice_batch_review_cancel_boundary before insert on invoice_draft_cancellations for each row execute function guard_invoice_batch_review_boundary();

create function guard_invoice_batch_policy() returns trigger language plpgsql as $$
declare ctx jsonb;prior invoice_batch_approval_policies;stage jsonb;uid uuid;held_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if ctx is null or new.id::text is distinct from ctx->>'policyId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or new.definition->>'engagementId' is distinct from new.engagement_id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date then raise exception 'Explicit current scoped invoice policy authority is required.' using errcode='IBA01';end if;
 select * into prior from invoice_batch_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or(prior.id is not null and new.effective_from<prior.effective_from) then raise exception 'The current policy version changed.' using errcode='IBA02';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v order by v->>'userId',v->>'role' loop
  uid=(stage->>'userId')::uuid;held_role=stage->>'role';perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,uid,held_role);
  if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,uid,held_role,'decider') then raise exception 'Every named stage requires current held scope and authority.' using errcode='IBA01';end if;
 end loop;return new;
end $$;
create trigger guarded_invoice_batch_policy before insert on invoice_batch_approval_policies for each row execute function guard_invoice_batch_policy();

create function guard_invoice_batch_review_instance() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;p invoice_batch_approval_policies;last_sequence int;line invoice_draft_lines;first_stage jsonb;approver uuid;approver_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id for update;
 select * into p from invoice_batch_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=b.engagement_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by effective_from desc,sequence desc limit 1;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role);
 if b.id is null or p.id is null or ctx is null or new.id::text is distinct from ctx->>'instanceId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.requester_user_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.batch_id::text is distinct from ctx->>'batchId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.policy_id<>p.id or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role,'submitter') or invoice_batch_governed_state(b.id)<>'Draft' then raise exception 'Current scoped Draft, policy and requester are required.' using errcode='IBA01';end if;
 select coalesce(max(sequence),0) into last_sequence from invoice_batch_approval_instances where batch_id=b.id;
 if new.sequence<>last_sequence+1 or new.owner_user_id<>b.owner_user_id or new.owner_role<>b.owner_role or new.preparer_user_id<>b.preparer_user_id or new.preparer_role<>b.preparer_role or new.currency<>b.currency then raise exception 'Batch version and retained relationships must match.' using errcode='IBA02';end if;
 first_stage=p.definition->'stages'->0;approver=(first_stage->>'userId')::uuid;approver_role=first_stage->>'role';
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,b.owner_user_id,b.owner_role);perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,b.preparer_user_id,b.preparer_role);perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,approver,approver_role);
 if exists(select 1 from jsonb_array_elements(p.definition->'stages') st where st->>'userId'=new.requester_user_id::text) or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,approver,approver_role,'decider') or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,b.preparer_user_id,b.preparer_role,'view') then raise exception 'Required current stage and preparer relationships are unavailable.' using errcode='IBA01';end if;
 for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,line.snapshot_id,new.requester_user_id,new.active_role);perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,line.snapshot_id,b.owner_user_id,b.owner_role);perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,line.snapshot_id,b.preparer_user_id,b.preparer_role);perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,line.snapshot_id,approver,approver_role);
  if not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,line.snapshot_id,new.requester_user_id,new.active_role) or not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,line.snapshot_id,b.preparer_user_id,b.preparer_role) or not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,line.snapshot_id,approver,approver_role) then raise exception 'Required scoped batch relationships are unavailable.' using errcode='IBA01';end if;
 end loop;
 if not invoice_batch_source_current(b) or new.line_count<>(select count(*) from invoice_draft_lines where batch_id=b.id) or new.total<>(select sum(amount) from invoice_draft_lines where batch_id=b.id) or new.lineage_hash<>invoice_batch_lineage_hash(b.id) then raise exception 'Batch sources, occupancy and control totals changed.' using errcode='IBA02';end if;
 return new;
end $$;
create trigger guarded_invoice_batch_review_instance before insert on invoice_batch_approval_instances for each row execute function guard_invoice_batch_review_instance();

create function guard_invoice_batch_review_decision() returns trigger language plpgsql as $$
declare ctx jsonb;i invoice_batch_approval_instances;b invoice_draft_batches;p invoice_batch_approval_policies;line invoice_draft_lines;stage jsonb;next_stage jsonb;n int;recipient uuid;recipient_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from invoice_batch_approval_instances where id=new.instance_id;select * into b from invoice_draft_batches where id=i.batch_id for update;select * into p from invoice_batch_approval_policies where id=i.policy_id;
 select count(*)::int into n from invoice_batch_approval_transitions where instance_id=i.id;
 stage=p.definition->'stages'->n;
 perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);
 if ctx is null or b.id is null or new.id::text is distinct from ctx->>'transitionId' or new.instance_id::text is distinct from ctx->>'instanceId' or i.batch_id::text is distinct from ctx->>'batchId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.sequence<>n+1 or new.stage<>n or stage is null or stage->>'userId' is distinct from new.actor_id::text or stage->>'role' is distinct from new.active_role or new.actor_id=i.requester_user_id or not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'decider') or not invoice_batch_approval_review_current(i) then raise exception 'Current named stage, source and actor are required.' using errcode='IBA02';end if;
 for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,new.actor_id,new.active_role);
  if not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,line.snapshot_id,new.actor_id,new.active_role) then raise exception 'Current reviewer scope is required for every retained line.' using errcode='IBA01';end if;
 end loop;
 if new.decision='Approved' and n+1<jsonb_array_length(p.definition->'stages') then
  next_stage=p.definition->'stages'->(n+1);recipient=(next_stage->>'userId')::uuid;recipient_role=next_stage->>'role';perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,recipient,recipient_role);
  if recipient=i.requester_user_id or not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,recipient,recipient_role,'decider') then raise exception 'The next named stage must be currently eligible.' using errcode='IBA01';end if;
  for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,recipient,recipient_role);if not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,line.snapshot_id,recipient,recipient_role) then raise exception 'Next-stage scoped access is required for every retained line.' using errcode='IBA01';end if;end loop;
 end if;
 return new;
end $$;
create trigger guarded_invoice_batch_review_decision before insert on invoice_batch_approval_transitions for each row execute function guard_invoice_batch_review_decision();
