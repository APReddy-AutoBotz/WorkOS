create or replace function prevent_audit_log_mutation()
returns trigger as $$
begin
  raise exception 'audit_logs are immutable; append a compensating audit record instead';
end;
$$ language plpgsql;

drop trigger if exists audit_logs_no_update on audit_logs;
create trigger audit_logs_no_update
before update on audit_logs
for each row execute function prevent_audit_log_mutation();

drop trigger if exists audit_logs_no_delete on audit_logs;
create trigger audit_logs_no_delete
before delete on audit_logs
for each row execute function prevent_audit_log_mutation();
