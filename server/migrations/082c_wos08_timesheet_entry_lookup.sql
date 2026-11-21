-- Scoped history reads and write-policy checks retrieve entries by header.
create index timesheet_entries_header_date_idx on timesheet_entries(timesheet_id,work_date);
