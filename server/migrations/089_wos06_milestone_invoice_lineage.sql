-- Development sentinel: source-specific draft, approval and export guards and
-- connected acceptance are not complete. Never install this partial migration.
do $$begin raise exception 'Milestone invoice consumption is incomplete';end$$;

-- Preserve every existing T&M line and its original snapshot. The discriminator
-- cannot be supplied independently of the retained event. The existing draft
-- guards still reject milestone lines until the complete source-specific
-- occupancy, review and export paths are implemented and verified.
alter table invoice_draft_lines add column source_type text not null default 'TM_SNAPSHOT';
alter table invoice_draft_lines alter column snapshot_id drop not null;
alter table invoice_draft_lines add constraint invoice_line_event_source_fk
 foreign key(event_id,source_type) references billing_eligibility_events(id,source_type);
alter table invoice_draft_lines add constraint invoice_line_source_identity_check check(
 (source_type='TM_SNAPSHOT' and snapshot_id is not null) or
 (source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null));
alter table invoice_draft_batches add column source_type text not null default 'TM_SNAPSHOT' check(source_type in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE'));
alter table invoice_draft_batches add constraint invoice_batch_id_source_unique unique(id,source_type);
alter table invoice_draft_lines add constraint invoice_line_batch_source_fk foreign key(batch_id,source_type) references invoice_draft_batches(id,source_type);
alter table invoice_draft_cancellations add column source_type text not null default 'TM_SNAPSHOT';
alter table invoice_draft_cancellations add constraint invoice_cancel_batch_source_fk foreign key(batch_id,source_type) references invoice_draft_batches(id,source_type);

-- This projection is a reusable prerequisite, not a replacement for the draft
-- append/commit, approval, occupancy or CSV transaction guards. An accepted
-- milestone has no work date or worker witness; eligibility date is explicit.
create function milestone_invoice_item_current(b invoice_draft_batches,item_uuid uuid,who uuid,held_role text)
returns boolean language sql stable as $$
 select exists(
  select 1 from approved_unbilled_items item
  join billing_eligibility_events ev on ev.id=item.event_id and ev.source_type=item.source_type
  join milestone_billing_instances i on i.id=ev.milestone_instance_id
  join milestone_billing_transitions t on t.id=ev.milestone_decision_id and t.instance_id=i.id
  join milestone_billing_policies p on p.id=i.policy_id
  join commercial_milestones m on m.id=i.milestone_id and m.organization_id=i.organization_id and m.legal_entity_id=i.legal_entity_id
  join commercial_engagements e on e.id=i.engagement_id and e.organization_id=i.organization_id and e.legal_entity_id=i.legal_entity_id
  where item.id=item_uuid and item.version=1 and item.source_type='MILESTONE_ACCEPTANCE'
   and item.organization_id=b.organization_id and item.legal_entity_id=b.legal_entity_id
   and ev.organization_id=b.organization_id and ev.legal_entity_id=b.legal_entity_id
   and i.organization_id=b.organization_id and i.legal_entity_id=b.legal_entity_id
   and ev.client_id=b.client_id and ev.contract_id=b.contract_id and ev.engagement_id=b.engagement_id and ev.currency=b.currency
   and b.period_basis='ELIGIBLE_DATE' and ev.eligible_on between b.period_start and b.period_end
   and ev.amount=m.amount and ev.currency=m.currency and m.engagement_id=i.engagement_id
   and t.decision='Approved' and t.sequence=jsonb_array_length(p.definition->'stages')
   and not exists(select 1 from milestone_billing_invalidations z where z.instance_id=i.id)
   and milestone_billing_source_valid(i.organization_id,i.legal_entity_id,i.engagement_id,i.milestone_id,i.engagement_lifecycle_id,i.contract_lifecycle_id)
   and milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,who,held_role,'viewer')
   and milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'viewer')
   and ev.billing_evidence=jsonb_build_object('milestoneId',m.id,'sourceVersion',1,'engagementId',e.id,'contractVersionId',e.contract_version_id,'engagementLifecycleId',i.engagement_lifecycle_id,'contractLifecycleId',i.contract_lifecycle_id,'dueOn',to_char(m.due_on,'YYYY-MM-DD'),'evidence',i.evidence,'ownerUserId',i.owner_user_id,'ownerRole',i.owner_role,'policyId',i.policy_id,'decisionId',t.id,'currency',m.currency,'amount',trim_scale(m.amount)::text)
 )
$$;

