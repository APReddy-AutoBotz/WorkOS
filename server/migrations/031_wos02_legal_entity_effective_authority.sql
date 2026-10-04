-- WOS-02: keep legal-entity profile and lifecycle authority effective-dated.
-- Base legal_entities values remain a compatibility projection for currently effective writes.

alter table legal_entity_profile_versions add column if not exists country_code text;
alter table legal_entity_profile_versions add column if not exists status text;
alter table legal_entity_profile_versions add column if not exists authority_effective_to date;

-- Migration 028 already established a deterministic legacy address countryCode fallback of US.
-- Reuse that persisted authority when the older legal_entities projection did not carry a country code.
update legal_entity_profile_versions p
set country_code = case
      when upper(coalesce(p.country_code, le.country_code, p.address->>'countryCode', '')) ~ '^[A-Z]{2}$'
        then upper(coalesce(p.country_code, le.country_code, p.address->>'countryCode'))
      else 'US'
    end,
    status = coalesce(p.status, le.status, 'Active'),
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

-- Keep the compatibility base row aligned only with the profile version that is effective now.
-- Future-dated profile versions remain history/authority only and must not change current access early.
update legal_entities le
set country_code = p.country_code,
    updated_at = now()
from legal_entity_profile_versions p
where p.legal_entity_id = le.id
  and p.organization_id = le.organization_id
  and le.country_code is null
  and current_date between p.effective_from and coalesce(p.effective_to, 'infinity'::date);
