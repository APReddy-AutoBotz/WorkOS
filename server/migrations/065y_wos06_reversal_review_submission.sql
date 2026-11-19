-- One submission pins the immutable request, policy and confirmation known at submission.
-- Its recipient and delivery identity are the first mandatory in-app approval notice.
create table invoice_reversal_reviews (
  id uuid primary key, organization_id text not null, legal_entity_id text not null,
  request_id uuid not null unique references invoice_line_reversal_requests(id),
  policy_id uuid not null references invoice_batch_approval_policies(id),
  confirmation_id uuid references invoice_batch_confirmations(id),
  actor_id uuid not null references users(id), active_role text not null,
  reviewer_id uuid not null references users(id), reviewer_role text not null,
  delivery_id uuid not null unique, operation_id text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index invoice_reversal_reviews_recipient on invoice_reversal_reviews
  (organization_id,legal_entity_id,reviewer_id,reviewer_role,id);

create function guard_invoice_reversal_review() returns trigger language plpgsql as $$
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
  if policy.id is distinct from new.policy_id or policy.definition->'fullLineReversals' is distinct from 'true'::jsonb
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
create trigger verify_invoice_reversal_review before insert on invoice_reversal_reviews
for each row execute function guard_invoice_reversal_review();
create trigger immutable_invoice_reversal_review before update or delete on invoice_reversal_reviews
for each row execute function reject_commercial_draft_rewrite();

create function require_invoice_reversal_review_audit() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from audit_logs a where a.organization_id=new.organization_id
    and a.legal_entity_id=new.legal_entity_id and a.entity_id=new.id::text and a.user_id=new.actor_id::text
    and a.active_role=new.active_role and a.operation_id=new.operation_id and a.module='Invoice Corrections'
    and a.entity_type='Invoice Reversal Review' and a.action='Submit Full Line Reversal'
    and a.new_value=jsonb_build_object('requestId',new.request_id,'policyId',new.policy_id,'reviewerId',new.reviewer_id,
        'reviewerRole',new.reviewer_role,'confirmationId',new.confirmation_id,'deliveryId',new.delivery_id))
  then raise exception 'Submission requires matching reversal review audit evidence' using errcode='23514'; end if;
  return null;
end $$;
create constraint trigger require_invoice_reversal_review_audit after insert on invoice_reversal_reviews
deferrable initially deferred for each row execute function require_invoice_reversal_review_audit();

create table invoice_reversal_review_reads (
 recipient_id uuid primary key references invoice_reversal_reviews(id), user_id uuid not null references users(id),
 read_at timestamptz not null default clock_timestamp()
);
create function guard_invoice_reversal_review_read() returns trigger language plpgsql as $$
declare ctx jsonb := current_setting('workos.work_approval_context',true)::jsonb;
begin
  if not exists (select 1 from invoice_reversal_reviews s join invoice_line_reversal_requests r on r.id=s.request_id
    join invoice_draft_lines l on l.id=r.line_id where s.id=new.recipient_id and s.reviewer_id=new.user_id
    and s.reviewer_id::text=ctx->>'actorId' and s.reviewer_role=ctx->>'activeRole'
    and s.organization_id=ctx->>'organizationId' and s.legal_entity_id=ctx->>'legalEntityId'
    and invoice_batch_approval_actor_valid(s.organization_id,s.legal_entity_id,s.reviewer_id,s.reviewer_role,'decider')
    and not exists(select 1 from invoice_draft_lines x where x.batch_id=l.batch_id and
      invoice_source_line_visible(s.organization_id,s.legal_entity_id,x.batch_id,x.item_id,s.reviewer_id,s.reviewer_role) is not true))
  then raise exception 'Reversal review notification unavailable' using errcode='23514'; end if;
  return new;
end $$;
create trigger verify_invoice_reversal_review_read before insert on invoice_reversal_review_reads
for each row execute function guard_invoice_reversal_review_read();
create trigger immutable_invoice_reversal_review_read before update or delete on invoice_reversal_review_reads
for each row execute function reject_commercial_draft_rewrite();
