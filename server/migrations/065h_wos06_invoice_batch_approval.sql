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
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(instance_id,sequence),unique(instance_id,request_id),unique(actor_id,request_id)
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
 id uuid primary key,event_id text not null references invoice_batch_approval_notices(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons) between 1 and 4 and reasons<@array['requester','invoice_batch_owner','finance_preparer','current_stage_approver','affected_worker']::text[]),in_app boolean not null,channel_decision text not null check(channel_decision in('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id)
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
 select invoice_batch_governed_state(i.batch_id)='Under Review' and i.sequence=(select max(x.sequence) from invoice_batch_approval_instances x where x.batch_id=i.batch_id) and not exists(select 1 from invoice_batch_approval_invalidations x where x.instance_id=i.id) and invoice_batch_approval_pin_current(i)
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
declare ctx jsonb;prior invoice_batch_approval_policies;e commercial_engagements;stage jsonb;uid uuid;held_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 perform pg_advisory_xact_lock(hashtext('invoice-approval-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
 if ctx is null or e.id is null or e.origin<>'manual' or e.model<>'time_and_materials' or not e.billable or e.client_id is null or e.contract_id is null or new.id::text is distinct from ctx->>'policyId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or new.definition->>'engagementId' is distinct from new.engagement_id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date then raise exception 'Explicit current scoped invoice policy authority is required.' using errcode='IBA01';end if;
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
  perform 1 from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where v.id=line.snapshot_id for share of h,te;
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
 perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.preparer_user_id,i.preparer_role);
 if ctx is null or b.id is null or new.id::text is distinct from ctx->>'transitionId' or new.instance_id::text is distinct from ctx->>'instanceId' or i.batch_id::text is distinct from ctx->>'batchId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.sequence<>n+1 or new.stage<>n or stage is null or stage->>'userId' is distinct from new.actor_id::text or stage->>'role' is distinct from new.active_role or new.actor_id=i.requester_user_id or not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'decider') or not invoice_batch_approval_review_current(i) then raise exception 'Current named stage, source and actor are required.' using errcode='IBA02';end if;
 for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform 1 from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where v.id=line.snapshot_id for share of h,te;
  perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,new.actor_id,new.active_role);perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,i.requester_user_id,i.active_role);perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,i.owner_user_id,i.owner_role);perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,i.preparer_user_id,i.preparer_role);
  if not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,line.snapshot_id,new.actor_id,new.active_role) then raise exception 'Current reviewer scope is required for every retained line.' using errcode='IBA01';end if;
 end loop;
 if new.decision='Approved' and n+1<jsonb_array_length(p.definition->'stages') then
  next_stage=p.definition->'stages'->(n+1);recipient=(next_stage->>'userId')::uuid;recipient_role=next_stage->>'role';perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,recipient,recipient_role);
  if recipient=i.requester_user_id or not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,recipient,recipient_role,'decider') then raise exception 'The next named stage must be currently eligible.' using errcode='IBA01';end if;
  for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,recipient,recipient_role);if not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,line.snapshot_id,recipient,recipient_role) then raise exception 'Next-stage scoped access is required for every retained line.' using errcode='IBA01';end if;end loop;
 end if;
 if not invoice_batch_approval_review_current(i) then raise exception 'Review pins or scope changed before decision.' using errcode='IBA02';end if;
 return new;
end $$;
create trigger guarded_invoice_batch_review_decision before insert on invoice_batch_approval_transitions for each row execute function guard_invoice_batch_review_decision();

create function complete_invoice_batch_policy() returns trigger language plpgsql as $$
declare stage jsonb;begin
 if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Batch Approval' and a.action='Configure Policy' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('policyId',new.id,'engagementId',new.engagement_id)) then raise exception 'Policy authority and redacted audit must commit together.' using errcode='IBA03';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v loop if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,(stage->>'userId')::uuid,stage->>'role','decider') then raise exception 'Every named stage must retain authority through commit.' using errcode='IBA03';end if;end loop;
 return null;
end $$;
create constraint trigger complete_invoice_batch_policy after insert on invoice_batch_approval_policies deferrable initially deferred for each row execute function complete_invoice_batch_policy();

