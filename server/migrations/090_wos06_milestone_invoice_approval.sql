-- Local development sentinel: connected approval/export acceptance is incomplete.
do $$begin raise exception 'Milestone invoice approval is incomplete';end$$;

-- Keep the historic T&M implementations intact and dispatch by retained batch source.
create function tm_original_invoice_batch_lineage_hash(batch uuid) returns text language sql stable as $$
 select encode(digest(coalesce(jsonb_agg(jsonb_build_object('sequence',l.sequence,'lineId',l.id,'itemId',l.item_id,'itemVersion',l.item_version,'eventId',l.event_id,'snapshotId',l.snapshot_id,'currency',l.currency,'amount',trim_scale(l.amount)::text,'evidence',l.billing_evidence) order by l.sequence),'[]'::jsonb)::text,'sha256'),'hex') from invoice_draft_lines l where l.batch_id=batch
$$;

create function tm_original_invoice_batch_source_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select invoice_draft_owner_current(b) and not exists(select 1 from invoice_draft_cancellations x where x.batch_id=b.id)
 and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id)
 and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id and o.item_id=l.item_id and o.item_version=l.item_version
 where l.batch_id=b.id and (o.line_id is null or not tm_billing_source_valid(b.organization_id,b.legal_entity_id,b.engagement_id,l.snapshot_id)))
$$;

create function tm_original_invoice_batch_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select exists(select 1 from invoice_draft_batches b where b.id=i.batch_id and b.organization_id=i.organization_id and b.legal_entity_id=i.legal_entity_id
 and b.owner_user_id=i.owner_user_id and b.owner_role=i.owner_role and b.preparer_user_id=i.preparer_user_id and b.preparer_role=i.preparer_role and b.currency=i.currency
 and invoice_batch_source_current(b)
 and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter')
 and i.line_count=(select count(*) from invoice_draft_lines l where l.batch_id=b.id)
 and i.total=(select sum(l.amount) from invoice_draft_lines l where l.batch_id=b.id) and i.lineage_hash=invoice_batch_lineage_hash(b.id)
 and not exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and (not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,i.requester_user_id,i.active_role) or not tm_billing_worker_visible(i.organization_id,i.legal_entity_id,l.snapshot_id,i.owner_user_id,i.owner_role))))
$$;

create or replace function invoice_batch_lineage_hash(batch uuid) returns text language sql stable as $$
 select case b.source_type when 'TM_SNAPSHOT' then tm_original_invoice_batch_lineage_hash(batch) when 'MILESTONE_ACCEPTANCE' then milestone_invoice_lineage_hash(batch) else null end from invoice_draft_batches b where b.id=batch
$$;
create or replace function invoice_batch_source_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select case b.source_type when 'TM_SNAPSHOT' then tm_original_invoice_batch_source_current(b) when 'MILESTONE_ACCEPTANCE' then milestone_invoice_batch_source_current(b,b.preparer_user_id,b.preparer_role) else false end
$$;
create or replace function invoice_batch_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select coalesce((select case b.source_type when 'TM_SNAPSHOT' then tm_original_invoice_batch_approval_pin_current(i) when 'MILESTONE_ACCEPTANCE' then milestone_invoice_approval_pin_current(i) else false end from invoice_draft_batches b where b.id=i.batch_id),false)
$$;
create function invoice_source_line_visible(org text,legal text,batch uuid,item uuid,who uuid,held_role text) returns boolean language sql stable as $$
 select coalesce((select case l.source_type when 'TM_SNAPSHOT' then tm_billing_worker_visible(org,legal,l.snapshot_id,who,held_role) when 'MILESTONE_ACCEPTANCE' then milestone_invoice_item_current(b,l.item_id,who,held_role) else false end from invoice_draft_lines l join invoice_draft_batches b on b.id=l.batch_id where l.batch_id=batch and l.item_id=item and b.organization_id=org and b.legal_entity_id=legal),false)
