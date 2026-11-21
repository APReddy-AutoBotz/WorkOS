-- Resolve only independently approved, current revisions and the engagement responsible for the whole period.
create function retainer_eligibility_source(org text, legal text, statement_pin uuid, review_pin uuid, engagement_pin text, eligible_date date)
returns table(client_id text, contract_id text, currency text, amount numeric, evidence jsonb)
language sql stable as $$
 select e.client_id,s.contract_id,v.currency,price.total,
   jsonb_build_object('statementId',s.id,'statementVersion',s.sequence,'sourceHash',s.source_hash,
     'reviewId',r.id,'contractVersionId',v.id,'engagementId',e.id,'startsOn',s.starts_on,'endsOn',s.ends_on,
     'periodPrice',s.evidence->'price'->'periodPrice','contractLifecycleId',cl.id,'engagementLifecycleId',el.id,
     'contractAmendmentId',ca.id,'engagementAmendmentId',ea.id)
 from commercial_retainer_statements s
 join commercial_retainer_reviews r on r.statement_id=s.id and r.organization_id=s.organization_id
   and r.legal_entity_id=s.legal_entity_id and r.source_hash=s.source_hash and r.decision='Approved'
 join commercial_contract_versions v on v.id=s.version_id and v.contract_id=s.contract_id
   and v.organization_id=s.organization_id and v.legal_entity_id=s.legal_entity_id and v.model='retainer'
 join commercial_contracts contract on contract.id=s.contract_id and contract.organization_id=s.organization_id and contract.legal_entity_id=s.legal_entity_id
 join commercial_engagements e on e.client_id=contract.client_id and e.contract_id=s.contract_id and e.organization_id=s.organization_id
   and e.legal_entity_id=s.legal_entity_id and e.model='retainer' and e.currency=v.currency and e.billable and e.origin='manual'
 cross join lateral (select (s.evidence->'price'->'periodPrice'->>'total')::numeric total) price
 join lateral (select * from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal
   and entity_type='Contract' and entity_id=s.contract_id and effective_on<=s.starts_on order by sequence desc limit 1) cl on true
 join lateral (select * from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal
   and entity_type='Engagement' and entity_id=e.id and effective_on<=s.starts_on order by sequence desc limit 1) el on true
 left join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=legal
   and entity_type='Contract' and entity_id=s.contract_id and effective_on<=s.starts_on order by sequence desc limit 1) ca on true
 left join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=legal
   and entity_type='Engagement' and entity_id=e.id and effective_on<=s.starts_on order by sequence desc limit 1) ea on true
 where s.organization_id=org and s.legal_entity_id=legal and s.id=statement_pin and r.id=review_pin and e.id=engagement_pin
   and s.ends_on<eligible_date and v.effective_from<=s.starts_on and cl.state='Active' and el.state='Active'
   and coalesce(ca.contract_version_id,cl.contract_version_id)=v.id and coalesce(ea.contract_version_id,e.contract_version_id)=v.id
   and s.starts_on>=coalesce(ca.starts_on,v.starts_on) and s.ends_on<=coalesce(ca.ends_on,v.ends_on)
   and s.starts_on>=coalesce(ea.starts_on,e.starts_on) and s.ends_on<=coalesce(ea.ends_on,e.ends_on)
   and price.total>0 and price.total<10000000000000000 and price.total=round(price.total,4)
   and not exists(select from commercial_retainer_statements newer where newer.organization_id=org and newer.legal_entity_id=legal
     and newer.contract_id=s.contract_id and newer.version_id=s.version_id and newer.starts_on=s.starts_on and newer.sequence>s.sequence)
   and not exists(select from commercial_lifecycle_events change where change.organization_id=org and change.legal_entity_id=legal
     and (change.entity_type,change.entity_id) in (('Contract',s.contract_id),('Engagement',e.id))
     and change.effective_on>s.starts_on and change.effective_on<=s.ends_on and change.state<>'Active')
   and not exists(select from commercial_amendments change where change.organization_id=org and change.legal_entity_id=legal
     and (change.entity_type,change.entity_id) in (('Contract',s.contract_id),('Engagement',e.id))
     and change.effective_on>s.starts_on and change.effective_on<=s.ends_on
     and (change.contract_version_id is distinct from v.id or change.starts_on>s.starts_on or change.ends_on<s.ends_on))
   and not exists(select from jsonb_array_elements(s.evidence->'periods') period
     cross join lateral jsonb_array_elements(period->'entries') entry where entry->>'engagementId' is distinct from e.id)
