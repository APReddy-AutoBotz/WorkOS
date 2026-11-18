-- Protected, opt-in candidate evidence only. No role/user grants and no effective financial source.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.rate_candidates.view','Commercial','View billing rate candidates','View scoped, unapproved billing rate candidates and their previews.',false),
 ('commercial.rate_candidates.manage','Commercial','Manage billing rate candidates','Append scoped, unapproved billing rate candidate versions.',false),
 ('commercial.cost_candidates.view','Commercial','View cost rate candidates','View scoped, unapproved confidential cost candidates and their previews.',false),
 ('commercial.cost_candidates.manage','Commercial','Manage cost rate candidates','Append scoped, unapproved confidential cost candidate versions.',false);

create table commercial_rate_candidates (
 id uuid primary key, organization_id text not null, legal_entity_id text not null,
 stream_id uuid not null, sequence integer not null check(sequence>0), previous_id uuid references commercial_rate_candidates(id) on delete restrict,
 kind text not null check(kind in('billing','cost')), binding_type text not null check(binding_type in('contract','engagement','worker')), binding_id text not null,
 contract_ref text generated always as (case when binding_type='contract' then binding_id end) stored,
 engagement_ref text generated always as (case when binding_type='engagement' then binding_id end) stored,
 worker_ref text generated always as (case when binding_type='worker' then binding_id end) stored,
 effective_from date not null, effective_to date not null check(effective_to>=effective_from),
 currency text not null check(currency ~ '^[A-Z]{3}$'), unit text not null check(unit ~ '^[A-Z][A-Z0-9_]{0,39}$'),
 amount numeric(18,4) not null check(amount>=0), priority integer not null check(priority between 0 and 1000000),
 command jsonb not null, request_id uuid not null, actor_id uuid not null references users(id) on delete restrict,
 active_role text not null, reason text not null check(length(btrim(reason)) between 3 and 1000), operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,stream_id,sequence), unique(organization_id,legal_entity_id,actor_id,request_id),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,contract_ref) references commercial_contracts(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,engagement_ref) references commercial_engagements(organization_id,legal_entity_id,id) on delete restrict,
 foreign key(organization_id,legal_entity_id,worker_ref) references employees(organization_id,legal_entity_id,id) on delete restrict,
 check((kind='billing' and binding_type in('contract','engagement')) or (kind='cost' and binding_type='worker'))
);
create index idx_rate_candidate_match on commercial_rate_candidates(organization_id,legal_entity_id,kind,binding_type,binding_id,effective_from,effective_to,priority desc);
create trigger immutable_commercial_rate_candidate before update or delete on commercial_rate_candidates for each row execute function reject_commercial_draft_rewrite();

create function rate_candidate_worker_visible(ctx jsonb,worker text) returns boolean language plpgsql stable as $$
declare u record;e employees;begin
 select u0.id,a.id employee_record_id,a.employee_id,cd.id country_director_id into u from users u0 left join employees a on a.id=u0.employee_record_id left join country_directors cd on cd.id=a.primary_country_director_id and(lower(a.designation)in('country director','regional lead','director')or lower(a.department)='regional leadership') where u0.id::text=ctx->>'actorId' and u0.status='Active';
 if u.id is null or (not exists(select 1 from role_permissions where role_name=ctx->>'activeRole' and permission_key='employees.view' and enabled) and not exists(select 1 from user_permission_grants where user_id=u.id and permission_key='employees.view')) then return false;end if;
 select * into e from employees where id=worker and organization_id=ctx->>'organizationId' and legal_entity_id=ctx->>'legalEntityId' and status<>'Exited';if e.id is null then return false;end if;
 if ctx->>'activeRole'='Employee' then return coalesce(e.id=u.employee_record_id or e.employee_id=u.employee_id,false);
 elsif ctx->>'activeRole'='TeamLead' then return coalesce(e.id=u.employee_record_id or e.employee_id=u.employee_id,false) or exists(with recursive chain as(select id from employees where organization_id=e.organization_id and legal_entity_id=e.legal_entity_id and reporting_manager_id in(u.employee_record_id,u.employee_id) union select x.id from employees x join chain c on x.reporting_manager_id=c.id where x.organization_id=e.organization_id and x.legal_entity_id=e.legal_entity_id)select 1 from chain where id=e.id);
 elsif ctx->>'activeRole'='CountryDirector' then return coalesce(e.primary_country_director_id=u.country_director_id,false) or exists(select 1 from employee_country_director_map where employee_id=e.id and country_director_id=u.country_director_id);
 elsif ctx->>'activeRole'='ProjectManager' then return coalesce(e.id=u.employee_record_id or e.employee_id=u.employee_id,false) or exists(select 1 from project_allocations a join projects p on p.id=a.project_id where a.employee_id=e.id and a.organization_id=e.organization_id and a.legal_entity_id=e.legal_entity_id and p.organization_id=e.organization_id and p.legal_entity_id=e.legal_entity_id and p.manager_id in(u.employee_record_id,u.employee_id));end if;
 return true;