$$;
create function invoice_lock_source_witness(org text,legal text,line invoice_draft_lines,who uuid,held_role text) returns void language plpgsql as $$
begin
 if line.source_type='TM_SNAPSHOT' then perform lock_tm_billing_worker_witness(org,legal,line.snapshot_id,who,held_role);
 elsif line.source_type='MILESTONE_ACCEPTANCE' then
  perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||org||':'||legal,0));perform lock_commercial_candidate_identity(org,legal,who,held_role);
  perform 1 from approved_unbilled_items item join billing_eligibility_events ev on ev.id=item.event_id join milestone_billing_instances i on i.id=ev.milestone_instance_id join commercial_milestones m on m.id=i.milestone_id join commercial_engagements e on e.id=i.engagement_id where item.id=line.item_id and item.organization_id=org and item.legal_entity_id=legal for share of item,ev,i,m,e;
 else raise exception 'Unsupported retained invoice source.' using errcode='IBA02';end if;
end $$;
create or replace function guard_invoice_batch_policy() returns trigger language plpgsql as $$
declare ctx jsonb;prior invoice_batch_approval_policies;e commercial_engagements;stage jsonb;uid uuid;held_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 perform pg_advisory_xact_lock(hashtext('invoice-approval-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
 if ctx is null or e.id is null or e.origin<>'manual' or e.model not in('time_and_materials','milestone') or not e.billable or e.client_id is null or e.contract_id is null or new.id::text is distinct from ctx->>'policyId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or new.definition->>'engagementId' is distinct from new.engagement_id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date then raise exception 'Explicit current scoped invoice policy authority is required.' using errcode='IBA01';end if;
 if e.model='milestone' and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'viewer') then raise exception 'Milestone visibility is required.' using errcode='IBA01';end if;
 select * into prior from invoice_batch_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or(prior.id is not null and new.effective_from<prior.effective_from) then raise exception 'The current policy version changed.' using errcode='IBA02';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v order by v->>'userId',v->>'role' loop
  uid=(stage->>'userId')::uuid;held_role=stage->>'role';perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,uid,held_role);
  if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,uid,held_role,'decider') then raise exception 'Every named stage requires current held scope and authority.' using errcode='IBA01';end if;
  if e.model='milestone' and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,uid,held_role,'viewer') then raise exception 'Named milestone reviewer access is required.' using errcode='IBA01';end if;
 end loop;return new;
end $$;

create or replace function complete_invoice_batch_policy() returns trigger language plpgsql as $$
declare stage jsonb;begin
 if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Batch Approval' and a.action='Configure Policy' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('policyId',new.id,'engagementId',new.engagement_id)) then raise exception 'Policy authority and redacted audit must commit together.' using errcode='IBA03';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v loop if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,(stage->>'userId')::uuid,stage->>'role','decider') or (exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.model='milestone') and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,(stage->>'userId')::uuid,stage->>'role','viewer')) then raise exception 'Every named stage must retain authority through commit.' using errcode='IBA03';end if;end loop;
 if exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.model='milestone') and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'viewer') then raise exception 'Milestone authority must persist through commit.' using errcode='IBA03';end if;return null;
end $$;

