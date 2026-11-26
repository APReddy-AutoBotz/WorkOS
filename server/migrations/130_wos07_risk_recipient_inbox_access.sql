-- Required named recipients must be able to open the governed inbox in their selected role.
create or replace function engagement_risk_recipients(required_model text,org text,entity text,eng text,manager uuid,manager_role text,finance uuid,finance_role text)
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
   where invoice_notice_named_recipient(org,entity,x.id,x.role_name)
     and invoice_notice_actor_has(org,entity,x.id,x.role_name,'commercial.contracts.view')
     and rate_candidate_worker_visible(jsonb_build_object('actorId',x.id,'activeRole',x.role_name,'organizationId',org,'legalEntityId',entity),x.owner_id)
 )
 select id,relationships.reason from relationships where (select count(*) from relationships)=3
   and exists(select from owners o join user_roles ur on ur.user_id=o.id join roles held on held.id=ur.role_id
     where invoice_notice_named_recipient(org,entity,o.id,held.name))
$$;