-- Resolve relationships from the locked retained batch and its work sources.
-- The caller cannot provide identities. Duplicate identities are returned with
-- separate reasons and must be deduplicated before protected persistence.
create function invoice_batch_expected_recipients(i invoice_batch_approval_instances,event_key text,stage_no int) returns table(recipient uuid,reason text) language plpgsql stable as $$
declare p invoice_batch_approval_policies;w text;accounts uuid[];begin
 select * into p from invoice_batch_approval_policies where id=i.policy_id;
 if p.id is null or event_key not in('approval.action_required','approval.rejected_or_correction_required','approval.completed') then raise exception 'Canonical notification context unavailable.' using errcode='IBA03';end if;
 if event_key='approval.action_required' then
  if stage_no<0 or stage_no>=jsonb_array_length(p.definition->'stages') then raise exception 'Current stage unavailable.' using errcode='IBA03';end if;
  recipient=(p.definition->'stages'->stage_no->>'userId')::uuid;reason='current_stage_approver';return next;return;
 end if;
 if not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter') then raise exception 'Requester relationship unavailable.' using errcode='IBA03';end if;
 recipient=i.requester_user_id;reason='requester';return next;
 if event_key='approval.rejected_or_correction_required' then
  if not invoice_draft_actor_valid(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role,'own') or not invoice_draft_actor_valid(i.organization_id,i.legal_entity_id,i.preparer_user_id,i.preparer_role,'view') then raise exception 'Batch owner or preparer relationship unavailable.' using errcode='IBA03';end if;
  if exists(select 1 from invoice_draft_lines l where l.batch_id=i.batch_id and (not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,i.owner_user_id,i.owner_role) or not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,i.preparer_user_id,i.preparer_role))) then raise exception 'Batch owner or preparer worker scope changed.' using errcode='IBA03';end if;
  recipient=i.owner_user_id;reason='invoice_batch_owner';return next;recipient=i.preparer_user_id;reason='finance_preparer';return next;
 end if;
 for w in select distinct h.employee_id from invoice_draft_lines l join commercial_tm_valuations v on v.id=l.snapshot_id join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where l.batch_id=i.batch_id order by h.employee_id loop
  select array_agg(u.id order by u.id) into accounts from users u join user_organization_scopes sc on sc.user_id=u.id where u.employee_record_id=w and u.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active;
  if coalesce(cardinality(accounts),0)<>1 then raise exception 'A retained affected worker account is unavailable.' using errcode='IBA03';end if;
  recipient=accounts[1];reason='affected_worker';return next;
 end loop;
end $$;

