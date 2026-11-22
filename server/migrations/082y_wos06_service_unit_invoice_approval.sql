create function service_unit_invoice_lineage_hash(batch uuid) returns text language sql stable as $$
 select case when not exists(select 1 from invoice_draft_lines l where l.batch_id=batch and l.source_type<>'MANAGED_SERVICE_UNIT')
 then encode(digest(coalesce(jsonb_agg(jsonb_build_object('sequence',l.sequence,'lineId',l.id,'itemId',l.item_id,'itemVersion',l.item_version,'eventId',l.event_id,'sourceType',l.source_type,'currency',l.currency,'amount',trim_scale(l.amount)::text,'evidence',l.billing_evidence) order by l.sequence),'[]'::jsonb)::text,'sha256'),'hex') end
 from invoice_draft_lines l where l.batch_id=batch
$$;

create function service_unit_invoice_batch_source_current(b invoice_draft_batches,who uuid,held_role text) returns boolean language sql stable as $$
 select b.id is not null and b.period_basis='ELIGIBLE_DATE'
  and not exists(select 1 from invoice_draft_cancellations c where c.batch_id=b.id)
  and not exists(select 1 from invoice_draft_owner_losses z where z.batch_id=b.id)
  and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own')
  and exists(select 1 from invoice_draft_lines l where l.batch_id=b.id)
  and not exists(select 1 from invoice_draft_lines l left join invoice_draft_occupancies o on o.line_id=l.id and o.batch_id=l.batch_id and o.item_id=l.item_id and o.item_version=l.item_version
   where l.batch_id=b.id and (l.source_type<>'MANAGED_SERVICE_UNIT' or o.line_id is null
    or not service_unit_invoice_item_current(b,l.item_id,who,held_role)
    or l.event_id<>(select event_id from approved_unbilled_items where id=l.item_id)
    or l.billing_evidence is distinct from (select billing_evidence from billing_eligibility_events where id=l.event_id)
    or l.currency is distinct from (select currency from billing_eligibility_events where id=l.event_id)
    or l.amount is distinct from (select amount from billing_eligibility_events where id=l.event_id)))
$$;

create function service_unit_review_participants_valid(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 with reviewers as (
   select (stage->>'userId')::uuid uid,stage->>'role' held_role
   from invoice_batch_approval_policies p cross join lateral jsonb_array_elements(p.definition->'stages') stage where p.id=i.policy_id
 ), participants as (
   select uid,held_role,true reviewer from reviewers union all
   select i.requester_user_id,i.active_role,false union all select i.preparer_user_id,i.preparer_role,false union all select i.owner_user_id,i.owner_role,false
 ), workers as (
   select p.*,e.id worker from participants p left join users u on u.id=p.uid and u.status='Active'
   left join employees e on e.id=u.employee_record_id and e.organization_id=i.organization_id and e.legal_entity_id=i.legal_entity_id and e.status='Active'
 )
 select exists(select from reviewers) and not exists(select from workers where worker is null
   or not invoice_notice_actor_has(i.organization_id,i.legal_entity_id,uid,held_role,'commercial.service_units.issue')
   or (reviewer and not invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,uid,held_role,'decider')))
   and not exists(select from workers group by worker having bool_or(reviewer) and count(*)>1)
$$;

alter function invoice_batch_lineage_hash(uuid) rename to before_service_unit_invoice_batch_lineage_hash;
create function invoice_batch_lineage_hash(batch uuid) returns text language sql stable as $$
 select case when b.source_type='MANAGED_SERVICE_UNIT' then service_unit_invoice_lineage_hash(batch)
 else before_service_unit_invoice_batch_lineage_hash(batch) end from invoice_draft_batches b where b.id=batch
$$;
alter function invoice_batch_source_current(invoice_draft_batches) rename to before_service_unit_invoice_batch_source_current;
create function invoice_batch_source_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select case when b.source_type='MANAGED_SERVICE_UNIT' then service_unit_invoice_batch_source_current(b,b.owner_user_id,b.owner_role) else before_service_unit_invoice_batch_source_current(b) end
$$;
alter function invoice_batch_approval_pin_current(invoice_batch_approval_instances) rename to before_service_unit_invoice_batch_approval_pin_current;
create function invoice_batch_approval_pin_current(i invoice_batch_approval_instances) returns boolean language sql stable as $$
 select case when b.source_type='MANAGED_SERVICE_UNIT' then invoice_batch_source_current(b)
 and i.organization_id=b.organization_id and i.legal_entity_id=b.legal_entity_id
 and (i.owner_user_id,i.owner_role,i.preparer_user_id,i.preparer_role,i.currency)=(b.owner_user_id,b.owner_role,b.preparer_user_id,b.preparer_role,b.currency)
 and i.total=(select sum(amount) from invoice_draft_lines where batch_id=b.id)
 and i.line_count=(select count(*) from invoice_draft_lines where batch_id=b.id)
 and i.lineage_hash=service_unit_invoice_lineage_hash(b.id)
 and invoice_batch_approval_actor_valid(i.organization_id,i.legal_entity_id,i.requester_user_id,i.active_role,'submitter')
 and service_unit_review_participants_valid(i) and service_unit_invoice_batch_source_current(b,i.requester_user_id,i.active_role) and invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,i.preparer_user_id,i.preparer_role,'prepare')
 else before_service_unit_invoice_batch_approval_pin_current(i) end from invoice_draft_batches b where b.id=i.batch_id