-- Separate format and function leave prior T&M artifact bytes and their
-- database validator unchanged. The existing CSV guard still only accepts
-- T&M; this helper alone cannot create an artifact.
create function milestone_invoice_csv_bytes(b invoice_draft_batches) returns bytea language sql stable as $$
 select convert_to('schema_version,batch_id,line_id,line_sequence,item_id,item_version,event_id,source_type,milestone_id_b64,billing_evidence_b64,client_id_b64,contract_id_b64,engagement_id_b64,eligible_date,currency,amount,period_start,period_end,period_basis'||E'\r\n'||coalesce(string_agg(concat_ws(',', 'workos.invoice-milestone-csv/1',b.id::text,l.id::text,l.sequence::text,l.item_id::text,l.item_version::text,l.event_id::text,l.source_type,invoice_csv_base64(l.billing_evidence->>'milestoneId'),invoice_csv_base64(l.billing_evidence::text),invoice_csv_base64(b.client_id),invoice_csv_base64(b.contract_id),invoice_csv_base64(b.engagement_id),ev.eligible_on::text,l.currency,trim_scale(l.amount)::text,b.period_start::text,b.period_end::text,b.period_basis)||E'\r\n','' order by l.sequence),''),'UTF8')
 from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id and ev.organization_id=l.organization_id and ev.legal_entity_id=l.legal_entity_id where l.batch_id=b.id
$$;

-- A distinct pin includes the source discriminator without changing the
-- historical T&M hash. Callers must lock the same rows and identities as the
-- existing approval transaction; this predicate does not authorize a write.
create function milestone_invoice_lineage_hash(batch uuid) returns text language sql stable as $$
 select case when not exists(select 1 from invoice_draft_lines l where l.batch_id=batch and l.source_type<>'MILESTONE_ACCEPTANCE')
 then encode(digest(coalesce(jsonb_agg(jsonb_build_object('sequence',l.sequence,'lineId',l.id,'itemId',l.item_id,'itemVersion',l.item_version,'eventId',l.event_id,'sourceType',l.source_type,'currency',l.currency,'amount',trim_scale(l.amount)::text,'evidence',l.billing_evidence) order by l.sequence),'[]'::jsonb)::text,'sha256'),'hex') end
 from invoice_draft_lines l where l.batch_id=batch
$$;

create function milestone_invoice_batch_source_current(b invoice_draft_batches,who uuid,held_role text) returns boolean language sql stable as $$
 select b.id is not null and b.period_basis='ELIGIBLE_DATE'
  and not exists(select 1 from invoice_draft_cancellations c where c.batch_id=b.id)
  and not exists(select 1 from invoice_draft_owner_losses z where z.batch_id=b.id)
  and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own')
  and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id)
  and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id and o.item_id=l.item_id and o.item_version=l.item_version
   where l.batch_id=b.id and (l.source_type<>'MILESTONE_ACCEPTANCE' or o.line_id is null
    or not milestone_invoice_item_current(b,l.item_id,who,held_role)
    or l.event_id<>(select event_id from approved_unbilled_items where id=l.item_id)
    or l.billing_evidence is distinct from (select billing_evidence from billing_eligibility_events where id=l.event_id)
    or l.currency is distinct from (select currency from billing_eligibility_events where id=l.event_id)
    or l.amount is distinct from (select amount from billing_eligibility_events where id=l.event_id)))
$$;

-- The existing T&M path and worker checks remain byte-for-byte equivalent.
create or replace function invoice_draft_owner_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own') and not exists(select 1 from invoice_draft_owner_losses z where z.batch_id=b.id)
 and case when b.source_type='TM_SNAPSHOT' then
  not exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,b.owner_user_id,b.owner_role))
 when b.source_type='MILESTONE_ACCEPTANCE' then milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'viewer') and
  not exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and (l.source_type<>'MILESTONE_ACCEPTANCE' or not milestone_invoice_item_current(b,l.item_id,b.owner_user_id,b.owner_role)))
 else false end
$$;