create function guard_invoice_batch_notice_authority() returns trigger language plpgsql as $$
declare ctx jsonb;i invoice_batch_approval_instances;p invoice_batch_approval_policies;t invoice_batch_approval_transitions;ev invoice_batch_approval_notices;rec invoice_batch_approval_recipients;expected_key text;expected_stage int;expected_op text;expected_actor uuid;expected_role text;expected_reasons text[];tmpl jsonb;pref boolean;expected_channel text;recipient_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if tg_table_name in('invoice_batch_approval_notices','invoice_batch_approval_notice_failures') then select * into i from invoice_batch_approval_instances where id=new.instance_id;
 elsif tg_table_name='invoice_batch_approval_recipients' then select * into ev from invoice_batch_approval_notices where id=new.event_id;select * into i from invoice_batch_approval_instances where id=ev.instance_id;
 else select * into rec from invoice_batch_approval_recipients where id=new.recipient_id;select * into ev from invoice_batch_approval_notices where id=rec.event_id;select * into i from invoice_batch_approval_instances where id=ev.instance_id;end if;
 if i.id is null or ctx is null or i.id::text is distinct from ctx->>'instanceId' or i.batch_id::text is distinct from ctx->>'batchId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' then raise exception 'Exact scoped invoice review is required.' using errcode='IBA01';end if;
 select * into p from invoice_batch_approval_policies where id=i.policy_id;
 if tg_table_name in('invoice_batch_approval_notices','invoice_batch_approval_notice_failures') then
  if new.transition_sequence=0 then expected_key='approval.action_required';expected_stage=0;expected_op=i.operation_id;expected_actor=i.requester_user_id;expected_role=i.active_role;
  else select * into t from invoice_batch_approval_transitions where instance_id=i.id and sequence=new.transition_sequence;if t.id is null then raise exception 'Retained decision unavailable.' using errcode='IBA02';end if;
   expected_key=case when t.decision='Rejected' then 'approval.rejected_or_correction_required' when t.sequence<jsonb_array_length(p.definition->'stages') then 'approval.action_required' else 'approval.completed' end;
   expected_stage=case when t.decision='Approved' and t.sequence<jsonb_array_length(p.definition->'stages') then t.sequence else t.stage end;expected_op=t.operation_id;expected_actor=t.actor_id;expected_role=t.active_role;
  end if;
  if expected_actor::text is distinct from ctx->>'actorId' or expected_role is distinct from ctx->>'activeRole' or expected_op is distinct from ctx->>'operationId' then raise exception 'The original stage actor is required.' using errcode='IBA01';end if;
  if tg_table_name='invoice_batch_approval_notice_failures' then if expected_key<>'approval.completed' or exists(select 1 from invoice_batch_approval_notices where instance_id=i.id and transition_sequence=new.transition_sequence) then raise exception 'Only an unavailable informational completion may be recorded.' using errcode='IBA02';end if;return new;end if;
  select x into tmpl from jsonb_array_elements(p.definition->'templates') x where x->>'key'=expected_key;
  if new.event_key<>expected_key or new.stage<>expected_stage or new.policy_id<>p.id or new.operation_id<>expected_op or new.locale is distinct from p.definition->>'locale' or tmpl is null or new.title is distinct from replace(replace(tmpl->>'subject','{{sourceRef}}','invoice-batch/'||i.batch_id::text),'{{stageNumber}}',(expected_stage+1)::text) or new.body is distinct from replace(replace(tmpl->>'body','{{sourceRef}}','invoice-batch/'||i.batch_id::text),'{{stageNumber}}',(expected_stage+1)::text) or exists(select 1 from invoice_batch_approval_notice_failures where instance_id=i.id and transition_sequence=new.transition_sequence) then raise exception 'Only the sanitized canonical event is allowed.' using errcode='IBA02';end if;return new;
 end if;
 if ev.transition_sequence=0 then expected_actor=i.requester_user_id;expected_role=i.active_role;else select * into t from invoice_batch_approval_transitions where instance_id=i.id and sequence=ev.transition_sequence;expected_actor=t.actor_id;expected_role=t.active_role;end if;
 if expected_actor::text is distinct from ctx->>'actorId' or expected_role is distinct from ctx->>'activeRole' or ev.operation_id is distinct from ctx->>'operationId' then raise exception 'The original event actor is required.' using errcode='IBA01';end if;
 if tg_table_name='invoice_batch_approval_deliveries' then if rec.id is null or not rec.in_app then raise exception 'Exact in-app recipient required.' using errcode='IBA02';end if;return new;end if;
 select role.name into recipient_role from users usr join user_organization_scopes sc on sc.user_id=usr.id join user_roles ur on ur.user_id=usr.id join roles role on role.id=ur.role_id where usr.id=new.user_id and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='notifications.view')) and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='employees.view')) order by role.name limit 1;
 if recipient_role is null then raise exception 'A protected recipient is unavailable.' using errcode='IBA03';end if;perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.user_id,recipient_role);
 select array_agg(distinct x.reason order by x.reason) into expected_reasons from invoice_batch_expected_recipients(i,ev.event_key,ev.stage) x where x.recipient=new.user_id;
 if ev.event_key='approval.completed' then select n.in_app into pref from notification_preferences n join users usr on usr.employee_record_id=n.employee_id where usr.id=new.user_id and n.event_type=ev.event_key for share of n;expected_channel=case when not(p.definition->>'completionInApp')::boolean then 'SuppressedPolicy' when pref is false then 'SuppressedPreference' else 'Enabled' end;else expected_channel='Required';end if;
 if expected_reasons is null or(select array_agg(x order by x) from unnest(new.reasons)x) is distinct from expected_reasons or new.channel_decision<>expected_channel or new.in_app is distinct from(expected_channel in('Required','Enabled')) then raise exception 'Protected recipient reasons and channel must match the source.' using errcode='IBA03';end if;return new;
