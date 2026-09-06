-- WOS-02: keep legal-entity profile and lifecycle authority effective-dated.
-- Base legal_entities values remain a compatibility projection for currently effective writes.

alter table legal_entity_profile_versions add column if not exists country_code text;
alter table legal_entity_profile_versions add column if not exists status text;
alter table legal_entity_profile_versions add column if not exists authority_effective_to date;

update legal_entity_profile_versions p
set country_code = coalesce(p.country_code, le.country_code),
    status = coalesce(p.status, le.status),
    authority_effective_to = coalesce(p.authority_effective_to, le.effective_to)
from legal_entities le
where le.id = p.legal_entity_id
  and le.organization_id = p.organization_id
  and (p.country_code is null or p.status is null or p.authority_effective_to is null);

alter table legal_entity_profile_versions alter column country_code set not null;
alter table legal_entity_profile_versions alter column status set not null;

alter table legal_entity_profile_versions drop constraint if exists legal_entity_profile_country_code_check;
alter table legal_entity_profile_versions add constraint legal_entity_profile_country_code_check
  check (country_code ~ '^[A-Z]{2}$');
alter table legal_entity_profile_versions drop constraint if exists legal_entity_profile_status_check;
alter table legal_entity_profile_versions add constraint legal_entity_profile_status_check
  check (status in ('Active', 'Inactive'));
alter table legal_entity_profile_versions drop constraint if exists legal_entity_profile_authority_range_check;
alter table legal_entity_profile_versions add constraint legal_entity_profile_authority_range_check
  check (authority_effective_to is null or authority_effective_to >= effective_from);
