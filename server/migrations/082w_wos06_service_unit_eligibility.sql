create function valid_billable_service_dimensions(dimensions jsonb,contract_model text)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare unit jsonb; original jsonb := '[]'::jsonb;
begin
 if jsonb_typeof(dimensions) is distinct from 'array' then return false; end if;
 if jsonb_array_length(dimensions)>50 then return false; end if;
 for unit in select value from jsonb_array_elements(dimensions) loop
   if jsonb_typeof(unit) is distinct from 'object' then return false; end if;
   if unit ? 'billingPrecision' and (not (unit ? 'unitPrice') or jsonb_typeof(unit->'billingPrecision') is distinct from 'number'
      or unit->>'billingPrecision' !~ '^[0-4]$') then return false; end if;
   original:=original || jsonb_build_array(unit-'billingPrecision');
 end loop;
 return public.valid_priced_service_dimensions(original,contract_model);
end $$;
alter table commercial_contract_versions drop constraint managed_service_dimensions_valid,
 add constraint managed_service_dimensions_valid check(valid_billable_service_dimensions(service_dimensions,model));

insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_units.issue','Commercial','Register accepted service units','Record a contractual charge for independently accepted managed-service units.',false);
alter table billing_eligibility_events add column service_review_id uuid unique references commercial_service_unit_reviews(id),
 add constraint service_event_review_required check ((source_type='MANAGED_SERVICE_UNIT')=(service_review_id is not null));

alter table billing_eligibility_events drop constraint billing_event_source_identity;
alter table billing_eligibility_events add constraint billing_event_source_identity check (
 (source_type='TM_SNAPSHOT' and snapshot_id is not null and instance_id is not null and decision_id is not null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='MILESTONE_ACCEPTANCE' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is not null and milestone_decision_id is not null and reversal_decision_id is null and reverses_event_id is null)
 or (source_type='FULL_LINE_REVERSAL' and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is not null and reverses_event_id is not null)
 or (source_type in ('FIXED_FEE_INSTALLMENT','RETAINER_PERIOD','MANAGED_SERVICE_UNIT') and snapshot_id is null and instance_id is null and decision_id is null
  and milestone_instance_id is null and milestone_decision_id is null and reversal_decision_id is null and reverses_event_id is null)
);



create function service_unit_eligibility_source(org text,legal text,eng text,receipt uuid,acceptance uuid)
returns table(client_id text,contract_id text,currency text,amount numeric,evidence jsonb) language sql stable as $$
 select g.client_id,g.contract_id,v.currency,charge.amount,
 jsonb_build_object('evidenceId',s.id,'reviewId',r.id,'contractVersionId',v.id,'priceEffectiveFrom',v.effective_from,'engagementId',g.id,
   'serviceDate',s.service_date,'dimensionCode',s.dimension_code,'quantity',s.quantity::text,'unitPrice',unit->>'unitPrice',
   'billingPrecision',unit->'billingPrecision','rounding','HALF_UP','contractLifecycleId',cl.id,'engagementLifecycleId',el.id,
   'contractAmendmentId',ca.id,'engagementAmendmentId',ea.id)
 from commercial_service_unit_evidence s join commercial_service_unit_reviews r on r.evidence_id=s.id and r.decision='Accepted'
 join commercial_engagements g on g.id=s.engagement_id and g.model='managed_service' and g.billable and g.contract_id=s.contract_id
 join commercial_contract_versions v on v.id=s.version_id and v.contract_id=g.contract_id and v.currency=g.currency
 join commercial_contracts c on c.id=g.contract_id and c.client_id=g.client_id
 cross join lateral jsonb_array_elements(v.service_dimensions) unit
 cross join lateral (select round(s.quantity*(unit->>'unitPrice')::numeric,(unit->>'billingPrecision')::int) amount) charge
 join lateral (select * from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal and entity_type='Contract'
   and entity_id=c.id and effective_on<=s.service_date order by sequence desc limit 1) cl on cl.state='Active'
 join lateral (select * from commercial_lifecycle_events where organization_id=org and legal_entity_id=legal and entity_type='Engagement'
   and entity_id=g.id and effective_on<=s.service_date order by sequence desc limit 1) el on el.state='Active'
 left join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=legal and entity_type='Contract'
   and entity_id=c.id and effective_on<=s.service_date order by sequence desc limit 1) ca on true
 left join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=legal and entity_type='Engagement'
   and entity_id=g.id and effective_on<=s.service_date order by sequence desc limit 1) ea on true
 where s.organization_id=org and s.legal_entity_id=legal and s.engagement_id=eng and s.id=receipt and r.id=acceptance
   and unit->>'code'=s.dimension_code and charge.amount>0 and charge.amount<10000000000000000
   and coalesce(ca.contract_version_id,cl.contract_version_id)=v.id and coalesce(ea.contract_version_id,el.contract_version_id)=v.id
   and s.service_date between coalesce(ca.starts_on,v.starts_on) and coalesce(ca.ends_on,v.ends_on)
   and s.service_date between coalesce(ea.starts_on,g.starts_on) and coalesce(ea.ends_on,g.ends_on)
   and not exists(select from (values(s.actor_id,s.recorder_worker_id,s.recorder_link_generation),(r.actor_id,r.worker_id,r.reviewer_generation)) x(account,worker,generation)
     where not exists(select from users u join employees w on w.id=u.employee_record_id where u.id=x.account and w.id=x.worker
     and u.status='Active' and w.status='Active' and w.organization_id=org and w.legal_entity_id=legal and x.generation=
       coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0)))
