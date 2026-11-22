create function service_unit_invoice_csv_bytes(b invoice_draft_batches) returns bytea language sql stable as $$
 select convert_to('schema_version,batch_id,line_id,line_sequence,item_id,item_version,event_id,source_type,evidence_id,billing_evidence_b64,client_id_b64,contract_id_b64,engagement_id_b64,eligible_date,currency,amount,period_start,period_end,period_basis,event_version'||E'\r\n'||coalesce(string_agg(concat_ws(',', 'workos.invoice-service-unit-csv/1',b.id::text,l.id::text,l.sequence::text,l.item_id::text,l.item_version::text,l.event_id::text,l.source_type,l.billing_evidence->>'evidenceId',invoice_csv_base64(l.billing_evidence::text),invoice_csv_base64(b.client_id),invoice_csv_base64(b.contract_id),invoice_csv_base64(b.engagement_id),ev.eligible_on::text,l.currency,trim_scale(l.amount)::text,b.period_start::text,b.period_end::text,b.period_basis,ev.version)||E'\r\n','' order by l.sequence),''),'UTF8')
 from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id and ev.organization_id=l.organization_id and ev.legal_entity_id=l.legal_entity_id where l.batch_id=b.id and l.source_type='MANAGED_SERVICE_UNIT' and ev.source_type=l.source_type
$$;

alter table invoice_csv_artifacts drop constraint invoice_csv_schema_total_check;
alter table invoice_csv_artifacts add constraint invoice_csv_schema_total_check check(
 (schema_version in ('workos.invoice-tm-csv/1','workos.invoice-milestone-csv/1','workos.invoice-retainer-csv/1','workos.invoice-service-unit-csv/1') and total>0) or
 (schema_version='workos.invoice-credit-csv/1' and total<0));

create or replace function invoice_csv_bytes(b invoice_draft_batches) returns bytea language sql stable as $$
 select case b.source_type when 'TM_SNAPSHOT' then tm_original_invoice_csv_bytes(b)
 when 'MILESTONE_ACCEPTANCE' then milestone_invoice_csv_bytes(b)
 when 'MANAGED_SERVICE_UNIT' then service_unit_invoice_csv_bytes(b)
 when 'RETAINER_PERIOD' then retainer_invoice_csv_bytes(b)
 when 'FULL_LINE_REVERSAL' then correction_invoice_csv_bytes(b) else null end
