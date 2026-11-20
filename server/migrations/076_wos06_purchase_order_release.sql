insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.purchase_orders.release','Commercial','Release purchase orders','Independently release an in-force purchase order against its active contract terms.',false);

create table commercial_purchase_order_releases (
 purchase_order_id text primary key references commercial_purchase_orders(id),
 organization_id text not null, legal_entity_id text not null, actor_id uuid not null references users(id),
 active_role text not null, approval_reference text not null check(length(trim(approval_reference)) between 3 and 200),
 reason text not null check(length(trim(reason)) between 3 and 1000),
 operation_id text not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id)
);

create function guard_purchase_order_release() returns trigger language plpgsql as $$
declare po commercial_purchase_orders; lifecycle commercial_lifecycle_events; pin text;
  work_day date := (clock_timestamp() at time zone 'UTC')::date;
begin
 select * into po from commercial_purchase_orders where id=new.purchase_order_id
   and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id for share;
 if po.id is null or po.value<=0 or work_day not between po.starts_on and po.ends_on then
   raise exception 'An in-force purchase order with positive value is required.' using errcode='POR01';
 end if;
 perform id from users where id=po.created_by for share;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if current_setting('workos.po_release_operation',true) is distinct from new.operation_id or exists (
   select 1 from unnest(array['commercial.contracts.view','commercial.contracts.manage','commercial.purchase_orders.release']) grant_key
   where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,grant_key)
 ) then raise exception 'Current release authority is required.' using errcode='POR02'; end if;
 if po.created_by=new.actor_id or exists (
   select 1 from users maker join users reviewer on reviewer.employee_record_id=maker.employee_record_id
   where maker.id=po.created_by and reviewer.id=new.actor_id
 ) then raise exception 'An independent release authority is required.' using errcode='POR02'; end if;
 select * into lifecycle from commercial_lifecycle_events where organization_id=new.organization_id
   and legal_entity_id=new.legal_entity_id and entity_type='Contract' and entity_id=po.contract_id
   and effective_on<=work_day order by sequence desc limit 1;
 select contract_version_id into pin from commercial_amendments where organization_id=new.organization_id
   and legal_entity_id=new.legal_entity_id and entity_type='Contract' and entity_id=po.contract_id
   and effective_on<=work_day order by sequence desc limit 1;
 if lifecycle.state is distinct from 'Active' or coalesce(pin,lifecycle.contract_version_id) is distinct from po.contract_version_id then
   raise exception 'The purchase order must match currently active contract terms.' using errcode='POR01';
 end if;
 return new;
end $$;
create trigger validate_purchase_order_release before insert on commercial_purchase_order_releases
 for each row execute function guard_purchase_order_release();
create trigger immutable_purchase_order_release before update or delete on commercial_purchase_order_releases
 for each row execute function reject_commercial_draft_rewrite();

create function require_purchase_order_release_audit() returns trigger language plpgsql as $$
begin
 if not exists (select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id
   and module='Commercial Drafting' and action='Release' and entity_type='Purchase Order' and entity_id=new.purchase_order_id
   and old_value=jsonb_build_object('status','Draft')
   and new_value=jsonb_build_object('status','Released','purchaseOrderId',new.purchase_order_id)) then
   raise exception 'The purchase order release requires an atomic scoped audit.' using errcode='POR03';
 end if;
 return null;
end $$;
create constraint trigger purchase_order_release_audit after insert on commercial_purchase_order_releases
 deferrable initially deferred for each row execute function require_purchase_order_release_audit();
