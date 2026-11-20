alter table invoice_draft_batches drop constraint invoice_draft_batches_source_type_check,
 add constraint invoice_draft_batches_source_type_check check(source_type in
 ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','FIXED_FEE_INSTALLMENT'));
alter table invoice_draft_lines drop constraint invoice_line_source_identity_check,
 add constraint invoice_line_source_identity_check check(
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and amount>0) or
 (source_type in ('MILESTONE_ACCEPTANCE','FIXED_FEE_INSTALLMENT') and snapshot_id is null and amount>0) or
 (source_type='FULL_LINE_REVERSAL' and snapshot_id is null and amount<0));

create function fixed_fee_invoice_item_current(b invoice_draft_batches,item_uuid uuid,who uuid,held_role text)
returns boolean language sql stable as $$
 select exists(select 1 from approved_unbilled_items i join billing_eligibility_events ev on ev.id=i.event_id
   cross join lateral fixed_fee_installment_source(b.organization_id,b.legal_entity_id,
     ev.billing_evidence->>'contractVersionId',(ev.billing_evidence->>'installment')::int,b.engagement_id,
     (statement_timestamp() at time zone 'UTC')::date) src
   where b.source_type='FIXED_FEE_INSTALLMENT' and i.id=item_uuid and i.source_type=b.source_type
   and ev.source_type=b.source_type and i.organization_id=b.organization_id and i.legal_entity_id=b.legal_entity_id
   and ev.organization_id=b.organization_id and ev.legal_entity_id=b.legal_entity_id
   and ev.client_id=b.client_id and ev.contract_id=b.contract_id and ev.engagement_id=b.engagement_id
   and ev.currency=b.currency and ev.eligible_on between b.period_start and b.period_end
   and ev.amount=src.amount and (ev.billing_evidence-'approvalReason')=src.evidence
   and invoice_notice_actor_has(b.organization_id,b.legal_entity_id,who,held_role,'commercial.fixed_fee_eligibility.issue'))
$$;

alter function invoice_draft_owner_current(invoice_draft_batches) rename to prior_invoice_draft_owner_current;
create function invoice_draft_owner_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select case when b.source_type='FIXED_FEE_INSTALLMENT' then
   invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own')
   and invoice_notice_actor_has(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'commercial.fixed_fee_eligibility.issue')
   and not exists(select 1 from invoice_draft_owner_losses loss where loss.batch_id=b.id)
   and not exists(select 1 from invoice_draft_lines l where l.batch_id=b.id
     and not fixed_fee_invoice_item_current(b,l.item_id,b.owner_user_id,b.owner_role))
 else prior_invoice_draft_owner_current(b) end
$$;

create function guard_fixed_fee_invoice_draft() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;e commercial_engagements;item approved_unbilled_items;ev billing_eligibility_events;n integer;
begin
 begin ctx=nullif(current_setting('workos.invoice_draft_context',true),'')::jsonb;exception when others then ctx=null;end;
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 if ctx is null then raise exception 'Use the authenticated scoped invoice command.' using errcode='IDR01';end if;
 if tg_table_name='invoice_draft_batches' then
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role);
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role);
  select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
  if new.id::text is distinct from ctx->>'batchId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.preparer_user_id::text is distinct from ctx->>'actorId' or new.preparer_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role,'prepare') or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role,'own') or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role,'commercial.fixed_fee_eligibility.issue') or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role,'commercial.fixed_fee_eligibility.issue') or e.id is null or e.origin<>'manual' or e.model<>'fixed_fee' or not e.billable or e.client_id is distinct from new.client_id or e.contract_id is distinct from new.contract_id or e.currency is distinct from new.currency or new.period_basis<>'ELIGIBLE_DATE' then raise exception 'Explicit scoped fixed-fee batch and current authority required.' using errcode='IDR01';end if;
  return new;
 end if;
 select * into b from invoice_draft_batches where id=new.batch_id for update;
 if b.id is null or b.source_type<>'FIXED_FEE_INSTALLMENT' or b.id::text is distinct from ctx->>'batchId' or b.organization_id is distinct from ctx->>'organizationId' or b.legal_entity_id is distinct from ctx->>'legalEntityId' or exists(select 1 from invoice_draft_cancellations where batch_id=b.id) then raise exception 'Current scoped fixed-fee draft unavailable.' using errcode='IDR02';end if;
 perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role);
 if tg_table_name='invoice_draft_cancellations' then
  select count(*)::int into n from invoice_draft_lines where batch_id=b.id;
  if new.id::text is distinct from ctx->>'cancellationId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.expected_line_count<>n or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'cancel') or not invoice_notice_actor_has(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'commercial.fixed_fee_eligibility.issue') then raise exception 'Current scoped cancellation and line version required.' using errcode='IDR01';end if;
  return new;
 end if;
 perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role);
 select * into item from approved_unbilled_items where id=new.item_id and organization_id=b.organization_id and legal_entity_id=b.legal_entity_id for share;
 select * into ev from billing_eligibility_events where id=item.event_id for share;
 select count(*)::int into n from invoice_draft_lines where batch_id=b.id;
 if new.id::text is distinct from ctx->>'lineId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.sequence<>n+1 or n::text is distinct from ctx->>'expectedLineCount' or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'prepare') or not invoice_draft_owner_current(b) or item.id is null or ev.id is null or item.version<>new.item_version or ev.id<>new.event_id or new.snapshot_id is not null or new.currency<>ev.currency or new.amount<>ev.amount or new.billing_evidence is distinct from ev.billing_evidence or not fixed_fee_invoice_item_current(b,item.id,new.actor_id,new.active_role) then raise exception 'Exact current fixed-fee item, owner, period and native amount required.' using errcode='IDR02';end if;
 return new;
