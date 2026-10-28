-- Opt-in definitions only. No roles, users or buyer policies are granted.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.invoice_export.view','Commercial','View invoice CSV artifacts','Retrieve scoped retained invoice-ready CSV artifact bytes.',false),
 ('commercial.invoice_export.create','Commercial','Create invoice CSV artifacts','Accept one approved scoped invoice-ready CSV artifact.',false);

create table invoice_csv_artifacts(
 id uuid primary key,batch_id uuid not null unique references invoice_draft_batches(id),organization_id text not null,legal_entity_id text not null,approval_id uuid not null references invoice_batch_approval_instances(id),final_transition_id uuid not null references invoice_batch_approval_transitions(id),lineage_hash text not null check(lineage_hash~'^[a-f0-9]{64}$'),schema_version text not null check(schema_version='workos.invoice-tm-csv/1'),version int not null check(version=1),payload bytea not null,sha256 text not null check(sha256~'^[a-f0-9]{64}$'),line_count int not null check(line_count>0),currency text not null check(currency~'^[A-Z]{3}$'),total numeric not null check(total>0),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,generated_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table invoice_csv_failures(
 id uuid primary key,batch_id uuid not null references invoice_draft_batches(id),organization_id text not null,legal_entity_id text not null,actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),code text not null check(code='ARTIFACT_GENERATION_FAILED'),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,actor_id,request_id)
);
-- One shared request namespace makes success/failure races across batches
-- mutually exclusive, including paths that do not use the HTTP advisory lock.
create table invoice_csv_request_keys(
 organization_id text not null, legal_entity_id text not null, actor_id uuid not null references users(id), request_id uuid not null,
 result_kind text not null check(result_kind in ('artifact','failure')), result_id uuid not null,
 primary key(organization_id,legal_entity_id,actor_id,request_id)
);
create trigger immutable_invoice_csv_request_keys before update or delete on invoice_csv_request_keys for each row execute function reject_commercial_draft_rewrite();
create function complete_invoice_csv_request_key() returns trigger language plpgsql as $$
begin
 if new.result_kind='artifact' and exists(select 1 from invoice_csv_artifacts a where a.id=new.result_id and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.actor_id=new.actor_id and a.request_id=new.request_id) then return null;end if;
 if new.result_kind='failure' and exists(select 1 from invoice_csv_failures f where f.id=new.result_id and f.organization_id=new.organization_id and f.legal_entity_id=new.legal_entity_id and f.actor_id=new.actor_id and f.request_id=new.request_id) then return null;end if;
 raise exception 'A request key must commit with its exact result.' using errcode='ICV03';
end $$;
create constraint trigger complete_invoice_csv_request_key after insert on invoice_csv_request_keys deferrable initially deferred for each row execute function complete_invoice_csv_request_key();
do $$declare t text;begin foreach t in array array['invoice_csv_artifacts','invoice_csv_failures'] loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;

-- This is the database's independent exact-byte representation. Base64 values
-- carry arbitrary UTF-8 source fields without spreadsheet formula execution;
-- consumers decode columns whose names end in _b64.
create function invoice_csv_base64(value text) returns text language sql immutable strict as $$select 'b64:'||replace(replace(encode(convert_to(value,'UTF8'),'base64'),E'\n',''),E'\r','')$$;
create function invoice_csv_bytes(b invoice_draft_batches) returns bytea language sql stable as $$
 select convert_to('schema_version,batch_id,line_id,line_sequence,item_id,item_version,event_id,snapshot_id,billing_evidence_b64,client_id_b64,contract_id_b64,engagement_id_b64,work_date,eligible_date,currency,amount,period_start,period_end,period_basis'||E'\r\n'||coalesce(string_agg(concat_ws(',', 'workos.invoice-tm-csv/1',b.id::text,l.id::text,l.sequence::text,l.item_id::text,l.item_version::text,l.event_id::text,l.snapshot_id::text,invoice_csv_base64(l.billing_evidence::text),invoice_csv_base64(b.client_id),invoice_csv_base64(b.contract_id),invoice_csv_base64(b.engagement_id),l.billing_evidence->>'workDate',ev.eligible_on::text,l.currency,trim_scale(l.amount)::text,b.period_start::text,b.period_end::text,b.period_basis)||E'\r\n','' order by l.sequence),''),'UTF8')
 from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id and ev.organization_id=l.organization_id and ev.legal_entity_id=l.legal_entity_id where l.batch_id=b.id
