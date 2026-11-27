-- Commercial receipt recovery uses the immutable reserved lines and the operator's
-- current source permission. A later loss of an upstream approver is independent.
create function invoice_reserved_line_visible(b invoice_draft_batches,l invoice_draft_lines,actor uuid,held_role text)
returns boolean language sql stable as $$
 select coalesce(case when b.source_type in ('MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT') then
   l.batch_id=b.id and l.source_type=b.source_type and (l.organization_id,l.legal_entity_id)=(b.organization_id,b.legal_entity_id)
   and exists(select from billing_eligibility_events ev where ev.id=l.event_id
     and (ev.organization_id,ev.legal_entity_id,ev.engagement_id,ev.client_id,ev.contract_id,ev.source_type,ev.currency,ev.amount,ev.billing_evidence)
       =(b.organization_id,b.legal_entity_id,b.engagement_id,b.client_id,b.contract_id,l.source_type,l.currency,l.amount,l.billing_evidence))
   and case when b.source_type='MILESTONE_ACCEPTANCE' then milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,actor,held_role,'viewer')
     else invoice_notice_actor_has(b.organization_id,b.legal_entity_id,actor,held_role,case b.source_type
       when 'RETAINER_PERIOD' then 'commercial.retainer_eligibility.issue' when 'MANAGED_SERVICE_UNIT' then 'commercial.service_units.issue'
       when 'MANAGED_SERVICE_PERIOD' then 'commercial.service_periods.issue' when 'FIXED_FEE_INSTALLMENT' then 'commercial.fixed_fee_eligibility.issue' end) end
   when b.source_type='TM_SNAPSHOT' then exists(select from commercial_tm_valuations v
     join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id
     where v.id=l.snapshot_id and (v.organization_id,v.legal_entity_id)=(b.organization_id,b.legal_entity_id)
       and invoice_historical_worker_visible(b.organization_id,b.legal_entity_id,h.employee_id,actor,held_role))
   else invoice_source_line_visible(b.organization_id,b.legal_entity_id,b.id,l.item_id,actor,held_role) end,false)
$$;

create function invoice_reserved_batch_visible(b invoice_draft_batches,actor uuid,held_role text)
returns boolean language sql stable as $$
 select case when b.source_type='FULL_LINE_REVERSAL' then
   not exists(select from invoice_draft_lines credit where credit.batch_id=b.id and not exists(
     select from invoice_draft_batches orig join invoice_csv_artifacts a on a.batch_id=orig.id
     where orig.id::text=credit.billing_evidence->>'originalBatchId' and a.id::text=credit.billing_evidence->>'artifactId'
       and (orig.organization_id,orig.legal_entity_id,orig.engagement_id,orig.currency)=(b.organization_id,b.legal_entity_id,b.engagement_id,b.currency)
       and not exists(select from invoice_draft_lines l where l.batch_id=orig.id and not invoice_reserved_line_visible(orig,l,actor,held_role))))
 else not exists(select from invoice_draft_lines l where l.batch_id=b.id and not invoice_reserved_line_visible(b,l,actor,held_role)) end
$$;

create function invoice_provider_approval_current(b invoice_draft_batches,i invoice_batch_approval_instances)
returns boolean language sql stable as $$
 select invoice_batch_approval_pin_current(i) and case
   when is_retainer_credit_batch(b.id) then invoice_review_identities_current(i) and not exists(select from invoice_draft_lines l
     where l.batch_id=b.id and invoice_reversal_participants_valid(l.billing_evidence->>'originalSourceType',i) is not true)
   when b.source_type in ('RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT') then invoice_review_identities_current(i)
   else true end
$$;

create function invoice_provider_terminal_receipt(b invoice_draft_batches,actor uuid,held_role text,result_table text,result_id uuid,request_key uuid) returns boolean language sql stable as $$
 select exists(select from invoice_provider_exports e join invoice_provider_attempts a on a.export_id=e.id
   where e.batch_id=b.id and e.approval_id=(select id from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1)
     and a.actor_id=actor and a.active_role=held_role and invoice_csv_actor_valid(b.organization_id,b.legal_entity_id,actor,held_role,'create')
     and invoice_notice_actor_has(b.organization_id,b.legal_entity_id,actor,held_role,'commercial.invoice_export.deliver')
     and invoice_reserved_batch_visible(b,actor,held_role)
     and ((result_table='invoice_csv_artifacts' and a.result='accepted' and a.artifact_id=result_id and request_key=e.id)
       or (result_table='invoice_csv_failures' and a.result='permanently_rejected' and a.id=result_id)))
$$;

