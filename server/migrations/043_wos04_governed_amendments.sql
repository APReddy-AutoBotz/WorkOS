-- PR-007D: explicit governed adoption, separate from immutable drafts/activation.
-- No historical work, operational identity, or financial snapshot is rewritten.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.amendments.manage','Commercial','Manage governed amendments','Opt-in effective-dated commercial adoption; also requires commercial view and lifecycle manage.',false);
create table commercial_amendments (
 id text primary key default ('amendment-'||gen_random_uuid()::text),organization_id text not null,legal_entity_id text not null,
 entity_type text not null check(entity_type in('Contract','Engagement','Project')),entity_id text not null,
 contract_id text not null,contract_version_id text not null,sequence integer not null check(sequence between 1 and 200),
 lifecycle_sequence integer not null check(lifecycle_sequence between 1 and 200),contract_version integer not null check(contract_version>0),
 effective_on date not null,starts_on date not null,ends_on date not null,budget numeric(18,4) not null check(budget>=0),
 before_value jsonb not null,after_value jsonb not null,reason text not null check(length(trim(reason)) between 3 and 1000),
 approval_reference text not null check(length(trim(approval_reference)) between 1 and 200),
 actor_id uuid not null references users(id) on delete restrict,active_role text not null,
 correlation_id text not null,operation_id text not null,created_at timestamptz not null default now(),
 unique(organization_id,legal_entity_id,entity_type,entity_id,sequence),
 unique(organization_id,legal_entity_id,entity_type,entity_id,effective_on),
 foreign key(organization_id,legal_entity_id,contract_id,contract_version_id) references commercial_contract_versions(organization_id,legal_entity_id,contract_id,id) on delete restrict,
 check(starts_on<=effective_on and effective_on<=ends_on)
);
create index idx_commercial_amendments_lookup on commercial_amendments(organization_id,legal_entity_id,entity_type,entity_id,effective_on desc);
create trigger immutable_commercial_amendment before update or delete on commercial_amendments for each row execute function reject_commercial_draft_rewrite();
create function commercial_reserved_amendment_budget(org text,legal text,kind text,entity text,baseline numeric,baseline_end date,at_date date) returns numeric language sql stable as $$
 select greatest(case when coalesce((select a.ends_on from commercial_amendments a where a.organization_id=org and a.legal_entity_id=legal and a.entity_type=kind and a.entity_id=entity and a.effective_on<=at_date order by a.sequence desc limit 1),baseline_end)>=at_date then coalesce((select a.budget from commercial_amendments a where a.organization_id=org and a.legal_entity_id=legal and a.entity_type=kind and a.entity_id=entity and a.effective_on<=at_date order by a.sequence desc limit 1),baseline) else 0 end,
  coalesce((select max(a.budget) from commercial_amendments a where a.organization_id=org and a.legal_entity_id=legal and a.entity_type=kind and a.entity_id=entity and a.effective_on>at_date),0));