end $$;
create trigger guard_invoice_batch_notice before insert on invoice_batch_approval_notices for each row execute function guard_invoice_batch_notice_authority();
create trigger guard_invoice_batch_recipient before insert on invoice_batch_approval_recipients for each row execute function guard_invoice_batch_notice_authority();
create trigger guard_invoice_batch_delivery before insert on invoice_batch_approval_deliveries for each row execute function guard_invoice_batch_notice_authority();
create trigger guard_invoice_batch_notice_failure before insert on invoice_batch_approval_notice_failures for each row execute function guard_invoice_batch_notice_authority();

create function complete_invoice_batch_review() returns trigger language plpgsql as $$
declare i invoice_batch_approval_instances;p invoice_batch_approval_policies;last_decision invoice_batch_approval_transitions;ev invoice_batch_approval_notices;rec invoice_batch_approval_recipients;seq int;stage_no int;v_event_key text;v_status text;op text;actor uuid;held_role text;audit_entity uuid;expected_users uuid[];u uuid;reasons text[];tmpl jsonb;begin
 if tg_table_name='invoice_batch_approval_instances' then i=new;seq=0;stage_no=0;v_event_key='approval.action_required';op=i.operation_id;actor=i.requester_user_id;held_role=i.active_role;audit_entity=i.id;
 else select * into i from invoice_batch_approval_instances where id=new.instance_id;seq=new.sequence;op=new.operation_id;actor=new.actor_id;held_role=new.active_role;audit_entity=new.id;end if;
 select * into p from invoice_batch_approval_policies where id=i.policy_id;select * into last_decision from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if p.id is null or not invoice_batch_approval_pin_current(i) then raise exception 'Source, occupancy, owner or requester changed before commit.' using errcode='IBA03';end if;
 if tg_table_name='invoice_batch_approval_transitions' and (not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,actor,held_role,'decider') or exists(select 1 from invoice_draft_lines l where l.batch_id=i.batch_id and not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,actor,held_role))) then raise exception 'Decider authority or scope changed before commit.' using errcode='IBA03';end if;
 v_status=case when last_decision.id is null then 'Pending' when last_decision.decision='Rejected' then 'Rejected' when last_decision.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if tg_table_name='invoice_batch_approval_transitions' then if new.decision='Rejected' then v_event_key='approval.rejected_or_correction_required';stage_no=new.stage;elsif new.sequence<jsonb_array_length(p.definition->'stages') then v_event_key='approval.action_required';stage_no=new.sequence;else v_event_key='approval.completed';stage_no=new.stage;end if;end if;
 if not exists(select 1 from approval_records a where a.entity_type='InvoiceBatchApproval' and a.entity_id=i.id::text and a.status=v_status and a.comments is null and a.due_at is null) or invoice_batch_governed_state(i.batch_id) is distinct from (case when v_status='Pending' then 'Under Review' when v_status='Rejected' then 'Draft' else 'Approved' end) then raise exception 'Generic approval and batch state must converge.' using errcode='IBA03';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=actor::text and a.active_role=held_role and a.module='Invoice Batch Approval' and a.action=(case when tg_table_name='invoice_batch_approval_instances' then 'Request Review' else 'Decide Review' end) and a.entity_id=audit_entity::text and a.operation_id=op and a.new_value=jsonb_build_object('instanceId',i.id,'batchId',i.batch_id)) then raise exception 'Review and redacted audit must commit together.' using errcode='IBA03';end if;
 select * into ev from invoice_batch_approval_notices where instance_id=i.id and transition_sequence=seq and invoice_batch_approval_notices.event_key=v_event_key;
 if v_event_key='approval.completed' and ev.id is null and exists(select 1 from invoice_batch_approval_notice_failures where instance_id=i.id and transition_sequence=seq) then return null;end if;
 select x into tmpl from jsonb_array_elements(p.definition->'templates') x where x->>'key'=v_event_key;
 if ev.id is null or ev.stage<>stage_no or ev.policy_id<>p.id or ev.operation_id is distinct from op or ev.locale is distinct from p.definition->>'locale' or tmpl is null or ev.title is distinct from replace(replace(tmpl->>'subject','{{sourceRef}}','invoice-batch/'||i.batch_id::text),'{{stageNumber}}',(stage_no+1)::text) or ev.body is distinct from replace(replace(tmpl->>'body','{{sourceRef}}','invoice-batch/'||i.batch_id::text),'{{stageNumber}}',(stage_no+1)::text) or(select count(*) from invoice_batch_approval_notices where instance_id=i.id and transition_sequence=seq)<>1 then raise exception 'One sanitized canonical stage event is required.' using errcode='IBA03';end if;
 if v_event_key='approval.action_required' and (not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,(p.definition->'stages'->stage_no->>'userId')::uuid,p.definition->'stages'->stage_no->>'role','decider') or exists(select 1 from invoice_draft_lines l where l.batch_id=i.batch_id and not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,(p.definition->'stages'->stage_no->>'userId')::uuid,p.definition->'stages'->stage_no->>'role'))) then raise exception 'Current-stage authority and scope must persist through commit.' using errcode='IBA03';end if;
 select array_agg(distinct x.recipient order by x.recipient) into expected_users from invoice_batch_expected_recipients(i,v_event_key,stage_no) x;
 if expected_users is null or(select count(*) from invoice_batch_approval_recipients where event_id=ev.id)<>cardinality(expected_users) then raise exception 'The complete protected recipient set is required.' using errcode='IBA03';end if;
 foreach u in array expected_users loop
  if not exists(select 1 from users usr join user_organization_scopes sc on sc.user_id=usr.id join user_roles ur on ur.user_id=usr.id join roles role on role.id=ur.role_id where usr.id=u and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='notifications.view')) and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='employees.view'))) then raise exception 'A protected recipient lost current authority.' using errcode='IBA03';end if;
  select array_agg(distinct x.reason order by x.reason) into reasons from invoice_batch_expected_recipients(i,v_event_key,stage_no) x where x.recipient=u;
  select * into rec from invoice_batch_approval_recipients where event_id=ev.id and user_id=u;
  if rec.id is null or(select array_agg(x order by x) from unnest(rec.reasons)x) is distinct from reasons or(v_event_key<>'approval.completed' and(not rec.in_app or rec.channel_decision<>'Required')) or(rec.in_app and not exists(select 1 from invoice_batch_approval_deliveries d where d.recipient_id=rec.id and d.channel='InApp' and d.status='Delivered')) then raise exception 'Every exact recipient and required in-app delivery must commit.' using errcode='IBA03';end if;
 end loop;return null;
