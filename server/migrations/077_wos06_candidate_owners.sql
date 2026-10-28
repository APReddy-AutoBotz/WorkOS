-- Per-candidate owner history is explicit and does not create financial authority.
create table commercial_candidate_owners (
 id uuid primary key, organization_id text not null, legal_entity_id text not null,
 candidate_id uuid not null references commercial_rate_candidates(id) on delete restrict,
 sequence integer not null check(sequence>0), previous_id uuid references commercial_candidate_owners(id) on delete restrict,
 owner_user_id uuid not null references users(id) on delete restrict, owner_role text not null references roles(name) on delete restrict,
 request_id uuid not null, actor_id uuid not null references users(id) on delete restrict, active_role text not null,
 reason text not null check(length(btrim(reason)) between 3 and 1000), operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,candidate_id,sequence),
 unique(organization_id,legal_entity_id,actor_id,request_id)
);
create trigger immutable_commercial_candidate_owner before update or delete on commercial_candidate_owners for each row execute function reject_commercial_draft_rewrite();

create function valid_candidate_owner(org text, legal text, candidate commercial_rate_candidates, ownerid uuid, ownerrole text) returns boolean language plpgsql stable as $$
declare k text; ctx jsonb; begin
 if candidate.organization_id<>org or candidate.legal_entity_id<>legal then return false; end if;
 if not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id=ownerid and u.status='Active' and r.name=ownerrole and s.organization_id=org and s.legal_entity_id=legal and s.active) then return false; end if;
 foreach k in array array['commercial.contracts.view',case candidate.kind when 'billing' then 'commercial.rate_candidates.view' else 'commercial.cost_candidates.view' end,'notifications.view'] loop
  if not exists(select 1 from role_permissions where role_name=ownerrole and permission_key=k and enabled) and not exists(select 1 from user_permission_grants where user_id=ownerid and permission_key=k) then return false; end if;
 end loop;
 if candidate.kind='cost' then
  ctx=jsonb_build_object('actorId',ownerid,'activeRole',ownerrole,'organizationId',org,'legalEntityId',legal);
  if not rate_candidate_worker_visible(ctx,candidate.binding_id) then return false; end if;
 end if;
 return true;
end $$;

create function guard_candidate_owner() returns trigger language plpgsql as $$
declare ctx jsonb; candidate commercial_rate_candidates; prior commercial_candidate_owners; k text; begin
 begin ctx=nullif(current_setting('workos.candidate_owner_context',true),'')::jsonb; exception when others then ctx=null; end;
 if ctx is null or new.id::text is distinct from ctx->>'eventId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.created_at<statement_timestamp() or new.created_at>clock_timestamp() then raise exception 'Use scoped owner command.' using errcode='RCO01'; end if;
 select * into candidate from commercial_rate_candidates where id=new.candidate_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
 if candidate.id is null then raise exception 'Scoped candidate unavailable.' using errcode='RCO03'; end if;
 if not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id where u.id=new.actor_id and u.status='Active' and r.name=new.active_role and s.organization_id=new.organization_id and s.legal_entity_id=new.legal_entity_id and s.active) then raise exception 'Current actor, role and scope required.' using errcode='RCO01'; end if;
 foreach k in array case candidate.kind when 'billing' then array['commercial.contracts.view','commercial.contracts.manage','commercial.rate_candidates.view','commercial.rate_candidates.manage'] else array['commercial.contracts.view','commercial.cost_candidates.view','commercial.cost_candidates.manage','employees.view'] end loop
  if not exists(select 1 from role_permissions where role_name=new.active_role and permission_key=k and enabled) and not exists(select 1 from user_permission_grants where user_id=new.actor_id and permission_key=k) then raise exception 'Current owner administration permission required.' using errcode='RCO01'; end if;
 end loop;
 if candidate.kind='cost' and not rate_candidate_worker_visible(ctx,candidate.binding_id) then raise exception 'Worker is outside current scope.' using errcode='RCO01'; end if;
 if not valid_candidate_owner(new.organization_id,new.legal_entity_id,candidate,new.owner_user_id,new.owner_role) then raise exception 'Owner relationship is unavailable.' using errcode='RCO03'; end if;
 perform pg_advisory_xact_lock(hashtext('candidate-owner:'||new.organization_id||':'||new.legal_entity_id||':'||new.candidate_id::text));
 select * into prior from commercial_candidate_owners where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and candidate_id=new.candidate_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id then raise exception 'Owner version changed.' using errcode='RCO02'; end if;
 return new;
end $$;
create trigger guarded_candidate_owner before insert on commercial_candidate_owners for each row execute function guard_candidate_owner();
create function complete_candidate_owner() returns trigger language plpgsql as $$begin
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Commercial Owner' and a.action='Assign Owner' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('ownerEventId',new.id,'candidateId',new.candidate_id)) then raise exception 'Atomic redacted audit required.' using errcode='RCO04'; end if;
 return null;
end $$;
create constraint trigger complete_candidate_owner after insert on commercial_candidate_owners deferrable initially deferred for each row execute function complete_candidate_owner();