create or replace function record_invoice_draft_owner_loss() returns trigger language plpgsql as $$
declare changed_user uuid;changed_role text;begin
 if tg_table_name in('users','user_roles','user_organization_scopes','user_permission_grants') then
  if tg_table_name='users' then if tg_op='DELETE' then changed_user=old.id;else changed_user=new.id;end if;
  else if tg_op='DELETE' then changed_user=old.user_id;elsif tg_op='UPDATE' and old.user_id is distinct from new.user_id then changed_user=null;else changed_user=new.user_id;end if;end if;
 elsif tg_table_name='role_permissions' then if tg_op='DELETE' then changed_role=old.role_name;elsif tg_op='UPDATE' and old.role_name is distinct from new.role_name then changed_role=null;else changed_role=new.role_name;end if;
 elsif tg_table_name='roles' then changed_role=old.name;end if;
 insert into invoice_draft_owner_losses(batch_id,cause)
 select b.id,tg_table_name from invoice_draft_batches b where(changed_user is null or b.owner_user_id=changed_user) and(changed_role is null or b.owner_role=changed_role) and not exists(select 1 from invoice_draft_cancellations z where z.batch_id=b.id)
 and(not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own') or (b.source_type='TM_SNAPSHOT' and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,b.owner_user_id,b.owner_role))) or (b.source_type='MILESTONE_ACCEPTANCE' and not milestone_billing_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'viewer'))) on conflict(batch_id)do nothing;
 return null;
end $$;

create or replace function guard_invoice_batch_review_instance() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;p invoice_batch_approval_policies;last_sequence int;line invoice_draft_lines;first_stage jsonb;approver uuid;approver_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id for update;
 select * into p from invoice_batch_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=b.engagement_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by effective_from desc,sequence desc limit 1;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role);
 if b.id is null or p.id is null or ctx is null or new.id::text is distinct from ctx->>'instanceId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.requester_user_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.batch_id::text is distinct from ctx->>'batchId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.policy_id<>p.id or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.requester_user_id,new.active_role,'submitter') or invoice_batch_governed_state(b.id)<>'Draft' then raise exception 'Current scoped Draft, policy and requester are required.' using errcode='IBA01';end if;
 select coalesce(max(sequence),0) into last_sequence from invoice_batch_approval_instances where batch_id=b.id;
 if new.sequence<>last_sequence+1 or new.owner_user_id<>b.owner_user_id or new.owner_role<>b.owner_role or new.preparer_user_id<>b.preparer_user_id or new.preparer_role<>b.preparer_role or new.currency<>b.currency then raise exception 'Batch version and retained relationships must match.' using errcode='IBA02';end if;
 first_stage=p.definition->'stages'->0;approver=(first_stage->>'userId')::uuid;approver_role=first_stage->>'role';
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,b.owner_user_id,b.owner_role);perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,b.preparer_user_id,b.preparer_role);perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,approver,approver_role);
 if exists(select 1 from jsonb_array_elements(p.definition->'stages') st where st->>'userId'=new.requester_user_id::text) or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,approver,approver_role,'decider') or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,b.preparer_user_id,b.preparer_role,'view') then raise exception 'Required current stage and preparer relationships are unavailable.' using errcode='IBA01';end if;
 for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform 1 from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where v.id=line.snapshot_id for share of h,te;
  perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,line,new.requester_user_id,new.active_role);perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,line,b.owner_user_id,b.owner_role);perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,line,b.preparer_user_id,b.preparer_role);perform invoice_lock_source_witness(b.organization_id,b.legal_entity_id,line,approver,approver_role);
  if not invoice_source_line_visible(b.organization_id,b.legal_entity_id,line.batch_id,line.item_id,new.requester_user_id,new.active_role) or not invoice_source_line_visible(b.organization_id,b.legal_entity_id,line.batch_id,line.item_id,b.preparer_user_id,b.preparer_role) or not invoice_source_line_visible(b.organization_id,b.legal_entity_id,line.batch_id,line.item_id,approver,approver_role) then raise exception 'Required scoped batch relationships are unavailable.' using errcode='IBA01';end if;
 end loop;
 if not invoice_batch_source_current(b) or new.line_count<>(select count(*) from invoice_draft_lines where batch_id=b.id) or new.total<>(select sum(amount) from invoice_draft_lines where batch_id=b.id) or new.lineage_hash<>invoice_batch_lineage_hash(b.id) then raise exception 'Batch sources, occupancy and control totals changed.' using errcode='IBA02';end if;
 return new;
end $$;

