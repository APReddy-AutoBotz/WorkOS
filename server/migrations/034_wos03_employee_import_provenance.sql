alter table audit_logs add column if not exists import_batch_id uuid;
alter table audit_logs add column if not exists source_identifier text;
alter table audit_logs add column if not exists import_processing_result text;

create index if not exists audit_logs_import_batch_id_idx
  on audit_logs (import_batch_id)
  where import_batch_id is not null;
