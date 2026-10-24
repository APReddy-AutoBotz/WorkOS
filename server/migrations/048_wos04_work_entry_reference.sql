-- Optional descriptive text; no relationship, duplicate key or financial authority.
alter table timesheet_entries add column work_reference text;
alter table timesheet_entries add constraint timesheet_entry_work_reference_shape check (
 work_reference is null or (
  char_length(work_reference) between 1 and 200
  and work_reference !~ '[[:cntrl:]]'
  and work_reference !~ U&'[\2028\2029]'
 )
);
-- Full-row revisions include reference-only changes automatically.
-- Existing immutable submission JSON and evidence URLs remain unchanged.