create or replace function guard_invoice_batch_review_decision() returns trigger language plpgsql as $$
declare ctx jsonb;i invoice_batch_approval_instances;b invoice_draft_batches;p invoice_batch_approval_policies;line invoice_draft_lines;stage jsonb;next_stage jsonb;n int;recipient uuid;recipient_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into i from invoice_batch_approval_instances where id=new.instance_id;select * into b from invoice_draft_batches where id=i.batch_id for update;select * into p from invoice_batch_approval_policies where id=i.policy_id;
 select count(*)::int into n from invoice_batch_approval_transitions where instance_id=i.id;
 stage=p.definition->'stages'->n;
 perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role);
 perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role);perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,i.preparer_user_id,i.preparer_role);
 if ctx is null or b.id is null or new.id::text is distinct from ctx->>'transitionId' or new.instance_id::text is distinct from ctx->>'instanceId' or i.batch_id::text is distinct from ctx->>'batchId' or i.organization_id is distinct from ctx->>'organizationId' or i.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.sequence<>n+1 or new.stage<>n or stage is null or stage->>'userId' is distinct from new.actor_id::text or stage->>'role' is distinct from new.active_role or new.actor_id=i.requester_user_id or not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'decider') or not invoice_batch_approval_review_current(i) then raise exception 'Current named stage, source and actor are required.' using errcode='IBA02';end if;
 for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
  perform 1 from commercial_tm_valuations v join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where v.id=line.snapshot_id for share of h,te;
  perform invoice_lock_source_witness(i.organization_id,i.legal_entity_id,line,new.actor_id,new.active_role);perform invoice_lock_source_witness(i.organization_id,i.legal_entity_id,line,i.requester_user_id,i.active_role);perform invoice_lock_source_witness(i.organization_id,i.legal_entity_id,line,i.owner_user_id,i.owner_role);perform invoice_lock_source_witness(i.organization_id,i.legal_entity_id,line,i.preparer_user_id,i.preparer_role);
  if not invoice_source_line_visible(i.organization_id,i.legal_entity_id,line.batch_id,line.item_id,new.actor_id,new.active_role) then raise exception 'Current reviewer scope is required for every retained line.' using errcode='IBA01';end if;
 end loop;
 if new.decision='Approved' and n+1<jsonb_array_length(p.definition->'stages') then
  next_stage=p.definition->'stages'->(n+1);recipient=(next_stage->>'userId')::uuid;recipient_role=next_stage->>'role';perform lock_commercial_candidate_identity(i.organization_id,i.legal_entity_id,recipient,recipient_role);
  if recipient=i.requester_user_id or not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,recipient,recipient_role,'decider') then raise exception 'The next named stage must be currently eligible.' using errcode='IBA01';end if;
  for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop perform invoice_lock_source_witness(i.organization_id,i.legal_entity_id,line,recipient,recipient_role);if not invoice_source_line_visible(i.organization_id,i.legal_entity_id,line.batch_id,line.item_id,recipient,recipient_role) then raise exception 'Next-stage scoped access is required for every retained line.' using errcode='IBA01';end if;end loop;
 end if;
 if not invoice_batch_approval_review_current(i) then raise exception 'Review pins or scope changed before decision.' using errcode='IBA02';end if;
 return new;
end $$;

