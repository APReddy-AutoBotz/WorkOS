-- Both engagement types use the same immutable recipient-policy revisions. Configuration grants remain model-specific.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_margin_risk.configure','Commercial','Configure managed-service margin notices','Set mandatory margin breach recipients and the engagement notice template.',false);

create function engagement_risk_recipients(required_model text,org text,entity text,eng text,manager uuid,manager_role text,finance uuid,finance_role text)
returns table(user_id uuid,reason text) language sql stable as $$
 with eligible as (
   select distinct u.id, r.name as role_name, e.id as worker_id, c.owner_id
   from commercial_engagements c
   join employees e on e.organization_id=c.organization_id and e.legal_entity_id=c.legal_entity_id
   join users u on u.employee_record_id=e.id
   join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
   where c.organization_id=org and c.legal_entity_id=entity and c.id=eng and c.model=required_model and required_model in ('fixed_fee','managed_service')
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
   and exists(select from owners o join user_roles ur on ur.user_id=o.id join roles held on held.id=ur.role_id
     where invoice_notice_named_recipient(org,entity,o.id,held.name))
$$;

create or replace function fixed_fee_risk_recipients(org text,entity text,eng text,manager uuid,manager_role text,finance uuid,finance_role text)
returns table(user_id uuid,reason text) language sql stable as $$
 select * from engagement_risk_recipients('fixed_fee',org,entity,eng,manager,manager_role,finance,finance_role)
$$;

create or replace function guard_fixed_fee_risk_policy() returns trigger language plpgsql as $$
declare prior fixed_fee_risk_notice_policies; ctx jsonb; engagement_model text; required_grant text;
begin
 select model into engagement_model from commercial_engagements where organization_id=new.organization_id
   and legal_entity_id=new.legal_entity_id and id=new.engagement_id;
 required_grant:=case engagement_model when 'fixed_fee' then 'commercial.fixed_fee_risk.configure'
   when 'managed_service' then 'commercial.service_margin_risk.configure' end;
 if required_grant is null then raise exception 'Risk configuration unavailable.' using errcode='FRN01'; end if;
 ctx:=nullif(current_setting('workos.risk_notice_policy_context',true),'')::jsonb;
 if ctx is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'role',new.active_role,'organization',new.organization_id,'entity',new.legal_entity_id,'engagement',new.engagement_id,'operation',new.operation_id)
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,required_grant)
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
   or not exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id
     and rate_candidate_worker_visible(jsonb_build_object('actorId',new.actor_id,'activeRole',new.active_role,'organizationId',new.organization_id,'legalEntityId',new.legal_entity_id),e.owner_id))
 then raise exception 'Current scoped configuration authority required.' using errcode='FRN01'; end if;
 perform pg_advisory_xact_lock(hashtextextended('fixed-fee-risk-policy:'||new.engagement_id,0));
 select * into prior from fixed_fee_risk_notice_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and engagement_id=new.engagement_id order by version desc limit 1;
 if new.version<>coalesce(prior.version,0)+1 or new.effective_from<(now() at time zone 'UTC')::date or new.effective_from<prior.effective_from
 then raise exception 'Prospective notice policy version required.' using errcode='FRN02'; end if;
 if not exists(select from engagement_risk_recipients(engagement_model,new.organization_id,new.legal_entity_id,new.engagement_id,new.manager_id,new.manager_role,new.finance_id,new.finance_role))
 then raise exception 'Current scoped recipients required.' using errcode='FRN03'; end if;
 return new;
end $$;
