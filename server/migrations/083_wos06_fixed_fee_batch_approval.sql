create function fixed_fee_invoice_lineage_hash(batch uuid) returns text language sql stable as $$
 select case when not exists(select 1 from invoice_draft_lines l where l.batch_id=batch and l.source_type<>'FIXED_FEE_INSTALLMENT')
 then encode(digest(coalesce(jsonb_agg(jsonb_build_object('sequence',l.sequence,'lineId',l.id,'itemId',l.item_id,'itemVersion',l.item_version,'eventId',l.event_id,'sourceType',l.source_type,'currency',l.currency,'amount',trim_scale(l.amount)::text,'evidence',l.billing_evidence) order by l.sequence),'[]'::jsonb)::text,'sha256'),'hex') end
 from invoice_draft_lines l where l.batch_id=batch
$$;

create function fixed_fee_invoice_batch_source_current(b invoice_draft_batches,who uuid,held_role text) returns boolean language sql stable as $$
 select b.id is not null and b.source_type='FIXED_FEE_INSTALLMENT' and b.period_basis='ELIGIBLE_DATE'
  and not exists(select 1 from invoice_draft_cancellations c where c.batch_id=b.id)
  and not exists(select 1 from invoice_draft_owner_losses z where z.batch_id=b.id)
  and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own')
  and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id)
  and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id and o.item_id=l.item_id and o.item_version=l.item_version
   where l.batch_id=b.id and (l.source_type<>'FIXED_FEE_INSTALLMENT' or o.line_id is null
    or not fixed_fee_invoice_item_current(b,l.item_id,who,held_role)
    or l.event_id<>(select event_id from approved_unbilled_items where id=l.item_id)
    or l.billing_evidence is distinct from (select billing_evidence from billing_eligibility_events where id=l.event_id)
    or l.currency is distinct from (select currency from billing_eligibility_events where id=l.event_id)
    or l.amount is distinct from (select amount from billing_eligibility_events where id=l.event_id)))
$$;

create function fixed_fee_invoice_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select exists(select 1 from invoice_draft_batches b where b.id=i.batch_id
  and b.organization_id=i.organization_id and b.legal_entity_id=i.legal_entity_id
  and b.owner_user_id=i.owner_user_id and b.owner_role=i.owner_role
  and b.preparer_user_id=i.preparer_user_id and b.preparer_role=i.preparer_role and b.currency=i.currency
  and b.source_type='FIXED_FEE_INSTALLMENT' and b.period_basis='ELIGIBLE_DATE' and not exists(select 1 from invoice_draft_cancellations c where c.batch_id=b.id)
  and not exists(select 1 from invoice_draft_owner_losses z where z.batch_id=b.id)
  and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own')
  and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.preparer_user_id,b.preparer_role,'prepare')
  and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter')
  and i.line_count>0 and i.line_count=(select count(*) from invoice_draft_lines l where l.batch_id=b.id)
  and i.total=(select sum(l.amount) from invoice_draft_lines l where l.batch_id=b.id)
  and i.lineage_hash=fixed_fee_invoice_lineage_hash(b.id)
  and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id and o.item_id=l.item_id and o.item_version=l.item_version
   where l.batch_id=b.id and (l.source_type<>'FIXED_FEE_INSTALLMENT' or o.line_id is null
    or not fixed_fee_invoice_item_current(b,l.item_id,i.requester_user_id,i.active_role)
    or not fixed_fee_invoice_item_current(b,l.item_id,b.preparer_user_id,b.preparer_role)
    or l.event_id<>(select event_id from approved_unbilled_items where id=l.item_id)
    or l.currency is distinct from (select currency from billing_eligibility_events where id=l.event_id)
    or l.billing_evidence is distinct from (select billing_evidence from billing_eligibility_events where id=l.event_id)
    or l.amount is distinct from (select amount from billing_eligibility_events where id=l.event_id)))
 )
$$;

create or replace function invoice_batch_lineage_hash(batch uuid) returns text language sql stable as $$
 select case when b.source_type='FIXED_FEE_INSTALLMENT' then fixed_fee_invoice_lineage_hash(batch) when b.source_type='FULL_LINE_REVERSAL' then correction_batch_lineage_hash(batch)
 else standard_invoice_batch_lineage_hash(batch) end from invoice_draft_batches b where b.id=batch
$$;

create or replace function invoice_batch_source_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select case when b.source_type='FIXED_FEE_INSTALLMENT' then fixed_fee_invoice_batch_source_current(b,b.preparer_user_id,b.preparer_role) when b.source_type='FULL_LINE_REVERSAL' then invoice_draft_owner_current(b)
 and not exists(select 1 from invoice_draft_cancellations x where x.batch_id=b.id)
 and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o
   on o.item_id=l.item_id and o.item_version=l.item_version and o.line_id=l.id and o.batch_id=b.id
   where l.batch_id=b.id and o.line_id is null)
 else standard_invoice_batch_source_current(b) end
$$;

create or replace function invoice_batch_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select case when b.source_type='FIXED_FEE_INSTALLMENT' then fixed_fee_invoice_approval_pin_current(i) when b.source_type='FULL_LINE_REVERSAL' then invoice_batch_source_current(b)
 and i.organization_id=b.organization_id and i.legal_entity_id=b.legal_entity_id
 and (i.owner_user_id,i.owner_role,i.preparer_user_id,i.preparer_role,i.currency)=(b.owner_user_id,b.owner_role,b.preparer_user_id,b.preparer_role,b.currency)
 and i.total=(select sum(amount) from invoice_draft_lines where batch_id=b.id)
 and i.line_count=(select count(*) from invoice_draft_lines where batch_id=b.id)
 and i.lineage_hash=correction_batch_lineage_hash(b.id)
 and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter')
 and correction_original_scope_current(b,i.requester_user_id,i.active_role)
 else standard_invoice_batch_approval_pin_current(i) end from invoice_draft_batches b where b.id=i.batch_id
