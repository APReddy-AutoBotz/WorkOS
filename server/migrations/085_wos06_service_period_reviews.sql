insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_periods.decide','Commercial','Review fixed-period service charges','Independently approve or reject a closed managed-service contract period.',false);

create table commercial_service_period_reviews (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, contract_id text not null, version_id text not null,
 starts_on date not null, ends_on date not null, currency text not null, amount numeric(18,4) not null check(amount>0),
 lifecycle_id text not null references commercial_lifecycle_events(id), amendment_id text references commercial_amendments(id),
 author_id uuid not null references users(id), author_worker_id text not null, author_generation bigint not null,
 actor_id uuid not null references users(id), worker_id text not null, reviewer_generation bigint not null, active_role text not null,
 decision text not null check(decision in ('Approved','Rejected')), reason text not null check(length(btrim(reason)) between 3 and 1000),
 operation_id text not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,contract_id,version_id) references commercial_contract_versions(organization_id,legal_entity_id,contract_id,id),
 unique(organization_id,legal_entity_id,contract_id,version_id,starts_on)
);
create function guard_service_period_review() returns trigger language plpgsql as $$
declare ver commercial_contract_versions; life commercial_lifecycle_events; amendment commercial_amendments; term jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 select * into strict ver from commercial_contract_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and contract_id=new.contract_id and id=new.version_id;
 select value into term from jsonb_array_elements(ver.service_period_charges) where value->>'startsOn'=new.starts_on::text;
 new.ends_on:=(term->>'endsOn')::date; new.amount:=(term->>'amount')::numeric; new.currency:=ver.currency;
 select * into life from commercial_lifecycle_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
 and entity_type='Contract' and entity_id=new.contract_id and effective_on<=new.starts_on order by sequence desc limit 1;
 select * into amendment from commercial_amendments where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
 and entity_type='Contract' and entity_id=new.contract_id and effective_on<=new.starts_on order by sequence desc limit 1;
 if ver.model<>'managed_service' or term is null or new.ends_on >= (now() at time zone 'UTC')::date or new.starts_on<ver.effective_from
 or life.state is distinct from 'Active' or coalesce(amendment.contract_version_id,life.contract_version_id) is distinct from ver.id
 or new.starts_on<coalesce(amendment.starts_on,ver.starts_on) or new.ends_on>coalesce(amendment.ends_on,ver.ends_on)
 or exists(select from commercial_lifecycle_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type='Contract' and entity_id=new.contract_id and effective_on>new.starts_on and effective_on<=new.ends_on)
 or exists(select from commercial_amendments where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and entity_type='Contract' and entity_id=new.contract_id and effective_on>new.starts_on and effective_on<=new.ends_on)
 then raise exception 'A closed period under continuous active terms is required' using errcode='MSP01'; end if;
 new.lifecycle_id:=life.id; new.amendment_id:=amendment.id; new.author_id:=ver.created_by;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 perform id from users where id in(new.actor_id,new.author_id) order by id for share;
 perform e.id from employees e join users u on u.employee_record_id=e.id where u.id in(new.actor_id,new.author_id) order by e.id for share of e;
 select e.id into new.worker_id from users u join employees e on e.id=u.employee_record_id where u.id=new.actor_id and u.status='Active' and e.status='Active' and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id;
 select e.id into new.author_worker_id from users u join employees e on e.id=u.employee_record_id where u.id=new.author_id and u.status='Active' and e.status='Active' and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id;
 if nullif(current_setting('workos.period_review',true),'')::jsonb is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id)
 or new.actor_id=new.author_id or new.worker_id is null or new.author_worker_id is null or new.worker_id=new.author_worker_id
 or exists(select from retainer_link_observations where account_id in(new.author_id,new.actor_id) and observed_at>=ver.created_at)
 or exists(select from unnest(array['commercial.contracts.view','commercial.service_periods.decide']) k where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k))
 then raise exception 'Current independent period reviewer required' using errcode='MSP02'; end if;
 select coalesce(max(generation),0) into new.author_generation from invoice_reviewer_link_changes where account_id=new.author_id;
 select coalesce(max(generation),0) into new.reviewer_generation from invoice_reviewer_link_changes where account_id=new.actor_id;
 return new;
end $$;
create trigger validate_service_period_review before insert on commercial_service_period_reviews for each row execute function guard_service_period_review();
create trigger immutable_service_period_review before update or delete on commercial_service_period_reviews for each row execute function reject_commercial_draft_rewrite();
create function require_service_period_review_audit() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id::text
 and active_role=new.active_role and source='Web' and operation_id=new.operation_id and module='Commercial Drafting' and entity_type='Managed Service Period Review'
 and entity_id=new.id::text and action=new.decision and old_value=jsonb_build_object('status','Pending') and new_value=jsonb_build_object('contractId',new.contract_id,
 'versionId',new.version_id,'startsOn',new.starts_on,'endsOn',new.ends_on,'amount',trim_scale(new.amount)::text,'currency',new.currency,'decision',new.decision,'reason',new.reason))
 then raise exception 'Period review audit required' using errcode='MSP03'; end if;
 return null;
end $$;
create constraint trigger service_period_review_audit after insert on commercial_service_period_reviews deferrable initially deferred for each row execute function require_service_period_review_audit();
