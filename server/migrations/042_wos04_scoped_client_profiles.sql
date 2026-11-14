-- Customer identity is not the buyer legal entity. Legacy client rows, labels,
-- contracts, pins and neutral histories are intentionally not rewritten/backfilled.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.clients.view','Commercial','View protected client profiles','Opt-in scoped customer legal names, billing contacts, units and profile history.',false),
 ('commercial.clients.manage','Commercial','Manage protected client profiles','Opt-in append-only scoped client and customer billing profiles. Requires client-profile view access.',false);

create function valid_client_billing_contacts(value jsonb) returns boolean language sql immutable as $$
 select case when jsonb_typeof(value)='array' then jsonb_array_length(value)<=10 and not exists(
  select 1 from jsonb_array_elements(value) item where jsonb_typeof(item)<>'object'
   or not (item ? 'name' and item ? 'email') or (item-'name'-'email')<>'{}'::jsonb
   or jsonb_typeof(item->'name')<>'string' or length(btrim(item->>'name')) not between 1 and 200
   or jsonb_typeof(item->'email')<>'string' or length(item->>'email')>254
   or (item->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 ) else false end
$$;
create table client_profile_accounts (
 client_id text primary key, organization_id text not null,legal_entity_id text not null,
 code text not null check(code ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'),
 created_by uuid not null references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,client_id),unique(organization_id,legal_entity_id,code),
 foreign key(organization_id,legal_entity_id,client_id) references clients(organization_id,legal_entity_id,id) on delete restrict
);
create table client_profile_versions (
 id text primary key default ('client-profile-'||gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,client_id text not null,
 version integer not null check(version between 1 and 200),effective_from date not null,
 legal_name text check(legal_name is null or length(btrim(legal_name)) between 1 and 200),
 display_name text check(display_name is null or length(btrim(display_name)) between 1 and 200),parent_client_id text,
 default_currency text check(default_currency is null or default_currency ~ '^[A-Z]{3}$'),
 billing_contacts jsonb not null check(valid_client_billing_contacts(billing_contacts)),reason text not null check(length(btrim(reason)) between 3 and 1000),
 created_by uuid not null references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,client_id,version),unique(organization_id,legal_entity_id,client_id,effective_from),
 foreign key(organization_id,legal_entity_id,client_id) references client_profile_accounts(organization_id,legal_entity_id,client_id) on delete restrict,
 foreign key(organization_id,legal_entity_id,parent_client_id) references clients(organization_id,legal_entity_id,id) on delete restrict,
 check(parent_client_id is null or parent_client_id<>client_id)
);
create index idx_client_profile_effective on client_profile_versions(organization_id,legal_entity_id,client_id,effective_from desc);
create table client_billing_units (
 id text primary key default ('client-unit-'||gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,client_id text not null,
 code text not null check(code ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'),kind text not null check(kind in('billing_entity','business_unit')),
 created_by uuid not null references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,client_id,id),unique(organization_id,legal_entity_id,client_id,code),
 foreign key(organization_id,legal_entity_id,client_id) references client_profile_accounts(organization_id,legal_entity_id,client_id) on delete restrict
);
create table client_billing_unit_versions (
 id text primary key default ('client-unit-profile-'||gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,client_id text not null,unit_id text not null,
 version integer not null check(version between 1 and 200),effective_from date not null,
 legal_name text check(legal_name is null or length(btrim(legal_name)) between 1 and 200),
 display_name text check(display_name is null or length(btrim(display_name)) between 1 and 200),
 default_currency text check(default_currency is null or default_currency ~ '^[A-Z]{3}$'),
 billing_contacts jsonb not null check(valid_client_billing_contacts(billing_contacts)),reason text not null check(length(btrim(reason)) between 3 and 1000),
 created_by uuid not null references users(id) on delete restrict,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,unit_id,version),unique(organization_id,legal_entity_id,unit_id,effective_from),
 foreign key(organization_id,legal_entity_id,client_id,unit_id) references client_billing_units(organization_id,legal_entity_id,client_id,id) on delete restrict
);
create index idx_client_unit_effective on client_billing_unit_versions(organization_id,legal_entity_id,unit_id,effective_from desc);
create table client_profile_events (
 id text primary key default ('client-profile-event-'||gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,client_id text not null,
 entity_type text not null check(entity_type in('ClientProfile','ClientBillingUnit')),entity_id text not null,action text not null,
 before_value jsonb,after_value jsonb not null,reason text not null,actor_id uuid not null references users(id) on delete restrict,
 active_role text not null,source text not null default 'Web' check(source='Web'),correlation_id text not null,operation_id text not null,
 created_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,client_id) references client_profile_accounts(organization_id,legal_entity_id,client_id) on delete restrict
);
create index idx_client_profile_event on client_profile_events(organization_id,legal_entity_id,client_id,created_at desc);
create trigger immutable_client_profile_account before update or delete on client_profile_accounts for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_client_profile before update or delete on client_profile_versions for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_client_billing_unit before update or delete on client_billing_units for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_client_unit_profile before update or delete on client_billing_unit_versions for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_client_profile_event before update or delete on client_profile_events for each row execute function reject_commercial_draft_rewrite();

create function validate_client_profile_append() returns trigger language plpgsql as $$
declare prior_version integer;prior_date date;boundary date;has_cycle boolean;
begin
 -- Advisory serialization needs a fresh statement snapshot after the lock.
 -- Reject inherited/reused snapshots rather than allowing opposing edges at RR.
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'Client profile writes require read committed isolation.' using errcode='WCP04';end if;
 perform pg_advisory_xact_lock(hashtextextended('client-profiles:'||new.organization_id||':'||new.legal_entity_id,0));
 if tg_table_name='client_profile_versions' then
  select version,effective_from into prior_version,prior_date from client_profile_versions
   where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and client_id=new.client_id order by version desc limit 1;
 else
  select version,effective_from into prior_version,prior_date from client_billing_unit_versions
   where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and unit_id=new.unit_id order by version desc limit 1;
 end if;
 if new.version<>coalesce(prior_version,0)+1 then raise exception 'Client profile version changed.' using errcode='WCP01';end if;
 if (prior_version is null and new.effective_from<(now() at time zone 'UTC')::date)
  or (prior_version is not null and (new.effective_from<=prior_date or new.effective_from<=(now() at time zone 'UTC')::date)) then
  raise exception 'Client profile effective date is invalid.' using errcode='WCP02';end if;
 if tg_table_name='client_profile_versions' then
  -- Re-evaluate every future boundary, not just today or the inserted date.
  -- The common scope lock serializes opposing edges and prevents write skew.
  for boundary in select new.effective_from union select effective_from from client_profile_versions
   where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and effective_from>=new.effective_from loop
   with recursive candidates as (
    select client_id,parent_client_id,effective_from from client_profile_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
    union all select new.client_id,new.parent_client_id,new.effective_from
   ), edges as (select distinct on(client_id) client_id,parent_client_id from candidates where effective_from<=boundary order by client_id,effective_from desc),
   walk(node,path,cycle) as (
    select new.client_id,array[new.client_id],false
    union all select e.parent_client_id,w.path||e.parent_client_id,e.parent_client_id=any(w.path)
     from walk w join edges e on e.client_id=w.node where e.parent_client_id is not null and not w.cycle
   ) select coalesce(bool_or(cycle),false) into has_cycle from walk;
   if has_cycle then raise exception 'Client parent relationship would form a cycle.' using errcode='WCP03';end if;
  end loop;
 end if;
 return new;
end $$;
create trigger validate_client_profile before insert on client_profile_versions for each row execute function validate_client_profile_append();
create trigger validate_client_billing_profile before insert on client_billing_unit_versions for each row execute function validate_client_profile_append();