$$;
create function validate_commercial_amendment_append() returns trigger language plpgsql as $$
declare prior commercial_amendments%rowtype; root_contract text; live_sequence integer;
 target commercial_contract_versions%rowtype; previous_term commercial_contract_versions%rowtype;
 root_start date;root_model text;root_currency text;old_pin text;parent_type text;parent_id text;
 parent_pin text;parent_start date;parent_end date;parent_budget numeric;parent_state text;
 sibling_budget numeric;child_budget numeric;parent_amendment commercial_amendments%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 if new.effective_on<(clock_timestamp() at time zone 'UTC')::date then raise exception 'Amendments cannot be backdated.' using errcode='23514';end if;
 select * into prior from commercial_amendments where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type=new.entity_type and entity_id=new.entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.effective_on<=prior.effective_on or prior.effective_on>(clock_timestamp() at time zone 'UTC')::date then
  raise exception 'Amendment chronology or pending version is invalid.' using errcode='23514';end if;
 if new.entity_type='Contract' then select id into root_contract from commercial_contracts where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.entity_id;
 elsif new.entity_type='Engagement' then select contract_id into root_contract from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.entity_id and origin='manual';
 else select contract_id into root_contract from commercial_project_bindings where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and project_id=new.entity_id;end if;
 if root_contract is null or root_contract<>new.contract_id then raise exception 'Scoped amendment root is unavailable.' using errcode='23503';end if;
 select sequence into live_sequence from commercial_lifecycle_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type=new.entity_type and entity_id=new.entity_id order by sequence desc limit 1;
 if live_sequence is null or live_sequence<>new.lifecycle_sequence then raise exception 'Lifecycle sequence changed.' using errcode='23514';end if;
 if not exists(select 1 from commercial_contracts where id=new.contract_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and latest_version=new.contract_version) then raise exception 'Contract version changed.' using errcode='23514';end if;
 select * into target from commercial_contract_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and contract_id=new.contract_id and id=new.contract_version_id;
 select contract_version_id into old_pin from commercial_lifecycle_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type=new.entity_type and entity_id=new.entity_id order by sequence desc limit 1;
 old_pin=coalesce(prior.contract_version_id,old_pin);
 select * into previous_term from commercial_contract_versions where id=old_pin and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and contract_id=new.contract_id;
 if target.id is null or previous_term.id is null or target.version<=previous_term.version or target.model<>previous_term.model or target.currency<>previous_term.currency
  or new.effective_on<target.effective_from or new.effective_on<target.starts_on or new.ends_on>target.ends_on then
  raise exception 'Amendment version identity or dates are invalid.' using errcode='23514';end if;
 if new.entity_type='Contract' then
  if new.starts_on<>target.starts_on or new.ends_on<>target.ends_on or new.budget<>target.value then raise exception 'Adoption must equal immutable contract terms.' using errcode='23514';end if;
 else
  if new.entity_type='Engagement' then
   select starts_on,model,currency,contract_id into root_start,root_model,root_currency,parent_id from commercial_engagements where id=new.entity_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
   parent_type='Contract';
  else
   select starts_on,model,currency,engagement_id into root_start,root_model,root_currency,parent_id from commercial_project_bindings where project_id=new.entity_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
   parent_type='Engagement';
  end if;
  if new.starts_on<>root_start or root_model<>target.model or root_currency<>target.currency then raise exception 'Historical child identity or start cannot change.' using errcode='23514';end if;
  select state,contract_version_id into parent_state,parent_pin from commercial_lifecycle_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type=parent_type and entity_id=parent_id order by sequence desc limit 1;
  if parent_state is distinct from 'Active' then raise exception 'Parent must be active.' using errcode='23514';end if;
  if exists(select 1 from commercial_amendments where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type=parent_type and entity_id=parent_id and effective_on>new.effective_on) then raise exception 'Later pending parent terms must take effect first.' using errcode='23514';end if;
  if parent_type='Contract' then select starts_on,ends_on,value into parent_start,parent_end,parent_budget from commercial_contract_versions where id=parent_pin;
  else select starts_on,ends_on,budget into parent_start,parent_end,parent_budget from commercial_engagements where id=parent_id;end if;
  select * into parent_amendment from commercial_amendments where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type=parent_type and entity_id=parent_id and effective_on<=new.effective_on order by sequence desc limit 1;
  if found then parent_pin=parent_amendment.contract_version_id;parent_start=parent_amendment.starts_on;parent_end=parent_amendment.ends_on;parent_budget=parent_amendment.budget;end if;
  if parent_pin is distinct from new.contract_version_id or new.effective_on<parent_start or new.ends_on>parent_end or new.budget>parent_budget then raise exception 'Child must fit explicitly adopted parent terms.' using errcode='23514';end if;
  if new.entity_type='Engagement' then
   select coalesce(sum(commercial_reserved_amendment_budget(new.organization_id,new.legal_entity_id,'Engagement',e.id,e.budget,e.ends_on,new.effective_on)),0) into sibling_budget from commercial_engagements e where e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.contract_id=new.contract_id and e.id<>new.entity_id and exists(select 1 from commercial_lifecycle_events l where l.entity_type='Engagement' and l.entity_id=e.id);
  else
   select coalesce(sum(commercial_reserved_amendment_budget(new.organization_id,new.legal_entity_id,'Project',p.project_id,p.budget_allocation,p.ends_on,new.effective_on)),0) into sibling_budget from commercial_project_bindings p where p.organization_id=new.organization_id and p.legal_entity_id=new.legal_entity_id and p.engagement_id=parent_id and p.project_id<>new.entity_id;
  end if;
  if new.budget+sibling_budget>parent_budget then raise exception 'Remaining sibling allocation exceeds parent budget.' using errcode='23514';end if;
 end if;
 if new.entity_type='Contract' then
  if exists(select 1 from commercial_engagements e where e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.contract_id=new.contract_id and exists(select 1 from commercial_lifecycle_events l where l.entity_type='Engagement' and l.entity_id=e.id) and coalesce((select a.ends_on from commercial_amendments a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.entity_type='Engagement' and a.entity_id=e.id and a.effective_on<=new.effective_on order by a.sequence desc limit 1),e.ends_on)>new.ends_on) then raise exception 'Remaining child dates exceed adopted contract.' using errcode='23514';end if;
  select coalesce(sum(commercial_reserved_amendment_budget(new.organization_id,new.legal_entity_id,'Engagement',e.id,e.budget,e.ends_on,new.effective_on)),0) into child_budget from commercial_engagements e where e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.contract_id=new.contract_id and exists(select 1 from commercial_lifecycle_events l where l.entity_type='Engagement' and l.entity_id=e.id) and coalesce((select a.ends_on from commercial_amendments a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.entity_type='Engagement' and a.entity_id=e.id and a.effective_on<=new.effective_on order by a.sequence desc limit 1),e.ends_on)>=new.effective_on;
 elsif new.entity_type='Engagement' then
  if exists(select 1 from commercial_project_bindings p where p.organization_id=new.organization_id and p.legal_entity_id=new.legal_entity_id and p.engagement_id=new.entity_id and coalesce((select a.ends_on from commercial_amendments a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.entity_type='Project' and a.entity_id=p.project_id and a.effective_on<=new.effective_on order by a.sequence desc limit 1),p.ends_on)>new.ends_on) then raise exception 'Remaining child dates exceed adopted engagement.' using errcode='23514';end if;
  select coalesce(sum(commercial_reserved_amendment_budget(new.organization_id,new.legal_entity_id,'Project',p.project_id,p.budget_allocation,p.ends_on,new.effective_on)),0) into child_budget from commercial_project_bindings p where p.organization_id=new.organization_id and p.legal_entity_id=new.legal_entity_id and p.engagement_id=new.entity_id and coalesce((select a.ends_on from commercial_amendments a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.entity_type='Project' and a.entity_id=p.project_id and a.effective_on<=new.effective_on order by a.sequence desc limit 1),p.ends_on)>=new.effective_on;
 end if;
 if coalesce(child_budget,0)>new.budget then raise exception 'Remaining child allocations exceed adopted budget.' using errcode='23514';end if;
 if exists(select 1 from commercial_amendments a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.effective_on>new.effective_on and (
   (new.entity_type='Contract' and a.contract_id=new.contract_id and a.entity_type<>'Contract') or
   (new.entity_type='Engagement' and a.entity_type='Project' and a.entity_id in(select p.project_id from commercial_project_bindings p where p.organization_id=new.organization_id and p.legal_entity_id=new.legal_entity_id and p.engagement_id=new.entity_id)))) then raise exception 'Later pending child amendment must take effect first.' using errcode='23514';end if;
 return new;
end $$;
create trigger validate_commercial_amendment before insert on commercial_amendments for each row execute function validate_commercial_amendment_append();