end $$;
create constraint trigger complete_invoice_batch_review_instance after insert on invoice_batch_approval_instances deferrable initially deferred for each row execute function complete_invoice_batch_review();
create constraint trigger complete_invoice_batch_review_transition after insert on invoice_batch_approval_transitions deferrable initially deferred for each row execute function complete_invoice_batch_review();

create function guard_invoice_batch_approval_compatibility() returns trigger language plpgsql as $$
declare ctx jsonb;i invoice_batch_approval_instances;p invoice_batch_approval_policies;t invoice_batch_approval_transitions;expected text;begin
 if tg_op='DELETE' then if old.entity_type='InvoiceBatchApproval' then raise exception 'Invoice batch approval history is immutable.' using errcode='IBA02';end if;return old;end if;
 if tg_op='UPDATE' and old.entity_type='InvoiceBatchApproval' and ((new.entity_type,new.entity_id) is distinct from(old.entity_type,old.entity_id) or(old.status='Approved' and new is distinct from old)) then raise exception 'Final invoice approval cannot be reopened or rewritten.' using errcode='IBA02';end if;
 if new.entity_type<>'InvoiceBatchApproval' then return new;end if;
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from invoice_batch_approval_instances where id::text=new.entity_id;select * into p from invoice_batch_approval_policies where id=i.policy_id;select * into t from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 expected=case when exists(select 1 from invoice_batch_approval_invalidations where instance_id=i.id) then 'Cancelled' when t.id is null then 'Pending' when t.decision='Rejected' then 'Rejected' when t.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if i.id is null or ctx is null or i.id::text is distinct from ctx->>'instanceId' or i.batch_id::text is distinct from ctx->>'batchId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.status is distinct from expected or new.subject_employee_id is not null or new.comments is not null or new.due_at is not null then raise exception 'Generic compatibility must follow its protected invoice stage.' using errcode='IBA02';end if;return new;
end $$;
create trigger guarded_invoice_batch_approval_compatibility before insert or update or delete on approval_records for each row execute function guard_invoice_batch_approval_compatibility();

