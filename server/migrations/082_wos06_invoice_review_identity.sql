-- Keep a generation for each actual change to the account's employee link.
-- Generation zero describes the link in place when this migration becomes active.
lock table users in share row exclusive mode;
lock table invoice_batch_approval_instances in share row exclusive mode;

create table invoice_reviewer_link_changes (
  -- Historical account IDs survive deprovisioning and cannot restart at generation zero.
  account_id uuid not null,
  generation bigint not null check(generation > 0),
  primary key(account_id,generation)
);
create function record_invoice_reviewer_link_change() returns trigger language plpgsql as $$
declare changed_account uuid := old.id;
begin
  insert into invoice_reviewer_link_changes(account_id,generation)
    select changed_account,coalesce(max(generation),0)+1 from invoice_reviewer_link_changes where account_id=changed_account;
  return null;
end $$;
create trigger invoice_review_employee_link_changed after update of employee_record_id on users
  for each row when(old.employee_record_id is distinct from new.employee_record_id)
  execute function record_invoice_reviewer_link_change();
create trigger invoice_review_account_removed after delete on users
  for each row execute function record_invoice_reviewer_link_change();
create trigger immutable_invoice_link_changes before update or delete on invoice_reviewer_link_changes
  for each row execute function reject_commercial_draft_rewrite();

create table invoice_review_identity_receipts (
  instance_id uuid primary key references invoice_batch_approval_instances(id),
  organization_id text not null, legal_entity_id text not null,
  generations jsonb not null check(jsonb_typeof(generations)='object'),
  foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id)
);
create function invoice_review_participants(i invoice_batch_approval_instances)
returns table(account_id uuid) language sql stable as $$
  select i.requester_user_id union select i.owner_user_id union select i.preparer_user_id
  union select (stage->>'userId')::uuid from invoice_batch_approval_policies p
    cross join lateral jsonb_array_elements(p.definition->'stages') stage where p.id=i.policy_id
$$;
create function invoice_review_link_generations(i invoice_batch_approval_instances)
returns jsonb language sql stable as $$
 select jsonb_object_agg(p.account_id::text,coalesce((select max(c.generation)
   from invoice_reviewer_link_changes c where c.account_id=p.account_id),0))
 from invoice_review_participants(i) p
$$;
create function pin_invoice_review_identities() returns trigger language plpgsql as $$
begin
 perform u.id from users u join invoice_review_participants(new) p on p.account_id=u.id order by u.id for share of u;
 insert into invoice_review_identity_receipts values(new.id,new.organization_id,new.legal_entity_id,invoice_review_link_generations(new));
 return null;
end $$;
create trigger pin_invoice_review_participants after insert on invoice_batch_approval_instances
 for each row execute function pin_invoice_review_identities();
create trigger immutable_invoice_review_identity_receipts before update or delete on invoice_review_identity_receipts
 for each row execute function reject_commercial_draft_rewrite();

insert into invoice_review_identity_receipts
 select i.id,i.organization_id,i.legal_entity_id,invoice_review_link_generations(i)
 from invoice_batch_approval_instances i where invoice_batch_approval_review_current(i);

create function invoice_review_identities_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select exists(select 1 from invoice_review_identity_receipts r where r.instance_id=i.id
   and r.organization_id=i.organization_id and r.legal_entity_id=i.legal_entity_id
   and r.generations=invoice_review_link_generations(i))
$$;
alter function invoice_batch_approval_review_current(invoice_batch_approval_instances) rename to invoice_review_current_before_identity_check;
create function invoice_batch_approval_review_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select invoice_review_current_before_identity_check(i) and invoice_review_identities_current(i)
$$;
create function verify_invoice_decision_identities() returns trigger language plpgsql as $$
declare i invoice_batch_approval_instances;
begin
 select * into strict i from invoice_batch_approval_instances where id=new.instance_id;
 perform u.id from users u join invoice_review_participants(i) p on p.account_id=u.id order by u.id for share of u;
 if not invoice_review_identities_current(i) then
   raise exception 'Invoice review employee identity changed; withdraw and resubmit.' using errcode='IBA02';
 end if;
 return new;
end $$;
create trigger verify_invoice_review_identities before insert on invoice_batch_approval_transitions
 for each row execute function verify_invoice_decision_identities();
