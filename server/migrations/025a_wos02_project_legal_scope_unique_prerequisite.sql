-- WOS-02 prerequisite: provide the composite project key referenced by the
-- canonical legal-scope foreign key added in migration 026.

create unique index if not exists uq_projects_org_legal_id
  on projects(organization_id, legal_entity_id, id);
