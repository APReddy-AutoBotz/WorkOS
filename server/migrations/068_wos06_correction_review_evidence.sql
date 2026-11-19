-- The original export defines the row boundary for every credit in a correction draft.
create function correction_original_scope_current(b invoice_draft_batches, who uuid, held_role text)
returns boolean language sql stable as $$
 select b.source_type='FULL_LINE_REVERSAL'
 and exists(select 1 from invoice_draft_lines where batch_id=b.id)
 and not exists(
   select 1 from (select distinct billing_evidence->>'originalBatchId' as id from invoice_draft_lines where batch_id=b.id) origins
   left join invoice_draft_batches orig on orig.id=origins.id::uuid and orig.organization_id=b.organization_id
     and orig.legal_entity_id=b.legal_entity_id and orig.engagement_id=b.engagement_id and orig.currency=b.currency
   where orig.id is null or (orig.source_type='MILESTONE_ACCEPTANCE'
     and milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,who,held_role,'viewer') is not true)
   or exists(select 1 from invoice_draft_lines member where member.batch_id=orig.id
     and invoice_source_line_visible(b.organization_id,b.legal_entity_id,orig.id,member.item_id,who,held_role) is not true)
 )
$$;

alter function invoice_draft_owner_current(invoice_draft_batches) rename to invoice_standard_draft_owner_current;
create function invoice_draft_owner_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select case when b.source_type='FULL_LINE_REVERSAL' then
   invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own')
   and not exists(select 1 from invoice_draft_owner_losses loss where loss.batch_id=b.id)
   and correction_original_scope_current(b,b.owner_user_id,b.owner_role)
 else invoice_standard_draft_owner_current(b) end
$$;

create or replace function record_invoice_draft_owner_loss() returns trigger language plpgsql as $$
declare changed_user uuid;changed_role text;begin
 if tg_table_name in('users','user_roles','user_organization_scopes','user_permission_grants') then
  if tg_table_name='users' then if tg_op='DELETE' then changed_user=old.id;else changed_user=new.id;end if;
  else if tg_op='DELETE' then changed_user=old.user_id;elsif tg_op='UPDATE' and old.user_id is distinct from new.user_id then changed_user=null;else changed_user=new.user_id;end if;end if;
 elsif tg_table_name='role_permissions' then if tg_op='DELETE' then changed_role=old.role_name;elsif tg_op='UPDATE' and old.role_name is distinct from new.role_name then changed_role=null;else changed_role=new.role_name;end if;
 elsif tg_table_name='roles' then changed_role=old.name;end if;
 insert into invoice_draft_owner_losses(batch_id,cause)
 select b.id,tg_table_name from invoice_draft_batches b where(changed_user is null or b.owner_user_id=changed_user) and(changed_role is null or b.owner_role=changed_role) and not exists(select 1 from invoice_draft_cancellations z where z.batch_id=b.id)
 and(not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own') or (b.source_type='TM_SNAPSHOT' and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,b.owner_user_id,b.owner_role))) or (b.source_type='FULL_LINE_REVERSAL' and not correction_original_scope_current(b,b.owner_user_id,b.owner_role)) or (b.source_type='MILESTONE_ACCEPTANCE' and not milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'viewer'))) on conflict(batch_id)do nothing;
 return null;
end $$;

-- Record observable source-scope loss on existing open correction drafts during upgrade.
insert into invoice_draft_owner_losses(batch_id,cause)
select b.id,'correction_owner_scope_upgrade' from invoice_draft_batches b
where b.source_type='FULL_LINE_REVERSAL' and not exists(select 1 from invoice_draft_cancellations x where x.batch_id=b.id)
and not invoice_draft_owner_current(b) on conflict(batch_id) do nothing;

create function correction_batch_lineage_hash(batch uuid) returns text language sql stable as $$
 select encode(digest(jsonb_agg(jsonb_build_object(
   'sequence',l.sequence,'lineId',l.id,'itemId',l.item_id,'itemVersion',l.item_version,
   'eventId',l.event_id,'eventVersion',ev.version,'eligibleOn',ev.eligible_on,'currency',l.currency,
   'amount',trim_scale(l.amount)::text,'evidence',l.billing_evidence) order by l.sequence)::text,'sha256'),'hex')
 from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id
 where l.batch_id=batch and l.source_type='FULL_LINE_REVERSAL'
$$;