create or replace function guard_invoice_csv_append() returns trigger language plpgsql as $$
declare reserved_receipt boolean; ctx jsonb;b invoice_draft_batches;i invoice_batch_approval_instances;p invoice_batch_approval_policies;t invoice_batch_approval_transitions;l invoice_draft_lines;stage record;v_count int;v_total numeric;begin
 begin ctx=nullif(current_setting('workos.invoice_csv_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id for update;perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if b.id is null or ctx is null or new.batch_id::text is distinct from ctx->>'batchId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or b.organization_id<>new.organization_id or b.legal_entity_id<>new.legal_entity_id or invoice_batch_governed_state(b.id)<>'Approved' or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'create') then raise exception 'An authorized current approved batch is required.' using errcode='ICV01';end if;
 -- The reservation was verified before delivery. Only a terminal receipt for
 -- precisely that operation can settle after its source approval goes stale.
 reserved_receipt=invoice_provider_terminal_receipt(b,new.actor_id,new.active_role,tg_table_name,new.id,new.request_id);
 insert into invoice_csv_request_keys(organization_id,legal_entity_id,actor_id,request_id,result_kind,result_id) values(new.organization_id,new.legal_entity_id,new.actor_id,new.request_id,case when tg_table_name='invoice_csv_artifacts' then 'artifact' else 'failure' end,new.id);
 for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,l,new.actor_id,new.active_role);
  if not reserved_receipt and not invoice_source_line_visible(b.organization_id,b.legal_entity_id,l.batch_id,l.item_id,new.actor_id,new.active_role) then raise exception 'Current worker scope is required for every retained line.' using errcode='ICV01';end if;
  perform 1 from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where v.id=l.snapshot_id for share of h,te;
 end loop;
 select * into i from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1;select * into p from invoice_batch_approval_policies where id=i.policy_id;select * into t from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if b.source_type in ('RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT') and i.id is not null then
   for stage in select (s->>'userId')::uuid uid,s->>'role' held_role from jsonb_array_elements(p.definition->'stages') s order by 1,2 loop
     perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,stage.uid,stage.held_role);
   end loop;
   perform u.id from users u join invoice_review_participants(i) participant on participant.account_id=u.id order by u.id for share of u;
   perform e.id from employees e join users u on u.employee_record_id=e.id join invoice_review_participants(i) participant on participant.account_id=u.id order by e.id for share of e;
   if not reserved_receipt and not invoice_review_identities_current(i) then raise exception 'Invoice approval identities changed' using errcode='ICV02';end if;
 end if;
 if i.id is not null then perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,l,i.owner_user_id,i.owner_role);perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,l,i.requester_user_id,i.active_role);end loop;end if;
 if i.id is null or p.id is null or t.id is null or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or (not reserved_receipt and not invoice_batch_approval_pin_current(i)) or i.lineage_hash<>invoice_batch_lineage_hash(b.id) then raise exception 'A current final approval and retained source are required.' using errcode='ICV02';end if;
 if tg_table_name='invoice_csv_failures' then if new.id::text is distinct from ctx->>'failureId' or exists(select 1 from invoice_csv_artifacts a where a.batch_id=b.id) then raise exception 'Only an unaccepted approved operation may record failure.' using errcode='ICV02';end if;return new;end if;
 if new.schema_version is distinct from (case b.source_type when 'TM_SNAPSHOT' then 'workos.invoice-tm-csv/1' when 'MILESTONE_ACCEPTANCE' then 'workos.invoice-milestone-csv/1' when 'RETAINER_PERIOD' then 'workos.invoice-retainer-csv/1' when 'MANAGED_SERVICE_UNIT' then 'workos.invoice-service-unit-csv/1' when 'MANAGED_SERVICE_PERIOD' then 'workos.invoice-service-period-csv/1' when 'FIXED_FEE_INSTALLMENT' then 'workos.invoice-fixed-fee-csv/2' when 'FULL_LINE_REVERSAL' then 'workos.invoice-credit-csv/1' else null end) then raise exception 'Source-specific artifact schema required.' using errcode='ICV02';end if;
 select count(*)::int,coalesce(sum(amount),0) into v_count,v_total from invoice_draft_lines where batch_id=b.id;
 if new.id::text is distinct from ctx->>'artifactId' or i.id is null or p.id is null or t.id is null or new.approval_id<>i.id or new.final_transition_id<>t.id or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or (not reserved_receipt and not invoice_batch_approval_pin_current(i)) or new.lineage_hash<>i.lineage_hash or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.line_count<>v_count or new.total<>v_total or new.currency<>b.currency or new.payload is distinct from invoice_csv_bytes(b) or new.sha256<>encode(digest(new.payload,'sha256'),'hex') then raise exception 'Final approval, source lineage, bytes and control totals must match.' using errcode='ICV02';end if;return new;
