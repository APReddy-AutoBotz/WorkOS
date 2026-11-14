-- Add source-specific authority without altering retained invoice or notice data.
create function invoice_action_source_actor_valid(b invoice_draft_batches, who uuid, held_role text, kind text)
returns boolean language sql stable as $$
 select coalesce(invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,who,held_role,kind)
   and (b.source_type='TM_SNAPSHOT' or (b.source_type='MILESTONE_ACCEPTANCE'
     and milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,who,held_role,'viewer'))),false)
$$;

create function guard_invoice_action_source_authority() returns trigger language plpgsql as $$
declare b invoice_draft_batches; rel record; model text;
begin
 if tg_table_name='invoice_action_templates' then
  select e.model into model from commercial_engagements e where e.id=new.engagement_id
    and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id;
  if model is null or (model='milestone' and not milestone_billing_actor_valid(
    new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'viewer')) then
   raise exception 'Current source-specific template authority required.' using errcode='IAN01';
  end if;
 elsif tg_table_name='invoice_action_events' then
  select * into b from invoice_draft_batches where id=new.batch_id;
  if b.id is null or not invoice_action_source_actor_valid(b,new.actor_id,new.active_role,'prepare') then
   raise exception 'Current source-specific assessment authority required.' using errcode='IAN01';
  end if;
  for rel in select * from invoice_action_expected_recipients(b) loop
   if not invoice_action_source_actor_valid(b,rel.recipient,rel.held_role,'view') then
    raise exception 'Every required recipient must retain source-specific visibility.' using errcode='IAN01';
   end if;
  end loop;
 end if;
 return new;
end $$;

create trigger guard_invoice_action_source_template before insert on invoice_action_templates
 for each row execute function guard_invoice_action_source_authority();
create constraint trigger complete_invoice_action_source_template after insert on invoice_action_templates
 deferrable initially deferred for each row execute function guard_invoice_action_source_authority();
create trigger guard_invoice_action_source_event before insert on invoice_action_events
 for each row execute function guard_invoice_action_source_authority();
create constraint trigger complete_invoice_action_source_event after insert on invoice_action_events
 deferrable initially deferred for each row execute function guard_invoice_action_source_authority();

-- Source history remains visible after business-state changes. The previous
-- T&M-only line check treated milestone snapshot_id=NULL as unavailable.
create or replace function guard_invoice_action_read() returns trigger language plpgsql as $$
declare ctx jsonb; rec invoice_action_recipients; ev invoice_action_events; b invoice_draft_batches;
begin
 begin ctx=nullif(current_setting('workos.invoice_action_read_context',true),'')::jsonb;
 exception when others then ctx=null;end;
 select * into rec from invoice_action_recipients where id=new.recipient_id;
 select * into ev from invoice_action_events where id=rec.event_id;
 select * into b from invoice_draft_batches where id=ev.batch_id;
 if ctx is null or rec.id is null or ev.id is null or b.id is null
   or new.user_id is distinct from rec.user_id or new.user_id::text is distinct from ctx->>'actorId'
   or b.organization_id is distinct from ctx->>'organizationId' or b.legal_entity_id is distinct from ctx->>'legalEntityId'
   or not invoice_action_source_actor_valid(b,new.user_id,ctx->>'activeRole','view')
   or exists(select 1 from invoice_draft_lines l where l.batch_id=b.id
     and not invoice_source_historical_visible(b.organization_id,b.legal_entity_id,l,new.user_id,ctx->>'activeRole')) then
  raise exception 'Only the currently scoped recipient may acknowledge this event.' using errcode='IAN01';
 end if;
 return new;
end $$;