-- Source-specific append and deferred completion keep the old T&M functions
-- as the sole guards for T&M rows. The shared occupancy guard remains intact.
create function guard_milestone_invoice_draft() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;e commercial_engagements;item approved_unbilled_items;ev billing_eligibility_events;n integer;
begin
 begin ctx=nullif(current_setting('workos.invoice_draft_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null then raise exception 'Use the authenticated scoped invoice command.' using errcode='IDR01';end if;
 if tg_table_name='invoice_draft_batches' then
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role);
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role);
  select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
  if new.id::text is distinct from ctx->>'batchId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.preparer_user_id::text is distinct from ctx->>'actorId' or new.preparer_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role,'prepare') or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role,'own') or not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role,'viewer') or not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role,'viewer') or e.id is null or e.origin<>'manual' or e.model<>'milestone' or not e.billable or e.client_id is distinct from new.client_id or e.contract_id is distinct from new.contract_id or e.currency is distinct from new.currency or new.period_basis<>'ELIGIBLE_DATE' then raise exception 'Explicit scoped milestone batch and current authority required.' using errcode='IDR01';end if;
  return new;
 end if;
 select * into b from invoice_draft_batches where id=new.batch_id for update;
 if b.id is null or b.source_type<>'MILESTONE_ACCEPTANCE' or b.id::text is distinct from ctx->>'batchId' or b.organization_id is distinct from ctx->>'organizationId' or b.legal_entity_id is distinct from ctx->>'legalEntityId' or exists(select 1 from invoice_draft_cancellations where batch_id=b.id) then raise exception 'Current scoped milestone draft unavailable.' using errcode='IDR02';end if;
 perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role);
 if tg_table_name='invoice_draft_cancellations' then
  select count(*)::int into n from invoice_draft_lines where batch_id=b.id;
  if new.id::text is distinct from ctx->>'cancellationId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.expected_line_count<>n or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'cancel') or not milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'viewer') then raise exception 'Current scoped cancellation and line version required.' using errcode='IDR01';end if;
  return new;
 end if;
 perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role);
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||b.organization_id||':'||b.legal_entity_id,0));
 select * into item from approved_unbilled_items where id=new.item_id and organization_id=b.organization_id and legal_entity_id=b.legal_entity_id for share;
 select * into ev from billing_eligibility_events where id=item.event_id for share;
 select count(*)::int into n from invoice_draft_lines where batch_id=b.id;
 if new.id::text is distinct from ctx->>'lineId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.sequence<>n+1 or n::text is distinct from ctx->>'expectedLineCount' or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'prepare') or not invoice_draft_owner_current(b) or item.id is null or ev.id is null or item.version<>new.item_version or ev.id<>new.event_id or new.snapshot_id is not null or new.currency<>ev.currency or new.amount<>ev.amount or new.billing_evidence is distinct from ev.billing_evidence or not milestone_invoice_item_current(b,item.id,new.actor_id,new.active_role) then raise exception 'Exact current milestone item, owner, period and native amount required.' using errcode='IDR02';end if;
 return new;
end $$;

create function complete_milestone_invoice_draft() returns trigger language plpgsql as $$
declare b invoice_draft_batches;actor uuid;role_name text;op text;action_name text;expected jsonb;begin
 if tg_table_name='invoice_draft_batches' then b=new;actor=new.preparer_user_id;role_name=new.preparer_role;op=new.operation_id;action_name='Create Draft';expected=jsonb_build_object('batchId',new.id);
  if not invoice_draft_owner_current(b) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'prepare') or not milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'viewer') then raise exception 'Current owner and preparer are required.' using errcode='IDR03';end if;
 elsif tg_table_name='invoice_draft_lines' then select * into b from invoice_draft_batches where id=new.batch_id;actor=new.actor_id;role_name=new.active_role;op=new.operation_id;action_name='Acquire Item';expected=jsonb_build_object('batchId',new.batch_id,'lineId',new.id,'itemId',new.item_id);
  if not invoice_draft_owner_current(b) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'prepare') or not milestone_invoice_item_current(b,new.item_id,actor,role_name) or not exists(select 1 from invoice_draft_occupancies o where o.item_id=new.item_id and o.item_version=new.item_version and o.batch_id=b.id and o.line_id=new.id) then raise exception 'Current milestone source and unique occupancy must commit together.' using errcode='IDR03';end if;
 else select * into b from invoice_draft_batches where id=new.batch_id;actor=new.actor_id;role_name=new.active_role;op=new.operation_id;action_name='Cancel Draft';expected=jsonb_build_object('batchId',new.batch_id,'cancellationId',new.id);
  if not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'cancel') or not milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'viewer') or exists(select 1 from invoice_draft_occupancies o where o.batch_id=b.id) or (select count(*) from invoice_draft_lines l where l.batch_id=b.id)<>new.expected_line_count then raise exception 'Cancellation and release must commit together.' using errcode='IDR03';end if;
 end if;
 if not exists(select 1 from audit_logs a where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id and a.user_id=actor::text and a.active_role=role_name and a.module='Invoice Draft' and a.action=action_name and a.entity_id=new.id::text and a.operation_id=op and a.new_value=expected) then raise exception 'Invoice draft and audit must commit together.' using errcode='IDR03';end if;return null;