create or replace function invoice_batch_expected_recipients(i invoice_batch_approval_instances,event_key text,stage_no int) returns table(recipient uuid,reason text) language plpgsql stable as $$
declare p invoice_batch_approval_policies;w text;accounts uuid[];begin
 select * into p from invoice_batch_approval_policies where id=i.policy_id;
 if p.id is null or event_key not in('approval.action_required','approval.rejected_or_correction_required','approval.completed') then raise exception 'Canonical notification context unavailable.' using errcode='IBA03';end if;
 if event_key='approval.action_required' then
  if stage_no<0 or stage_no>=jsonb_array_length(p.definition->'stages') then raise exception 'Current stage unavailable.' using errcode='IBA03';end if;
  recipient=(p.definition->'stages'->stage_no->>'userId')::uuid;reason='current_stage_approver';return next;return;
 end if;
 if not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter') then raise exception 'Requester relationship unavailable.' using errcode='IBA03';end if;
 recipient=i.requester_user_id;reason='requester';return next;
 if event_key='approval.rejected_or_correction_required' then
  if not invoice_draft_actor_valid(i.organization_id,i.legal_entity_id,i.owner_user_id,i.owner_role,'own') or not invoice_draft_actor_valid(i.organization_id,i.legal_entity_id,i.preparer_user_id,i.preparer_role,'view') then raise exception 'Batch owner or preparer relationship unavailable.' using errcode='IBA03';end if;
  if exists(select 1 from invoice_draft_lines l where l.batch_id=i.batch_id and (not invoice_source_line_visible(i.organization_id,i.legal_entity_id,l.batch_id,l.item_id,i.owner_user_id,i.owner_role) or not invoice_source_line_visible(i.organization_id,i.legal_entity_id,l.batch_id,l.item_id,i.preparer_user_id,i.preparer_role))) then raise exception 'Batch owner or preparer worker scope changed.' using errcode='IBA03';end if;
  recipient=i.owner_user_id;reason='invoice_batch_owner';return next;recipient=i.preparer_user_id;reason='finance_preparer';return next;
 end if;
 for w in select distinct h.employee_id from invoice_draft_lines l join commercial_tm_valuations v on v.id=l.snapshot_id join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where l.batch_id=i.batch_id order by h.employee_id loop
  select array_agg(u.id order by u.id) into accounts from users u join user_organization_scopes sc on sc.user_id=u.id where u.employee_record_id=w and u.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active;
  if coalesce(cardinality(accounts),0)<>1 then raise exception 'A retained affected worker account is unavailable.' using errcode='IBA03';end if;
  recipient=accounts[1];reason='affected_worker';return next;
 end loop;
end $$;