$$;

alter function invoice_source_line_visible(text,text,uuid,uuid,uuid,text) rename to before_service_unit_invoice_source_line_visible;
create function invoice_source_line_visible(org text,legal text,batch uuid,item uuid,who uuid,held_role text) returns boolean language sql stable as $$
 select coalesce((select case when b.source_type='MANAGED_SERVICE_UNIT' then service_unit_invoice_item_current(b,item,who,held_role)
 else before_service_unit_invoice_source_line_visible(org,legal,batch,item,who,held_role) end
 from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id where b.id=batch and l.item_id=item
 and b.organization_id=org and b.legal_entity_id=legal),false)
$$;
alter function invoice_lock_source_witness(text,text,invoice_draft_lines,uuid,text) rename to before_service_unit_invoice_lock_source_witness;
create function invoice_lock_source_witness(org text,legal text,line invoice_draft_lines,who uuid,held_role text) returns void language plpgsql as $$

begin
 if line.source_type='MANAGED_SERVICE_UNIT' then
   perform lock_commercial_candidate_identity(org,legal,who,held_role);
   perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||org||':'||legal,0));
   perform u.id from users u where u.id in (select account from billing_eligibility_events ev
     join commercial_service_unit_reviews r on r.id=ev.service_review_id join commercial_service_unit_evidence e on e.id=r.evidence_id
     cross join lateral (values(r.actor_id),(e.actor_id)) p(account) where ev.id=line.event_id) order by u.id for share;
   perform w.id from employees w where w.id in (select worker from billing_eligibility_events ev
     join commercial_service_unit_reviews r on r.id=ev.service_review_id join commercial_service_unit_evidence e on e.id=r.evidence_id
     cross join lateral (values(r.worker_id),(e.recorder_worker_id)) p(worker) where ev.id=line.event_id) order by w.id for share;
 else perform before_service_unit_invoice_lock_source_witness(org,legal,line,who,held_role); end if;
end $$;

create or replace function guard_invoice_batch_policy() returns trigger language plpgsql as $$
declare ctx jsonb;prior invoice_batch_approval_policies;e commercial_engagements;stage jsonb;uid uuid;held_role text;begin
 begin ctx=nullif(current_setting('workos.invoice_batch_approval_context',true),'')::jsonb;exception when others then ctx=null;end;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 perform pg_advisory_xact_lock(hashtext('invoice-approval-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
 if ctx is null or e.id is null or e.origin<>'manual' or e.model not in('time_and_materials','milestone','retainer','managed_service') or not e.billable or e.client_id is null or e.contract_id is null or new.id::text is distinct from ctx->>'policyId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or new.definition->>'engagementId' is distinct from new.engagement_id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date then raise exception 'Explicit current scoped invoice policy authority is required.' using errcode='IBA01';end if;
 if e.model='retainer' and not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.retainer_eligibility.issue') then raise exception 'Retainer access required' using errcode='IBA01';end if;
 if e.model='managed_service' and not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_units.issue') then raise exception 'Service unit access required' using errcode='IBA01';end if;
 if e.model='milestone' and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'viewer') then raise exception 'Milestone visibility is required.' using errcode='IBA01';end if;
 select * into prior from invoice_batch_approval_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or(prior.id is not null and new.effective_from<prior.effective_from) then raise exception 'The current policy version changed.' using errcode='IBA02';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v order by v->>'userId',v->>'role' loop
  uid=(stage->>'userId')::uuid;held_role=stage->>'role';perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,uid,held_role);
  if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,uid,held_role,'decider') then raise exception 'Every named stage requires current held scope and authority.' using errcode='IBA01';end if;
  if e.model='retainer' and not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,uid,held_role,'commercial.retainer_eligibility.issue') then raise exception 'Retainer reviewer access required' using errcode='IBA01';end if;
  if e.model='managed_service' and not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,uid,held_role,'commercial.service_units.issue') then raise exception 'Service unit reviewer access required' using errcode='IBA01';end if;
  if e.model='milestone' and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,uid,held_role,'viewer') then raise exception 'Named milestone reviewer access is required.' using errcode='IBA01';end if;
 end loop;return new;
