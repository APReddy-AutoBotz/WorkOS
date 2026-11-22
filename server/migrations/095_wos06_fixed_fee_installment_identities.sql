create table fixed_fee_installment_identities (
 event_id uuid primary key references billing_eligibility_events(id),
 author_id uuid not null,author_worker_id text not null,author_generation bigint not null,
 reviewer_id uuid not null,reviewer_worker_id text not null,reviewer_generation bigint not null,
 origin text not null check(origin in ('issue','upgrade_continuity')),
 check(author_id<>reviewer_id and author_worker_id<>reviewer_worker_id)
);

-- Resolve only account links observed continuously since the underlying action.
create function fixed_fee_identity_pair(ev billing_eligibility_events)
returns table(author_id uuid,author_worker_id text,author_generation bigint,reviewer_id uuid,reviewer_worker_id text,reviewer_generation bigint)
language sql stable as $$
 select maker.id,mw.id,coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=maker.id),0),
        reviewer.id,rw.id,coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=reviewer.id),0)
 from commercial_contract_versions v
 join users maker on maker.id=v.created_by and maker.status='Active'
 join employees mw on mw.id=maker.employee_record_id and mw.status='Active' and mw.organization_id=v.organization_id and mw.legal_entity_id=v.legal_entity_id
 join users reviewer on reviewer.id=ev.actor_id and reviewer.status='Active' and reviewer.id<>maker.id
 join employees rw on rw.id=reviewer.employee_record_id and rw.status='Active' and rw.id<>mw.id and rw.organization_id=v.organization_id and rw.legal_entity_id=v.legal_entity_id
 where ev.source_type='FIXED_FEE_INSTALLMENT' and v.id=ev.billing_evidence->>'contractVersionId' and v.contract_id=ev.contract_id
   and v.organization_id=ev.organization_id and v.legal_entity_id=ev.legal_entity_id
   and exists(select from schema_migrations where id='082_wos06_invoice_review_identity' and applied_at<=least(v.created_at,ev.created_at))
   and not exists(select from retainer_link_observations where (account_id=maker.id and observed_at>=v.created_at)
     or (account_id=reviewer.id and observed_at>=ev.created_at))
$$;

insert into fixed_fee_installment_identities
 select ev.id,p.*,'upgrade_continuity' from billing_eligibility_events ev cross join lateral fixed_fee_identity_pair(ev) p
 where ev.source_type='FIXED_FEE_INSTALLMENT';

create function lock_fixed_fee_source_workers(ev billing_eligibility_events) returns void language plpgsql as $$
begin
 perform u.id from users u where u.id=ev.actor_id or u.id=(select created_by from commercial_contract_versions
   where id=ev.billing_evidence->>'contractVersionId' and organization_id=ev.organization_id and legal_entity_id=ev.legal_entity_id)
   order by u.id for share;
 perform w.id from employees w join users u on u.employee_record_id=w.id where u.id=ev.actor_id or u.id=(select created_by
   from commercial_contract_versions where id=ev.billing_evidence->>'contractVersionId' and organization_id=ev.organization_id
     and legal_entity_id=ev.legal_entity_id) order by w.id for share of w;
end $$;

create function record_fixed_fee_identities() returns trigger language plpgsql as $$
begin
 perform lock_fixed_fee_source_workers(new);
 insert into fixed_fee_installment_identities select new.id,p.*,'issue' from fixed_fee_identity_pair(new) p;
 if not found then raise exception 'Two independent current scoped workers required' using errcode='FFE01'; end if;
 return null;
end $$;
create trigger record_fixed_fee_identities after insert on billing_eligibility_events for each row
 when(new.source_type='FIXED_FEE_INSTALLMENT') execute function record_fixed_fee_identities();

create function guard_fixed_fee_identity_receipt() returns trigger language plpgsql as $$
begin
 if new.origin<>'issue' or pg_trigger_depth()<>2 or not exists(select from billing_eligibility_events ev
   cross join lateral fixed_fee_identity_pair(ev) p where ev.id=new.event_id and
   (p.author_id,p.author_worker_id,p.author_generation,p.reviewer_id,p.reviewer_worker_id,p.reviewer_generation)=
   (new.author_id,new.author_worker_id,new.author_generation,new.reviewer_id,new.reviewer_worker_id,new.reviewer_generation)) then
   raise exception 'Installment identity evidence must accompany issuance' using errcode='FFE01'; end if;
 return new;
end $$;
create trigger guarded_fixed_fee_identity before insert on fixed_fee_installment_identities for each row execute function guard_fixed_fee_identity_receipt();
create trigger immutable_fixed_fee_identity before update or delete on fixed_fee_installment_identities for each row execute function reject_commercial_draft_rewrite();

create function fixed_fee_identity_current(event_uuid uuid) returns boolean language sql stable as $$
 select exists(select from fixed_fee_installment_identities i join billing_eligibility_events ev on ev.id=i.event_id
   cross join lateral fixed_fee_identity_pair(ev) p where i.event_id=event_uuid and
   (p.author_id,p.author_worker_id,p.author_generation,p.reviewer_id,p.reviewer_worker_id,p.reviewer_generation)=
   (i.author_id,i.author_worker_id,i.author_generation,i.reviewer_id,i.reviewer_worker_id,i.reviewer_generation))
$$;
alter function fixed_fee_invoice_item_current(invoice_draft_batches,uuid,uuid,text) rename to before_identity_fixed_fee_invoice_item_current;
create function fixed_fee_invoice_item_current(b invoice_draft_batches,item_uuid uuid,who uuid,held_role text)
returns boolean language sql stable as $$
 select before_identity_fixed_fee_invoice_item_current(b,item_uuid,who,held_role) and exists(select from approved_unbilled_items i
   where i.id=item_uuid and i.organization_id=b.organization_id and i.legal_entity_id=b.legal_entity_id and fixed_fee_identity_current(i.event_id))
$$;

create function lock_fixed_fee_reservation_workers() returns trigger language plpgsql as $$
declare ev billing_eligibility_events;
begin
 select * into ev from billing_eligibility_events where id=new.event_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
 perform lock_fixed_fee_source_workers(ev);
 if not fixed_fee_identity_current(ev.id) then raise exception 'Current installment approval identities required' using errcode='IDR02';end if;
 return new;
end $$;
create trigger locked_fixed_fee_reservation_workers before insert on invoice_draft_lines for each row
 when(new.source_type='FIXED_FEE_INSTALLMENT') execute function lock_fixed_fee_reservation_workers();
