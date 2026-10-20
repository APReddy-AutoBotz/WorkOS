-- PR-007A: additive commercial drafts, immutable contract terms, neutral legacy mapping.
-- Opt-in definitions only: no role or user grants are made by this migration.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.contracts.view','Commercial','View commercial drafts','View scoped confidential contracts, engagement budgets, purchase orders and milestone drafts.',false),
 ('commercial.contracts.manage','Commercial','Manage commercial drafts','Create scoped commercial drafts and append immutable future contract terms.',false);

create unique index uq_clients_org_legal_id on clients(organization_id,legal_entity_id,id);
create unique index uq_org_catalog_org_id on organization_catalog_items(organization_id,id);

create table commercial_contracts (
 id text primary key default ('contract-' || gen_random_uuid()::text),
 organization_id text not null, legal_entity_id text not null, client_id text not null,
 number text not null, latest_version integer not null default 1 check(latest_version>0),
 status text not null default 'Draft' check(status='Draft'),
 created_by uuid not null references users(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,number), unique(organization_id,legal_entity_id,id),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,client_id) references clients(organization_id,legal_entity_id,id) on delete restrict
);
create table commercial_contract_versions (
 id text primary key default ('contract-version-' || gen_random_uuid()::text),
 organization_id text not null,legal_entity_id text not null,contract_id text not null,
 version integer not null check(version>0),effective_from date not null,
 name text not null,model text not null check(model in('time_and_materials','fixed_fee','milestone','retainer','managed_service')),
 starts_on date not null,ends_on date not null,currency text not null check(currency ~ '^[A-Z]{3}$'),
 value numeric(18,4) not null check(value>=0),billing_terms text not null,
 documents jsonb not null default '[]'::jsonb check(jsonb_typeof(documents)='array'),
 reason text not null,created_by uuid not null references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(contract_id,version),unique(contract_id,effective_from),unique(organization_id,legal_entity_id,contract_id,id),
 foreign key(organization_id,legal_entity_id,contract_id) references commercial_contracts(organization_id,legal_entity_id,id) on delete restrict,
 check(ends_on>=starts_on),check(effective_from between starts_on and ends_on)
);
alter table commercial_contracts add constraint contract_latest_version_exists foreign key(id,latest_version) references commercial_contract_versions(contract_id,version) deferrable initially deferred;

create index idx_contract_terms_effective on commercial_contract_versions(contract_id,effective_from desc);

create table commercial_engagements (
 id text primary key default ('engagement-' || gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,
 code text not null,name text not null,origin text not null default 'manual' check(origin in('manual','legacy-neutral')),
 model text not null check(model in('time_and_materials','fixed_fee','milestone','retainer','managed_service','internal','pre_sales','legacy_unclassified')),
 client_id text,contract_id text,contract_version_id text,owner_id text,attribution_id text,
 starts_on date not null,ends_on date not null,currency text check(currency ~ '^[A-Z]{3}$'),budget numeric(18,4) check(budget>=0),
 billable boolean not null default false,status text not null default 'Draft' check(status='Draft'),
 reason text not null,created_by uuid references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,code),unique(organization_id,legal_entity_id,id),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,client_id) references clients(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,contract_id,contract_version_id) references commercial_contract_versions(organization_id,legal_entity_id,contract_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,owner_id) references employees(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,attribution_id) references organization_catalog_items(organization_id,id) on delete restrict,
 check(ends_on>=starts_on),
 check((origin='legacy-neutral' and model='legacy_unclassified' and contract_id is null and contract_version_id is null and not billable)
   or (origin='manual' and model<>'legacy_unclassified' and owner_id is not null and created_by is not null and currency is not null and budget is not null
     and ((model in('internal','pre_sales') and contract_id is null and contract_version_id is null and attribution_id is not null and not billable)
       or (model in('time_and_materials','fixed_fee','milestone','retainer','managed_service') and client_id is not null and contract_id is not null and contract_version_id is not null and billable))))
);
create table commercial_purchase_orders (
 id text primary key default ('po-' || gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,
 contract_id text not null,contract_version_id text not null,number text not null,currency text not null check(currency ~ '^[A-Z]{3}$'),
 value numeric(18,4) not null check(value>=0),starts_on date not null,ends_on date not null,
 warning_threshold_percent numeric(5,2) not null check(warning_threshold_percent between 0 and 100),
 status text not null default 'Draft' check(status='Draft'),reason text not null,
 created_by uuid not null references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,number),
 foreign key(organization_id,legal_entity_id,contract_id,contract_version_id) references commercial_contract_versions(organization_id,legal_entity_id,contract_id,id) on delete restrict,
 check(ends_on>=starts_on)
);
create table commercial_milestones (
 id text primary key default ('milestone-' || gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,
 engagement_id text not null,code text not null,name text not null,due_on date not null,
 amount numeric(18,4) not null check(amount>=0),currency text not null check(currency ~ '^[A-Z]{3}$'),
 status text not null default 'Draft' check(status='Draft'),reason text not null,
 created_by uuid not null references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(engagement_id,code),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id) on delete restrict
);
create table project_engagement_mappings (
 organization_id text not null,legal_entity_id text not null,project_id text primary key,engagement_id text not null unique,
 origin text not null default 'legacy-neutral' check(origin='legacy-neutral'),
 source_snapshot jsonb not null,mapped_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,project_id) references projects(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id) on delete restrict
);
-- Do not infer T&M, a currency, a budget, a contract or billing eligibility from legacy projects.
insert into commercial_engagements(id,organization_id,legal_entity_id,code,name,origin,model,starts_on,ends_on,reason)
 select 'legacy-engagement-'||id,organization_id,legal_entity_id,'LEGACY-'||id,name,'legacy-neutral','legacy_unclassified',start_date,end_date,
 'Neutral migration snapshot; no commercial terms inferred.' from projects;
