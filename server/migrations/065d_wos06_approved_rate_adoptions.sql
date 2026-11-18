-- An adoption is explicit authority to resolve this approved source, not a
-- valuation, currency conversion, billing-eligibility or invoice event.
create table commercial_rate_adoptions (
 id uuid primary key, organization_id text not null, legal_entity_id text not null,
 candidate_id uuid not null references commercial_rate_candidates(id),
 owner_event_id uuid not null references commercial_candidate_owners(id),
 approval_id uuid not null references commercial_candidate_approval_instances(id),
 policy_id uuid not null references commercial_candidate_approval_policies(id),
 final_transition_id uuid not null references commercial_candidate_approval_transitions(id),
 actor_id uuid not null references users(id), active_role text not null,
 request_id uuid not null, command jsonb not null,
 reason text not null check(length(btrim(reason)) between 3 and 1000),
 operation_id text not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id),
 unique(organization_id,legal_entity_id,candidate_id),
 unique(organization_id,legal_entity_id,actor_id,request_id)
);
create index commercial_rate_adoptions_source on commercial_rate_adoptions(organization_id,legal_entity_id,candidate_id);
create trigger immutable_commercial_rate_adoptions before update or delete on commercial_rate_adoptions for each row execute function reject_commercial_draft_rewrite();

create function guard_commercial_rate_adoption() returns trigger language plpgsql as $$
declare ctx jsonb;c commercial_rate_candidates;i commercial_candidate_approval_instances;o commercial_candidate_owners;p commercial_candidate_approval_policies;t commercial_candidate_approval_transitions;
begin
 begin ctx=nullif(current_setting('workos.commercial_rate_adoption_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into c from commercial_rate_candidates where id=new.candidate_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
 select * into i from commercial_candidate_approval_instances where id=new.approval_id and candidate_id=new.candidate_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
 select * into o from commercial_candidate_owners where id=new.owner_event_id and candidate_id=new.candidate_id;
 select * into p from commercial_candidate_approval_policies where id=new.policy_id and candidate_id=new.candidate_id;
 if c.id is null or i.id is null or o.id is null or p.id is null then raise exception 'Exact reviewed source unavailable.' using errcode='CRA01';end if;
 perform pg_advisory_xact_lock(hashtext('rate-candidate:'||new.organization_id||':'||new.legal_entity_id||':'||c.stream_id::text));
 perform pg_advisory_xact_lock(hashtext('candidate-owner:'||new.organization_id||':'||new.legal_entity_id||':'||c.id::text));
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,o.owner_user_id,o.owner_role);
 perform lock_commercial_candidate_worker_witness(c,new.actor_id,new.active_role);
 perform lock_commercial_candidate_worker_witness(c,o.owner_user_id,o.owner_role);
 select * into t from commercial_candidate_approval_transitions where instance_id=i.id order by sequence desc limit 1;
 if ctx is null or new.id::text is distinct from ctx->>'eventId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not commercial_candidate_manager_valid(new.organization_id,new.legal_entity_id,c,new.actor_id,new.active_role) or not commercial_candidate_approval_is_current(i) or (select count(*) from commercial_candidate_approval_instances x where x.organization_id=new.organization_id and x.legal_entity_id=new.legal_entity_id and x.candidate_id=new.candidate_id and x.owner_event_id=new.owner_event_id and x.policy_id=new.policy_id and not exists(select 1 from commercial_candidate_approval_invalidations z where z.instance_id=x.id))<>1 or i.owner_event_id<>new.owner_event_id or i.policy_id<>new.policy_id or t.id is distinct from new.final_transition_id or t.decision is distinct from 'Approved' or t.sequence<>jsonb_array_length(p.definition->'stages') or not exists(select 1 from approval_records where entity_type='CommercialCandidateApproval' and entity_id=i.id::text and status='Approved') or c.effective_from<(clock_timestamp() at time zone 'UTC')::date then raise exception 'A current approved source and independent scoped authority are required.' using errcode='CRA01';end if;
 if new.command is distinct from jsonb_build_object('requestId',new.request_id,'candidateId',new.candidate_id,'expectedOwnerEventId',new.owner_event_id,'approvalId',new.approval_id,'expectedPolicyId',new.policy_id,'expectedFinalTransitionId',new.final_transition_id,'reason',new.reason) then raise exception 'The exact explicit adoption command must be retained.' using errcode='CRA01';end if;
 return new;
end $$;
create trigger guarded_commercial_rate_adoption before insert on commercial_rate_adoptions for each row execute function guard_commercial_rate_adoption();
create function complete_commercial_rate_adoption() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Commercial Rate Adoption' and a.action='Adopt Approved Source' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('adoptionId',new.id,'candidateId',new.candidate_id,'approvalId',new.approval_id)) then raise exception 'Adoption and redacted audit must commit together.' using errcode='CRA02';end if;return null;
end $$;
create constraint trigger complete_commercial_rate_adoption after insert on commercial_rate_adoptions deferrable initially deferred for each row execute function complete_commercial_rate_adoption();
