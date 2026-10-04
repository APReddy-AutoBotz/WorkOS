-- WOS-02 correction: make canonical timesheet identity organization scoped.
-- The employee ownership foreign key established by migration 023 prevents a
-- timesheet from being assigned to an employee in another organization.
alter table timesheets drop constraint if exists timesheets_employee_id_week_ending_key;
create unique index if not exists uq_timesheets_org_employee_week
  on timesheets (organization_id, employee_id, week_ending);