end $$;

drop trigger guarded_invoice_draft_batch on invoice_draft_batches;
drop trigger guarded_invoice_draft_line on invoice_draft_lines;
drop trigger guarded_invoice_draft_cancel on invoice_draft_cancellations;
drop trigger complete_invoice_draft_batch on invoice_draft_batches;
drop trigger complete_invoice_draft_line on invoice_draft_lines;
drop trigger complete_invoice_draft_cancel on invoice_draft_cancellations;
create trigger guarded_invoice_draft_batch before insert on invoice_draft_batches for each row when(new.source_type='TM_SNAPSHOT') execute function guard_invoice_draft_append();
create trigger guarded_invoice_draft_line before insert on invoice_draft_lines for each row when(new.source_type='TM_SNAPSHOT') execute function guard_invoice_draft_append();
create trigger guarded_invoice_draft_cancel before insert on invoice_draft_cancellations for each row when(new.source_type='TM_SNAPSHOT') execute function guard_invoice_draft_append();
create constraint trigger complete_invoice_draft_batch after insert on invoice_draft_batches deferrable initially deferred for each row when(new.source_type='TM_SNAPSHOT') execute function complete_invoice_draft_commit();
create constraint trigger complete_invoice_draft_line after insert on invoice_draft_lines deferrable initially deferred for each row when(new.source_type='TM_SNAPSHOT') execute function complete_invoice_draft_commit();
create constraint trigger complete_invoice_draft_cancel after insert on invoice_draft_cancellations deferrable initially deferred for each row when(new.source_type='TM_SNAPSHOT') execute function complete_invoice_draft_commit();
create trigger guarded_milestone_invoice_batch before insert on invoice_draft_batches for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function guard_milestone_invoice_draft();
create trigger guarded_milestone_invoice_line before insert on invoice_draft_lines for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function guard_milestone_invoice_draft();
create trigger guarded_milestone_invoice_cancel before insert on invoice_draft_cancellations for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function guard_milestone_invoice_draft();
create constraint trigger complete_milestone_invoice_batch after insert on invoice_draft_batches deferrable initially deferred for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function complete_milestone_invoice_draft();
create constraint trigger complete_milestone_invoice_line after insert on invoice_draft_lines deferrable initially deferred for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function complete_milestone_invoice_draft();
create constraint trigger complete_milestone_invoice_cancel after insert on invoice_draft_cancellations deferrable initially deferred for each row when(new.source_type='MILESTONE_ACCEPTANCE') execute function complete_milestone_invoice_draft();

create function milestone_invoice_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select exists(select 1 from invoice_draft_batches b where b.id=i.batch_id
  and b.organization_id=i.organization_id and b.legal_entity_id=i.legal_entity_id
  and b.owner_user_id=i.owner_user_id and b.owner_role=i.owner_role
  and b.preparer_user_id=i.preparer_user_id and b.preparer_role=i.preparer_role and b.currency=i.currency
  and b.period_basis='ELIGIBLE_DATE' and not exists(select 1 from invoice_draft_cancellations c where c.batch_id=b.id)
  and not exists(select 1 from invoice_draft_owner_losses z where z.batch_id=b.id)
  and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own')
  and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.preparer_user_id,b.preparer_role,'prepare')
  and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter')
  and i.line_count>0 and i.line_count=(select count(*) from invoice_draft_lines l where l.batch_id=b.id)
  and i.total=(select sum(l.amount) from invoice_draft_lines l where l.batch_id=b.id)
  and i.lineage_hash=milestone_invoice_lineage_hash(b.id)
  and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id and o.item_id=l.item_id and o.item_version=l.item_version
   where l.batch_id=b.id and (l.source_type<>'MILESTONE_ACCEPTANCE' or o.line_id is null
    or not milestone_invoice_item_current(b,l.item_id,i.requester_user_id,i.active_role)
    or not milestone_invoice_item_current(b,l.item_id,b.preparer_user_id,b.preparer_role)
    or l.event_id<>(select event_id from approved_unbilled_items where id=l.item_id)
    or l.currency is distinct from (select currency from billing_eligibility_events where id=l.event_id)
    or l.billing_evidence is distinct from (select billing_evidence from billing_eligibility_events where id=l.event_id)
    or l.amount is distinct from (select amount from billing_eligibility_events where id=l.event_id)))
 )
$$;