create function guard_invoice_batch_review_invalidation() returns trigger language plpgsql as $$
declare ctx jsonb;i invoice_batch_approval_instances;b invoice_draft_batches;line invoice_draft_lines;worker_id text;allow_cancel boolean;allow_withdraw boolean;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from invoice_batch_approval_instances where id=new.instance_id;select * into b from invoice_draft_batches where id=i.batch_id for update;perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);
 allow_cancel=invoice_draft_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'cancel');allow_withdraw=new.actor_id=i.requester_user_id and new.active_role=i.active_role and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'submitter');
 if ctx is null or i.id is null or b.id is null or new.id::text is distinct from ctx->>'invalidationId' or i.id::text is distinct from ctx->>'instanceId' or i.batch_id::text is distinct from ctx->>'batchId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not(allow_cancel or allow_withdraw) or invoice_batch_governed_state(b.id)<>'Under Review' or i.sequence<>(select max(x.sequence) from invoice_batch_approval_instances x where x.batch_id=b.id) then raise exception 'Only the active protected review may be withdrawn or cancelled.' using errcode='IBA02';end if;
 for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,new.actor_id,new.active_role);
  select h.employee_id into worker_id from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where v.id=line.snapshot_id;
  if not invoice_historical_worker_visible(i.organization_id,i.legal_entity_id,worker_id,new.actor_id,new.active_role) then raise exception 'Historical worker scope is required for every retained line.' using errcode='IBA01';end if;
 end loop;return new;
end $$;
create trigger guarded_invoice_batch_review_invalidation before insert on invoice_batch_approval_invalidations for each row execute function guard_invoice_batch_review_invalidation();

create function complete_invoice_batch_invalidation() returns trigger language plpgsql as $$
declare i invoice_batch_approval_instances;begin
 select * into i from invoice_batch_approval_instances where id=new.instance_id;
 if i.id is null or not(invoice_draft_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'cancel') or(new.actor_id=i.requester_user_id and new.active_role=i.active_role and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'submitter'))) or exists(select 1 from invoice_draft_lines l join commercial_tm_valuations v on v.id=l.snapshot_id join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where l.batch_id=i.batch_id and not invoice_historical_worker_visible(i.organization_id,i.legal_entity_id,h.employee_id,new.actor_id,new.active_role)) or not exists(select 1 from approval_records a where a.entity_type='InvoiceBatchApproval' and a.entity_id=i.id::text and a.status='Cancelled') or not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Batch Approval' and a.action='Cancel Review' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('invalidationId',new.id,'instanceId',i.id,'batchId',i.batch_id)) then raise exception 'Review invalidation, authority and audit must commit together.' using errcode='IBA03';end if;return null;
end $$;
create constraint trigger complete_invoice_batch_invalidation after insert on invoice_batch_approval_invalidations deferrable initially deferred for each row execute function complete_invoice_batch_invalidation();

create function guard_invoice_batch_notice_read() returns trigger language plpgsql as $$
declare ctx jsonb;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or new.user_id::text is distinct from ctx->>'actorId' or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles role on role.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id join invoice_batch_approval_recipients r on r.user_id=u.id join invoice_batch_approval_notices ev on ev.id=r.event_id join invoice_batch_approval_instances i on i.id=ev.instance_id where u.id=new.user_id and u.status='Active' and role.name=ctx->>'activeRole' and sc.organization_id=ctx->>'organizationId' and sc.legal_entity_id=ctx->>'legalEntityId' and sc.active and i.organization_id=sc.organization_id and i.legal_entity_id=sc.legal_entity_id and r.id=new.recipient_id and r.in_app and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=u.id and g.permission_key='notifications.view'))) then raise exception 'Only the current named recipient may acknowledge this notice.' using errcode='IBA01';end if;return new;
end $$;
create trigger guarded_invoice_batch_notice_read before insert on invoice_batch_approval_reads for each row execute function guard_invoice_batch_notice_read();
