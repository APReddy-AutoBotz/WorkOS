create or replace function guard_po_line_commitment() returns trigger language plpgsql as $$
declare po commercial_purchase_orders; b invoice_draft_batches; l invoice_draft_lines; available numeric; charge_date date; contract_pin text; witness invoice_draft_lines;
begin
 select * into b from invoice_draft_batches where id=new.batch_id and organization_id=new.organization_id
   and legal_entity_id=new.legal_entity_id for update;
 select * into po from commercial_purchase_orders where id=new.purchase_order_id and organization_id=new.organization_id
   and legal_entity_id=new.legal_entity_id for update;
 select * into l from invoice_draft_lines where batch_id=new.batch_id and id=new.line_id;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if current_setting('workos.po_commit_operation',true) is distinct from new.operation_id
   or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'view')
   or exists(select 1 from unnest(array['commercial.contracts.manage','commercial.purchase_orders.release','commercial.invoice_drafts.prepare']) k
     where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k)) then
   raise exception 'Current purchase order authority is required.' using errcode='ICV01';
 end if;
 if b.source_type='TM_SNAPSHOT' then
   charge_date=(l.billing_evidence->>'workDate')::date;
   select r->>'contractVersionId' into contract_pin from jsonb_array_elements(l.billing_evidence->'references') r
     where r->>'entityType'='Contract' and r->>'entityId'=b.contract_id;
 elsif b.source_type in ('MILESTONE_ACCEPTANCE','FIXED_FEE_INSTALLMENT') then
   if not invoice_notice_actor_has(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,
       case b.source_type when 'FIXED_FEE_INSTALLMENT' then 'commercial.fixed_fee_eligibility.issue' else 'commercial.milestone_billing.view' end) then
     raise exception 'Current billing source authority is required.' using errcode='ICV01';
   end if;
   for witness in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
     perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,witness,new.actor_id,new.active_role);
     if invoice_source_historical_visible(b.organization_id,b.legal_entity_id,witness,new.actor_id,new.active_role) is not true then
       raise exception 'Current billing source scope is required.' using errcode='ICV01';
     end if;
   end loop;
   if b.source_type='FIXED_FEE_INSTALLMENT' and fixed_fee_invoice_batch_source_current(b,new.actor_id,new.active_role) is not true then
     raise exception 'Current fixed-fee installment and reservation are required.' using errcode='ICV02';
   end if;
   select ev.eligible_on,ev.billing_evidence->>'contractVersionId' into charge_date,contract_pin
     from billing_eligibility_events ev where ev.id=l.event_id and ev.source_type=b.source_type
       and ev.organization_id=b.organization_id and ev.legal_entity_id=b.legal_entity_id
       and ev.engagement_id=b.engagement_id and ev.contract_id=b.contract_id and ev.currency=l.currency
       and ev.amount=l.amount and ev.billing_evidence=l.billing_evidence;
 end if;
 if po.id is null or b.id is null or l.id is null or l.amount<=0 or l.source_type is distinct from b.source_type
   or invoice_batch_governed_state(b.id) is distinct from 'Approved' or b.contract_id is distinct from po.contract_id
   or l.currency is distinct from po.currency or not coalesce(charge_date between po.starts_on and po.ends_on,false)
   or contract_pin is distinct from po.contract_version_id then
   raise exception 'Compatible approved charge required.' using errcode='ICV02';
 end if;
 select remaining into available from commercial_po_balance(po.id);
 if available is null or l.amount>available then raise exception 'Purchase order limit exceeded.' using errcode='POC01'; end if;
 return new;
end $$;
