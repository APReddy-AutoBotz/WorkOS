create table po_risk_engagement_assignments (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, purchase_order_id text not null references commercial_purchase_order_releases(purchase_order_id),
 version integer not null check(version>0),engagement_ids text[] not null check(cardinality(engagement_ids)<=200),
 actor_id uuid not null references users(id),active_role text not null,operation_id text not null,reason text not null check(length(trim(reason)) between 3 and 1000),
 created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,purchase_order_id,version)
);
create trigger immutable_po_risk_assignments before update or delete on po_risk_engagement_assignments
 for each row execute function reject_commercial_draft_rewrite();

create function guard_po_risk_assignments() returns trigger language plpgsql as $$
declare order_contract text;latest integer;
begin
 select contract_id into order_contract from commercial_purchase_orders where id=new.purchase_order_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id for update;
 if order_contract is null or nullif(current_setting('workos.po_risk_assignment_context',true),'')::jsonb is distinct from
   jsonb_build_object('order',new.purchase_order_id,'actor',new.actor_id,'role',new.active_role,'operation',new.operation_id,'organization',new.organization_id,'entity',new.legal_entity_id)
   or exists(select from unnest(array['commercial.contracts.view','commercial.contracts.manage','commercial.purchase_orders.release']) p
     where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,p)) then
   raise exception 'Scoped order risk authority required.' using errcode='PRA01';
 end if;
 select coalesce(max(version),0) into latest from po_risk_engagement_assignments where purchase_order_id=new.purchase_order_id;
 if new.version<>latest+1 or cardinality(new.engagement_ids)<>(select count(*) from commercial_engagements e
   where e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.contract_id=order_contract and e.id=any(new.engagement_ids)) then
   raise exception 'Review version and contract engagement assignments.' using errcode='PRA02';
 end if;
 return new;
end $$;
create trigger validate_po_risk_assignments before insert on po_risk_engagement_assignments for each row execute function guard_po_risk_assignments();

create function po_risk_engagement_owners(org text,entity text,po text) returns table(engagement_id text,user_id uuid) language sql stable as $$
 select e.id,u.id from commercial_purchase_orders p join lateral (
   select a.engagement_ids from po_risk_engagement_assignments a where a.organization_id=org and a.legal_entity_id=entity and a.purchase_order_id=p.id
     order by a.version desc limit 1) a on true
 join commercial_engagements e on e.id=any(a.engagement_ids) and e.organization_id=org and e.legal_entity_id=entity and e.contract_id=p.contract_id
 left join employees w on w.id=e.owner_id and w.organization_id=org and w.legal_entity_id=entity and w.status in ('Active','On Leave')
   and coalesce(w.joining_date,'-infinity'::date)<=(now() at time zone 'UTC')::date and coalesce(w.exit_date,'infinity'::date)>=(now() at time zone 'UTC')::date
 left join users u on u.employee_record_id=w.id and u.status='Active' and exists(select from user_roles ur join roles r on r.id=ur.role_id
   where ur.user_id=u.id and invoice_notice_named_recipient(org,entity,u.id,r.name))
 where p.id=po and p.organization_id=org and p.legal_entity_id=entity
$$;

create function require_po_assignment_audit() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id
   and module='Commercial Notifications' and action='Assign PO Risk Engagements' and entity_id=new.id::text) then
   raise exception 'Assignment audit required.' using errcode='PRA02';
 end if;
 return null;
end $$;
create constraint trigger po_assignment_audit after insert on po_risk_engagement_assignments deferrable initially deferred
 for each row execute function require_po_assignment_audit();
