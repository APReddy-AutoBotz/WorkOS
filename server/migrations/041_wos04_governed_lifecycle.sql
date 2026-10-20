-- PR-007B: immutable drafting remains intact. Only append-only lifecycle and
-- explicit governed project bindings add authority; neutral mappings are untouched.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.lifecycle.manage','Commercial','Manage governed commercial lifecycle','Opt-in exact-version activation, active/on-hold lifecycle and governed project creation. Requires commercial view access.',false);

create table commercial_project_bindings (
 id text primary key default ('project-binding-'||gen_random_uuid()::text),
 organization_id text not null, legal_entity_id text not null, project_id text not null unique,
 engagement_id text not null, contract_id text, contract_version_id text,
 code text not null,name text not null,manager_id text not null,starts_on date not null,ends_on date not null,
 model text not null,currency text not null check(currency ~ '^[A-Z]{3}$'),budget_allocation numeric(18,4) not null check(budget_allocation>=0),
 billable boolean not null,attribution_id text,origin text not null check(origin in('manual','explicit-legacy-promotion')),
 source_snapshot jsonb not null,reason text not null,created_by uuid not null references users(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,id),
 foreign key(organization_id,legal_entity_id,project_id) references projects(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,contract_id,contract_version_id) references commercial_contract_versions(organization_id,legal_entity_id,contract_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,manager_id) references employees(organization_id,legal_entity_id,id) on delete restrict,
 check(ends_on>=starts_on),
 check((model in('internal','pre_sales') and not billable and attribution_id is not null and contract_id is null and contract_version_id is null)
   or (model in('time_and_materials','fixed_fee','milestone','retainer','managed_service') and contract_id is not null and contract_version_id is not null and attribution_id is null))
);
create index idx_commercial_project_engagement on commercial_project_bindings(organization_id,legal_entity_id,engagement_id);
create trigger immutable_commercial_project_binding before update or delete on commercial_project_bindings for each row execute function reject_commercial_draft_rewrite();

create table commercial_lifecycle_events (
 id text primary key default ('lifecycle-'||gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,
 entity_type text not null check(entity_type in('Contract','Engagement','Project')),entity_id text not null,
 sequence integer not null check(sequence between 1 and 200),state text not null check(state in('Active','On Hold')),
 effective_on date not null default ((now() at time zone 'UTC')::date),
 contract_id text,contract_version_id text,
 before_value jsonb,after_value jsonb not null,reason text not null,approval_reference text,
 actor_id uuid not null references users(id) on delete restrict,active_role text not null,
 correlation_id text not null,operation_id text not null,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,entity_type,entity_id,sequence),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,contract_id,contract_version_id) references commercial_contract_versions(organization_id,legal_entity_id,contract_id,id) on delete restrict,
 check((contract_id is null)=(contract_version_id is null))
);
create index idx_commercial_lifecycle_lookup on commercial_lifecycle_events(organization_id,legal_entity_id,entity_type,entity_id,sequence desc);
create trigger immutable_commercial_lifecycle before update or delete on commercial_lifecycle_events for each row execute function reject_commercial_draft_rewrite();
-- No client controlled bypass setting. Only this nested lifecycle trigger may
-- synchronize the operational status, and only the exact ledger state may change.
create function protect_governed_project_mutation() returns trigger language plpgsql as $$
declare expected text;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||old.organization_id||':'||old.legal_entity_id,0));
 if exists(select 1 from commercial_project_bindings where project_id=old.id) then
  if tg_op='UPDATE' and pg_trigger_depth()>1 then
   select state into expected from commercial_lifecycle_events where entity_type='Project' and entity_id=old.id order by sequence desc limit 1;
   if new.status=expected and (to_jsonb(new)-'status'-'updated_at')=(to_jsonb(old)-'status'-'updated_at') then return new; end if;
  end if;
  raise exception 'Use the governed project lifecycle command.' using errcode='WPG01';
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;
create trigger governed_project_mutation before update or delete on projects for each row execute function protect_governed_project_mutation();
create function project_lifecycle_status_projection() returns trigger language plpgsql as $$
begin
 if new.entity_type='Project' then
  update projects set status=new.state,updated_at=now() where id=new.entity_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
  if not found then raise exception 'Scoped project is unavailable.' using errcode='23503';end if;
 end if;
 return new;
end $$;
create trigger project_lifecycle_projection after insert on commercial_lifecycle_events for each row execute function project_lifecycle_status_projection();

-- Ledger chronology and root identity are database invariants too. No backdated
-- or scheduled command can be smuggled through a future application writer.
create function validate_commercial_lifecycle_append() returns trigger language plpgsql as $$
declare prior commercial_lifecycle_events%rowtype;root_contract text;root_version text;found_root boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 if new.effective_on<>(now() at time zone 'UTC')::date then raise exception 'Lifecycle effective date is server owned.' using errcode='23514';end if;
 select * into prior from commercial_lifecycle_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type=new.entity_type and entity_id=new.entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or (prior.id is null and new.state<>'Active') or prior.state=new.state then
  raise exception 'Lifecycle sequence or transition is invalid.' using errcode='23514';end if;
 if prior.id is not null and (new.contract_id is distinct from prior.contract_id or new.contract_version_id is distinct from prior.contract_version_id) then
  raise exception 'Lifecycle contract pin is immutable.' using errcode='23514';end if;
 if new.entity_type='Contract' then
  select true,id into found_root,root_contract from commercial_contracts where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.entity_id;
  if new.contract_id is distinct from root_contract or new.contract_version_id is null then raise exception 'Contract lifecycle pin is invalid.' using errcode='23514';end if;
 elsif new.entity_type='Engagement' then
  select true,contract_id,contract_version_id into found_root,root_contract,root_version from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.entity_id and origin='manual';
  if new.contract_id is distinct from root_contract or new.contract_version_id is distinct from root_version then raise exception 'Engagement lifecycle pin is invalid.' using errcode='23514';end if;
 else
  select true,contract_id,contract_version_id into found_root,root_contract,root_version from commercial_project_bindings where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and project_id=new.entity_id;
  if new.contract_id is distinct from root_contract or new.contract_version_id is distinct from root_version then raise exception 'Project lifecycle pin is invalid.' using errcode='23514';end if;
 end if;
 if found_root is not true then raise exception 'Scoped lifecycle root is unavailable.' using errcode='23503';end if;
 return new;
end $$;
create trigger validate_commercial_lifecycle before insert on commercial_lifecycle_events for each row execute function validate_commercial_lifecycle_append();
