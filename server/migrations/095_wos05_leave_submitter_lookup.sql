-- Retained submission audit is the authoritative legacy submitter identity.
-- Keep approval checks bounded as the append-only audit ledger grows.
create index audit_logs_leave_submit_actor_idx on audit_logs(entity_id, user_id)
where entity_type='LeaveRequest' and module='Leave' and action='Submit Leave';
