create table invoice_reversal_decisions (
 id uuid primary key, review_id uuid not null references invoice_reversal_reviews(id),
 sequence integer not null check(sequence between 1 and 10), decision text not null check(decision in ('Approved','Rejected')),
 actor_id uuid not null references users(id), active_role text not null, reason text not null check(length(btrim(reason)) between 3 and 1000),
 confirmation_id uuid references invoice_batch_confirmations(id), operation_id text not null,
 created_at timestamptz not null default clock_timestamp(), unique(review_id,sequence)
);
create table invoice_reversal_decision_notices (
 id uuid primary key default gen_random_uuid(), decision_id uuid not null references invoice_reversal_decisions(id),
 recipient_id uuid not null references users(id), required_role text, reasons text[] not null,
 event_key text not null check(event_key in ('approval.action_required','approval.completed','approval.rejected_or_correction_required')),
 channel text not null check(channel in ('Required','Enabled','SuppressedPreference','SuppressedPolicy')),
 delivery_id uuid not null unique default gen_random_uuid(), unique(decision_id,recipient_id)
);
create index invoice_reversal_decision_inbox on invoice_reversal_decision_notices(recipient_id,id);
create table invoice_reversal_decision_reads (
 recipient_id uuid primary key references invoice_reversal_decision_notices(id),user_id uuid not null references users(id),
 read_at timestamptz not null default clock_timestamp()
);

create function reversal_review_actor_visible(review uuid,who uuid,held text,decider boolean) returns boolean language sql stable as $$
 select exists(select 1 from invoice_reversal_reviews s join invoice_line_reversal_requests r on r.id=s.request_id
 join invoice_draft_lines original on original.id=r.line_id where s.id=review
 and case when decider then invoice_batch_approval_actor_valid(s.organization_id,s.legal_entity_id,who,held,'decider')
 else invoice_draft_actor_valid(s.organization_id,s.legal_entity_id,who,held,'view') end
 and not exists(select 1 from invoice_draft_lines l where l.batch_id=original.batch_id and
 invoice_source_line_visible(s.organization_id,s.legal_entity_id,l.batch_id,l.item_id,who,held) is not true))
$$;

create function guard_invoice_reversal_decision() returns trigger language plpgsql as $$
declare
 s invoice_reversal_reviews; r invoice_line_reversal_requests; b invoice_draft_batches; p invoice_batch_approval_policies;
 n integer; stage jsonb; l invoice_draft_lines; ctx jsonb := current_setting('workos.work_approval_context',true)::jsonb;
begin
 select * into strict s from invoice_reversal_reviews where id=new.review_id for update;
 select * into strict r from invoice_line_reversal_requests where id=s.request_id;
 select batch.* into strict b from invoice_draft_lines line join invoice_draft_batches batch on batch.id=line.batch_id
 where line.id=r.line_id for update of batch;
 select * into strict p from invoice_batch_approval_policies where id=s.policy_id;
 select count(*) into n from invoice_reversal_decisions where review_id=s.id;
 stage:=p.definition->'stages'->n;
 if (ctx->>'actorId',ctx->>'activeRole',ctx->>'organizationId',ctx->>'legalEntityId',ctx->>'operationId') is distinct from
 (new.actor_id::text,new.active_role,s.organization_id,s.legal_entity_id,new.operation_id)
 or new.sequence<>n+1 or exists(select 1 from invoice_reversal_decisions where review_id=s.id and decision='Rejected')
 or (new.actor_id,new.active_role) is distinct from ((stage->>'userId')::uuid,stage->>'role')
 or new.actor_id in (r.actor_id,b.preparer_user_id)
 or new.confirmation_id is distinct from (select id from invoice_batch_confirmations where artifact_id=r.artifact_id)
 then raise exception 'Reversal stage, actor or billing evidence changed' using errcode='IBA02'; end if;
 perform lock_commercial_candidate_identity(s.organization_id,s.legal_entity_id,new.actor_id,new.active_role);
 for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
   perform invoice_lock_source_witness(s.organization_id,s.legal_entity_id,l,new.actor_id,new.active_role);
 end loop;
 if not reversal_review_actor_visible(s.id,new.actor_id,new.active_role,true) then
   raise exception 'Reviewer authority changed' using errcode='IBA01'; end if;
 return new;
