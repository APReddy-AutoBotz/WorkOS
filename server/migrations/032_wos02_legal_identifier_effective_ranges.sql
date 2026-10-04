-- WOS-02: enforce organization-scoped registration/tax identifier uniqueness
-- across overlapping effective profile ranges. Do not rewrite historical profiles
-- to repair pre-existing conflicts; fail closed and require an explicit correction.

do $$
begin
  if exists (
    select 1
    from legal_entity_profile_versions a
    join legal_entity_profile_versions b
      on a.organization_id = b.organization_id
      and a.id < b.id
      and a.registration_identifier is not null
      and a.registration_identifier = b.registration_identifier
    where daterange(a.effective_from, coalesce(a.effective_to + 1, 'infinity'::date), '[)')
       && daterange(b.effective_from, coalesce(b.effective_to + 1, 'infinity'::date), '[)')
  ) then
    raise exception using
      errcode = '23514',
      message = 'Overlapping registration-identifier effective ranges must be corrected before migration 032';
  end if;

  if exists (
    select 1
    from legal_entity_profile_versions a
    join legal_entity_profile_versions b
      on a.organization_id = b.organization_id
      and a.id < b.id
      and a.tax_identifier is not null
      and a.tax_identifier = b.tax_identifier
    where daterange(a.effective_from, coalesce(a.effective_to + 1, 'infinity'::date), '[)')
       && daterange(b.effective_from, coalesce(b.effective_to + 1, 'infinity'::date), '[)')
  ) then
    raise exception using
      errcode = '23514',
      message = 'Overlapping tax-identifier effective ranges must be corrected before migration 032';
  end if;
end
$$;

drop index if exists uq_legal_entity_registration_identity;
drop index if exists uq_legal_entity_tax_identity;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'legal_entity_profile_versions'::regclass
      and conname = 'legal_entity_registration_identifier_no_overlap'
  ) then
    alter table legal_entity_profile_versions
      add constraint legal_entity_registration_identifier_no_overlap
      exclude using gist (
        organization_id with =,
        registration_identifier with =,
        daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') with &&
      )
      where (registration_identifier is not null);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'legal_entity_profile_versions'::regclass
      and conname = 'legal_entity_tax_identifier_no_overlap'
  ) then
    alter table legal_entity_profile_versions
      add constraint legal_entity_tax_identifier_no_overlap
      exclude using gist (
        organization_id with =,
        tax_identifier with =,
        daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') with &&
      )
      where (tax_identifier is not null);
  end if;
end
$$;
