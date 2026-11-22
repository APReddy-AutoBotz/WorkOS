create function invoice_reversal_participants_valid(original_source text,i invoice_batch_approval_instances)
returns boolean language sql stable as $$
 select case original_source
  when 'RETAINER_PERIOD' then retainer_review_participants_valid(i)
  when 'MANAGED_SERVICE_UNIT' then service_unit_review_participants_valid(i)
  when 'MANAGED_SERVICE_PERIOD' then service_period_review_participants_valid(i)
  else false end
$$;

create or replace function guard_retainer_reversal_identities() returns trigger language plpgsql as $$
declare b invoice_draft_batches; s invoice_reversal_reviews; i invoice_batch_approval_instances; current_links jsonb; member record;
begin
 if tg_table_name='invoice_reversal_reviews' then s=new;
 else select * into strict s from invoice_reversal_reviews where id=new.review_id for update; end if;
 select batch.* into strict b from invoice_line_reversal_requests req join invoice_draft_lines l on l.id=req.line_id
 join invoice_draft_batches batch on batch.id=l.batch_id where req.id=s.request_id for update of batch;
 if b.source_type not in ('RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD') then return new; end if;
 i=retainer_reversal_participants(b,s.actor_id,s.active_role,s.policy_id);
 for member in select (stage->>'userId')::uuid uid,stage->>'role' held_role
 from invoice_batch_approval_policies p cross join lateral jsonb_array_elements(p.definition->'stages') stage
 where p.id=s.policy_id union select s.actor_id,s.active_role union select b.owner_user_id,b.owner_role
 union select b.preparer_user_id,b.preparer_role order by 1,2 loop
   perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,member.uid,member.held_role);
 end loop;
 perform u.id from users u join invoice_review_participants(i) x on x.account_id=u.id order by u.id for share of u;
 perform e.id from employees e join users u on u.employee_record_id=e.id join invoice_review_participants(i) x on x.account_id=u.id order by e.id for share of e;
 if not invoice_reversal_participants_valid(b.source_type,i) then raise exception 'Independent scoped reversal reviewers required' using errcode='IBA02'; end if;
 current_links=invoice_review_link_generations(i);
 if tg_table_name='invoice_reversal_reviews' then new.retainer_link_generations=current_links;
 elsif s.retainer_link_generations is distinct from current_links then raise exception 'Reversal reviewer identity changed' using errcode='IBA02'; end if;
 return new;
end $$;

create or replace function full_line_reversal_source(review uuid) returns table (
 organization_id text, legal_entity_id text, client_id text, contract_id text, engagement_id text,
 currency text, amount numeric, original_event uuid, final_decision uuid, confirmation uuid, evidence jsonb
) language sql stable as $$
 select l.organization_id,l.legal_entity_id,original.client_id,original.contract_id,original.engagement_id,l.currency,-l.amount,
   original.id,d.id,cf.id,jsonb_build_object(
    'sourceVersion',1,'reviewId',s.id,'policyId',s.policy_id,'requestId',req.id,'decisionId',d.id,
    'originalSourceType',original.source_type,'originalEventId',original.id,'originalEventVersion',original.version,
    'originalItemId',l.item_id,'originalItemVersion',l.item_version,'originalLineId',l.id,'originalBatchId',l.batch_id,
    'artifactId',a.id,'artifactSha256',a.sha256,'confirmationId',cf.id,'currency',l.currency,
    'originalAmount',trim_scale(l.amount)::text,'amount',trim_scale(-l.amount)::text)
 from invoice_reversal_reviews s join invoice_line_reversal_requests req on req.id=s.request_id
 join invoice_batch_approval_policies p on p.id=s.policy_id
 join invoice_reversal_decisions d on d.review_id=s.id and d.sequence=jsonb_array_length(p.definition->'stages') and d.decision='Approved'
 join invoice_draft_lines l on l.id=req.line_id join invoice_csv_artifacts a on a.id=req.artifact_id and a.batch_id=l.batch_id
 join invoice_draft_occupancies occ on occ.line_id=l.id and occ.item_id=l.item_id and occ.item_version=l.item_version and occ.batch_id=l.batch_id
 join billing_eligibility_events original on original.id=l.event_id and original.source_type=l.source_type
 left join invoice_batch_confirmations cf on cf.artifact_id=a.id
 where s.id=review and l.source_type in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD') and l.amount=original.amount and l.currency=original.currency