insert into project_engagement_mappings(organization_id,legal_entity_id,project_id,engagement_id,source_snapshot)
 select organization_id,legal_entity_id,id,'legacy-engagement-'||id,to_jsonb(p) from projects p;

-- Protected material evidence is separate from the general audit projection.
create table commercial_draft_events (
 id text primary key default ('commercial-event-'||gen_random_uuid()::text),
 organization_id text not null,legal_entity_id text not null,
 actor_id uuid references users(id) on delete restrict,system_identity text,active_role text not null,
 source text not null check(source in('Web','Migration')),entity_type text not null,entity_id text not null,action text not null,
 before_value jsonb,after_value jsonb not null,reason text not null,correlation_id text not null,operation_id text not null,
 created_at timestamptz not null default now(),
 check((source='Web' and actor_id is not null and system_identity is null) or (source='Migration' and actor_id is null and system_identity is not null and active_role='system')),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict
);
create index idx_commercial_event_scope on commercial_draft_events(organization_id,legal_entity_id,created_at desc);

-- Each conversion has an explicit system identity and immutable material evidence.
insert into commercial_draft_events(organization_id,legal_entity_id,actor_id,system_identity,active_role,source,entity_type,entity_id,action,
 before_value,after_value,reason,correlation_id,operation_id)
 select m.organization_id,m.legal_entity_id,null,'migration:040_wos04_commercial_drafting_foundation','system','Migration','Engagement',m.engagement_id,
 'Create Neutral Mapping',null,jsonb_build_object('mapping',to_jsonb(m),'engagement',to_jsonb(e)),
 'Neutral migration snapshot; no commercial terms inferred.','migration:040','migration:040:'||m.project_id
 from project_engagement_mappings m join commercial_engagements e on e.id=m.engagement_id;

create function reject_commercial_draft_rewrite() returns trigger language plpgsql as $$
begin raise exception 'Commercial draft/version history is immutable; use an authorized new version.' using errcode='55000'; end $$;
create trigger immutable_commercial_event before update or delete on commercial_draft_events for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_contract_terms before update or delete on commercial_contract_versions for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_engagement_draft before update or delete on commercial_engagements for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_purchase_order_draft before update or delete on commercial_purchase_orders for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_milestone_draft before update or delete on commercial_milestones for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_project_engagement_mapping before update or delete on project_engagement_mappings for each row execute function reject_commercial_draft_rewrite();
create function protect_commercial_contract_root() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'Contract roots cannot be deleted.' using errcode='55000'; end if;
 if (to_jsonb(new)-'latest_version') is distinct from (to_jsonb(old)-'latest_version') or new.latest_version<>old.latest_version+1 then
  raise exception 'Only a sequential contract version pointer may change.' using errcode='55000';
 end if;
 return new;
end $$;
create trigger immutable_contract_identity before update or delete on commercial_contracts for each row execute function protect_commercial_contract_root();
create index idx_engagement_scope on commercial_engagements(organization_id,legal_entity_id,origin,created_at desc);
create index idx_po_scope on commercial_purchase_orders(organization_id,legal_entity_id,created_at desc);
create index idx_milestone_scope on commercial_milestones(organization_id,legal_entity_id,created_at desc);
