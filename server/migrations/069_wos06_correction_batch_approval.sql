-- The existing submission guard verifies the exact signed sum against immutable source lines.
alter table invoice_batch_approval_instances drop constraint invoice_batch_approval_instances_total_check;
alter table invoice_batch_approval_instances add constraint invoice_batch_approval_instances_total_check check(total<>0);

alter function invoice_batch_lineage_hash(uuid) rename to standard_invoice_batch_lineage_hash;
create function invoice_batch_lineage_hash(batch uuid) returns text language sql stable as $$
 select case when b.source_type='FULL_LINE_REVERSAL' then correction_batch_lineage_hash(batch)
 else standard_invoice_batch_lineage_hash(batch) end from invoice_draft_batches b where b.id=batch
$$;
alter function invoice_batch_source_current(invoice_draft_batches) rename to standard_invoice_batch_source_current;
create function invoice_batch_source_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select case when b.source_type='FULL_LINE_REVERSAL' then invoice_draft_owner_current(b)
 and not exists(select 1 from invoice_draft_cancellations x where x.batch_id=b.id)
 and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o
   on o.item_id=l.item_id and o.item_version=l.item_version and o.line_id=l.id and o.batch_id=b.id
   where l.batch_id=b.id and o.line_id is null)
 else standard_invoice_batch_source_current(b) end
$$;
alter function invoice_batch_approval_pin_current(invoice_batch_approval_instances) rename to standard_invoice_batch_approval_pin_current;
create function invoice_batch_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select case when b.source_type='FULL_LINE_REVERSAL' then invoice_batch_source_current(b)
 and i.organization_id=b.organization_id and i.legal_entity_id=b.legal_entity_id
 and (i.owner_user_id,i.owner_role,i.preparer_user_id,i.preparer_role,i.currency)=(b.owner_user_id,b.owner_role,b.preparer_user_id,b.preparer_role,b.currency)
 and i.total=(select sum(amount) from invoice_draft_lines where batch_id=b.id)
 and i.line_count=(select count(*) from invoice_draft_lines where batch_id=b.id)
 and i.lineage_hash=correction_batch_lineage_hash(b.id)
 and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter')
 and correction_original_scope_current(b,i.requester_user_id,i.active_role)
 else standard_invoice_batch_approval_pin_current(i) end from invoice_draft_batches b where b.id=i.batch_id
$$;

alter function invoice_source_line_visible(text,text,uuid,uuid,uuid,text) rename to standard_invoice_source_line_visible;
create function invoice_source_line_visible(org text,legal text,batch uuid,item uuid,who uuid,held_role text) returns boolean language sql stable as $$
 select coalesce((select case when b.source_type='FULL_LINE_REVERSAL' then correction_original_scope_current(b,who,held_role)
 else standard_invoice_source_line_visible(org,legal,batch,item,who,held_role) end
 from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id where b.id=batch and l.item_id=item
 and b.organization_id=org and b.legal_entity_id=legal),false)
$$;
alter function invoice_lock_source_witness(text,text,invoice_draft_lines,uuid,text) rename to standard_invoice_lock_source_witness;
create function invoice_lock_source_witness(org text,legal text,line invoice_draft_lines,who uuid,held_role text) returns void language plpgsql as $$
declare member invoice_draft_lines;
begin
 if line.source_type='FULL_LINE_REVERSAL' then
   perform lock_commercial_candidate_identity(org,legal,who,held_role);
   for member in select l.* from invoice_draft_lines l where l.batch_id=(line.billing_evidence->>'originalBatchId')::uuid
     and l.organization_id=org and l.legal_entity_id=legal order by l.sequence loop
     perform standard_invoice_lock_source_witness(org,legal,member,who,held_role);
   end loop;
 else perform standard_invoice_lock_source_witness(org,legal,line,who,held_role); end if;
end $$;

create function require_independent_correction_stages() returns trigger language plpgsql as $$
declare b invoice_draft_batches; p invoice_batch_approval_policies; st jsonb; who uuid; held_role text;
begin
 select * into strict b from invoice_draft_batches where id=new.batch_id for update;
 if b.source_type<>'FULL_LINE_REVERSAL' then return new;end if;
 select * into strict p from invoice_batch_approval_policies where id=new.policy_id;
 if exists(select 1 from jsonb_array_elements(p.definition->'stages') s group by (s->>'userId')::uuid having count(*)>1)
 then raise exception 'Distinct correction reviewers required' using errcode='IBA01';end if;
 for st in select value from jsonb_array_elements(p.definition->'stages') order by value->>'userId' loop
   who:=(st->>'userId')::uuid;held_role:=st->>'role';
   perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,who,held_role);
   if who in(new.requester_user_id,b.owner_user_id,b.preparer_user_id)
   or invoice_batch_approval_actor_valid(b.organization_id,b.legal_entity_id,who,held_role,'decider') is not true
   or correction_original_scope_current(b,who,held_role) is not true
   then raise exception 'Independent scoped correction reviewer unavailable' using errcode='IBA01';end if;
 end loop;
 return new;