$$;

create or replace function verify_retainer_credit_authority() returns trigger language plpgsql as $$
declare b invoice_draft_batches; s invoice_reversal_reviews; i invoice_batch_approval_instances;
begin
 select review.* into strict s from invoice_reversal_reviews review join invoice_reversal_decisions d on d.review_id=review.id where d.id=new.reversal_decision_id;
 select batch.* into strict b from invoice_line_reversal_requests req join invoice_draft_lines l on l.id=req.line_id
 join invoice_draft_batches batch on batch.id=l.batch_id where req.id=s.request_id for update of batch;
 if b.source_type not in ('RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD') then return new; end if;
 i=retainer_reversal_participants(b,s.actor_id,s.active_role,s.policy_id);
 perform lock_retainer_credit_reviewers(i);
 if not invoice_reversal_participants_valid(b.source_type,i) or s.retainer_link_generations is distinct from invoice_review_link_generations(i) then
   raise exception 'Reversal approval identity changed before credit issuance' using errcode='IBA02';
 end if;
 return new;
end $$;

create or replace function guard_correction_draft() returns trigger language plpgsql as $$
declare ctx jsonb:=nullif(current_setting('workos.invoice_draft_context',true),'')::jsonb;
 orig invoice_draft_batches; b invoice_draft_batches; credit billing_eligibility_events; item approved_unbilled_items;
begin
 select * into strict orig from invoice_draft_batches where id=(ctx->>'originalId')::uuid for update;
 if (orig.organization_id,orig.legal_entity_id) is distinct from (ctx->>'organizationId',ctx->>'legalEntityId')
 or orig.source_type not in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD') or not exists(select 1 from invoice_csv_artifacts where batch_id=orig.id)
 then raise exception 'Original export required' using errcode='23514'; end if;
 perform lock_correction_export_scope(orig,(ctx->>'actorId')::uuid,ctx->>'activeRole');
 if tg_table_name='invoice_draft_batches' then
   if (new.id::text,new.preparer_user_id::text,new.preparer_role,new.operation_id) is distinct from
      (ctx->>'batchId',ctx->>'actorId',ctx->>'activeRole',ctx->>'operationId')
   or (new.organization_id,new.legal_entity_id,new.client_id,new.contract_id,new.engagement_id,new.currency) is distinct from
      (orig.organization_id,orig.legal_entity_id,orig.client_id,orig.contract_id,orig.engagement_id,orig.currency)
   or (new.owner_user_id,new.owner_role) is distinct from (new.preparer_user_id,new.preparer_role)
   or new.period_basis<>'ELIGIBLE_DATE' or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role,'own')
   then raise exception 'Scoped correction draft owner and dimensions required' using errcode='IBA01'; end if;
 else
   select * into strict b from invoice_draft_batches where id=new.batch_id for update;
   if (new.batch_id::text,new.actor_id::text,new.active_role,new.operation_id) is distinct from
      (ctx->>'batchId',ctx->>'actorId',ctx->>'activeRole',ctx->>'operationId')
   or (new.organization_id,new.legal_entity_id) is distinct from (b.organization_id,b.legal_entity_id)
   then raise exception 'Scoped correction command required' using errcode='23514'; end if;
   if tg_table_name='invoice_draft_lines' then
     select * into strict item from approved_unbilled_items where id=new.item_id and version=new.item_version;
     select * into strict credit from billing_eligibility_events where id=item.event_id and source_type='FULL_LINE_REVERSAL';
     if not exists(select 1 from invoice_draft_batches where id=b.id and xmin=pg_current_xact_id()::xid)
     or (b.preparer_user_id,b.preparer_role,b.operation_id) is distinct from (new.actor_id,new.active_role,new.operation_id)
     or (item.organization_id,item.legal_entity_id,credit.client_id,credit.contract_id,credit.engagement_id,credit.currency) is distinct from
        (b.organization_id,b.legal_entity_id,b.client_id,b.contract_id,b.engagement_id,b.currency)
     or (new.event_id,new.currency,new.amount,new.billing_evidence) is distinct from (credit.id,credit.currency,credit.amount,credit.billing_evidence)
     or credit.billing_evidence->>'originalBatchId' is distinct from orig.id::text or credit.eligible_on not between b.period_start and b.period_end
     then raise exception 'Whole credit from the inspected export required' using errcode='23514'; end if;
   else
     if coalesce(ctx->>'expectedState','Draft') not in ('Draft','Approved')
     or invoice_batch_governed_state(b.id) is distinct from coalesce(ctx->>'expectedState','Draft')
     or exists(select 1 from invoice_csv_artifacts where batch_id=b.id) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'cancel')
     or (select count(*) from invoice_draft_lines where batch_id=b.id)<>new.expected_line_count
     or exists(select 1 from invoice_draft_lines where batch_id=b.id and billing_evidence->>'originalBatchId' is distinct from orig.id::text)
     then raise exception 'Current correction draft required for cancellation' using errcode='IBA01'; end if;
   end if;
 end if;
 return new;