end $$;

create function complete_fixed_fee_invoice_draft() returns trigger language plpgsql as $$
declare b invoice_draft_batches;actor uuid;role_name text;op text;action_name text;expected jsonb;begin
 if tg_table_name='invoice_draft_batches' then b=new;actor=new.preparer_user_id;role_name=new.preparer_role;op=new.operation_id;action_name='Create Draft';expected=jsonb_build_object('batchId',new.id);
  if not invoice_draft_owner_current(b) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'prepare') or not invoice_notice_actor_has(b.organization_id,b.legal_entity_id,actor,role_name,'commercial.fixed_fee_eligibility.issue') then raise exception 'Current owner and preparer are required.' using errcode='IDR03';end if;
 elsif tg_table_name='invoice_draft_lines' then select * into b from invoice_draft_batches where id=new.batch_id;actor=new.actor_id;role_name=new.active_role;op=new.operation_id;action_name='Acquire Item';expected=jsonb_build_object('batchId',new.batch_id,'lineId',new.id,'itemId',new.item_id);
  if not invoice_draft_owner_current(b) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'prepare') or not fixed_fee_invoice_item_current(b,new.item_id,actor,role_name) or not exists(select 1 from invoice_draft_occupancies o where o.item_id=new.item_id and o.item_version=new.item_version and o.batch_id=b.id and o.line_id=new.id) then raise exception 'Current fixed-fee source and unique occupancy must commit together.' using errcode='IDR03';end if;
 else select * into b from invoice_draft_batches where id=new.batch_id;actor=new.actor_id;role_name=new.active_role;op=new.operation_id;action_name='Cancel Draft';expected=jsonb_build_object('batchId',new.batch_id,'cancellationId',new.id);
  if not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'cancel') or not invoice_notice_actor_has(b.organization_id,b.legal_entity_id,actor,role_name,'commercial.fixed_fee_eligibility.issue') or exists(select 1 from invoice_draft_occupancies o where o.batch_id=b.id) or (select count(*) from invoice_draft_lines l where l.batch_id=b.id)<>new.expected_line_count then raise exception 'Cancellation and release must commit together.' using errcode='IDR03';end if;
 end if;
 if not exists(select 1 from audit_logs a where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id and a.user_id=actor::text and a.active_role=role_name and a.module='Invoice Draft' and a.action=action_name and a.entity_id=new.id::text and a.operation_id=op and a.new_value=expected) then raise exception 'Invoice draft and audit must commit together.' using errcode='IDR03';end if;return null;
end $$;

create trigger guarded_fixed_fee_invoice_batch before insert on invoice_draft_batches for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function guard_fixed_fee_invoice_draft();
create trigger guarded_fixed_fee_invoice_line before insert on invoice_draft_lines for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function guard_fixed_fee_invoice_draft();
create trigger guarded_fixed_fee_invoice_cancel before insert on invoice_draft_cancellations for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function guard_fixed_fee_invoice_draft();
create constraint trigger complete_fixed_fee_invoice_batch after insert on invoice_draft_batches deferrable initially deferred for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function complete_fixed_fee_invoice_draft();
create constraint trigger complete_fixed_fee_invoice_line after insert on invoice_draft_lines deferrable initially deferred for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function complete_fixed_fee_invoice_draft();
create constraint trigger complete_fixed_fee_invoice_cancel after insert on invoice_draft_cancellations deferrable initially deferred for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function complete_fixed_fee_invoice_draft();

create or replace function record_invoice_draft_owner_loss() returns trigger language plpgsql as $$
declare changed_user uuid;changed_role text;begin
 if tg_table_name in('users','user_roles','user_organization_scopes','user_permission_grants') then
  if tg_table_name='users' then if tg_op='DELETE' then changed_user=old.id;else changed_user=new.id;end if;
  else if tg_op='DELETE' then changed_user=old.user_id;elsif tg_op='UPDATE' and old.user_id is distinct from new.user_id then changed_user=null;else changed_user=new.user_id;end if;end if;
 elsif tg_table_name='role_permissions' then if tg_op='DELETE' then changed_role=old.role_name;elsif tg_op='UPDATE' and old.role_name is distinct from new.role_name then changed_role=null;else changed_role=new.role_name;end if;
 elsif tg_table_name='roles' then changed_role=old.name;end if;
 insert into invoice_draft_owner_losses(batch_id,cause)
 select b.id,tg_table_name from invoice_draft_batches b where(changed_user is null or b.owner_user_id=changed_user) and(changed_role is null or b.owner_role=changed_role) and not exists(select 1 from invoice_draft_cancellations z where z.batch_id=b.id)
 and(not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own') or (b.source_type='TM_SNAPSHOT' and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,b.owner_user_id,b.owner_role))) or (b.source_type='FIXED_FEE_INSTALLMENT' and not invoice_notice_actor_has(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'commercial.fixed_fee_eligibility.issue')) or (b.source_type='FULL_LINE_REVERSAL' and not correction_original_scope_current(b,b.owner_user_id,b.owner_role)) or (b.source_type='MILESTONE_ACCEPTANCE' and not milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'viewer'))) on conflict(batch_id)do nothing;
 return null;
end $$;
