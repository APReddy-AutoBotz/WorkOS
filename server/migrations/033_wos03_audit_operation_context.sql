alter table audit_logs add column if not exists correlation_id text;
alter table audit_logs add column if not exists operation_id text;

create index if not exists audit_logs_correlation_id_idx
  on audit_logs (correlation_id)
  where correlation_id is not null;

create index if not exists audit_logs_operation_id_idx
  on audit_logs (operation_id)
  where operation_id is not null;