$$;

create function invoice_csv_actor_valid(org text,legal text,who uuid,role_name text,kind text) returns boolean language plpgsql stable as $$
declare k text;keys text[];begin
 if kind not in('view','create') or not invoice_draft_actor_valid(org,legal,who,role_name,'view') then return false;end if;
 keys=case when kind='create' then array['commercial.invoice_export.view','commercial.invoice_export.create'] else array['commercial.invoice_export.view'] end;
 foreach k in array keys loop if not exists(select 1 from role_permissions rp where rp.role_name=invoice_csv_actor_valid.role_name and rp.permission_key=k and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=k) then return false;end if;end loop;return true;
end $$;

-- A retained accepted artifact is the sole transition to Exported. Existing
-- prior approval, cancellation and immutable source rows are not rewritten.
create or replace function invoice_batch_governed_state(batch uuid) returns text language plpgsql stable as $$
declare i invoice_batch_approval_instances;p invoice_batch_approval_policies;last_decision text;n int;begin
 if exists(select 1 from invoice_csv_artifacts where batch_id=batch) then return 'Exported';end if;
 if exists(select 1 from invoice_draft_cancellations where batch_id=batch) then return 'Cancelled';end if;
 select * into i from invoice_batch_approval_instances where batch_id=batch order by sequence desc limit 1;
 if i.id is null then return 'Draft';end if;
 select * into p from invoice_batch_approval_policies where id=i.policy_id;select count(*)::int into n from invoice_batch_approval_transitions where instance_id=i.id;select decision into last_decision from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if last_decision='Approved' and n=jsonb_array_length(p.definition->'stages') then return 'Approved';end if;
 if last_decision='Rejected' or exists(select 1 from invoice_batch_approval_invalidations where instance_id=i.id) then return 'Draft';end if;return 'Under Review';
end $$;
create or replace function guard_invoice_batch_review_boundary() returns trigger language plpgsql as $$
declare state text;begin
 state=invoice_batch_governed_state(new.batch_id);
 if tg_table_name='invoice_draft_lines' and state<>'Draft' then raise exception 'A reviewed batch cannot acquire another line.' using errcode='IBA02';end if;
 if tg_table_name='invoice_draft_cancellations' and state not in('Draft','Approved') then raise exception 'The review must be retired and exported batches cannot be cancelled.' using errcode='IBA02';end if;return new;
end $$;