end $$;
create trigger verify_invoice_reversal_decision before insert on invoice_reversal_decisions
for each row execute function guard_invoice_reversal_decision();

create function deliver_invoice_reversal_decision() returns trigger language plpgsql as $$
declare
 s invoice_reversal_reviews; b invoice_draft_batches; p invoice_batch_approval_policies;
 stage jsonb; event text; target record; ch text; l invoice_draft_lines; original invoice_draft_lines; worker_account uuid; recipients jsonb := '[]'::jsonb;
begin
 select * into strict s from invoice_reversal_reviews where id=new.review_id;
 select * into strict p from invoice_batch_approval_policies where id=s.policy_id;
 select batch.* into strict b from invoice_line_reversal_requests req join invoice_draft_lines origline on origline.id=req.line_id
 join invoice_draft_batches batch on batch.id=origline.batch_id where req.id=s.request_id;
 stage:=p.definition->'stages'->new.sequence;
 if new.decision='Approved' and stage is not null then
   event:='approval.action_required';
 elsif new.decision='Rejected' then event:='approval.rejected_or_correction_required';
 else event:='approval.completed'; end if;
 if event<>'approval.action_required' then
   select line.* into strict original from invoice_line_reversal_requests req join invoice_draft_lines line on line.id=req.line_id where req.id=s.request_id;
   if original.source_type='TM_SNAPSHOT' then
     select u.id into worker_account from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id
     join timesheets h on h.id=e.timesheet_id join users u on u.employee_record_id=h.employee_id and u.status='Active'
     join user_organization_scopes sc on sc.user_id=u.id and sc.organization_id=s.organization_id and sc.legal_entity_id=s.legal_entity_id and sc.active
     where v.id=original.snapshot_id for share of u,sc;
     if worker_account is null then raise exception 'Affected worker unavailable' using errcode='IBA02'; end if;
   end if;
 end if;
 for target in select * from (values
 ((stage->>'userId')::uuid,stage->>'role','current_stage_approver',event='approval.action_required'),
 (s.actor_id,s.active_role,'requester',event<>'approval.action_required'),
 (worker_account,null,'affected_worker',worker_account is not null),
 (b.owner_user_id,b.owner_role,'invoice_batch_owner',event='approval.rejected_or_correction_required'),
 (b.preparer_user_id,b.preparer_role,'finance_preparer',event='approval.rejected_or_correction_required')
 ) as targets(who,held,why,needed) where needed order by who,held,why loop
   if target.why<>'affected_worker' then
   perform lock_commercial_candidate_identity(s.organization_id,s.legal_entity_id,target.who,target.held);
   for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
     perform invoice_lock_source_witness(s.organization_id,s.legal_entity_id,l,target.who,target.held);
   end loop;
   if (target.why='invoice_batch_owner' and not invoice_draft_actor_valid(s.organization_id,s.legal_entity_id,target.who,target.held,'own')) or not reversal_review_actor_visible(s.id,target.who,target.held,event='approval.action_required') or
      (event='approval.action_required' and target.who in (s.actor_id,b.preparer_user_id)) then
     raise exception 'Reversal decision recipient unavailable' using errcode='IBA02'; end if;
   end if;
   ch:='Required';
   if event='approval.completed' then
     ch:=case when not (p.definition->>'completionInApp')::boolean then 'SuppressedPolicy'
       when exists(select 1 from notification_preferences pref join users u on u.employee_record_id=pref.employee_id
         where u.id=target.who and pref.event_type=event and not pref.in_app) then 'SuppressedPreference' else 'Enabled' end;
   end if;
   recipients := recipients || jsonb_build_object('who',target.who,'why',target.why,'channel',ch,
      'held',case when event='approval.action_required' then target.held end);
 end loop;
 insert into invoice_reversal_decision_notices(decision_id,recipient_id,required_role,reasons,event_key,channel)
   select new.id,v.who,v.held,array_agg(distinct v.why order by v.why),event,v.channel
   from jsonb_to_recordset(recipients) v(who uuid,held text,why text,channel text)
   group by v.who,v.held,v.channel;
 return null;
