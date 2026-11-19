-- Intake only. An original exported line can have one full-reversal request.
create table invoice_line_reversal_requests (
  id uuid primary key,
  organization_id text not null,
  legal_entity_id text not null,
  line_id uuid not null unique references invoice_draft_lines(id),
  artifact_id uuid not null references invoice_csv_artifacts(id),
  confirmation_id uuid references invoice_batch_confirmations(id),
  actor_id uuid not null references users(id),
  active_role text not null,
  reason text not null check (reason=btrim(reason) and length(reason) between 3 and 1000),
  operation_id text not null,
  created_at timestamptz not null default clock_timestamp()
);

create function guard_invoice_line_reversal_request() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from invoice_draft_lines l
    join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id
    join invoice_csv_artifacts a on a.batch_id=l.batch_id
    left join invoice_batch_confirmations c on c.artifact_id=a.id
    where l.id=new.line_id and a.id=new.artifact_id and l.organization_id=new.organization_id
      and l.legal_entity_id=new.legal_entity_id and c.id is not distinct from new.confirmation_id
  ) then raise exception 'Reversal request requires the retained occupied export line' using errcode='23514'; end if;
  return new;
end $$;

create trigger verify_invoice_line_reversal_request before insert on invoice_line_reversal_requests
for each row execute function guard_invoice_line_reversal_request();
create trigger immutable_invoice_line_reversal_request before update or delete on invoice_line_reversal_requests
for each row execute function reject_commercial_draft_rewrite();

create function require_invoice_line_reversal_audit() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from audit_logs a
    join invoice_csv_artifacts artifact on artifact.id=new.artifact_id
    where a.operation_id=new.operation_id and a.entity_id=new.id::text
      and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id
      and a.user_id=new.actor_id::text and a.active_role=new.active_role
      and a.module='Invoice Corrections' and a.action='Request Full Line Reversal'
      and a.entity_type='Invoice Line Reversal Request' and a.reason=new.reason
      and a.new_value=jsonb_build_object('requestId',new.id,'lineId',new.line_id,'artifactId',new.artifact_id,
        'confirmationId',new.confirmation_id,'batchId',artifact.batch_id,'sha256',artifact.sha256)
  ) then raise exception 'Reversal request requires matching audit evidence' using errcode='23514'; end if;
  return null;
end $$;
create constraint trigger require_invoice_line_reversal_audit after insert on invoice_line_reversal_requests
deferrable initially deferred for each row execute function require_invoice_line_reversal_audit();
