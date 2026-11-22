insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_units.decide','Commercial','Review delivered service units','Independently accept or reject recorded managed-service quantities.',false);

create table commercial_service_unit_reviews (
 id uuid primary key, evidence_id uuid not null unique references commercial_service_unit_evidence(id),
 organization_id text not null, legal_entity_id text not null, actor_id uuid not null references users(id),
 worker_id text not null, reviewer_generation bigint not null, active_role text not null, operation_id text not null,
 decision text not null check(decision in ('Accepted','Rejected')), reason text not null check(length(btrim(reason)) between 3 and 1000),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id)
);
create function guard_service_unit_review() returns trigger language plpgsql as $$
declare evidence commercial_service_unit_evidence;
begin
 select * into evidence from commercial_service_unit_evidence where id=new.evidence_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
 if not found then raise exception 'Scoped evidence required' using errcode='MSU04'; end if;
 perform id from users where id in (new.actor_id,evidence.actor_id) order by id for share;
 perform e.id from employees e join users u on u.employee_record_id=e.id where u.id in (new.actor_id,evidence.actor_id) order by e.id for share of e;
 select e.id,coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0)
 into new.worker_id,new.reviewer_generation from users u join employees e on e.id=u.employee_record_id
 where u.id=new.actor_id and u.status='Active' and e.status='Active' and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id;
 if new.worker_id is null or new.worker_id=evidence.recorder_worker_id or new.actor_id=evidence.actor_id
 or not exists(select 1 from users u join employees e on e.id=u.employee_record_id
   where u.id=evidence.actor_id and u.status='Active' and e.id=evidence.recorder_worker_id and e.status='Active'
   and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and evidence.recorder_link_generation=
    coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0))
 or exists(select 1 from retainer_link_observations where account_id=new.actor_id and observed_at>=evidence.created_at)
 or exists(select 1 from unnest(array['commercial.service_units.decide','commercial.contracts.view']) k
   where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k))
 or nullif(current_setting('workos.service_unit_review',true),'')::jsonb is distinct from
 jsonb_build_object('actor',new.actor_id,'operation',new.operation_id,'id',new.id,'evidence',new.evidence_id)
 then raise exception 'Independent current reviewer required' using errcode='MSU05'; end if;
 return new;
end $$;
create trigger validate_service_unit_review before insert on commercial_service_unit_reviews for each row execute function guard_service_unit_review();
create trigger immutable_service_unit_review before update or delete on commercial_service_unit_reviews for each row execute function reject_commercial_draft_rewrite();

create function require_service_unit_review_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and
   user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and source='Web' and module='Commercial Drafting'
   and action=new.decision and entity_type='Managed Service Review' and entity_id=new.id::text and
   new_value=jsonb_build_object('evidenceId',new.evidence_id,'decision',new.decision,'reason',new.reason))
 then raise exception 'Service review audit required' using errcode='MSU06'; end if;
 return null;
end $$;
create constraint trigger service_unit_review_audit after insert on commercial_service_unit_reviews deferrable initially deferred
 for each row execute function require_service_unit_review_audit();
