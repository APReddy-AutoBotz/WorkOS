create table commercial_po_line_commitments (
 line_id uuid primary key references invoice_draft_lines(id),
 batch_id uuid not null references invoice_draft_batches(id),
 purchase_order_id text not null references commercial_purchase_order_releases(purchase_order_id),
 organization_id text not null, legal_entity_id text not null, actor_id uuid not null references users(id),
 active_role text not null, reason text not null check(length(trim(reason)) between 3 and 1000),
 operation_id text not null, created_at timestamptz not null default clock_timestamp()
);
create index po_commitment_order_idx on commercial_po_line_commitments(purchase_order_id);
create function commercial_po_balance(po_id text) returns table(
 committed numeric, consumed numeric, remaining numeric, warning boolean
) language sql stable as $$
 with used as (
   select coalesce(sum(l.amount) filter(where f.id is null),0) reserved,
     coalesce(sum(l.amount) filter(where f.id is not null),0) confirmed
   from commercial_po_line_commitments a join invoice_draft_lines l on l.id=a.line_id and l.batch_id=a.batch_id
   left join invoice_batch_confirmations f on f.batch_id=a.batch_id
   where a.purchase_order_id=po_id and not exists(select 1 from invoice_draft_cancellations c where c.batch_id=a.batch_id)
 )
 select reserved,confirmed,p.value-reserved-confirmed,
   (reserved+confirmed)>0 and (reserved+confirmed)*100>=p.value*p.warning_threshold_percent
 from used cross join commercial_purchase_orders p where p.id=po_id
$$;
create function guard_po_line_commitment() returns trigger language plpgsql as $$
declare po commercial_purchase_orders; b invoice_draft_batches; l invoice_draft_lines; available numeric;
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
 if po.id is null or b.id is null or l.id is null or l.amount<=0 or b.source_type is distinct from 'TM_SNAPSHOT'
   or invoice_batch_governed_state(b.id) is distinct from 'Approved' or b.contract_id is distinct from po.contract_id
   or l.currency is distinct from po.currency or not coalesce((l.billing_evidence->>'workDate')::date between po.starts_on and po.ends_on,false)
   or not exists(select 1 from jsonb_array_elements(l.billing_evidence->'references') r
     where r->>'entityType'='Contract' and r->>'entityId'=po.contract_id and r->>'contractVersionId'=po.contract_version_id)
   then raise exception 'Compatible approved charge required.' using errcode='ICV02';
 end if;
 select remaining into available from commercial_po_balance(po.id);
 if available is null or l.amount>available then raise exception 'Purchase order limit exceeded.' using errcode='POC01'; end if;
 return new;
end $$;
create trigger validate_po_line_commitment before insert on commercial_po_line_commitments for each row execute function guard_po_line_commitment();
create trigger immutable_po_line_commitment before update or delete on commercial_po_line_commitments for each row execute function reject_commercial_draft_rewrite();
create function require_po_line_commitment_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id
   and module='Invoice CSV' and action='Commit purchase order' and entity_id=new.line_id::text) then
   raise exception 'Atomic purchase order audit is required.' using errcode='ICV03';
 end if;
 return null;
end $$;
create constraint trigger po_line_commitment_audit after insert on commercial_po_line_commitments deferrable initially deferred
 for each row execute function require_po_line_commitment_audit();
