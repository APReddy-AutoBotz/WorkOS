alter table identity_provider_links add column provenance_reference text;

update identity_provider_links
set provenance_reference = 'identity-link-ref-' || gen_random_uuid()::text
where provenance_reference is null;

alter table identity_provider_links
  alter column provenance_reference set default ('identity-link-ref-' || gen_random_uuid()::text);
alter table identity_provider_links
  alter column provenance_reference set not null;

create unique index identity_provider_links_provenance_reference_uidx
  on identity_provider_links (provenance_reference);

create or replace function reject_identity_link_provenance_reference_mutation()
returns trigger language plpgsql as $$
begin
  if new.provenance_reference is distinct from old.provenance_reference then
    raise exception 'identity-link provenance reference is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger identity_provider_links_provenance_reference_immutable
before update of provenance_reference on identity_provider_links
for each row execute function reject_identity_link_provenance_reference_mutation();