end $$;

create or replace function complete_invoice_batch_policy() returns trigger language plpgsql as $$
declare stage jsonb;begin
 if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Batch Approval' and a.action='Configure Policy' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('policyId',new.id,'engagementId',new.engagement_id)) then raise exception 'Policy authority and redacted audit must commit together.' using errcode='IBA03';end if;
 if exists(select from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.model='retainer')
 and (not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.retainer_eligibility.issue')
 or exists(select from jsonb_array_elements(new.definition->'stages') s where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,(s->>'userId')::uuid,s->>'role','commercial.retainer_eligibility.issue')))
 then raise exception 'Retainer authority must persist through commit' using errcode='IBA03';end if;
 if exists(select from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.model='managed_service')
 and (not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_units.issue')
 or exists(select from jsonb_array_elements(new.definition->'stages') s where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,(s->>'userId')::uuid,s->>'role','commercial.service_units.issue')))
 then raise exception 'Service unit authority must persist through commit' using errcode='IBA03';end if;
 for stage in select v from jsonb_array_elements(new.definition->'stages') v loop if not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,(stage->>'userId')::uuid,stage->>'role','decider') or (exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.model='milestone') and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,(stage->>'userId')::uuid,stage->>'role','viewer')) then raise exception 'Every named stage must retain authority through commit.' using errcode='IBA03';end if;end loop;
 if exists(select 1 from commercial_engagements e where e.id=new.engagement_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.model='milestone') and not milestone_billing_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'viewer') then raise exception 'Milestone authority must persist through commit.' using errcode='IBA03';end if;return null;
end $$;

create function guard_service_unit_review_participants() returns trigger language plpgsql as $$
declare instance invoice_batch_approval_instances; stage record;
begin
 if tg_table_name='invoice_batch_approval_instances' then instance:=new;
 else select * into strict instance from invoice_batch_approval_instances where id=new.instance_id;end if;
 if exists(select from invoice_draft_batches b where b.id=instance.batch_id and b.source_type='MANAGED_SERVICE_UNIT') then
   for stage in select (s->>'userId')::uuid uid,s->>'role' held_role from invoice_batch_approval_policies p
     cross join lateral jsonb_array_elements(p.definition->'stages') s where p.id=instance.policy_id order by 1,2 loop
     perform lock_commercial_candidate_identity(instance.organization_id,instance.legal_entity_id,stage.uid,stage.held_role);
   end loop;
   perform u.id from users u join invoice_review_participants(instance) p on p.account_id=u.id order by u.id for share of u;
   perform e.id from employees e join users u on u.employee_record_id=e.id join invoice_review_participants(instance) p on p.account_id=u.id order by e.id for share of e;
   if not service_unit_review_participants_valid(instance) then raise exception 'Independent active scoped service_unit reviewers required' using errcode='IBA01';end if;
 end if;
 return new;
end $$;
create trigger service_unit_review_participants before insert on invoice_batch_approval_instances for each row execute function guard_service_unit_review_participants();
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
  elsif line.source_type='RETAINER_PERIOD' then
   if not invoice_notice_actor_has(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'commercial.retainer_eligibility.issue')
     then raise exception 'Retainer history access required' using errcode='IBA01';end if;
  elsif line.source_type='MANAGED_SERVICE_UNIT' then
   if not invoice_notice_actor_has(i.organization_id,i.legal_entity_id,new.actor_id,new.active_role,'commercial.service_units.issue')
     then raise exception 'Service unit history access required' using errcode='IBA01';end if;
  elsif line.source_type='MILESTONE_ACCEPTANCE' then
   if not invoice_source_historical_visible(i.organization_id,i.legal_entity_id,line,new.actor_id,new.active_role) then raise exception 'Current milestone history access is required.' using errcode='IBA01';end if;
  else raise exception 'Unsupported invoice source.' using errcode='IBA01';end if;
 end loop;return new;
end $$;

alter function invoice_notice_source_authorized(invoice_draft_batches,uuid,text) rename to before_service_unit_invoice_notice_source_authorized;
create function invoice_notice_source_authorized(b invoice_draft_batches,actor uuid,active_role text) returns boolean language sql stable as $$
 select case when b.source_type='MANAGED_SERVICE_UNIT' then invoice_notice_actor_has(b.organization_id,b.legal_entity_id,actor,active_role,'commercial.service_units.issue')
 else before_service_unit_invoice_notice_source_authorized(b,actor,active_role) end
$$;

create trigger service_unit_decision_participants before insert on invoice_batch_approval_transitions
 for each row execute function guard_service_unit_review_participants();
