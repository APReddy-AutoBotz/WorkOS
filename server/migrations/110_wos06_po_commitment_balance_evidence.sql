-- Existing commitments retain their original evidence. Every new commitment captures
-- the available balance under the same order lock that prevents overspending.
alter table commercial_po_line_commitments
 add column available_before numeric,
 add column available_after numeric,
 add constraint po_commitment_balance_evidence check (
   (available_before is null and available_after is null) or
   (available_before is not null and available_after is not null and available_before>available_after and available_after>=0)
 );

create function capture_po_commitment_balance() returns trigger language plpgsql as $$
declare amount numeric;
begin
 select l.amount into strict amount from invoice_draft_lines l where l.id=new.line_id and l.batch_id=new.batch_id;
 select b.remaining into strict new.available_before from commercial_po_balance(new.purchase_order_id) b;
 new.available_after:=new.available_before-amount;
 return new;
end $$;
-- PostgreSQL orders same-kind triggers by name. The validation trigger obtains the
-- scoped order lock and validates the immutable invoice line before this capture.
create trigger witness_po_commitment_balance before insert on commercial_po_line_commitments
 for each row execute function capture_po_commitment_balance();
