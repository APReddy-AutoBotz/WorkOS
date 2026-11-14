alter table import_export_logs
  add column if not exists schema_version text;

alter table import_export_logs
  add column if not exists dry_run boolean not null default false;

create unique index if not exists import_export_logs_id_scope_contract_idx
  on import_export_logs (id, organization_id, legal_entity_id);

create table if not exists import_export_idempotency (
  organization_id text not null,
  legal_entity_id text not null,
  actor_id text not null check (length(actor_id) > 0),
  channel text not null check (length(channel) > 0),
  idempotency_key text not null
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash text not null
    check (request_hash ~ '^[a-f0-9]{64}$'),
  batch_id uuid not null unique,
  created_at timestamptz not null default now(),
  primary key (organization_id, legal_entity_id, actor_id, channel, idempotency_key),
  foreign key (batch_id, organization_id, legal_entity_id)
    references import_export_logs (id, organization_id, legal_entity_id)
    on delete cascade
);
