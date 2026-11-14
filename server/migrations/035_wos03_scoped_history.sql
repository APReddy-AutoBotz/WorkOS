alter table audit_logs add column organization_id text;
alter table audit_logs add column legal_entity_id text;
alter table import_export_logs add column organization_id text;
alter table import_export_logs add column legal_entity_id text;
alter table integration_event_logs add column organization_id text;
alter table integration_event_logs add column legal_entity_id text;
alter table teams_action_tokens add column organization_id text;
alter table teams_action_tokens add column legal_entity_id text;

alter table audit_logs add constraint audit_logs_scope_pair_check
  check ((organization_id is null) = (legal_entity_id is null));
alter table import_export_logs add constraint import_export_logs_scope_pair_check
  check ((organization_id is null) = (legal_entity_id is null));
alter table integration_event_logs add constraint integration_event_logs_scope_pair_check
  check ((organization_id is null) = (legal_entity_id is null));
alter table teams_action_tokens add constraint teams_action_tokens_scope_pair_check
  check ((organization_id is null) = (legal_entity_id is null));

alter table audit_logs add constraint audit_logs_scope_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities (organization_id, id)
  on delete restrict;
alter table import_export_logs add constraint import_export_logs_scope_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities (organization_id, id)
  on delete restrict;
alter table integration_event_logs add constraint integration_event_logs_scope_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities (organization_id, id)
  on delete restrict;
alter table teams_action_tokens add constraint teams_action_tokens_scope_legal_entity_fk
  foreign key (organization_id, legal_entity_id)
  references legal_entities (organization_id, id)
  on delete restrict;

create index audit_logs_scope_created_at_idx
  on audit_logs (organization_id, legal_entity_id, created_at desc)
  where organization_id is not null;
create index import_export_logs_scope_created_at_idx
  on import_export_logs (organization_id, legal_entity_id, created_at desc)
  where organization_id is not null;
create index integration_event_logs_scope_created_at_idx
  on integration_event_logs (organization_id, legal_entity_id, created_at desc)
  where organization_id is not null;
create index teams_action_tokens_scope_open_expiry_idx
  on teams_action_tokens (organization_id, legal_entity_id, expires_at)
  where organization_id is not null and used_at is null;
