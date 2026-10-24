-- Optional references only; additive and neutral for all existing work/history.
alter table timesheet_entries add column evidence_url text;
alter table timesheet_entries add constraint timesheet_entry_evidence_url_shape check (
 evidence_url is null or (
  length(evidence_url) between 1 and 2048
  and evidence_url ~* '^https?://[^/?#[:space:]\\]+([/?#][^[:space:]\\]*)?$'
  and evidence_url !~ '[[:cntrl:]]'
 )
);
-- The existing complete-row work_capture_write_token includes this new column.
-- Existing immutable submission JSON is intentionally not rewritten/backfilled.
