-- WOS-02 correction: persist legal-entity ownership on allocation and timesheet
-- records so alternate write paths cannot bridge legal-entity boundaries.

alter table project_allocations add column if not exists legal_entity_id text;
update project_allocations pa
set legal_entity_id = e.legal_entity_id
from employees e
where pa.employee_id = e.id
  and pa.organization_id = e.organization_id
  and pa.legal_entity_id is null;
alter table project_allocations alter column legal_entity_id set not null;

alter table timesheets add column if not exists legal_entity_id text;
update timesheets t
set legal_entity_id = e.legal_entity_id
from employees e
where t.employee_id = e.id
  and t.organization_id = e.organization_id
  and t.legal_entity_id is null;
alter table timesheets alter column legal_entity_id set not null;

alter table project_allocations
  add constraint project_allocations_employee_legal_scope_fk
  foreign key (organization_id, legal_entity_id, employee_id)
  references employees(organization_id, legal_entity_id, id) on delete restrict;
alter table project_allocations
  add constraint project_allocations_project_legal_scope_fk
  foreign key (organization_id, legal_entity_id, project_id)
  references projects(organization_id, legal_entity_id, id) on delete restrict;
alter table timesheets
  add constraint timesheets_employee_legal_scope_fk
  foreign key (organization_id, legal_entity_id, employee_id)
  references employees(organization_id, legal_entity_id, id) on delete restrict;

create index if not exists idx_allocations_org_legal
  on project_allocations(organization_id, legal_entity_id, employee_id, project_id);
create index if not exists idx_timesheets_org_legal
  on timesheets(organization_id, legal_entity_id, employee_id, week_ending);
