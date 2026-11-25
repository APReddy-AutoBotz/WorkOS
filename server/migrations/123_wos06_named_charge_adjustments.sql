-- Existing full-line requests and decisions retain their identities and evidence.
alter table invoice_line_reversal_requests
  add column adjustment_kind text,
  add column requested_amount numeric,
  add constraint valid_charge_adjustment check (
    (adjustment_kind is null and requested_amount is null) or
    (adjustment_kind is not null and adjustment_kind in ('Discount','Write-off')
      and requested_amount is not null and requested_amount>0 and requested_amount<10000000000000000
      and requested_amount=round(requested_amount,4))
  ),
  drop constraint invoice_line_reversal_requests_line_id_key;
create unique index one_full_reversal_per_charge on invoice_line_reversal_requests(line_id) where adjustment_kind is null;
create index adjustments_by_charge on invoice_line_reversal_requests(line_id) where adjustment_kind is not null;

create function remaining_invoice_charge(charge uuid) returns numeric language sql stable as $$
  select l.amount - coalesce((
    select sum(coalesce(req.requested_amount,l.amount))
    from invoice_line_reversal_requests req
    join invoice_reversal_reviews review on review.request_id=req.id
    join invoice_batch_approval_policies p on p.id=review.policy_id
    join invoice_reversal_decisions d on d.review_id=review.id and d.decision='Approved'
      and d.sequence=jsonb_array_length(p.definition->'stages')
    where req.line_id=l.id
  ),0) from invoice_draft_lines l where l.id=charge and l.amount>0
$$;

create function check_requested_charge_amount() returns trigger language plpgsql as $$
declare remaining numeric := remaining_invoice_charge(new.line_id);
begin
  if remaining is null or new.requested_amount>remaining then
    raise exception 'Requested adjustment exceeds the remaining original charge' using errcode='23514';
  end if;
  return new;
end $$;
create trigger check_requested_charge_amount before insert on invoice_line_reversal_requests
for each row when (new.adjustment_kind is not null) execute function check_requested_charge_amount();

-- A final approval claims a distinct starting balance. The unique index also fences
-- two transactions that observed the same balance under snapshot isolation.
alter table invoice_reversal_decisions add column charge_line_id uuid references invoice_draft_lines(id),
  add column balance_before numeric;
create unique index one_approval_at_charge_balance on invoice_reversal_decisions(charge_line_id,balance_before)
  where charge_line_id is not null;
create function cap_approved_charge_adjustment() returns trigger language plpgsql as $$
declare charge uuid; requested numeric; stage_count integer; remaining numeric;
begin
  new.charge_line_id := null;
  new.balance_before := null;
  if new.decision='Approved' then
    select l.id,coalesce(req.requested_amount,l.amount),jsonb_array_length(p.definition->'stages')
    into strict charge,requested,stage_count
    from invoice_reversal_reviews review join invoice_batch_approval_policies p on p.id=review.policy_id
    join invoice_line_reversal_requests req on req.id=review.request_id join invoice_draft_lines l on l.id=req.line_id
    where review.id=new.review_id;
    if stage_count=new.sequence then
      remaining := remaining_invoice_charge(charge);
      if remaining is null or requested<=0 or requested>remaining then
        raise exception 'Final approval exceeds the remaining original charge' using errcode='IBA02';
      end if;
      new.charge_line_id := charge;
      new.balance_before := remaining;
    end if;
  end if;
  return new;
end $$;
create trigger verify_remaining_charge before insert on invoice_reversal_decisions
for each row execute function cap_approved_charge_adjustment();

