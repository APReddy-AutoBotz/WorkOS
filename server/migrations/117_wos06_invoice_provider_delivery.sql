-- Persist the destination and exact delivery before any outbound request.
alter table invoice_csv_failures drop constraint invoice_csv_failures_code_check;
alter table invoice_csv_failures add check (code in ('ARTIFACT_GENERATION_FAILED','PROVIDER_DELIVERY_UNCONFIRMED','PROVIDER_DELIVERY_REJECTED'));
insert into permission_definitions(permission_key,module,label,description,protected)
values ('commercial.invoice_export.deliver','Commercial','Deliver approved invoices',
        'Send an approved invoice payload to the configured finance provider.',false);

create table invoice_provider_exports (
  id uuid primary key,
  batch_id uuid not null unique references invoice_draft_batches(id),
  organization_id text not null,
  legal_entity_id text not null,
  actor_id uuid not null references users(id),
  active_role text not null,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  destination_hash text not null check (destination_hash ~ '^[a-f0-9]{64}$'),
  approval_id uuid not null references invoice_batch_approval_instances(id),
  final_transition_id uuid not null references invoice_batch_approval_transitions(id),
  lineage_hash text not null check (lineage_hash ~ '^[a-f0-9]{64}$'),
  schema_version text not null,
  payload bytea not null,
  sha256 text generated always as (encode(digest(payload,'sha256'),'hex')) stored,
  line_count integer not null check (line_count > 0),
  currency text not null,
  total numeric not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  unique(organization_id,legal_entity_id,actor_id,request_id)
);

create table invoice_provider_attempts (
  id uuid primary key,
  export_id uuid not null references invoice_provider_exports(id),
  actor_id uuid not null references users(id),
  active_role text not null,
  attempted_at timestamptz not null default clock_timestamp(),
  result text not null check (result in ('unconfirmed','accepted','permanently_rejected')),
  -- Successful delivery and its immutable local artifact commit together.
  artifact_id uuid unique references invoice_csv_artifacts(id) deferrable initially deferred,
  check ((result = 'accepted') = (artifact_id is not null))
);
create unique index invoice_provider_single_terminal_result on invoice_provider_attempts(export_id)
  where result in ('accepted','permanently_rejected');
create trigger immutable_invoice_provider_export before update or delete on invoice_provider_exports
  for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_invoice_provider_attempt before update or delete on invoice_provider_attempts
  for each row execute function reject_commercial_draft_rewrite();

create function invoice_provider_actor_valid(b invoice_draft_batches,actor uuid,role_key text)
returns boolean language sql stable as $$
  select invoice_csv_actor_valid(b.organization_id,b.legal_entity_id,actor,role_key,'create')
    and (exists(select from role_permissions where role_name=role_key
                  and permission_key='commercial.invoice_export.deliver' and enabled)
         or exists(select from user_permission_grants where user_id=actor
                  and permission_key='commercial.invoice_export.deliver'))
    and not exists(select from invoice_draft_lines l where l.batch_id=b.id
      and not invoice_source_line_visible(b.organization_id,b.legal_entity_id,b.id,l.item_id,actor,role_key))
$$;

create function guard_invoice_provider_reservation() returns trigger language plpgsql as $$
declare b invoice_draft_batches; review invoice_batch_approval_instances; n integer; amount numeric;
begin
  select * into strict b from invoice_draft_batches where id=new.batch_id for update;
  perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role);
  if not invoice_provider_actor_valid(b,new.actor_id,new.active_role) then
    raise exception 'Scoped provider delivery authority required.' using errcode='ICV01';
  end if;
  select * into review from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1;
  select count(*),sum(l.amount) into n,amount from invoice_draft_lines l where l.batch_id=b.id;
  if invoice_batch_governed_state(b.id)<>'Approved' or review.id is distinct from new.approval_id
     or not invoice_batch_approval_pin_current(review)
     or new.final_transition_id is distinct from (select id from invoice_batch_approval_transitions
         where instance_id=review.id order by sequence desc limit 1)
     or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.lineage_hash<>review.lineage_hash
     or (new.organization_id,new.legal_entity_id)<>(b.organization_id,b.legal_entity_id)
     or new.payload is distinct from invoice_csv_bytes(b) or new.line_count<>n
     or new.currency<>b.currency or new.total is distinct from amount then
    raise exception 'Provider export requires the current approved payload.' using errcode='ICV02';
  end if;
  return new;
end $$;
create trigger guarded_invoice_provider_reservation before insert on invoice_provider_exports
  for each row execute function guard_invoice_provider_reservation();

create function check_invoice_provider_receipt() returns trigger language plpgsql as $$
begin
  if new.result='permanently_rejected' and not exists(
    select from invoice_provider_exports e join invoice_csv_failures f on f.batch_id=e.batch_id
    join audit_logs a on a.operation_id=f.operation_id and a.entity_id=e.id::text
    where e.id=new.export_id and f.id=new.id and f.code='PROVIDER_DELIVERY_REJECTED'
      and f.actor_id=new.actor_id and f.active_role=new.active_role
      and a.module='Invoice Export' and a.action='Record provider delivery result'
      and a.new_value->>'attemptId'=new.id::text and a.new_value->>'deliveryStatus'=new.result
  ) then raise exception 'A permanent rejection requires its audited provider failure.' using errcode='ICV02';
  end if;
  if new.result='accepted' and not exists(
    select from invoice_provider_exports e join invoice_csv_artifacts a on a.batch_id=e.batch_id
    where e.id=new.export_id and a.id=new.artifact_id and a.sha256=e.sha256
      and a.line_count=e.line_count and a.total=e.total and a.currency=e.currency
      and a.schema_version=e.schema_version and a.approval_id=e.approval_id
      and a.final_transition_id=e.final_transition_id and a.lineage_hash=e.lineage_hash
  ) then raise exception 'Accepted delivery requires its matching retained artifact.' using errcode='ICV02';
  end if;
  return null;
end $$;
create constraint trigger complete_invoice_provider_receipt after insert on invoice_provider_attempts
  deferrable initially deferred for each row execute function check_invoice_provider_receipt();

-- Serialize cancellation, CSV and provider claims on the same batch lock.
create function guard_reserved_invoice_export() returns trigger language plpgsql as $$
declare reservation invoice_provider_exports;
begin
  perform 1 from invoice_draft_batches where id=new.batch_id for update;
  select * into reservation from invoice_provider_exports where batch_id=new.batch_id;
  if not found then return new; end if;
  if tg_table_name='invoice_draft_cancellations' and exists(
    select from invoice_provider_attempts where export_id=reservation.id and result='permanently_rejected'
  ) then return new; end if;
  if tg_table_name='invoice_draft_cancellations' then
    raise exception 'Reconcile the pending provider delivery before cancellation.' using errcode='IPD01';
  end if;
  if tg_table_name='invoice_csv_artifacts' then
    if new.payload=reservation.payload and new.schema_version=reservation.schema_version
       and exists(select from invoice_provider_attempts where export_id=reservation.id and artifact_id=new.id) then
      return new;
    end if;
  end if;
  raise exception 'Reconcile the reserved provider delivery first.' using errcode='ICV02';
end $$;
create trigger guard_reserved_invoice_csv before insert on invoice_csv_artifacts
  for each row execute function guard_reserved_invoice_export();
create trigger guard_reserved_invoice_cancel before insert on invoice_draft_cancellations
  for each row execute function guard_reserved_invoice_export();
