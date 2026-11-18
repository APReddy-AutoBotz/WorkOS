-- One serialization row per isolated organization/legal entity. An advisory lock
-- orders writers, but a waiting repeatable-read writer retains its old snapshot.
-- Touching this row makes PostgreSQL reject a stale write with SQLSTATE 40001.
create table assignment_overlap_write_scopes (
  organization_id text not null,
  legal_entity_id text not null,
  primary key (organization_id, legal_entity_id),
  foreign key (organization_id, legal_entity_id)
    references legal_entities(organization_id, id) on delete cascade
);

create function serialize_assignment_overlap_write() returns trigger language plpgsql as $$
declare
  owner record;
begin
  for owner in
    select distinct s.org, s.entity from (values
      (case when tg_op <> 'INSERT' then old.organization_id end,
       case when tg_op <> 'INSERT' then old.legal_entity_id end),
      (case when tg_op <> 'DELETE' then new.organization_id end,
       case when tg_op <> 'DELETE' then new.legal_entity_id end)
    ) as s(org, entity)
    where s.org is not null
    order by s.org, s.entity
  loop
    insert into assignment_overlap_write_scopes (organization_id, legal_entity_id)
    values (owner.org, owner.entity)
    on conflict (organization_id, legal_entity_id) do update
      set legal_entity_id = excluded.legal_entity_id;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Run after the existing BEFORE guards which acquire the lifecycle advisory lock.
create trigger zz_serialize_assignment_overlap_source
before insert or update or delete on project_allocations
for each row execute function serialize_assignment_overlap_write();

create trigger zz_serialize_assignment_overlap_policy
before insert on assignment_overlap_policy_versions
for each row execute function serialize_assignment_overlap_write();

alter table assignment_overlap_policy_versions add constraint assignment_overlap_native_unit_status
check ((definition->>'quantityUnit') is not distinct from 'percentage'
   and (definition->>'includedStatus') is not distinct from 'Active');
