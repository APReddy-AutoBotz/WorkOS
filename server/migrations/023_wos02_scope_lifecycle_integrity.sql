-- WOS-02 correction: database scope and effective-date integrity.
-- Existing invalid ownership or overlapping history deliberately makes this
-- migration fail closed rather than silently reassigning authoritative data.

create extension if not exists btree_gist;

create unique index if not exists uq_legal_entities_org_id on legal_entities(organization_id, id);
create unique index if not exists uq_employees_org_legal_id on employees(organization_id, legal_entity_id, id);
create unique index if not exists uq_employees_org_id on employees(organization_id, id);
create unique index if not exists uq_clients_org_id on clients(organization_id, id);
create unique index if not exists uq_projects_org_id on projects(organization_id, id);

alter table user_organization_scopes
  add constraint user_scopes_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table employees
  add constraint employees_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table clients
  add constraint clients_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table projects
  add constraint projects_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table organization_catalog_items
  add constraint organization_catalog_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table working_calendars
  add constraint working_calendars_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table reporting_periods
  add constraint reporting_periods_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table worker_profiles
  add constraint worker_profiles_organization_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities(organization_id, id) on delete restrict;
alter table worker_profiles
  add constraint worker_profiles_employee_scope_fk
  foreign key (organization_id, legal_entity_id, employee_id)
  references employees(organization_id, legal_entity_id, id) on delete restrict;

alter table project_allocations
  add constraint project_allocations_project_scope_fk
  foreign key (organization_id, project_id)
  references projects(organization_id, id) on delete restrict;
alter table project_allocations
  add constraint project_allocations_employee_scope_fk
  foreign key (organization_id, employee_id)
  references employees(organization_id, id) on delete restrict;
alter table timesheets
  add constraint timesheets_employee_scope_fk
  foreign key (organization_id, employee_id)
  references employees(organization_id, id) on delete restrict;

alter table organization_catalog_items
  add constraint organization_catalog_versions_no_overlap
  exclude using gist (
    organization_id with =,
    coalesce(legal_entity_id, '') with =,
    catalog_type with =,
    code with =,
    daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') with &&
  );

alter table worker_history
  add constraint worker_history_versions_no_overlap
  exclude using gist (
    employee_id with =,
    daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') with &&
  );