create function guard_invoice_csv_append() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;i invoice_batch_approval_instances;p invoice_batch_approval_policies;t invoice_batch_approval_transitions;l invoice_draft_lines;v_count int;v_total numeric;begin
 begin ctx=nullif(current_setting('workos.invoice_csv_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id for update;perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if b.id is null or ctx is null or new.batch_id::text is distinct from ctx->>'batchId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or b.organization_id<>new.organization_id or b.legal_entity_id<>new.legal_entity_id or invoice_batch_governed_state(b.id)<>'Approved' or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'create') then raise exception 'An authorized current approved batch is required.' using errcode='ICV01';end if;
 insert into invoice_csv_request_keys(organization_id,legal_entity_id,actor_id,request_id,result_kind,result_id) values(new.organization_id,new.legal_entity_id,new.actor_id,new.request_id,case when tg_table_name='invoice_csv_artifacts' then 'artifact' else 'failure' end,new.id);
 for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,l.snapshot_id,new.actor_id,new.active_role);
  if not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,new.actor_id,new.active_role) then raise exception 'Current worker scope is required for every retained line.' using errcode='ICV01';end if;
  perform 1 from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where v.id=l.snapshot_id for share of h,te;
 end loop;
 select * into i from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1;select * into p from invoice_batch_approval_policies where id=i.policy_id;select * into t from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if i.id is not null then perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,l.snapshot_id,i.owner_user_id,i.owner_role);perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,l.snapshot_id,i.requester_user_id,i.active_role);end loop;end if;
 if i.id is null or p.id is null or t.id is null or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or not invoice_batch_approval_pin_current(i) or i.lineage_hash<>invoice_batch_lineage_hash(b.id) then raise exception 'A current final approval and retained source are required.' using errcode='ICV02';end if;
 if tg_table_name='invoice_csv_failures' then if new.id::text is distinct from ctx->>'failureId' or exists(select 1 from invoice_csv_artifacts a where a.batch_id=b.id) then raise exception 'Only an unaccepted approved operation may record failure.' using errcode='ICV02';end if;return new;end if;
 select count(*)::int,coalesce(sum(amount),0) into v_count,v_total from invoice_draft_lines where batch_id=b.id;
 if new.id::text is distinct from ctx->>'artifactId' or i.id is null or p.id is null or t.id is null or new.approval_id<>i.id or new.final_transition_id<>t.id or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or not invoice_batch_approval_pin_current(i) or new.lineage_hash<>i.lineage_hash or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.line_count<>v_count or new.total<>v_total or new.currency<>b.currency or new.payload is distinct from invoice_csv_bytes(b) or new.sha256<>encode(digest(new.payload,'sha256'),'hex') then raise exception 'Final approval, source lineage, bytes and control totals must match.' using errcode='ICV02';end if;return new;
end $$;
create trigger guarded_invoice_csv_artifact before insert on invoice_csv_artifacts for each row execute function guard_invoice_csv_append();
create trigger guarded_invoice_csv_failure before insert on invoice_csv_failures for each row execute function guard_invoice_csv_append();

create function complete_invoice_csv_commit() returns trigger language plpgsql as $$
declare b invoice_draft_batches;i invoice_batch_approval_instances;v_action text;v_expected jsonb;begin
 select * into b from invoice_draft_batches where id=new.batch_id;
 if b.id is null or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'create') or exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,new.actor_id,new.active_role)) then raise exception 'Current scoped export authority must persist through commit.' using errcode='ICV03';end if;
 if tg_table_name='invoice_csv_artifacts' then
  select * into i from invoice_batch_approval_instances where id=new.approval_id;
  if invoice_batch_governed_state(b.id)<>'Exported' or i.id is null or not invoice_batch_approval_pin_current(i) or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.payload is distinct from invoice_csv_bytes(b) or new.sha256<>encode(digest(new.payload,'sha256'),'hex') or new.line_count<>(select count(*) from invoice_draft_lines where batch_id=b.id) or new.total<>(select sum(amount) from invoice_draft_lines where batch_id=b.id) or exists(select 1 from invoice_draft_cancellations where batch_id=b.id) then raise exception 'Artifact, source, occupancy and control totals must commit together.' using errcode='ICV03';end if;
  v_action='Accept CSV';v_expected=jsonb_build_object('batchId',b.id,'artifactId',new.id,'sha256',new.sha256);
 else
  select * into i from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1;
  if invoice_batch_governed_state(b.id)<>'Approved' or i.id is null or not invoice_batch_approval_pin_current(i) or i.lineage_hash<>invoice_batch_lineage_hash(b.id) or exists(select 1 from invoice_csv_artifacts where batch_id=b.id) then raise exception 'Failed generation requires a current approved batch and cannot finalize it.' using errcode='ICV03';end if;
  v_action='Record CSV Failure';v_expected=jsonb_build_object('batchId',b.id,'failureId',new.id,'code',new.code);
 end if;
 if not exists(select 1 from audit_logs a where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice CSV' and a.action=v_action and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=v_expected) then raise exception 'Artifact operation and redacted audit must commit together.' using errcode='ICV03';end if;return null;
end $$;
create constraint trigger complete_invoice_csv_artifact after insert on invoice_csv_artifacts deferrable initially deferred for each row execute function complete_invoice_csv_commit();
create constraint trigger complete_invoice_csv_failure after insert on invoice_csv_failures deferrable initially deferred for each row execute function complete_invoice_csv_commit();
