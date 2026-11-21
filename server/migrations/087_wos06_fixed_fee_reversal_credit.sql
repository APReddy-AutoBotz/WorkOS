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
 where s.id=review and l.source_type in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','FIXED_FEE_INSTALLMENT') and l.amount=original.amount and l.currency=original.currency
$$;

create or replace function guard_correction_draft() returns trigger language plpgsql as $$
declare ctx jsonb:=nullif(current_setting('workos.invoice_draft_context',true),'')::jsonb;
 orig invoice_draft_batches; b invoice_draft_batches; credit billing_eligibility_events; item approved_unbilled_items;
begin
 select * into strict orig from invoice_draft_batches where id=(ctx->>'originalId')::uuid for update;
 if (orig.organization_id,orig.legal_entity_id) is distinct from (ctx->>'organizationId',ctx->>'legalEntityId')
 or orig.source_type not in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','FIXED_FEE_INSTALLMENT') or not exists(select 1 from invoice_csv_artifacts where batch_id=orig.id)
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

create or replace function invoice_lock_source_witness(org text,legal text,line invoice_draft_lines,who uuid,held_role text) returns void language plpgsql as $$
declare member invoice_draft_lines;
begin
 if line.source_type='FIXED_FEE_INSTALLMENT' then
   perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||org||':'||legal,0));
   perform lock_commercial_candidate_identity(org,legal,who,held_role);
 elsif line.source_type='FULL_LINE_REVERSAL' then
   perform lock_commercial_candidate_identity(org,legal,who,held_role);
   for member in select l.* from invoice_draft_lines l where l.batch_id=(line.billing_evidence->>'originalBatchId')::uuid
     and l.organization_id=org and l.legal_entity_id=legal order by l.sequence loop
     if member.source_type='FIXED_FEE_INSTALLMENT' then
       perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||org||':'||legal,0));
       perform lock_commercial_candidate_identity(org,legal,who,held_role);
     else perform standard_invoice_lock_source_witness(org,legal,member,who,held_role); end if;
   end loop;
 else perform standard_invoice_lock_source_witness(org,legal,line,who,held_role); end if;
end $$;

-- An exported installment keeps its retained terms; each reader must still hold current source access.
create or replace function invoice_source_line_visible(org text,legal text,batch uuid,item uuid,who uuid,held_role text) returns boolean language sql stable as $$
 select coalesce((select case when b.source_type='FIXED_FEE_INSTALLMENT' then
   case when exists(select 1 from invoice_csv_artifacts a where a.batch_id=b.id and a.schema_version='workos.invoice-fixed-fee-csv/1')
     then invoice_source_historical_visible(org,legal,l,who,held_role)
     else fixed_fee_invoice_item_current(b,item,who,held_role) end when b.source_type='FULL_LINE_REVERSAL' then correction_original_scope_current(b,who,held_role)
 else standard_invoice_source_line_visible(org,legal,batch,item,who,held_role) end
 from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id where b.id=batch and l.item_id=item
 and b.organization_id=org and b.legal_entity_id=legal),false)
$$;