end $$;

create or replace function guard_correction_draft() returns trigger language plpgsql as $$
declare ctx jsonb:=nullif(current_setting('workos.invoice_draft_context',true),'')::jsonb;
 orig invoice_draft_batches; b invoice_draft_batches; credit billing_eligibility_events; item approved_unbilled_items;
begin
 select * into strict orig from invoice_draft_batches where id=(ctx->>'originalId')::uuid for update;
 if (orig.organization_id,orig.legal_entity_id) is distinct from (ctx->>'organizationId',ctx->>'legalEntityId')
 or orig.source_type not in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT') or not exists(select 1 from invoice_csv_artifacts where batch_id=orig.id)
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
     select * into strict credit from billing_eligibility_events where id=item.event_id and source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT');
     if not exists(select 1 from invoice_draft_batches where id=b.id and xmin=pg_current_xact_id()::xid)
     or (b.preparer_user_id,b.preparer_role,b.operation_id) is distinct from (new.actor_id,new.active_role,new.operation_id)
     or (item.organization_id,item.legal_entity_id,credit.client_id,credit.contract_id,credit.engagement_id,credit.currency) is distinct from
        (b.organization_id,b.legal_entity_id,b.client_id,b.contract_id,b.engagement_id,b.currency)
     or (new.event_id,new.currency,new.amount,new.billing_evidence) is distinct from (credit.id,credit.currency,credit.amount,credit.billing_evidence)
     or credit.billing_evidence->>'originalBatchId' is distinct from orig.id::text or credit.eligible_on not between b.period_start and b.period_end
     then raise exception 'Whole credit from the inspected export required' using errcode='23514'; end if;
   else
     if coalesce(ctx->>'expectedState','Draft') not in ('Draft','Under Review','Approved')
     or invoice_batch_governed_state(b.id) is distinct from (case when ctx->>'expectedState'='Under Review' then 'Draft' else coalesce(ctx->>'expectedState','Draft') end)
     or (ctx->>'expectedState'='Under Review' and not exists(select from invoice_batch_approval_invalidations v join invoice_batch_approval_instances i on i.id=v.instance_id where i.batch_id=b.id and i.id::text=ctx->>'expectedReviewId' and v.operation_id=new.operation_id and v.actor_id=new.actor_id and v.request_id=new.request_id))
     or exists(select 1 from invoice_csv_artifacts where batch_id=b.id) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'cancel')
     or (select count(*) from invoice_draft_lines where batch_id=b.id)<>new.expected_line_count
     or exists(select 1 from invoice_draft_lines where batch_id=b.id and billing_evidence->>'originalBatchId' is distinct from orig.id::text)
     then raise exception 'Current correction draft required for cancellation' using errcode='IBA01'; end if;
   end if;
 end if;
 return new;
end $$;

