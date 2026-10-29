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