$$;

create or replace function invoice_source_line_visible(org text,legal text,batch uuid,item uuid,who uuid,held_role text) returns boolean language sql stable as $$
 select coalesce((select case when b.source_type='FIXED_FEE_INSTALLMENT' then fixed_fee_invoice_item_current(b,item,who,held_role) when b.source_type='FULL_LINE_REVERSAL' then correction_original_scope_current(b,who,held_role)
 else standard_invoice_source_line_visible(org,legal,batch,item,who,held_role) end
 from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id where b.id=batch and l.item_id=item
 and b.organization_id=org and b.legal_entity_id=legal),false)
$$;

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
     perform standard_invoice_lock_source_witness(org,legal,member,who,held_role);
   end loop;
 else perform standard_invoice_lock_source_witness(org,legal,line,who,held_role); end if;
end $$;

create or replace function invoice_source_historical_visible(org text,legal text,line invoice_draft_lines,who uuid,held_role text)
returns boolean language sql stable as $$
 select case when line.source_type='FIXED_FEE_INSTALLMENT' then invoice_notice_actor_has(org,legal,who,held_role,'commercial.fixed_fee_eligibility.issue') when line.source_type='FULL_LINE_REVERSAL' then exists(
   select 1 from invoice_draft_batches b where b.id=line.batch_id
   and b.organization_id=org and b.legal_entity_id=legal
   and correction_original_scope_current(b,who,held_role)
 ) else invoice_original_source_historical_visible(org,legal,line,who,held_role) end
$$;

create function invoice_policy_source_visible(model text,org text,legal text,who uuid,held_role text)
returns boolean language sql stable as $$
 select case model when 'fixed_fee' then invoice_notice_actor_has(org,legal,who,held_role,'commercial.fixed_fee_eligibility.issue')
   when 'milestone' then milestone_billing_actor_valid(org,legal,who,held_role,'viewer')
   else model='time_and_materials' end
$$;

create or replace function guard_invoice_batch_policy() returns trigger language plpgsql as $$
declare ctx jsonb;prior invoice_batch_approval_policies;e commercial_engagements;stage jsonb;uid uuid;held_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 perform pg_advisory_xact_lock(hashtext('invoice-approval-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
 if ctx is null or e.id is null or e.origin<>'manual' or e.model not in('time_and_materials','milestone','fixed_fee') or not e.billable or e.client_id is null or e.contract_id is null or new.id::text is distinct from ctx->>'policyId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or new.definition->>'engagementId' is distinct from new.engagement_id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date then raise exception 'Explicit current scoped invoice policy authority is required.' using errcode='IBA01';end if;
 if not invoice_policy_source_visible(e.model,new.organization_id,new.legal_entity_id,new.actor_id,new.active_role) then raise exception 'Source visibility is required.' using errcode='IBA01';end if;
 select * into prior from invoice_batch_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or(prior.id is not null and new.effective_from<prior.effective_from) then raise exception 'The current policy version changed.' using errcode='IBA02';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v order by v->>'userId',v->>'role' loop
  uid=(stage->>'userId')::uuid;held_role=stage->>'role';perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,uid,held_role);
  if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,uid,held_role,'decider') then raise exception 'Every named stage requires current held scope and authority.' using errcode='IBA01';end if;
  if not invoice_policy_source_visible(e.model,new.organization_id,new.legal_entity_id,uid,held_role) then raise exception 'Named invoice reviewer access is required.' using errcode='IBA01';end if;
 end loop;return new;
end $$;
create or replace function complete_invoice_batch_policy() returns trigger language plpgsql as $$
declare stage jsonb;begin
 if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Batch Approval' and a.action='Configure Policy' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('policyId',new.id,'engagementId',new.engagement_id)) then raise exception 'Policy authority and redacted audit must commit together.' using errcode='IBA03';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v loop if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,(stage->>'userId')::uuid,stage->>'role','decider') or (exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and not invoice_policy_source_visible(e.model,new.organization_id,new.legal_entity_id,(stage->>'userId')::uuid,stage->>'role'))) then raise exception 'Every named stage must retain authority through commit.' using errcode='IBA03';end if;end loop;
 if exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and not invoice_policy_source_visible(e.model,new.organization_id,new.legal_entity_id,new.actor_id,new.active_role)) then raise exception 'Invoice source authority must persist through commit.' using errcode='IBA03';end if;return null;
end $$;

create or replace function invoice_notice_source_authorized(b invoice_draft_batches,actor uuid,active_role text) returns boolean language sql stable as $$
 select case when b.source_type='FIXED_FEE_INSTALLMENT' then
   invoice_notice_actor_has(b.organization_id,b.legal_entity_id,actor,active_role,'commercial.fixed_fee_eligibility.issue')
   and invoice_notice_actor_has(b.organization_id,b.legal_entity_id,actor,active_role,'commercial.contracts.view')
 when b.source_type='FULL_LINE_REVERSAL' then correction_original_scope_current(b,actor,active_role)
 else standard_invoice_notice_source_authorized(b,actor,active_role) end
$$;
