insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.project_costs.prepare','Commercial','Prepare project costs','Record a non-labor project cost for independent finance review.',false),
 ('commercial.project_costs.decide','Commercial','Approve project costs','Approve or reject independently prepared non-labor project costs.',false);

create table commercial_project_cost_entries (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, binding_id text not null,
 incurred_on date not null, reference text not null check(length(btrim(reference)) between 1 and 160 and reference=btrim(reference)),
 amount numeric(18,4) not null check(amount>0), currency text not null check(currency ~ '^[A-Z]{3}$'),
 prepared_by uuid not null references users(id), preparer_worker text not null references employees(id),
 created_at timestamptz not null default clock_timestamp(),
 decision text check(decision in ('Approved','Rejected')), decided_by uuid references users(id),
 decided_at timestamptz, decision_reason text,
 foreign key(organization_id,legal_entity_id,binding_id) references commercial_project_bindings(organization_id,legal_entity_id,id),
 check((decision is null and decided_by is null and decided_at is null and decision_reason is null)
   or (decision is not null and decided_by is not null and decided_by<>prepared_by and decided_at is not null and decision_reason is not null and length(btrim(decision_reason)) between 3 and 1000))
);
create unique index project_cost_reference_once on commercial_project_cost_entries(binding_id,lower(reference)) where decision is distinct from 'Rejected';

create function guard_commercial_project_cost() returns trigger language plpgsql as $$
declare
 ctx jsonb := nullif(current_setting('workos.project_cost',true),'')::jsonb;
 actor uuid; active_worker text; binding commercial_project_bindings%rowtype; required_grant text;
begin
 if tg_op='DELETE' then raise exception 'Cost history is immutable' using errcode='PCE02'; end if;
 actor:=(ctx->>'actor')::uuid;
 select e.id into active_worker from users u join employees e on e.id=u.employee_record_id
 where u.id=actor and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.status='Active' for share of u,e;
 required_grant:=case when tg_op='INSERT' then 'commercial.project_costs.prepare' else 'commercial.project_costs.decide' end;
 if active_worker is null or (ctx->>'id') is distinct from new.id::text or ctx->>'role' in ('Employee','TeamLead','CountryDirector','ProjectManager')
 or exists(select from unnest(array[required_grant,'commercial.contracts.view','commercial.fixed_fee_margin.view','commercial.fixed_fee_cost.view','commercial.cost_candidates.view','employees.view','reports.view_utilization']) p
 where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,actor,ctx->>'role',p) is not true)
 then raise exception 'Scoped finance authority is required' using errcode='PCE01'; end if;
 if tg_op='INSERT' then
   if new.decision is not null or new.prepared_by is distinct from actor then raise exception 'Invalid cost preparation' using errcode='PCE01'; end if;
   select * into strict binding from commercial_project_bindings where id=new.binding_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and model='fixed_fee';
   if not exists(select from commercial_project_bindings b left join lateral
     (select a.starts_on,a.ends_on from commercial_amendments a where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id and a.entity_type='Project' and a.entity_id=b.project_id and a.effective_on<=new.incurred_on order by a.sequence desc limit 1) terms on true
     where b.id=new.binding_id and new.incurred_on between coalesce(terms.starts_on,b.starts_on) and coalesce(terms.ends_on,b.ends_on))
   then raise exception 'Project cost outside approved project dates' using errcode='PCE02'; end if;
   if new.incurred_on>(now() at time zone 'UTC')::date then raise exception 'Future actual cost' using errcode='PCE02'; end if;
   new.currency:=binding.currency; new.preparer_worker:=active_worker; new.created_at:=clock_timestamp();
 else
   if old.decision is not null or new.decision is null or new.decided_by is distinct from actor or
     (to_jsonb(new)-array['decision','decided_by','decided_at','decision_reason']) is distinct from
     (to_jsonb(old)-array['decision','decided_by','decided_at','decision_reason']) then
     raise exception 'Cost source or decision has changed' using errcode='PCE02'; end if;
   if actor=old.prepared_by or active_worker=old.preparer_worker or not exists(select from users where id=old.prepared_by and employee_record_id=old.preparer_worker)
   then raise exception 'Independent finance approval required' using errcode='PCE01'; end if;
   new.decided_at:=clock_timestamp();
 end if;
 perform assert_tm_financial_period(new.organization_id,new.legal_entity_id,new.incurred_on);
 return new;
end $$;
create trigger guard_project_cost before insert or update or delete on commercial_project_cost_entries
 for each row execute function guard_commercial_project_cost();

create function require_project_cost_audit() returns trigger language plpgsql as $$
declare ctx jsonb := nullif(current_setting('workos.project_cost',true),'')::jsonb;
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=ctx->>'actor' and active_role=ctx->>'role' and operation_id::text=ctx->>'operation' and entity_id=new.id::text
   and module='Commercial Drafting' and entity_type='Project Cost' and source='Web'
   and action=coalesce(new.decision,'Prepared') and new_value=(to_jsonb(new)||jsonb_build_object('amount',trim_scale(new.amount)::text))) then
   raise exception 'Project cost requires transactional audit' using errcode='PCE02'; end if;
 return null;
end $$;
create constraint trigger project_cost_audit after insert or update on commercial_project_cost_entries
 deferrable initially deferred for each row execute function require_project_cost_audit();
