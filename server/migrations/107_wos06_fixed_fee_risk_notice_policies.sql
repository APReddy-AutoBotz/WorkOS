insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_risk.configure','Commercial','Configure fixed-fee risk notices','Set scoped mandatory recipients and the engagement notice template.',false);

create table fixed_fee_risk_notice_policies (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, engagement_id text not null,
 version integer not null check(version>0), effective_from date not null,
 manager_id uuid not null references users(id), manager_role text not null,
 finance_id uuid not null references users(id), finance_role text not null,
 locale text not null check(length(locale) between 2 and 64),
 title text not null check(length(trim(title)) between 1 and 200),
 body text not null check(length(trim(body)) between 1 and 2000),
 actor_id uuid not null references users(id), active_role text not null, operation_id text not null,
 reason text not null check(length(trim(reason)) between 3 and 1000),
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,engagement_id,version),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create trigger immutable_fixed_fee_risk_policy before update or delete on fixed_fee_risk_notice_policies
 for each row execute function reject_commercial_draft_rewrite();

-- An account can qualify under several held roles. The owner relationship still
-- resolves to a single user. The other relationships bind a specific held role.
create function fixed_fee_risk_recipients(org text,entity text,eng text,manager uuid,manager_role text,finance uuid,finance_role text)
returns table(user_id uuid,reason text) language sql stable as $$
 with eligible as (
   select distinct u.id, r.name as role_name, e.id as worker_id, c.owner_id
   from commercial_engagements c
   join employees e on e.organization_id=c.organization_id and e.legal_entity_id=c.legal_entity_id
   join users u on u.employee_record_id=e.id
   join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
   where c.organization_id=org and c.legal_entity_id=entity and c.id=eng and c.model='fixed_fee'
     and e.status in ('Active','On Leave')
     and coalesce(e.joining_date,'-infinity'::date)<=(now() at time zone 'UTC')::date
     and coalesce(e.exit_date,'infinity'::date)>=(now() at time zone 'UTC')::date
     and (e.id=c.owner_id or u.id in (manager,finance))
     and invoice_notice_actor_has(org,entity,u.id,r.name,'notifications.view')
 ), owners as (select distinct id from eligible where worker_id=owner_id),
 relationships as (
   select id,'engagement_owner' as reason from owners where (select count(*) from owners)=1
   union all
   select x.id, named.reason from (values(manager,manager_role,'commercial_manager'),(finance,finance_role,'finance_billing_owner'))
     as named(id,role_name,reason) join eligible x on x.id=named.id and x.role_name=named.role_name
   where invoice_notice_actor_has(org,entity,x.id,x.role_name,'commercial.contracts.view')
     and rate_candidate_worker_visible(jsonb_build_object('actorId',x.id,'activeRole',x.role_name,'organizationId',org,'legalEntityId',entity),x.owner_id)
 )
 select id,relationships.reason from relationships where (select count(*) from relationships)=3
$$;

create function guard_fixed_fee_risk_policy() returns trigger language plpgsql as $$
declare prior fixed_fee_risk_notice_policies; ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.risk_notice_policy_context',true),'')::jsonb;
 if ctx is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'role',new.active_role,'organization',new.organization_id,'entity',new.legal_entity_id,'engagement',new.engagement_id,'operation',new.operation_id)
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.fixed_fee_risk.configure')
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
   or not exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id
     and rate_candidate_worker_visible(jsonb_build_object('actorId',new.actor_id,'activeRole',new.active_role,'organizationId',new.organization_id,'legalEntityId',new.legal_entity_id),e.owner_id))
 then raise exception 'Current scoped configuration authority required.' using errcode='FRN01'; end if;
 perform pg_advisory_xact_lock(hashtextextended('fixed-fee-risk-policy:'||new.engagement_id,0));
 select * into prior from fixed_fee_risk_notice_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and engagement_id=new.engagement_id order by version desc limit 1;
 if new.version<>coalesce(prior.version,0)+1 or new.effective_from<(now() at time zone 'UTC')::date or new.effective_from<prior.effective_from
 then raise exception 'Prospective notice policy version required.' using errcode='FRN02'; end if;
 if not exists(select from fixed_fee_risk_recipients(new.organization_id,new.legal_entity_id,new.engagement_id,new.manager_id,new.manager_role,new.finance_id,new.finance_role))
 then raise exception 'Current scoped recipients required.' using errcode='FRN03'; end if;
 return new;
end $$;
create trigger validate_fixed_fee_risk_policy before insert on fixed_fee_risk_notice_policies
 for each row execute function guard_fixed_fee_risk_policy();