$$;

insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.retainer_eligibility.issue','Commercial','Register approved retainer charges','Register an independently approved service period against its responsible engagement.',false);

alter table billing_eligibility_events
 add column retainer_review_id uuid references commercial_retainer_reviews(id),
 add column retainer_period daterange,
 add constraint retainer_event_fields check (
   (source_type='RETAINER_PERIOD' and retainer_review_id is not null and retainer_period is not null and not isempty(retainer_period))
   or (source_type<>'RETAINER_PERIOD' and retainer_review_id is null and retainer_period is null)),
 add constraint retainer_period_billed_once exclude using gist
   (organization_id with =,legal_entity_id with =,contract_id with =,retainer_period with &&) where (source_type='RETAINER_PERIOD');
alter table billing_eligibility_events drop constraint billing_event_source_identity;
alter table billing_eligibility_events add constraint billing_event_source_identity check (
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and instance_id is not null and decision_id is not null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is not null and milestone_decision_id is not null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='FULL_LINE_REVERSAL' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is not null and reverses_event_id is not null)
 or (source_type in ('FIXED_FEE_INSTALLMENT','RETAINER_PERIOD') and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
);

create function guard_retainer_billing_event() returns trigger language plpgsql as $$
declare src record; day date := (statement_timestamp() at time zone 'UTC')::date;
begin
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if current_setting('workos.retainer_issue_operation',true) is distinct from new.operation_id
   or exists(select from unnest(array['commercial.contracts.view','commercial.retainer_eligibility.issue','employees.view','reports.view_utilization','commercial.rate_candidates.view']) k
     where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k) is not true) then
   raise exception 'Current retainer billing authority required' using errcode='RBE01';
 end if;
 select * into src from retainer_eligibility_source(new.organization_id,new.legal_entity_id,
   (new.billing_evidence->>'statementId')::uuid,new.retainer_review_id,new.engagement_id,day);
 if src.contract_id is null or (new.contract_id,new.client_id,new.currency,new.amount,new.eligible_on)
   is distinct from (src.contract_id,src.client_id,src.currency,src.amount,day)
   or new.retainer_period is distinct from daterange((src.evidence->>'startsOn')::date,(src.evidence->>'endsOn')::date,'[]')
   or new.billing_evidence-'reason' is distinct from src.evidence
   or jsonb_typeof(new.billing_evidence->'reason') is distinct from 'string'
   or length(trim(new.billing_evidence->>'reason')) not between 3 and 1000 then
   raise exception 'Current approved period, adopted terms and supported charge required' using errcode='RBE02';
 end if;
 new.created_at:=clock_timestamp();
 return new;
end $$;
create trigger guard_retainer_event before insert on billing_eligibility_events for each row when(new.source_type='RETAINER_PERIOD')
 execute function guard_retainer_billing_event();
create trigger register_retainer_event after insert on billing_eligibility_events for each row when(new.source_type='RETAINER_PERIOD')
 execute function register_issued_billing_event();

create function require_retainer_register_receipt() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from approved_unbilled_items i join audit_logs a on a.entity_id=new.id::text
   where i.event_id=new.id and i.organization_id=new.organization_id and i.legal_entity_id=new.legal_entity_id
   and a.operation_id=new.operation_id and a.user_id=new.actor_id::text and a.active_role=new.active_role
   and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.module='Commercial Drafting'
   and a.action='Issue Retainer Charge' and a.entity_type='Billing Eligibility Event' and a.source='Web'
   and a.new_value=jsonb_build_object('itemId',i.id,'eventId',new.id)
   and length(trim(a.reason)) between 3 and 1000) then
   raise exception 'Audited retainer registration and register membership required' using errcode='RBE03';
 end if;
 return null;
end $$;
create constraint trigger retainer_register_receipt after insert on billing_eligibility_events
 deferrable initially deferred for each row when(new.source_type='RETAINER_PERIOD')
 execute function require_retainer_register_receipt();