create or replace function valid_invoice_batch_approval_policy(d jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
begin
 if d ? 'namedChargeAdjustments' then
   if d->'namedChargeAdjustments' is distinct from 'true'::jsonb then return false; end if;
   if exists(select 1 from jsonb_array_elements(d->'stages') s group by (s->>'userId')::uuid having count(*)>1) then return false; end if;
   d := d - 'namedChargeAdjustments';
 end if;
 if d ? 'fullLineReversals' then
   if d->'fullLineReversals' is distinct from 'true'::jsonb then return false; end if;
   if exists (select 1 from jsonb_array_elements(d->'stages') stage
     group by (stage->>'userId')::uuid having count(*)>1) then return false; end if;
   d := d - 'fullLineReversals';
 end if;
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','engagementId','stages','locale','templates','completionInApp']) or (select count(*) from jsonb_object_keys(d))<>6 or d->>'entityType' is distinct from 'InvoiceBatch' or jsonb_typeof(d->'engagementId') is distinct from 'string' or length(btrim(d->>'engagementId')) not between 1 and 200 then return false;end if;
 if not valid_work_approval_definition((d-'engagementId')||jsonb_build_object('entityType','Timesheet','workerIds','[]'::jsonb)) then return false;end if;
 if exists(select 1 from jsonb_array_elements(d->'templates') t where regexp_replace(t->>'subject','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]' or regexp_replace(t->>'body','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]') then return false;end if;
 return true;
exception when others then return false;end $$;

create or replace function guard_invoice_reversal_review() returns trigger language plpgsql as $$
declare
  req invoice_line_reversal_requests; batch invoice_draft_batches; policy invoice_batch_approval_policies;
  stage jsonb; line invoice_draft_lines; who uuid; held text;
begin
  select * into strict req from invoice_line_reversal_requests where id=new.request_id;
  select b.* into strict batch from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id
    where l.id=req.line_id for update of b;
  if (new.organization_id,new.legal_entity_id,new.actor_id,new.active_role) is distinct from
     (req.organization_id,req.legal_entity_id,req.actor_id,req.active_role)
     or new.confirmation_id is distinct from (select id from invoice_batch_confirmations where artifact_id=req.artifact_id)
  then raise exception 'Reversal source or requester changed' using errcode='23514'; end if;

  perform pg_advisory_xact_lock(hashtext('invoice-approval-policy:'||batch.organization_id||':'||batch.legal_entity_id||':'||batch.engagement_id));
  new.created_at := clock_timestamp();
  select * into policy from invoice_batch_approval_policies where organization_id=batch.organization_id
    and legal_entity_id=batch.legal_entity_id and engagement_id=batch.engagement_id
    and effective_from <= (new.created_at at time zone 'UTC')::date
    order by effective_from desc, sequence desc limit 1;
  if policy.id is distinct from new.policy_id or policy.definition->(case when req.adjustment_kind is null then 'fullLineReversals' else 'namedChargeAdjustments' end) is distinct from 'true'::jsonb
     or (new.reviewer_id,new.reviewer_role) is distinct from
        ((policy.definition->'stages'->0->>'userId')::uuid,policy.definition->'stages'->0->>'role')
  then raise exception 'Reversal policy changed' using errcode='23514'; end if;

  perform lock_commercial_candidate_identity(batch.organization_id,batch.legal_entity_id,new.actor_id,new.active_role);
  if invoice_batch_approval_actor_valid(batch.organization_id,batch.legal_entity_id,new.actor_id,new.active_role,'submitter') is not true
  then raise exception 'Reversal submission authority unavailable' using errcode='IBA01'; end if;
  for stage in select value from jsonb_array_elements(policy.definition->'stages') loop
    who := (stage->>'userId')::uuid; held := stage->>'role';
    perform lock_commercial_candidate_identity(batch.organization_id,batch.legal_entity_id,who,held);
    if who in (new.actor_id,batch.preparer_user_id) or invoice_batch_approval_actor_valid(batch.organization_id,batch.legal_entity_id,who,held,'decider') is not true
    then raise exception 'Independent reversal reviewer unavailable' using errcode='23514'; end if;
    for line in select * from invoice_draft_lines where batch_id=batch.id order by sequence loop
      perform invoice_lock_source_witness(batch.organization_id,batch.legal_entity_id,line,who,held);
      if invoice_source_line_visible(batch.organization_id,batch.legal_entity_id,batch.id,line.item_id,who,held) is not true
      then raise exception 'Reversal review scope changed' using errcode='23514'; end if;
    end loop;
  end loop;
  return new;
end $$;

create or replace function require_invoice_line_reversal_audit() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from audit_logs a
    join invoice_csv_artifacts artifact on artifact.id=new.artifact_id
    where a.operation_id=new.operation_id and a.entity_id=new.id::text
      and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id
      and a.user_id=new.actor_id::text and a.active_role=new.active_role
      and a.module='Invoice Corrections' and a.action=case when new.adjustment_kind is null then 'Request Full Line Reversal' else 'Request Charge Adjustment' end
      and a.entity_type='Invoice Line Reversal Request' and a.reason=new.reason
      and a.new_value=(jsonb_build_object('requestId',new.id,'lineId',new.line_id,'artifactId',new.artifact_id,
        'confirmationId',new.confirmation_id,'batchId',artifact.batch_id,'sha256',artifact.sha256) || case when new.adjustment_kind is null then '{}'::jsonb else jsonb_build_object('kind',new.adjustment_kind,'amount',trim_scale(new.requested_amount)::text,'currency',(select currency from invoice_draft_lines where id=new.line_id)) end)
  ) then raise exception 'Reversal request requires matching audit evidence' using errcode='23514'; end if;
  return null;
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
 where s.id=review and req.adjustment_kind is null and l.source_type in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT') and l.amount=original.amount and l.currency=original.currency
$$;

create or replace function require_invoice_reversal_review_audit() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from audit_logs a where a.organization_id=new.organization_id
    and a.legal_entity_id=new.legal_entity_id and a.entity_id=new.id::text and a.user_id=new.actor_id::text
    and a.active_role=new.active_role and a.operation_id=new.operation_id and a.module='Invoice Corrections'
    and a.entity_type='Invoice Reversal Review' and a.action=case when (select adjustment_kind from invoice_line_reversal_requests where id=new.request_id) is null then 'Submit Full Line Reversal' else 'Submit Charge Adjustment' end
    and a.new_value=jsonb_build_object('requestId',new.request_id,'policyId',new.policy_id,'reviewerId',new.reviewer_id,
        'reviewerRole',new.reviewer_role,'confirmationId',new.confirmation_id,'deliveryId',new.delivery_id))
  then raise exception 'Submission requires matching reversal review audit evidence' using errcode='23514'; end if;
  return null;
end $$;

create or replace function require_reversal_decision_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from invoice_reversal_reviews s join audit_logs a on a.organization_id=s.organization_id
   and a.legal_entity_id=s.legal_entity_id where s.id=new.review_id and a.entity_id=new.id::text
   and a.module='Invoice Corrections' and a.action=case when (select adjustment_kind from invoice_line_reversal_requests where id=s.request_id) is null then 'Decide Full Line Reversal' else 'Decide Charge Adjustment' end and a.entity_type='Invoice Reversal Decision'
   and a.operation_id=new.operation_id and a.active_role=new.active_role and a.user_id=new.actor_id::text and a.reason=new.reason
   and a.new_value=jsonb_build_object('reviewId',s.id,'sequence',new.sequence,'decision',new.decision,'confirmationId',new.confirmation_id))
 then raise exception 'Matching reversal decision evidence required' using errcode='23514'; end if;
 return null;
end $$;
