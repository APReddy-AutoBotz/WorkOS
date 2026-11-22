insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_periods.value','Commercial','Value approved service periods','Retain operational management value for an approved fixed-period charge.',false);

alter table commercial_service_unit_policies drop constraint commercial_service_unit_policies_profile_check,
 drop constraint commercial_service_unit_policies_check,
 add constraint service_valuation_profile check(profile in ('accepted_unit','approved_period','disabled')),
 add constraint service_valuation_precision check((profile='disabled')=(precision_digits is null));

create table commercial_service_period_valuations (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, engagement_id text not null,
 review_id uuid not null unique references commercial_service_period_reviews(id), policy_id uuid not null references commercial_service_unit_policies(id),
 version_id text not null references commercial_contract_versions(id), engagement_lifecycle_id text not null references commercial_lifecycle_events(id),
 engagement_amendment_id text references commercial_amendments(id), ends_on date not null, currency text not null,
 source_amount numeric(18,4) not null, amount numeric not null check(amount>=0), actor_id uuid not null references users(id),
 active_role text not null, operation_id text not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create function guard_service_period_valuation() returns trigger language plpgsql as $$
declare r commercial_service_period_reviews; e commercial_engagements; p commercial_service_unit_policies;
 life commercial_lifecycle_events; amendment commercial_amendments;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_periods.value')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
 or nullif(current_setting('workos.service_valuation',true),'')::jsonb is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id)
 then raise exception 'Scoped period valuation authority required' using errcode='MSV01'; end if;
 select * into r from commercial_service_period_reviews where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.review_id and decision='Approved';
 select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id and contract_id=r.contract_id and model='managed_service';
 select * into life from commercial_lifecycle_events where organization_id=e.organization_id and legal_entity_id=e.legal_entity_id and entity_type='Engagement' and entity_id=e.id and effective_on<=r.starts_on order by sequence desc limit 1;
 select * into amendment from commercial_amendments where organization_id=e.organization_id and legal_entity_id=e.legal_entity_id and entity_type='Engagement' and entity_id=e.id and effective_on<=r.starts_on order by sequence desc limit 1;
 select * into p from commercial_service_unit_policies where organization_id=e.organization_id and legal_entity_id=e.legal_entity_id and engagement_id=e.id and effective_from<=r.ends_on order by effective_from desc limit 1;
 if r.id is null or e.id is null or e.currency<>r.currency or p.profile is distinct from 'approved_period' or p.id is distinct from new.policy_id
 or life.state is distinct from 'Active' or coalesce(amendment.contract_version_id,life.contract_version_id) is distinct from r.version_id
 or r.starts_on<coalesce(amendment.starts_on,e.starts_on) or r.ends_on>coalesce(amendment.ends_on,e.ends_on)
 or exists(select from commercial_lifecycle_events where organization_id=e.organization_id and legal_entity_id=e.legal_entity_id and entity_type='Engagement' and entity_id=e.id and effective_on>r.starts_on and effective_on<=r.ends_on)
 or exists(select from commercial_amendments where organization_id=e.organization_id and legal_entity_id=e.legal_entity_id and entity_type='Engagement' and entity_id=e.id and effective_on>r.starts_on and effective_on<=r.ends_on)
 then raise exception 'Approved period, matching engagement and effective policy required' using errcode='MSV02'; end if;
 perform id from users where id in(r.actor_id,r.author_id) order by id for share;
 perform w.id from employees w join users u on u.employee_record_id=w.id where u.id in(r.actor_id,r.author_id) order by w.id for share of w;
 if exists(select from (values(r.actor_id,r.worker_id,r.reviewer_generation),(r.author_id,r.author_worker_id,r.author_generation)) x(account,worker,generation)
   where not exists(select from users u join employees w on w.id=u.employee_record_id where u.id=x.account and w.id=x.worker and u.status='Active' and w.status='Active'
    and w.organization_id=e.organization_id and w.legal_entity_id=e.legal_entity_id and x.generation=coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0)))
 then raise exception 'Period approval identity changed' using errcode='MSV02'; end if;
 perform assert_tm_financial_period(e.organization_id,e.legal_entity_id,r.ends_on);
 new.version_id:=r.version_id; new.ends_on:=r.ends_on; new.currency:=r.currency; new.source_amount:=r.amount;
 new.engagement_lifecycle_id:=life.id; new.engagement_amendment_id:=amendment.id; new.amount:=round(r.amount,p.precision_digits);
 return new;
end $$;
create trigger validate_service_period_value before insert on commercial_service_period_valuations for each row execute function guard_service_period_valuation();
create trigger immutable_service_period_value before update or delete on commercial_service_period_valuations for each row execute function reject_commercial_draft_rewrite();
create function require_service_period_value_audit() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id::text
 and active_role=new.active_role and source='Web' and operation_id=new.operation_id and module='Commercial Drafting' and entity_type='Service Period Valuation' and entity_id=new.id::text
 and action='Recorded' and new_value=jsonb_build_object('engagementId',new.engagement_id,'reviewId',new.review_id,'policyId',new.policy_id,'versionId',new.version_id,
 'endsOn',new.ends_on,'currency',new.currency,'sourceAmount',trim_scale(new.source_amount)::text,'amount',new.amount::text))
 then raise exception 'Period valuation audit required' using errcode='MSV03'; end if;
 return null;
end $$;
create constraint trigger service_period_value_audit after insert on commercial_service_period_valuations deferrable initially deferred for each row execute function require_service_period_value_audit();
