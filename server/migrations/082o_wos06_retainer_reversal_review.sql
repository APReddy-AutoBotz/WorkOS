-- Freeze the workforce identities used to submit and decide a retainer reversal.
alter table invoice_reversal_reviews add column retainer_link_generations jsonb;

create function retainer_reversal_participants(b invoice_draft_batches, requester uuid, held_role text, policy uuid)
returns invoice_batch_approval_instances language plpgsql immutable as $$
declare i invoice_batch_approval_instances;
begin
 i.organization_id=b.organization_id; i.legal_entity_id=b.legal_entity_id;
 i.owner_user_id=b.owner_user_id; i.owner_role=b.owner_role;
 i.preparer_user_id=b.preparer_user_id; i.preparer_role=b.preparer_role;
 i.requester_user_id=requester; i.active_role=held_role; i.policy_id=policy;
 return i;
end $$;

create function guard_retainer_reversal_identities() returns trigger language plpgsql as $$
declare b invoice_draft_batches; s invoice_reversal_reviews; i invoice_batch_approval_instances; current_links jsonb; member record;
begin
 if tg_table_name='invoice_reversal_reviews' then s=new;
 else select * into strict s from invoice_reversal_reviews where id=new.review_id for update; end if;
 select batch.* into strict b from invoice_line_reversal_requests req join invoice_draft_lines l on l.id=req.line_id
 join invoice_draft_batches batch on batch.id=l.batch_id where req.id=s.request_id for update of batch;
 if b.source_type <> 'RETAINER_PERIOD' then return new; end if;
 i=retainer_reversal_participants(b,s.actor_id,s.active_role,s.policy_id);
 for member in select (stage->>'userId')::uuid uid,stage->>'role' held_role
 from invoice_batch_approval_policies p cross join lateral jsonb_array_elements(p.definition->'stages') stage
 where p.id=s.policy_id union select s.actor_id,s.active_role union select b.owner_user_id,b.owner_role
 union select b.preparer_user_id,b.preparer_role order by 1,2 loop
   perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,member.uid,member.held_role);
 end loop;
 perform u.id from users u join invoice_review_participants(i) x on x.account_id=u.id order by u.id for share of u;
 perform e.id from employees e join users u on u.employee_record_id=e.id join invoice_review_participants(i) x on x.account_id=u.id order by e.id for share of e;
 if not retainer_review_participants_valid(i) then raise exception 'Independent scoped retainer reversal reviewers required' using errcode='IBA02'; end if;
 current_links=invoice_review_link_generations(i);
 if tg_table_name='invoice_reversal_reviews' then new.retainer_link_generations=current_links;
 elsif s.retainer_link_generations is distinct from current_links then raise exception 'Reversal reviewer identity changed' using errcode='IBA02'; end if;
 return new;
end $$;

create trigger pin_retainer_reversal_identities before insert on invoice_reversal_reviews
 for each row execute function guard_retainer_reversal_identities();
create trigger check_retainer_reversal_identities before insert on invoice_reversal_decisions
 for each row execute function guard_retainer_reversal_identities();