end $$;

-- A transaction-local context cannot manufacture a role, scope, permission or source.
create function guard_commercial_rate_candidate() returns trigger language plpgsql as $$
declare ctx jsonb; k text; prior commercial_rate_candidates; begin
 begin ctx=nullif(current_setting('workos.rate_candidate_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or new.id::text is distinct from ctx->>'eventId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.created_at<statement_timestamp() or new.created_at>clock_timestamp() then raise exception 'Use scoped candidate command.' using errcode='RCC01';end if;
 if not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where u.id=new.actor_id and u.status='Active' and r.name=new.active_role) or not exists(select 1 from user_organization_scopes where user_id=new.actor_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and active) then raise exception 'Current actor, role and scope required.' using errcode='RCC01';end if;
 foreach k in array array['commercial.contracts.view',case new.kind when 'billing' then 'commercial.rate_candidates.view' else 'commercial.cost_candidates.view' end,case new.kind when 'billing' then 'commercial.rate_candidates.manage' else 'commercial.cost_candidates.manage' end] loop
  if not exists(select 1 from role_permissions where role_name=new.active_role and permission_key=k and enabled) and not exists(select 1 from user_permission_grants where user_id=new.actor_id and permission_key=k) then raise exception 'Current explicit candidate permission required.' using errcode='RCC01';end if;
 end loop;
 perform pg_advisory_xact_lock(hashtext('rate-candidate:'||new.organization_id||':'||new.legal_entity_id||':'||new.stream_id::text));
 select * into prior from commercial_rate_candidates where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and stream_id=new.stream_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date or (prior.id is not null and (new.kind,new.binding_type,new.binding_id) is distinct from (prior.kind,prior.binding_type,prior.binding_id)) or (prior.id is not null and new.effective_from<=prior.effective_to) then raise exception 'Candidate version or dates changed.' using errcode='RCC02';end if;
 if new.binding_type='contract' and not exists(select 1 from commercial_contracts where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.binding_id) then raise exception 'Scoped contract unavailable.' using errcode='RCC03';end if;
 if new.binding_type='engagement' and not exists(select 1 from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.binding_id and contract_id is not null) then raise exception 'Scoped commercial engagement unavailable.' using errcode='RCC03';end if;
 if new.binding_type='worker' and rate_candidate_worker_visible(ctx,new.binding_id) is not true then raise exception 'Scoped worker unavailable.' using errcode='RCC03';end if;
 if jsonb_typeof(new.command) is distinct from 'object' or new.command is distinct from jsonb_build_object('requestId',new.request_id,'streamId',new.stream_id,'expectedLatestId',new.previous_id,'kind',new.kind,'bindingType',new.binding_type,'bindingId',new.binding_id,'effectiveFrom',to_char(new.effective_from,'YYYY-MM-DD'),'effectiveTo',to_char(new.effective_to,'YYYY-MM-DD'),'currency',new.currency,'unit',new.unit,'amount',new.command->>'amount','priority',new.priority,'reason',new.reason) or coalesce(new.command->>'amount','') !~ '^(0|[1-9][0-9]{0,13})(\.[0-9]{1,4})?$' or (new.command->>'amount')::numeric is distinct from new.amount then raise exception 'Retain exact candidate command.' using errcode='RCC03';end if;
 return new;
end $$;
create trigger guarded_commercial_rate_candidate before insert on commercial_rate_candidates for each row execute function guard_commercial_rate_candidate();
create function complete_commercial_rate_candidate() returns trigger language plpgsql as $$begin
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Rate Candidate' and a.action='Record Candidate' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('candidateId',new.id,'kind',new.kind)) then raise exception 'Atomic redacted audit required.' using errcode='RCC04';end if;return null;
end $$;
create constraint trigger complete_commercial_rate_candidate after insert on commercial_rate_candidates deferrable initially deferred for each row execute function complete_commercial_rate_candidate();
