insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_periods.issue','Commercial','Register approved service periods','Issue a contractual charge for an independently approved managed-service period.',false);
alter table billing_eligibility_events add column service_period_review_id uuid unique references commercial_service_period_reviews(id),
 add constraint service_period_event_review_required check ((source_type='MANAGED_SERVICE_PERIOD')=(service_period_review_id is not null));

alter table billing_eligibility_events drop constraint billing_event_source_identity;
alter table billing_eligibility_events add constraint billing_event_source_identity check (
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and instance_id is not null and decision_id is not null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is not null and milestone_decision_id is not null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='FULL_LINE_REVERSAL' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is not null and reverses_event_id is not null)
 or (source_type in ('FIXED_FEE_INSTALLMENT','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD') and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
);




create function service_period_eligibility_source(org text, legal text, eng text, review uuid)
returns table(client_id text,contract_id text,currency text,amount numeric,evidence jsonb) language sql stable as $$
 select g.client_id,g.contract_id,r.currency,trim_scale(r.amount),
 jsonb_build_object('reviewId',r.id,'contractVersionId',r.version_id,'engagementId',g.id,'startsOn',r.starts_on,'endsOn',r.ends_on,
 'contractLifecycleId',r.lifecycle_id,'contractAmendmentId',r.amendment_id,'engagementLifecycleId',life.id,'engagementAmendmentId',amend.id)
 from commercial_service_period_reviews r join commercial_engagements g on g.organization_id=r.organization_id and g.legal_entity_id=r.legal_entity_id
 and g.contract_id=r.contract_id and g.currency=r.currency and g.model='managed_service' and g.billable
 join commercial_contracts c on c.id=g.contract_id and c.client_id=g.client_id and c.organization_id=org and c.legal_entity_id=legal
 join lateral (select * from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal and entity_type='Engagement'
   and entity_id=g.id and effective_on<=r.starts_on order by sequence desc limit 1) life on life.state='Active'
 left join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=legal and entity_type='Engagement'
   and entity_id=g.id and effective_on<=r.starts_on order by sequence desc limit 1) amend on true
 where r.organization_id=org and r.legal_entity_id=legal and r.id=review and r.decision='Approved' and g.id=eng
 and coalesce(amend.contract_version_id,life.contract_version_id)=r.version_id
 and r.starts_on>=coalesce(amend.starts_on,g.starts_on) and r.ends_on<=coalesce(amend.ends_on,g.ends_on)
 and not exists(select from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal and entity_type='Engagement' and entity_id=eng and effective_on>r.starts_on and effective_on<=r.ends_on)
 and not exists(select from commercial_amendments where organization_id=org and legal_entity_id=legal and entity_type='Engagement' and entity_id=eng and effective_on>r.starts_on and effective_on<=r.ends_on)
 and not exists(select from billing_eligibility_events ev join commercial_service_period_reviews prior on prior.id=ev.service_period_review_id
   where ev.organization_id=org and ev.legal_entity_id=legal and ev.contract_id=r.contract_id and prior.starts_on<=r.ends_on and prior.ends_on>=r.starts_on)
 and not exists(select from (values(r.actor_id,r.worker_id,r.reviewer_generation),(r.author_id,r.author_worker_id,r.author_generation)) x(account,worker,generation)
   where not exists(select from users u join employees w on w.id=u.employee_record_id where u.id=x.account and w.id=x.worker and u.status='Active' and w.status='Active'
      and w.organization_id=org and w.legal_entity_id=legal and x.generation=coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0)))
$$;
create function guard_service_period_billing_event() returns trigger language plpgsql as $$
declare src record; pins record;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if current_setting('workos.period_issue_operation',true) is distinct from new.operation_id or exists(select from
 unnest(array['commercial.contracts.view','commercial.service_periods.issue']) k where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k) is not true)
 then raise exception 'Service billing authority required' using errcode='SBE01'; end if;
 select r.author_id recorder,r.actor_id reviewer into pins from commercial_service_period_reviews r where r.id=new.service_period_review_id
 and r.organization_id=new.organization_id and r.legal_entity_id=new.legal_entity_id;
 perform id from users where id in(pins.recorder,pins.reviewer) order by id for share;
 perform w.id from employees w join users u on u.employee_record_id=w.id where u.id in(pins.recorder,pins.reviewer) order by w.id for share of w;
 select * into src from service_period_eligibility_source(new.organization_id,new.legal_entity_id,new.engagement_id,new.service_period_review_id);
 if src.contract_id is null or (new.contract_id,new.client_id,new.currency,new.amount) is distinct from (src.contract_id,src.client_id,src.currency,src.amount)
   or new.eligible_on is distinct from (statement_timestamp() at time zone 'UTC')::date or new.version<>1
   or new.billing_evidence-'reason' is distinct from src.evidence or jsonb_typeof(new.billing_evidence->'reason') is distinct from 'string'
   or length(btrim(new.billing_evidence->>'reason')) not between 3 and 1000 then raise exception 'Approved period charge unavailable' using errcode='SBE02'; end if;
 perform assert_tm_financial_period(new.organization_id,new.legal_entity_id,new.eligible_on);
 new.created_at:=clock_timestamp();return new;
end $$;
create trigger verify_service_period_charge before insert on billing_eligibility_events for each row when(new.source_type='MANAGED_SERVICE_PERIOD') execute function guard_service_period_billing_event();
create trigger register_service_period_charge after insert on billing_eligibility_events for each row when(new.source_type='MANAGED_SERVICE_PERIOD') execute function register_issued_billing_event();

create function require_service_period_register_receipt() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from approved_unbilled_items i join audit_logs a on a.entity_id=new.id::text
   where i.event_id=new.id and i.organization_id=new.organization_id and i.legal_entity_id=new.legal_entity_id
   and a.operation_id=new.operation_id and a.user_id=new.actor_id::text and a.active_role=new.active_role
   and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.module='Commercial Drafting'
   and a.action='Issue Service Period Charge' and a.entity_type='Billing Eligibility Event' and a.source='Web'
   and a.new_value=jsonb_build_object('itemId',i.id,'eventId',new.id)
   and length(trim(a.reason)) between 3 and 1000) then
   raise exception 'Audited service period registration and register membership required' using errcode='SBE03';
 end if;
 return null;
end $$;
create constraint trigger service_period_register_receipt after insert on billing_eligibility_events
 deferrable initially deferred for each row when(new.source_type='MANAGED_SERVICE_PERIOD')
 execute function require_service_period_register_receipt();