end $$;

create or replace function is_retainer_credit_batch(batch uuid) returns boolean language sql stable as $$
 select exists(select 1 from invoice_draft_lines l where l.batch_id=batch and l.source_type='FULL_LINE_REVERSAL'
   and l.billing_evidence->>'originalSourceType' in ('RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD'))
$$;

create or replace function guard_retainer_credit_batch_review() returns trigger language plpgsql as $$
declare i invoice_batch_approval_instances;
begin
 if tg_table_name='invoice_batch_approval_instances' then i=new;
 elsif tg_table_name='invoice_batch_approval_transitions' then select * into strict i from invoice_batch_approval_instances where id=new.instance_id;
 else select * into strict i from invoice_batch_approval_instances where id=new.approval_id; end if;
 if not is_retainer_credit_batch(i.batch_id) then return new; end if;
 perform lock_retainer_credit_reviewers(i);
 if exists(select from invoice_draft_lines l where l.batch_id=i.batch_id
    and invoice_reversal_participants_valid(l.billing_evidence->>'originalSourceType',i) is not true) or (tg_table_name<>'invoice_batch_approval_instances' and not invoice_review_identities_current(i)) then
   raise exception 'Current independent credit approval for the original source required' using errcode='IBA02';
 end if;
 return new;
end $$;
alter function invoice_lock_source_witness(text,text,invoice_draft_lines,uuid,text) rename to before_period_credit_lock_source_witness;
create function invoice_lock_source_witness(org text,legal text,line invoice_draft_lines,who uuid,held_role text)
returns void language plpgsql as $$
declare original invoice_draft_lines;
begin
 if line.source_type='FULL_LINE_REVERSAL' and line.billing_evidence->>'originalSourceType'='MANAGED_SERVICE_PERIOD' then
   select l.* into strict original from invoice_draft_lines l where l.id=(line.billing_evidence->>'originalLineId')::uuid
     and l.batch_id=(line.billing_evidence->>'originalBatchId')::uuid and l.organization_id=org and l.legal_entity_id=legal
     and l.source_type='MANAGED_SERVICE_PERIOD';
   perform before_period_credit_lock_source_witness(org,legal,original,who,held_role);
 else perform before_period_credit_lock_source_witness(org,legal,line,who,held_role); end if;
end $$;

-- Corrections review the immutable exported period. Fresh issuance and export still validate live source evidence.
alter function invoice_source_line_visible(text,text,uuid,uuid,uuid,text) rename to before_period_credit_line_visible;
create function invoice_source_line_visible(org text,legal text,batch uuid,item uuid,who uuid,held_role text)
returns boolean language sql stable as $$
 select coalesce((select case when b.source_type='MANAGED_SERVICE_PERIOD' and exists(select from invoice_csv_artifacts a where a.batch_id=b.id)
   then invoice_source_historical_visible(org,legal,l,who,held_role)
   else before_period_credit_line_visible(org,legal,batch,item,who,held_role) end
 from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id and l.item_id=item
 where b.id=batch and b.organization_id=org and b.legal_entity_id=legal),false)
$$;
