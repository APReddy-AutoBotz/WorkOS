-- For existing grants the last recorded edit is the latest provable grant boundary.
alter table approval_delegations add column if not exists granted_at timestamptz;
update approval_delegations set granted_at = updated_at where granted_at is null;
alter table approval_delegations alter column granted_at set default clock_timestamp(),
  alter column granted_at set not null;