$$;

create function guard_service_billing_event() returns trigger language plpgsql as $$
declare src record; pins record;
begin
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if current_setting('workos.service_issue_operation',true) is distinct from new.operation_id or exists(select from
 unnest(array['commercial.contracts.view','commercial.service_units.issue']) k where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k) is not true)
 then raise exception 'Service billing authority required' using errcode='SBE01'; end if;
 select e.id,e.actor_id recorder,r.actor_id reviewer into pins from commercial_service_unit_reviews r join commercial_service_unit_evidence e on r.evidence_id=e.id
 where r.id=new.service_review_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id;
 perform id from users where id in(pins.recorder,pins.reviewer) order by id for share;
 perform w.id from employees w join users u on u.employee_record_id=w.id where u.id in(pins.recorder,pins.reviewer) order by w.id for share of w;
 select * into src from service_unit_eligibility_source(new.organization_id,new.legal_entity_id,new.engagement_id,pins.id,new.service_review_id);
 if src.contract_id is null or (new.contract_id,new.client_id,new.currency,new.amount) is distinct from (src.contract_id,src.client_id,src.currency,src.amount)
   or new.eligible_on is distinct from (statement_timestamp() at time zone 'UTC')::date or new.version<>1
   or new.billing_evidence-'reason' is distinct from src.evidence or jsonb_typeof(new.billing_evidence->'reason') is distinct from 'string'
   or length(btrim(new.billing_evidence->>'reason')) not between 3 and 1000 then raise exception 'Accepted service charge unavailable' using errcode='SBE02'; end if;
 new.created_at:=clock_timestamp();return new;
end $$;
create trigger verify_service_unit_charge before insert on billing_eligibility_events for each row when(new.source_type='MANAGED_SERVICE_UNIT') execute function guard_service_billing_event();
create trigger register_service_unit_charge after insert on billing_eligibility_events for each row when(new.source_type='MANAGED_SERVICE_UNIT') execute function register_issued_billing_event();

create function require_service_unit_register_receipt() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from approved_unbilled_items i join audit_logs a on a.entity_id=new.id::text
   where i.event_id=new.id and i.organization_id=new.organization_id and i.legal_entity_id=new.legal_entity_id
   and a.operation_id=new.operation_id and a.user_id=new.actor_id::text and a.active_role=new.active_role
   and a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.module='Commercial Drafting'
   and a.action='Issue Service Unit Charge' and a.entity_type='Billing Eligibility Event' and a.source='Web'
   and a.new_value=jsonb_build_object('itemId',i.id,'eventId',new.id)
   and length(trim(a.reason)) between 3 and 1000) then
   raise exception 'Audited service unit registration and register membership required' using errcode='SBE03';
 end if;
 return null;
end $$;
create constraint trigger service_unit_register_receipt after insert on billing_eligibility_events
 deferrable initially deferred for each row when(new.source_type='MANAGED_SERVICE_UNIT')
 execute function require_service_unit_register_receipt();