$$;
create or replace function guard_invoice_csv_append() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;i invoice_batch_approval_instances;p invoice_batch_approval_policies;t invoice_batch_approval_transitions;l invoice_draft_lines;stage record;v_count int;v_total numeric;begin
 begin ctx=nullif(current_setting('workos.invoice_csv_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id for update;perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if b.id is null or ctx is null or new.batch_id::text is distinct from ctx->>'batchId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or b.organization_id<>new.organization_id or b.legal_entity_id<>new.legal_entity_id or invoice_batch_governed_state(b.id)<>'Approved' or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'create') then raise exception 'An authorized current approved batch is required.' using errcode='ICV01';end if;
 insert into invoice_csv_request_keys(organization_id,legal_entity_id,actor_id,request_id,result_kind,result_id) values(new.organization_id,new.legal_entity_id,new.actor_id,new.request_id,case when tg_table_name='invoice_csv_artifacts' then 'artifact' else 'failure' end,new.id);
 for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,l,new.actor_id,new.active_role);
  if not invoice_source_line_visible(b.organization_id,b.legal_entity_id,l.batch_id,l.item_id,new.actor_id,new.active_role) then raise exception 'Current worker scope is required for every retained line.' using errcode='ICV01';end if;
  perform 1 from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where v.id=l.snapshot_id for share of h,te;
 end loop;
 select * into i from invoice_batch_approval_instances where batch_id=b.id order by sequence desc limit 1;select * into p from invoice_batch_approval_policies where id=i.policy_id;select * into t from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if b.source_type in ('RETAINER_PERIOD','MANAGED_SERVICE_UNIT') and i.id is not null then
   for stage in select (s->>'userId')::uuid uid,s->>'role' held_role from jsonb_array_elements(p.definition->'stages') s order by 1,2 loop
     perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,stage.uid,stage.held_role);
   end loop;
   perform u.id from users u join invoice_review_participants(i) participant on participant.account_id=u.id order by u.id for share of u;
   perform e.id from employees e join users u on u.employee_record_id=e.id join invoice_review_participants(i) participant on participant.account_id=u.id order by e.id for share of e;
   if not invoice_review_identities_current(i) then raise exception 'Invoice approval identities changed' using errcode='ICV02';end if;
 end if;
 if i.id is not null then perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,l,i.owner_user_id,i.owner_role);perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,l,i.requester_user_id,i.active_role);end loop;end if;
 if i.id is null or p.id is null or t.id is null or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or not invoice_batch_approval_pin_current(i) or i.lineage_hash<>invoice_batch_lineage_hash(b.id) then raise exception 'A current final approval and retained source are required.' using errcode='ICV02';end if;
 if tg_table_name='invoice_csv_failures' then if new.id::text is distinct from ctx->>'failureId' or exists(select 1 from invoice_csv_artifacts a where a.batch_id=b.id) then raise exception 'Only an unaccepted approved operation may record failure.' using errcode='ICV02';end if;return new;end if;
 if new.schema_version is distinct from (case b.source_type when 'TM_SNAPSHOT' then 'workos.invoice-tm-csv/1' when 'MILESTONE_ACCEPTANCE' then 'workos.invoice-milestone-csv/1' when 'RETAINER_PERIOD' then 'workos.invoice-retainer-csv/1' when 'MANAGED_SERVICE_UNIT' then 'workos.invoice-service-unit-csv/1' when 'FULL_LINE_REVERSAL' then 'workos.invoice-credit-csv/1' else null end) then raise exception 'Source-specific artifact schema required.' using errcode='ICV02';end if;
 select count(*)::int,coalesce(sum(amount),0) into v_count,v_total from invoice_draft_lines where batch_id=b.id;
 if new.id::text is distinct from ctx->>'artifactId' or i.id is null or p.id is null or t.id is null or new.approval_id<>i.id or new.final_transition_id<>t.id or t.decision<>'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or not invoice_batch_approval_pin_current(i) or new.lineage_hash<>i.lineage_hash or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.line_count<>v_count or new.total<>v_total or new.currency<>b.currency or new.payload is distinct from invoice_csv_bytes(b) or new.sha256<>encode(digest(new.payload,'sha256'),'hex') then raise exception 'Final approval, source lineage, bytes and control totals must match.' using errcode='ICV02';end if;return new;
end $$;

