insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_eligibility.issue','Commercial','Approve due fixed-fee installments',
  'Independently approve a due contract installment for a selected engagement and inspect its register receipt.',false);

alter table billing_eligibility_events drop constraint billing_event_source_identity;
alter table billing_eligibility_events add constraint billing_event_source_identity check (
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and instance_id is not null and decision_id is not null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is not null and milestone_decision_id is not null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='FULL_LINE_REVERSAL' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is not null and reverses_event_id is not null)
 or (source_type='FIXED_FEE_INSTALLMENT' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
);
create unique index fixed_fee_installment_once on billing_eligibility_events
 (organization_id,legal_entity_id,contract_id,((billing_evidence->>'installment')::int))
 where source_type='FIXED_FEE_INSTALLMENT';

create function fixed_fee_schedule_preserves_issued(org text,legal text,contract text,schedule jsonb)
returns boolean language sql stable strict as $$
 select not exists(select 1 from billing_eligibility_events prior
     cross join lateral (select schedule->((prior.billing_evidence->>'installment')::int-1) as row) retained
     where prior.organization_id=org and prior.legal_entity_id=legal and prior.contract_id=contract
       and prior.source_type='FIXED_FEE_INSTALLMENT' and (retained.row->>'dueOn' is distinct from prior.billing_evidence->>'dueOn'
       or (retained.row->>'amount')::numeric is distinct from prior.amount))
$$;

create function fixed_fee_installment_source(org text,legal text,version_pin text,idx int,eng text,day date)
returns table(client_id text,contract_id text,currency text,amount numeric,evidence jsonb,author uuid)
language sql stable as $$
 select e.client_id,v.contract_id,v.currency,(i.row->>'amount')::numeric,
   jsonb_build_object('sourceVersion',1,'contractVersionId',v.id,'installment',idx,'dueOn',i.row->>'dueOn',
   'currency',v.currency,'amount',trim_scale((i.row->>'amount')::numeric)::text,'engagementId',e.id,
   'contractLifecycleId',cl.id,'engagementLifecycleId',el.id,'contractAmendmentId',ca.id,'engagementAmendmentId',ea.id),
   v.created_by
 from commercial_contract_versions v join commercial_engagements e on e.organization_id=v.organization_id
   and e.legal_entity_id=v.legal_entity_id and e.contract_id=v.contract_id
 cross join lateral (select v.installments->(idx-1) as row) i
 join lateral (select * from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal
   and entity_type='Contract' and entity_id=v.contract_id and effective_on<=day order by sequence desc limit 1) cl on true
 join lateral (select * from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal
   and entity_type='Engagement' and entity_id=e.id and effective_on<=day order by sequence desc limit 1) el on true
 left join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=legal
   and entity_type='Contract' and entity_id=v.contract_id and effective_on<=day order by sequence desc limit 1) ca on true
 left join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=legal
   and entity_type='Engagement' and entity_id=e.id and effective_on<=day order by sequence desc limit 1) ea on true
 where v.organization_id=org and v.legal_entity_id=legal and v.id=version_pin and idx between 1 and 120
   and e.id=eng and v.model='fixed_fee' and e.model='fixed_fee' and e.billable and e.origin='manual' and e.currency=v.currency
   and cl.state='Active' and el.state='Active' and coalesce(ca.contract_version_id,cl.contract_version_id)=v.id
   and coalesce(ea.contract_version_id,e.contract_version_id)=v.id
   and day between coalesce(ca.starts_on,v.starts_on) and coalesce(ca.ends_on,v.ends_on)
   and day between coalesce(ea.starts_on,e.starts_on) and coalesce(ea.ends_on,e.ends_on)
   and (i.row->>'dueOn')::date between v.effective_from and day
   and (i.row->>'dueOn')::date between coalesce(ca.starts_on,v.starts_on) and coalesce(ca.ends_on,v.ends_on)
   and (i.row->>'dueOn')::date between coalesce(ea.starts_on,e.starts_on) and coalesce(ea.ends_on,e.ends_on)
   and fixed_fee_schedule_preserves_issued(org,legal,v.contract_id,v.installments)
$$;

create function guard_fixed_fee_installment_event() returns trigger language plpgsql as $$
declare src record; day date := (clock_timestamp() at time zone 'UTC')::date;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 perform id from commercial_contracts where id=new.contract_id and organization_id=new.organization_id
   and legal_entity_id=new.legal_entity_id for update;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if current_setting('workos.fixed_fee_issue_operation',true) is distinct from new.operation_id
   or exists(select 1 from unnest(array['commercial.contracts.view','commercial.contracts.manage','commercial.fixed_fee_eligibility.issue']) k
      where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k) is not true) then
   raise exception 'Current installment approval authority required' using errcode='FFE01';
 end if;
 select * into src from fixed_fee_installment_source(new.organization_id,new.legal_entity_id,
   new.billing_evidence->>'contractVersionId',(new.billing_evidence->>'installment')::int,new.engagement_id,day);
 if src.author is null or (new.client_id,new.contract_id,new.currency,new.amount,new.eligible_on)
   is distinct from (src.client_id,src.contract_id,src.currency,src.amount,day)
   or (new.billing_evidence-'approvalReason') is distinct from src.evidence
   or jsonb_typeof(new.billing_evidence->'approvalReason') is distinct from 'string'
   or length(trim(new.billing_evidence->>'approvalReason')) not between 3 and 1000 then
   raise exception 'Due installment and adopted active terms required' using errcode='FFE02';
 end if;
 perform id from users where id=src.author for share;
 if new.actor_id=src.author or exists(select 1 from users maker join users reviewer
   on maker.employee_record_id=reviewer.employee_record_id where maker.id=src.author and reviewer.id=new.actor_id) then
   raise exception 'Independent schedule approval required' using errcode='FFE01';
 end if;
 new.created_at := clock_timestamp();
 return new;
end $$;
create trigger guard_fixed_fee_installment before insert on billing_eligibility_events
 for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function guard_fixed_fee_installment_event();

-- Both sources enter the canonical register through the same immutable event projection.
alter function register_full_line_reversal() rename to register_issued_billing_event;
create trigger register_fixed_fee_installment after insert on billing_eligibility_events
 for each row when(new.source_type='FIXED_FEE_INSTALLMENT') execute function register_issued_billing_event();

create function require_fixed_fee_register_receipt() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from approved_unbilled_items i join audit_logs a on a.entity_id=new.id::text
   where i.event_id=new.id and i.organization_id=new.organization_id and i.legal_entity_id=new.legal_entity_id
   and a.operation_id=new.operation_id and a.user_id=new.actor_id::text and a.active_role=new.active_role
   and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.module='Commercial Drafting'
   and a.action='Approve Installment' and a.entity_type='Billing Eligibility Event' and a.source='Web'
   and a.new_value=jsonb_build_object('itemId',i.id,'eventId',new.id)
   and length(trim(a.reason)) between 3 and 1000) then
   raise exception 'Audited fixed-fee approval and register membership required' using errcode='FFE03';
 end if;
 return null;
end $$;
create constraint trigger fixed_fee_register_receipt after insert on billing_eligibility_events
 deferrable initially deferred for each row when(new.source_type='FIXED_FEE_INSTALLMENT')
 execute function require_fixed_fee_register_receipt();