create or replace function complete_invoice_batch_review() returns trigger language plpgsql as $$
declare i invoice_batch_approval_instances;p invoice_batch_approval_policies;last_decision invoice_batch_approval_transitions;ev invoice_batch_approval_notices;rec invoice_batch_approval_recipients;seq int;stage_no int;v_event_key text;v_status text;op text;actor uuid;held_role text;audit_entity uuid;expected_users uuid[];u uuid;reasons text[];tmpl jsonb;begin
 if tg_table_name='invoice_batch_approval_instances' then i=new;seq=0;stage_no=0;v_event_key='approval.action_required';op=i.operation_id;actor=i.requester_user_id;held_role=i.active_role;audit_entity=i.id;
 else select * into i from invoice_batch_approval_instances where id=new.instance_id;seq=new.sequence;op=new.operation_id;actor=new.actor_id;held_role=new.active_role;audit_entity=new.id;end if;
 select * into p from invoice_batch_approval_policies where id=i.policy_id;select * into last_decision from invoice_batch_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if p.id is null or not invoice_batch_approval_pin_current(i) then raise exception 'Source, occupancy, owner or requester changed before commit.' using errcode='IBA03';end if;
 if tg_table_name='invoice_batch_approval_transitions' and (not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,actor,held_role,'decider') or exists(select 1 from invoice_draft_lines l where l.batch_id=i.batch_id and not invoice_source_line_visible(i.organization_id,i.legal_entity_id,l.batch_id,l.item_id,actor,held_role))) then raise exception 'Decider authority or scope changed before commit.' using errcode='IBA03';end if;
 v_status=case when last_decision.id is null then 'Pending' when last_decision.decision='Rejected' then 'Rejected' when last_decision.sequence=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end;
 if tg_table_name='invoice_batch_approval_transitions' then if new.decision='Rejected' then v_event_key='approval.rejected_or_correction_required';stage_no=new.stage;elsif new.sequence<jsonb_array_length(p.definition->'stages') then v_event_key='approval.action_required';stage_no=new.sequence;else v_event_key='approval.completed';stage_no=new.stage;end if;end if;
 if not exists(select 1 from approval_records a where a.entity_type='InvoiceBatchApproval' and a.entity_id=i.id::text and a.status=v_status and a.comments is null and a.due_at is null) or invoice_batch_governed_state(i.batch_id) is distinct from (case when v_status='Pending' then 'Under Review' when v_status='Rejected' then 'Draft' else 'Approved' end) then raise exception 'Generic approval and batch state must converge.' using errcode='IBA03';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=i.organization_id and a.legal_entity_id=i.legal_entity_id and a.user_id=actor::text and a.active_role=held_role and a.module='Invoice Batch Approval' and a.action=(case when tg_table_name='invoice_batch_approval_instances' then 'Request Review' else 'Decide Review' end) and a.entity_id=audit_entity::text and a.operation_id=op and a.new_value=jsonb_build_object('instanceId',i.id,'batchId',i.batch_id)) then raise exception 'Review and redacted audit must commit together.' using errcode='IBA03';end if;
 select * into ev from invoice_batch_approval_notices where instance_id=i.id and transition_sequence=seq and invoice_batch_approval_notices.event_key=v_event_key;
 if v_event_key='approval.completed' and ev.id is null and exists(select 1 from invoice_batch_approval_notice_failures where instance_id=i.id and transition_sequence=seq) then return null;end if;
 select x into tmpl from jsonb_array_elements(p.definition->'templates') x where x->>'key'=v_event_key;
 if ev.id is null or ev.stage<>stage_no or ev.policy_id<>p.id or ev.operation_id is distinct from op or ev.locale is distinct from p.definition->>'locale' or tmpl is null or ev.title is distinct from replace(replace(tmpl->>'subject','{{sourceRef}}','invoice-batch/'||i.batch_id::text),'{{stageNumber}}',(stage_no+1)::text) or ev.body is distinct from replace(replace(tmpl->>'body','{{sourceRef}}','invoice-batch/'||i.batch_id::text),'{{stageNumber}}',(stage_no+1)::text) or(select count(*) from invoice_batch_approval_notices where instance_id=i.id and transition_sequence=seq)<>1 then raise exception 'One sanitized canonical stage event is required.' using errcode='IBA03';end if;
 if v_event_key='approval.action_required' and (not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,(p.definition->'stages'->stage_no->>'userId')::uuid,p.definition->'stages'->stage_no->>'role','decider') or exists(select 1 from invoice_draft_lines l where l.batch_id=i.batch_id and not invoice_source_line_visible(i.organization_id,i.legal_entity_id,l.batch_id,l.item_id,(p.definition->'stages'->stage_no->>'userId')::uuid,p.definition->'stages'->stage_no->>'role'))) then raise exception 'Current-stage authority and scope must persist through commit.' using errcode='IBA03';end if;
 select array_agg(distinct x.recipient order by x.recipient) into expected_users from invoice_batch_expected_recipients(i,v_event_key,stage_no) x;
 if expected_users is null or(select count(*) from invoice_batch_approval_recipients where event_id=ev.id)<>cardinality(expected_users) then raise exception 'The complete protected recipient set is required.' using errcode='IBA03';end if;
 foreach u in array expected_users loop
  if not exists(select 1 from users usr join user_organization_scopes sc on sc.user_id=usr.id join user_roles ur on ur.user_id=usr.id join roles role on role.id=ur.role_id where usr.id=u and usr.status='Active' and sc.organization_id=i.organization_id and sc.legal_entity_id=i.legal_entity_id and sc.active and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='notifications.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='notifications.view')) and (exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key='employees.view' and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=usr.id and g.permission_key='employees.view'))) then raise exception 'A protected recipient lost current authority.' using errcode='IBA03';end if;
  select array_agg(distinct x.reason order by x.reason) into reasons from invoice_batch_expected_recipients(i,v_event_key,stage_no) x where x.recipient=u;
  select * into rec from invoice_batch_approval_recipients where event_id=ev.id and user_id=u;
  if rec.id is null or(select array_agg(x order by x) from unnest(rec.reasons)x) is distinct from reasons or(v_event_key<>'approval.completed' and(not rec.in_app or rec.channel_decision<>'Required')) or(rec.in_app and not exists(select 1 from invoice_batch_approval_deliveries d where d.recipient_id=rec.id and d.channel='InApp' and d.status='Delivered')) then raise exception 'Every exact recipient and required in-app delivery must commit.' using errcode='IBA03';end if;
 end loop;return null;
end $$;