create function check_service_unit_notice_policy_scope() returns trigger language plpgsql as $$
begin
 if exists(select from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.model='managed_service')
 and (not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_units.issue')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.finance_owner_id,new.finance_owner_role,'commercial.service_units.issue'))
 then raise exception 'Scoped service_unit notification configuration required' using errcode='INC01';end if;
 return null;
end $$;
create constraint trigger service_unit_notice_policy_scope after insert on invoice_export_notice_policies
 deferrable initially deferred for each row execute function check_service_unit_notice_policy_scope();

alter table invoice_batch_confirmations drop constraint invoice_confirmation_signed_total;
alter table invoice_batch_confirmations add constraint invoice_confirmation_signed_total check (
  (source_type='FULL_LINE_REVERSAL' and total<0) or
  (source_type in ('TM_SNAPSHOT','MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT') and total>0)
);

alter function invoice_source_historical_visible(text,text,invoice_draft_lines,uuid,text)
rename to before_service_unit_invoice_source_historical_visible;
create function invoice_source_historical_visible(org text,legal text,line invoice_draft_lines,who uuid,held_role text)
returns boolean language sql stable as $$
 select case when line.source_type='MANAGED_SERVICE_UNIT' then
   invoice_source_line_visible(org,legal,line.batch_id,line.item_id,who,held_role)
 else before_service_unit_invoice_source_historical_visible(org,legal,line,who,held_role) end
$$;

create or replace function guard_invoice_batch_confirmation() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;a invoice_csv_artifacts;l invoice_draft_lines;begin
 begin ctx=nullif(current_setting('workos.invoice_confirmation_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id for update;select * into a from invoice_csv_artifacts where id=new.artifact_id for share;perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if ctx is null or b.id is null or a.id is null or new.id::text is distinct from ctx->>'confirmationId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or b.organization_id<>new.organization_id or b.legal_entity_id<>new.legal_entity_id or a.batch_id<>b.id or invoice_batch_governed_state(b.id)<>'Exported' or new.artifact_version<>a.version or new.artifact_sha256<>a.sha256 or new.artifact_sha256<>encode(digest(a.payload,'sha256'),'hex') or new.currency<>a.currency or new.total<>a.total or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'view') or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.invoice_batch.confirm') then raise exception 'Exact exported artifact, scoped actor and confirmation authority are required.' using errcode='IBC01';end if;
 if new.source_type is distinct from b.source_type or a.schema_version is distinct from (case b.source_type when 'TM_SNAPSHOT' then 'workos.invoice-tm-csv/1' when 'MILESTONE_ACCEPTANCE' then 'workos.invoice-milestone-csv/1' when 'RETAINER_PERIOD' then 'workos.invoice-retainer-csv/1' when 'MANAGED_SERVICE_UNIT' then 'workos.invoice-service-unit-csv/1' when 'FULL_LINE_REVERSAL' then 'workos.invoice-credit-csv/1' else null end) then raise exception 'Retained artifact source and batch type must match.' using errcode='IBC01';end if;
 new.confirmed_at=clock_timestamp();for l in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,l,new.actor_id,new.active_role);if not invoice_source_historical_visible(b.organization_id,b.legal_entity_id,l,new.actor_id,new.active_role) then raise exception 'Current worker scope is required for every retained line.' using errcode='IBC01';end if;end loop;return new;
end $$;

create or replace function complete_invoice_batch_confirmation() returns trigger language plpgsql as $$
declare b invoice_draft_batches;a invoice_csv_artifacts;begin
 select * into b from invoice_draft_batches where id=new.batch_id;select * into a from invoice_csv_artifacts where id=new.artifact_id;
 if b.id is null or a.id is null or invoice_batch_governed_state(b.id)<>'Billed/Confirmed' or a.batch_id<>b.id or new.artifact_version<>a.version or new.artifact_sha256<>a.sha256 or new.artifact_sha256<>encode(digest(a.payload,'sha256'),'hex') or new.currency<>a.currency or new.total<>a.total or exists(select 1 from invoice_draft_cancellations where batch_id=b.id) or exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not exists(select 1 from invoice_draft_occupancies o where o.batch_id=b.id and o.line_id=l.id and o.item_id=l.item_id and o.item_version=l.item_version)) or not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'view') or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.invoice_batch.confirm') or exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not invoice_source_historical_visible(b.organization_id,b.legal_entity_id,l,new.actor_id,new.active_role)) then raise exception 'Confirmation, immutable artifact, occupancy and current scope must commit together.' using errcode='IBC02';end if;
 if new.source_type is distinct from b.source_type or a.schema_version is distinct from (case b.source_type when 'TM_SNAPSHOT' then 'workos.invoice-tm-csv/1' when 'MILESTONE_ACCEPTANCE' then 'workos.invoice-milestone-csv/1' when 'RETAINER_PERIOD' then 'workos.invoice-retainer-csv/1' when 'MANAGED_SERVICE_UNIT' then 'workos.invoice-service-unit-csv/1' when 'FULL_LINE_REVERSAL' then 'workos.invoice-credit-csv/1' else null end) then raise exception 'Retained artifact source and batch type must persist.' using errcode='IBC02';end if;
 if not exists(select 1 from audit_logs x where x.organization_id=b.organization_id and x.legal_entity_id=b.legal_entity_id and x.user_id=new.actor_id::text and x.active_role=new.active_role and x.module='Invoice Billing Confirmation' and x.action='Record Manual Attestation' and x.entity_id=new.id::text and x.operation_id=new.operation_id and x.new_value=jsonb_build_object('confirmationId',new.id,'batchId',b.id,'artifactId',a.id,'sha256',a.sha256)) then raise exception 'Confirmation and sanitized audit must commit together.' using errcode='IBC02';end if;
 if not exists(select 1 from invoice_export_notice_events x where x.confirmation_id=new.id and x.batch_id=b.id and x.operation_id=new.operation_id and x.event_key='invoice_batch.exported_or_billed_confirmed') and not exists(select 1 from invoice_export_notice_producer_failures x where x.confirmation_id=new.id and x.batch_id=b.id and x.operation_id=new.operation_id) then raise exception 'Confirmation requires the canonical event or visible recovery evidence.' using errcode='IBC02';end if;return null;
end $$;
