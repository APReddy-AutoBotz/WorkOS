-- Local development safeguard: do not install until the confirmation event,
-- guarded recipient recovery, connected UI and full acceptance are complete.
do $$ begin raise exception 'Invoice confirmation integration is incomplete'; end $$;

-- Definition only; no role or user grants and no default policy.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.invoice_batch.confirm','Commercial','Confirm downstream invoice billing','Record an explicit scoped human attestation for an exported invoice-ready artifact.',false);

create table invoice_batch_confirmations(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,batch_id uuid not null unique references invoice_draft_batches(id),artifact_id uuid not null unique references invoice_csv_artifacts(id),artifact_version int not null check(artifact_version=1),artifact_sha256 text not null check(artifact_sha256~'^[a-f0-9]{64}$'),currency text not null check(currency~'^[A-Z]{3}$'),total numeric not null check(total>0),
 confirmation_kind text not null check(confirmation_kind='MANUAL_ATTESTATION'),external_reference text not null check(length(btrim(external_reference)) between 1 and 200),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,confirmed_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create trigger immutable_invoice_batch_confirmations before update or delete on invoice_batch_confirmations for each row execute function reject_commercial_draft_rewrite();

create or replace function invoice_batch_governed_state(batch uuid) returns text language plpgsql stable as $$
declare i invoice_batch_approval_instances;p invoice_batch_approval_policies;last_decision text;n int;begin
 if exists(select 1 from invoice_batch_confirmations where batch_id=batch) then return 'Billed/Confirmed';end if;
 if exists(select 1 from invoice_csv_artifacts where batch_id=batch) then return 'Exported';end if;
 if exists(select 1 from invoice_draft_cancellations where batch_id=batch) then return 'Cancelled';end if;
 select * into i from invoice_batch_approval_instances where batch_id=batch order by sequence desc limit 1;if i.id is null then return 'Draft';end if;
 select * into p from invoice_batch_approval_policies where id=i.policy_id;select count(*)::int into n from invoice_batch_approval_transitions where instance_id=i.id;select decision into last_decision from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if last_decision='Approved' and n=jsonb_array_length(p.definition->'stages') then return 'Approved';end if;if last_decision='Rejected' or exists(select 1 from invoice_batch_approval_invalidations where instance_id=i.id) then return 'Draft';end if;return 'Under Review';
end $$;

create function guard_invoice_batch_confirmation() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;a invoice_csv_artifacts;l invoice_draft_lines;begin
 begin ctx=nullif(current_setting('workos.invoice_confirmation_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id for update;select * into a from invoice_csv_artifacts where id=new.artifact_id for share;perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if ctx is null or b.id is null or a.id is null or new.id::text is distinct from ctx->>'confirmationId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or b.organization_id<>new.organization_id or b.legal_entity_id<>new.legal_entity_id or a.batch_id<>b.id or invoice_batch_governed_state(b.id)<>'Exported' or new.artifact_version<>a.version or new.artifact_sha256<>a.sha256 or new.artifact_sha256<>encode(digest(a.payload,'sha256'),'hex') or new.currency<>a.currency or new.total<>a.total or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'view') or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.invoice_batch.confirm') then raise exception 'Exact exported artifact, scoped actor and confirmation authority are required.' using errcode='IBC01';end if;
 for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,l.snapshot_id,new.actor_id,new.active_role);if not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,new.actor_id,new.active_role) then raise exception 'Current worker scope is required for every retained line.' using errcode='IBC01';end if;end loop;return new;
end $$;
create trigger guard_invoice_batch_confirmation before insert on invoice_batch_confirmations for each row execute function guard_invoice_batch_confirmation();
-- TODO before enabling: add deferred exact-state/occupancy/audit checks and
-- canonical informational notice with visible failure and recovery evidence;
-- wire authorized API, client and role journey without provider calls.