create or replace function complete_invoice_csv_commit() returns trigger language plpgsql as $$
declare reserved_receipt boolean; b invoice_draft_batches;i invoice_batch_approval_instances;v_action text;v_expected jsonb;begin
 select * into b from invoice_draft_batches where id=new.batch_id;
 reserved_receipt=invoice_provider_terminal_receipt(b,new.actor_id,new.active_role,tg_table_name,new.id,new.request_id);
 if b.id is null or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'create') or (not reserved_receipt and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not invoice_source_line_visible(b.organization_id,b.legal_entity_id,l.batch_id,l.item_id,new.actor_id,new.active_role))) then raise exception 'Current scoped export authority must persist through commit.' using errcode='ICV03';end if;
 if tg_table_name='invoice_csv_artifacts' then
  select * into i from invoice_batch_approval_instances where id=new.approval_id;
  if invoice_batch_governed_state(b.id)<>'Exported' or i.id is null or (not invoice_batch_approval_pin_current(i) and not reserved_receipt) or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.payload is distinct from invoice_csv_bytes(b) or new.sha256<>encode(digest(new.payload,'sha256'),'hex') or new.line_count<>(select count(*) from invoice_draft_lines where batch_id=b.id) or new.total<>(select sum(amount) from invoice_draft_lines where batch_id=b.id) or exists(select 1 from invoice_draft_cancellations where batch_id=b.id) then raise exception 'Artifact, source, occupancy and control totals must commit together.' using errcode='ICV03';end if;
  v_action='Accept CSV';v_expected=jsonb_build_object('batchId',b.id,'artifactId',new.id,'sha256',new.sha256);
 else
  select * into i from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1;
  if invoice_batch_governed_state(b.id)<>'Approved' or i.id is null or (not invoice_batch_approval_pin_current(i) and not reserved_receipt) or i.lineage_hash<>invoice_batch_lineage_hash(b.id) or exists(select 1 from invoice_csv_artifacts where batch_id=b.id) then raise exception 'Failed generation requires a current approved batch and cannot finalize it.' using errcode='ICV03';end if;
  v_action='Record CSV Failure';v_expected=jsonb_build_object('batchId',b.id,'failureId',new.id,'code',new.code);
 end if;
 if not exists(select 1 from audit_logs a where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice CSV' and a.action=v_action and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=v_expected) then raise exception 'Artifact operation and redacted audit must commit together.' using errcode='ICV03';end if;return null;
end $$;

create or replace function guard_invoice_provider_reservation() returns trigger language plpgsql as $$
declare b invoice_draft_batches; review invoice_batch_approval_instances; n integer; amount numeric;
begin
  select * into strict b from invoice_draft_batches where id=new.batch_id for update;
  perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role);
  if not invoice_provider_actor_valid(b,new.actor_id,new.active_role) then
    raise exception 'Scoped provider delivery authority required.' using errcode='ICV01';
  end if;
  select * into review from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1;
  select count(*),sum(l.amount) into n,amount from invoice_draft_lines l where l.batch_id=b.id;
  if invoice_batch_governed_state(b.id)<>'Approved' or review.id is distinct from new.approval_id
     or not invoice_provider_approval_current(b,review)
     or new.final_transition_id is distinct from (select id from invoice_batch_approval_transitions
         where instance_id=review.id order by sequence desc limit 1)
     or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.lineage_hash<>review.lineage_hash
     or (new.organization_id,new.legal_entity_id)<>(b.organization_id,b.legal_entity_id)
     or new.payload is distinct from invoice_csv_bytes(b) or new.line_count<>n
     or new.currency<>b.currency or new.total is distinct from amount then
    raise exception 'Provider export requires the current approved payload.' using errcode='ICV02';
  end if;
  return new;
end $$;

create or replace function guard_retainer_credit_batch_review() returns trigger language plpgsql as $$
declare i invoice_batch_approval_instances;
begin
 if tg_table_name='invoice_batch_approval_instances' then i=new;
 elsif tg_table_name='invoice_batch_approval_transitions' then select * into strict i from invoice_batch_approval_instances where id=new.instance_id;
 else select * into strict i from invoice_batch_approval_instances where id=new.approval_id; end if;
 if not is_retainer_credit_batch(i.batch_id) then return new; end if;
 if tg_table_name='invoice_csv_artifacts' then
   if invoice_provider_terminal_receipt((select b from invoice_draft_batches b where b.id=i.batch_id),new.actor_id,new.active_role,tg_table_name,new.id,new.request_id) then return new; end if;
 end if;
 perform lock_retainer_credit_reviewers(i);
 if exists(select from invoice_draft_lines l where l.batch_id=i.batch_id
    and invoice_reversal_participants_valid(l.billing_evidence->>'originalSourceType',i) is not true) or (tg_table_name<>'invoice_batch_approval_instances' and not invoice_review_identities_current(i)) then
   raise exception 'Current independent credit approval for the original source required' using errcode='IBA02';
 end if;
 return new;
end $$;

-- Once the provider receipt has been retained, confirmation uses the same
-- historical source scope. The resolver still needs separate confirmation authority.
alter function invoice_source_historical_visible(text,text,invoice_draft_lines,uuid,text) rename to before_receipt_invoice_historical_visible;
create function invoice_source_historical_visible(org text,legal text,line invoice_draft_lines,who uuid,held_role text)
returns boolean language sql stable as $$
 select case when exists(select from invoice_provider_attempts p join invoice_csv_artifacts a on a.id=p.artifact_id
   where p.result='accepted' and a.batch_id=line.batch_id and a.organization_id=org and a.legal_entity_id=legal)
 then exists(select from invoice_draft_batches b where b.id=line.batch_id and (b.organization_id,b.legal_entity_id)=(org,legal)
   and invoice_reserved_batch_visible(b,who,held_role))
 else before_receipt_invoice_historical_visible(org,legal,line,who,held_role) end
$$;

alter function correction_original_scope_current(invoice_draft_batches,uuid,text) rename to before_receipt_correction_original_scope;
create function correction_original_scope_current(b invoice_draft_batches,who uuid,held_role text)
returns boolean language sql stable as $$
 select case when b.source_type='FULL_LINE_REVERSAL' and exists(select from invoice_provider_attempts p
   join invoice_csv_artifacts a on a.id=p.artifact_id where p.result='accepted' and a.batch_id=b.id)
 then invoice_reserved_batch_visible(b,who,held_role) else before_receipt_correction_original_scope(b,who,held_role) end
$$;
