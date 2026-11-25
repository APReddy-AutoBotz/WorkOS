-- Each approved decision can issue once. Several independent partial approvals
-- may point to the same original event.
alter table billing_eligibility_events drop constraint billing_eligibility_events_reverses_event_id_key,
  drop constraint billing_event_signed_amount, drop constraint billing_event_source_identity;
create unique index one_full_credit_per_event on billing_eligibility_events(reverses_event_id)
  where source_type='FULL_LINE_REVERSAL';
alter table billing_eligibility_events add constraint billing_event_signed_amount check (
  (source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') and amount<0)
  or (source_type not in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') and amount>0)
);

alter table billing_eligibility_events add constraint billing_event_source_identity check (
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and instance_id is not null and decision_id is not null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is not null and milestone_decision_id is not null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is not null and reverses_event_id is not null)
 or (source_type in ('FIXED_FEE_INSTALLMENT','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD') and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
);

create or replace function invoice_credit_source(review uuid) returns table (
 organization_id text, legal_entity_id text, client_id text, contract_id text, engagement_id text,
 currency text, amount numeric, original_event uuid, final_decision uuid, confirmation uuid, evidence jsonb
) language sql stable as $$
 select l.organization_id,l.legal_entity_id,original.client_id,original.contract_id,original.engagement_id,l.currency,-coalesce(req.requested_amount,l.amount),
   original.id,d.id,cf.id,jsonb_build_object(
    'sourceVersion',1,'reviewId',s.id,'policyId',s.policy_id,'requestId',req.id,'decisionId',d.id,
    'originalSourceType',original.source_type,'originalEventId',original.id,'originalEventVersion',original.version,
    'originalItemId',l.item_id,'originalItemVersion',l.item_version,'originalLineId',l.id,'originalBatchId',l.batch_id,
    'artifactId',a.id,'artifactSha256',a.sha256,'confirmationId',cf.id,'currency',l.currency,
    'originalAmount',trim_scale(l.amount)::text,'amount',trim_scale(-coalesce(req.requested_amount,l.amount))::text) || case when req.adjustment_kind is null then '{}'::jsonb else jsonb_build_object(
     'adjustmentKind',req.adjustment_kind,'approvedBalanceBefore',trim_scale(d.balance_before)::text) end
 from invoice_reversal_reviews s join invoice_line_reversal_requests req on req.id=s.request_id
 join invoice_batch_approval_policies p on p.id=s.policy_id
 join invoice_reversal_decisions d on d.review_id=s.id and d.sequence=jsonb_array_length(p.definition->'stages') and d.decision='Approved'
 join invoice_draft_lines l on l.id=req.line_id join invoice_csv_artifacts a on a.id=req.artifact_id and a.batch_id=l.batch_id
 join invoice_draft_occupancies occ on occ.line_id=l.id and occ.item_id=l.item_id and occ.item_version=l.item_version and occ.batch_id=l.batch_id
 join billing_eligibility_events original on original.id=l.event_id and original.source_type=l.source_type
 left join invoice_batch_confirmations cf on cf.artifact_id=a.id
 where s.id=review and l.source_type in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT') and l.amount=original.amount and l.currency=original.currency
$$;

create or replace function guard_full_line_reversal_event() returns trigger language plpgsql as $$
declare
 src record; s invoice_reversal_reviews; b invoice_draft_batches; l invoice_draft_lines;
 ctx jsonb := current_setting('workos.reversal_issue_context',true)::jsonb;
 perm text := 'commercial.reversal_eligibility.create';
begin
 select s0.* into strict s from invoice_reversal_reviews s0 join invoice_reversal_decisions d on d.review_id=s0.id where d.id=new.reversal_decision_id;
 select batch.* into strict b from invoice_line_reversal_requests req join invoice_draft_lines line on line.id=req.line_id
 join invoice_draft_batches batch on batch.id=line.batch_id where req.id=s.request_id for update of batch;
 select * into src from invoice_credit_source(s.id);
 if new.source_type is distinct from (case when src.evidence ? 'adjustmentKind' then 'CHARGE_ADJUSTMENT' else 'FULL_LINE_REVERSAL' end)
 or src.final_decision is null or (ctx->>'actorId',ctx->>'role',ctx->>'org',ctx->>'legal',ctx->>'operationId') is distinct from
 (new.actor_id::text,new.active_role,new.organization_id,new.legal_entity_id,new.operation_id)
 or (src.organization_id,src.legal_entity_id,src.final_decision,src.original_event) is distinct from
 (new.organization_id,new.legal_entity_id,new.reversal_decision_id,new.reverses_event_id)
 or (new.client_id,new.contract_id,new.engagement_id,new.currency,new.amount,new.billing_evidence) is distinct from
 (src.client_id,src.contract_id,src.engagement_id,src.currency,src.amount,src.evidence)
 then raise exception 'Approved reversal evidence changed' using errcode='23514'; end if;
 perform lock_commercial_candidate_identity(s.organization_id,s.legal_entity_id,new.actor_id,new.active_role);
 if invoice_draft_actor_valid(s.organization_id,s.legal_entity_id,new.actor_id,new.active_role,'prepare') is not true
 or not (exists(select 1 from role_permissions rp where rp.role_name=new.active_role and rp.permission_key=perm and rp.enabled)
      or exists(select 1 from user_permission_grants g where g.user_id=new.actor_id and g.permission_key=perm)) then
   raise exception 'Reversal issuance authority unavailable' using errcode='IBA01'; end if;
 for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
   perform invoice_lock_source_witness(s.organization_id,s.legal_entity_id,l,new.actor_id,new.active_role);
   if invoice_source_line_visible(s.organization_id,s.legal_entity_id,l.batch_id,l.item_id,new.actor_id,new.active_role) is not true then
     raise exception 'Reversal source unavailable' using errcode='IBA01'; end if;
 end loop;
 new.created_at := clock_timestamp();
 if new.eligible_on is distinct from (new.created_at at time zone 'UTC')::date then
   raise exception 'Reinspect the UTC eligibility date' using errcode='23514'; end if;
 return new;
end $$;

create or replace function require_full_line_reversal_receipt() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from approved_unbilled_items item join audit_logs a on a.entity_id=new.id::text
 where item.event_id=new.id and item.organization_id=new.organization_id and item.legal_entity_id=new.legal_entity_id
 and a.module='Invoice Corrections' and a.action=case when new.source_type='CHARGE_ADJUSTMENT' then 'Issue Charge Adjustment' else 'Issue Full Line Reversal' end and a.entity_type='Billing Eligibility Event'
 and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text
 and a.active_role=new.active_role and a.operation_id=new.operation_id and length(btrim(a.reason)) between 3 and 1000
 and a.new_value=jsonb_build_object('itemId',item.id,'decisionId',new.reversal_decision_id,'originalEventId',new.reverses_event_id,
 'currency',new.currency,'amount',trim_scale(new.amount)::text,'eligibleOn',new.eligible_on))
 then raise exception 'Matching reversal eligibility receipt required' using errcode='23514'; end if;
 return null;
end $$;

create trigger guard_adjustment_eligibility before insert on billing_eligibility_events
for each row when (new.source_type='CHARGE_ADJUSTMENT') execute function guard_full_line_reversal_event();
create trigger verify_adjustment_credit_authority before insert on billing_eligibility_events
for each row when (new.source_type='CHARGE_ADJUSTMENT') execute function verify_retainer_credit_authority();
create trigger register_adjustment_credit after insert on billing_eligibility_events
for each row when (new.source_type='CHARGE_ADJUSTMENT') execute function register_issued_billing_event();
create constraint trigger require_adjustment_credit_receipt after insert on billing_eligibility_events
deferrable initially deferred for each row when (new.source_type='CHARGE_ADJUSTMENT') execute function require_full_line_reversal_receipt();