end $$;
create trigger deliver_invoice_reversal_decision after insert on invoice_reversal_decisions
for each row execute function deliver_invoice_reversal_decision();
create function guard_reversal_notice_write() returns trigger language plpgsql as $$
begin
 if pg_trigger_depth()<>2 then raise exception 'Reversal notices follow decisions' using errcode='23514'; end if;
 return new;
end $$;
create trigger verify_reversal_notice_write before insert on invoice_reversal_decision_notices
for each row execute function guard_reversal_notice_write();
create trigger immutable_reversal_decision_notices before update or delete on invoice_reversal_decision_notices
for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_reversal_decisions before update or delete on invoice_reversal_decisions
for each row execute function reject_commercial_draft_rewrite();

create function require_reversal_decision_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from invoice_reversal_reviews s join audit_logs a on a.organization_id=s.organization_id
   and a.legal_entity_id=s.legal_entity_id where s.id=new.review_id and a.entity_id=new.id::text
   and a.module='Invoice Corrections' and a.action='Decide Full Line Reversal' and a.entity_type='Invoice Reversal Decision'
   and a.operation_id=new.operation_id and a.active_role=new.active_role and a.user_id=new.actor_id::text and a.reason=new.reason
   and a.new_value=jsonb_build_object('reviewId',s.id,'sequence',new.sequence,'decision',new.decision,'confirmationId',new.confirmation_id))
 then raise exception 'Matching reversal decision evidence required' using errcode='23514'; end if;
 return null;
end $$;
create constraint trigger require_reversal_decision_audit after insert on invoice_reversal_decisions
deferrable initially deferred for each row execute function require_reversal_decision_audit();
create function reversal_decision_notice_visible(n invoice_reversal_decision_notices, who uuid, held text) returns boolean language sql stable as $$
 select exists(select 1 from invoice_reversal_decisions d join invoice_reversal_reviews s on s.id=d.review_id
 where d.id=n.decision_id and n.recipient_id=who and (n.required_role is null or n.required_role=held) and
 (reversal_review_actor_visible(s.id,who,held,n.required_role is not null) or ('affected_worker'=any(n.reasons) and exists (
 select 1 from invoice_line_reversal_requests r join invoice_draft_lines l on l.id=r.line_id join commercial_tm_valuations v on v.id=l.snapshot_id
 join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join users u on u.employee_record_id=h.employee_id
 join user_organization_scopes sc on sc.user_id=u.id and sc.active and sc.organization_id=s.organization_id and sc.legal_entity_id=s.legal_entity_id
 join user_roles ur on ur.user_id=u.id join roles role on role.id=ur.role_id and role.name=held
 where r.id=s.request_id and u.status='Active' and u.id=who))))
$$;
create function verify_reversal_decision_read() returns trigger language plpgsql as $$
declare ctx jsonb:=current_setting('workos.work_approval_context',true)::jsonb;
begin
 if not exists(select 1 from invoice_reversal_decision_notices n join invoice_reversal_decisions d on d.id=n.decision_id
 join invoice_reversal_reviews s on s.id=d.review_id where n.id=new.recipient_id and n.recipient_id=new.user_id
 and new.user_id::text=ctx->>'actorId' and s.organization_id=ctx->>'organizationId' and s.legal_entity_id=ctx->>'legalEntityId'
 and (n.required_role is null or n.required_role=ctx->>'activeRole') and n.channel in ('Required','Enabled')
 and reversal_decision_notice_visible(n,new.user_id,ctx->>'activeRole'))
 then raise exception 'Reversal notice unavailable' using errcode='23514'; end if;
 return new;
end $$;
create trigger verify_reversal_decision_read before insert on invoice_reversal_decision_reads
for each row execute function verify_reversal_decision_read();
create trigger immutable_reversal_decision_reads before update or delete on invoice_reversal_decision_reads
for each row execute function reject_commercial_draft_rewrite();