end $$;
create trigger require_independent_correction_stages before insert on invoice_batch_approval_instances
 for each row execute function require_independent_correction_stages();

alter function invoice_notice_source_authorized(invoice_draft_batches,uuid,text) rename to standard_invoice_notice_source_authorized;
create function invoice_notice_source_authorized(b invoice_draft_batches,actor uuid,active_role text) returns boolean language sql stable as $$
 select case when b.source_type='FULL_LINE_REVERSAL' then correction_original_scope_current(b,actor,active_role)
 else standard_invoice_notice_source_authorized(b,actor,active_role) end
$$;
alter function invoice_batch_expected_recipients(invoice_batch_approval_instances,text,int) rename to standard_invoice_batch_expected_recipients;
create function invoice_batch_expected_recipients(i invoice_batch_approval_instances,event_key text,stage_no int)
returns table(recipient uuid,reason text) language plpgsql stable as $$
declare w text; accounts uuid[];
begin
 return query select x.recipient,x.reason from standard_invoice_batch_expected_recipients(i,event_key,stage_no) x;
 if event_key='approval.action_required' or not exists(select 1 from invoice_draft_batches b where b.id=i.batch_id and b.source_type='FULL_LINE_REVERSAL')
 then return;end if;
 for w in select distinct h.employee_id from invoice_draft_lines credit join invoice_draft_lines orig
   on orig.id=(credit.billing_evidence->>'originalLineId')::uuid join commercial_tm_valuations v on v.id=orig.snapshot_id
   join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where credit.batch_id=i.batch_id order by h.employee_id loop
   select array_agg(u.id order by u.id) into accounts from users u join user_organization_scopes sc on sc.user_id=u.id
   where u.employee_record_id=w and u.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active;
   if coalesce(cardinality(accounts),0)<>1 then raise exception 'Affected worker account unavailable' using errcode='IBA03';end if;
   recipient:=accounts[1];reason:='affected_worker';return next;
 end loop;
end $$;

create or replace function guard_invoice_batch_review_invalidation() returns trigger language plpgsql as $$
declare ctx jsonb;i invoice_batch_approval_instances;b invoice_draft_batches;line invoice_draft_lines;worker_id text;allow_cancel boolean;allow_withdraw boolean;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from invoice_batch_approval_instances where id=new.instance_id;select * into b from invoice_draft_batches where id=i.batch_id for update;perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);
 allow_cancel=invoice_draft_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'cancel');allow_withdraw=new.actor_id=i.requester_user_id and new.active_role=i.active_role and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'submitter');
 if ctx is null or i.id is null or b.id is null or new.id::text is distinct from ctx->>'invalidationId' or i.id::text is distinct from ctx->>'instanceId' or i.batch_id::text is distinct from ctx->>'batchId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not(allow_cancel or allow_withdraw) or invoice_batch_governed_state(b.id)<>'Under Review' or i.sequence<>(select max(x.sequence) from invoice_batch_approval_instances x where x.batch_id=b.id) then raise exception 'Only the active protected review may be withdrawn or cancelled.' using errcode='IBA02';end if;
 for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  if line.source_type='TM_SNAPSHOT' then
   perform lock_tm_billing_worker_witness(i.organization_id,i.legal_entity_id,line.snapshot_id,new.actor_id,new.active_role);
   select h.employee_id into worker_id from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where v.id=line.snapshot_id;
   if not invoice_historical_worker_visible(i.organization_id,i.legal_entity_id,worker_id,new.actor_id,new.active_role) then raise exception 'Historical worker scope is required for every retained line.' using errcode='IBA01';end if;
  elsif line.source_type='FULL_LINE_REVERSAL' then
   perform invoice_lock_source_witness(i.organization_id,i.legal_entity_id,line,new.actor_id,new.active_role);
   if correction_original_scope_current(b,new.actor_id,new.active_role) is not true then raise exception 'Original export scope required' using errcode='IBA01';end if;
  elsif line.source_type='MILESTONE_ACCEPTANCE' then
   if not invoice_source_historical_visible(i.organization_id,i.legal_entity_id,line,new.actor_id,new.active_role) then raise exception 'Current milestone history access is required.' using errcode='IBA01';end if;
  else raise exception 'Unsupported invoice source.' using errcode='IBA01';end if;
 end loop;return new;
end $$;

create or replace function guard_correction_draft() returns trigger language plpgsql as $$
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
     if coalesce(ctx->>'expectedState','Draft') not in ('Draft','Approved')
     or invoice_batch_governed_state(b.id) is distinct from coalesce(ctx->>'expectedState','Draft')
     or exists(select 1 from invoice_csv_artifacts where batch_id=b.id) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'cancel')
     or (select count(*) from invoice_draft_lines where batch_id=b.id)<>new.expected_line_count
     or exists(select 1 from invoice_draft_lines where batch_id=b.id and billing_evidence->>'originalBatchId' is distinct from orig.id::text)
     then raise exception 'Current correction draft required for cancellation' using errcode='IBA01'; end if;
   end if;
 end if;
 return new;
end $$;
