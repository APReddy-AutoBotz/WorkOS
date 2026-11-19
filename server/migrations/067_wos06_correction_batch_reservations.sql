-- Correction drafts share the canonical line and occupancy tables with ordinary invoices.
alter table invoice_draft_batches drop constraint invoice_draft_batches_source_type_check;
alter table invoice_draft_batches add constraint invoice_draft_batches_source_type_check
 check(source_type in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL'));
alter table invoice_draft_lines drop constraint invoice_line_source_identity_check, drop constraint invoice_draft_lines_amount_check;
alter table invoice_draft_lines add constraint invoice_line_source_identity_check check(
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and amount>0) or
 (source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null and amount>0) or
 (source_type='FULL_LINE_REVERSAL' and snapshot_id is null and amount<0));

create function lock_correction_export_scope(orig invoice_draft_batches, who uuid, held_role text) returns void language plpgsql as $$
declare member invoice_draft_lines;
begin
 perform lock_commercial_candidate_identity(orig.organization_id,orig.legal_entity_id,who,held_role);
 if not invoice_draft_actor_valid(orig.organization_id,orig.legal_entity_id,who,held_role,'prepare')
 or not exists(select 1 from role_permissions where role_name=held_role and permission_key='commercial.invoice_export.view' and enabled
               union all select 1 from user_permission_grants where user_id=who and permission_key='commercial.invoice_export.view')
 or (orig.source_type='MILESTONE_ACCEPTANCE' and not milestone_billing_actor_valid(orig.organization_id,orig.legal_entity_id,who,held_role,'viewer'))
 then raise exception 'Current credit preparation scope required' using errcode='IBA01'; end if;
 for member in select * from invoice_draft_lines where batch_id=orig.id order by sequence loop
   perform invoice_lock_source_witness(orig.organization_id,orig.legal_entity_id,member,who,held_role);
   if invoice_source_line_visible(orig.organization_id,orig.legal_entity_id,orig.id,member.item_id,who,held_role) is not true
   then raise exception 'Original batch unavailable' using errcode='IBA01'; end if;
 end loop;
end $$;

create function guard_correction_draft() returns trigger language plpgsql as $$
declare ctx jsonb:=nullif(current_setting('workos.invoice_draft_context',true),'')::jsonb;
 orig invoice_draft_batches; b invoice_draft_batches; credit billing_eligibility_events; item approved_unbilled_items;
begin
 select * into strict orig from invoice_draft_batches where id=(ctx->>'originalId')::uuid for update;
 if (orig.organization_id,orig.legal_entity_id) is distinct from (ctx->>'organizationId',ctx->>'legalEntityId')
 or orig.source_type not in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE') or not exists(select 1 from invoice_csv_artifacts where batch_id=orig.id)
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
     if invoice_batch_governed_state(b.id)<>'Draft' or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'cancel')
     or (select count(*) from invoice_draft_lines where batch_id=b.id)<>new.expected_line_count
     or exists(select 1 from invoice_draft_lines where batch_id=b.id and billing_evidence->>'originalBatchId' is distinct from orig.id::text)
     then raise exception 'Current correction draft required for cancellation' using errcode='IBA01'; end if;
   end if;
 end if;
 return new;
end $$;

create function complete_correction_draft() returns trigger language plpgsql as $$
declare b invoice_draft_batches; action_name text; entity uuid; actor uuid; held_role text; op text; why text; n integer;
begin
 if tg_table_name='invoice_draft_batches' then
   b:=new; action_name:='Reserve Correction Credits'; entity:=b.id; actor:=b.preparer_user_id; held_role:=b.preparer_role; op:=b.operation_id; why:=b.reason;
   select count(*) into n from invoice_draft_lines where batch_id=b.id;
   if n not between 1 and 50 or n<>(select count(*) from invoice_draft_occupancies where batch_id=b.id)
   or (select count(distinct billing_evidence->>'originalBatchId') from invoice_draft_lines where batch_id=b.id)<>1
   then raise exception 'Complete correction occupancy required' using errcode='23514'; end if;
 else
   select * into strict b from invoice_draft_batches where id=new.batch_id;
   action_name:='Cancel Correction Draft'; entity:=new.id; actor:=new.actor_id; held_role:=new.active_role; op:=new.operation_id; why:=new.reason;
   if exists(select 1 from invoice_draft_occupancies where batch_id=b.id) then raise exception 'Release all correction reservations' using errcode='23514'; end if;
 end if;
 if not exists(select 1 from audit_logs where entity_id=entity::text and entity_type='Correction Draft'
   and module='Invoice Corrections' and action=action_name and user_id=actor::text and active_role=held_role and operation_id=op and reason=why
   and organization_id=b.organization_id and legal_entity_id=b.legal_entity_id and new_value=jsonb_build_object(
     'batchId',b.id,'itemIds',(select jsonb_agg(item_id order by item_id) from invoice_draft_lines where batch_id=b.id),
     'currency',b.currency,'total',(select trim_scale(sum(amount))::text from invoice_draft_lines where batch_id=b.id)))
 then raise exception 'Matching correction audit receipt required' using errcode='23514'; end if;
 return null;
end $$;
create trigger guard_correction_batch before insert on invoice_draft_batches for each row when(new.source_type='FULL_LINE_REVERSAL') execute function guard_correction_draft();
create trigger guard_correction_line before insert on invoice_draft_lines for each row when(new.source_type='FULL_LINE_REVERSAL') execute function guard_correction_draft();
create trigger guard_correction_cancel before insert on invoice_draft_cancellations for each row when(new.source_type='FULL_LINE_REVERSAL') execute function guard_correction_draft();
create constraint trigger complete_correction_batch after insert on invoice_draft_batches deferrable initially deferred for each row when(new.source_type='FULL_LINE_REVERSAL') execute function complete_correction_draft();
create constraint trigger complete_correction_cancel after insert on invoice_draft_cancellations deferrable initially deferred for each row when(new.source_type='FULL_LINE_REVERSAL') execute function complete_correction_draft();
