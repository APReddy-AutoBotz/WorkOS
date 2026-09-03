alter table employees add column if not exists region text;
alter table employees add column if not exists business_unit text;
alter table employees add column if not exists reporting_manager_id text references employees(id) on delete set null;

create index if not exists idx_employees_region on employees(region);
create index if not exists idx_employees_business_unit on employees(business_unit);
create index if not exists idx_employees_reporting_manager on employees(reporting_manager_id);
