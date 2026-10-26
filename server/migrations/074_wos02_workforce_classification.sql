-- Empty explicit classifications; no native employee rewrite, adoption or grants.
create function workforce_classification_worker(e employees)returns jsonb language sql stable as $$
 select jsonb_build_object('employeeId',e.id,'code',e.employee_id,'name',e.name,'status',e.status,'department',e.department,'country',e.country,'region',e.region,'businessUnit',e.business_unit,'reportingManagerId',e.reporting_manager_id);
$$;
create function workforce_classification_source(item text,kind text,org text,leg text,as_of date)returns jsonb language sql stable as $$
 select jsonb_build_object('itemId',i.id,'type',i.catalog_type,'code',i.code,'name',i.name,'ownerLegalEntityId',i.legal_entity_id,'effectiveFrom',to_char(i.effective_from,'YYYY-MM-DD'),'effectiveTo',to_char(i.effective_to,'YYYY-MM-DD'))
 from organization_catalog_items i where i.id=item and i.catalog_type=kind and i.organization_id=org and i.legal_entity_id=leg and i.active and as_of between i.effective_from and coalesce(i.effective_to,'infinity'::date);
$$;
create table workforce_classification_events(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,employee_id text not null references employees(id),sequence integer not null check(sequence>0),previous_event_id uuid references workforce_classification_events(id),
 effective_from date not null,definition jsonb not null,sources jsonb not null,worker_snapshot jsonb not null,worker_token text not null,
 request_id uuid not null,command jsonb not null,request_fingerprint text not null check(request_fingerprint=encode(digest(command::text,'sha256'),'hex')),
 actor_id uuid not null references users(id),active_role text not null,source text not null check(source='Web'),reason text not null check(length(reason)between 1 and 1000 and btrim(reason)=reason and reason!~'[\x01-\x1f\x7f-\x9f]'),operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(employee_id,sequence),unique(employee_id,effective_from),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table workforce_classification_references(event_id uuid not null references workforce_classification_events(id),catalog_type text not null,item_id text not null references organization_catalog_items(id),primary key(event_id,catalog_type));
create index workforce_classification_current on workforce_classification_events(organization_id,legal_entity_id,employee_id,effective_from desc);
create index workforce_classification_retained_reference on workforce_classification_references(item_id);
create function workforce_classification_event_json(e workforce_classification_events)returns jsonb language sql stable as $$
 select jsonb_build_object('eventId',e.id,'employeeId',e.employee_id,'sequence',e.sequence,'previousEventId',e.previous_event_id,'effectiveFrom',to_char(e.effective_from,'YYYY-MM-DD'),'definition',e.definition,'sources',e.sources,'workerSnapshot',e.worker_snapshot,'workerToken',e.worker_token,'requestId',e.request_id,'requestFingerprint',e.request_fingerprint,'actorUserId',e.actor_id,'activeRole',e.active_role,'source',e.source,'reason',e.reason,'createdAt',to_char(e.created_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
create function workforce_classification_actor(ctx jsonb,worker text)returns boolean language plpgsql stable as $$
declare u record;e employees;k text;begin
 select u0.*,cd.id country_director_id into u from users u0 left join employees a on a.id=u0.employee_record_id left join country_directors cd on cd.id=a.primary_country_director_id and(lower(a.designation)in('country director','regional lead','director')or lower(a.department)='regional leadership')where u0.id::text=ctx->>'actorId'and u0.status='Active';
 if u.id is null or not exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id and r.name=ctx->>'activeRole')or not exists(select 1 from user_organization_scopes where user_id=u.id and organization_id=ctx->>'organizationId'and legal_entity_id=ctx->>'legalEntityId'and active)then return false;end if;
 foreach k in array array['employees.view','employees.manage']loop if not exists(select 1 from role_permissions where role_name=ctx->>'activeRole'and permission_key=k and enabled)and not exists(select 1 from user_permission_grants where user_id=u.id and permission_key=k)then return false;end if;end loop;
 select * into e from employees where id=worker and organization_id=ctx->>'organizationId'and legal_entity_id=ctx->>'legalEntityId';if e.id is null or e.status='Exited'then return false;end if;
 if ctx->>'activeRole'='Employee'then return e.id=u.employee_record_id or e.employee_id=u.employee_id;
 elsif ctx->>'activeRole'='TeamLead'then return e.id=u.employee_record_id or e.employee_id=u.employee_id or exists(with recursive chain as(select id from employees where reporting_manager_id in(u.employee_record_id,u.employee_id)union select x.id from employees x join chain c on x.reporting_manager_id=c.id)select 1 from chain where id=e.id);
 elsif ctx->>'activeRole'='CountryDirector'then return e.primary_country_director_id=u.country_director_id or exists(select 1 from employee_country_director_map where employee_id=e.id and country_director_id=u.country_director_id);
 elsif ctx->>'activeRole'='ProjectManager'then return e.id=u.employee_record_id or e.employee_id=u.employee_id or exists(select 1 from project_allocations a join projects p on p.id=a.project_id where a.employee_id=e.id and p.manager_id in(u.employee_record_id,u.employee_id));end if;
 return true;
end $$;
create function guard_workforce_classification()returns trigger language plpgsql as $$
declare ctx jsonb;prior workforce_classification_events;e employees;s jsonb;v jsonb;k text;begin
 begin ctx=nullif(current_setting('workos.workforce_classification_context',true),'')::jsonb;exception when others then ctx=null;end;
 if not coalesce(workforce_classification_actor(ctx,new.employee_id),false)or new.id::text is distinct from ctx->>'eventId'or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.operation_id is distinct from ctx->>'operationId'or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Use current scoped workforce classification authority.'using errcode='WCG01';end if;
 select * into e from employees where id=new.employee_id for update;
 select * into prior from workforce_classification_events where employee_id=new.employee_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_event_id is distinct from prior.id or new.effective_from<(clock_timestamp()at time zone'UTC')::date or(prior.id is not null and new.effective_from<=prior.effective_from)then raise exception 'Append the current prospective classification source.'using errcode='WCG02';end if;
 if new.worker_snapshot is distinct from workforce_classification_worker(e)or new.worker_token is distinct from encode(digest(new.worker_snapshot::text,'sha256'),'hex')then raise exception 'Current worker observation changed.'using errcode='WCG02';end if;
 if jsonb_typeof(new.definition)is distinct from'object'or not(new.definition?&array['business_unit','department','cost_centre','practice','location','region'])or new.definition-array['business_unit','department','cost_centre','practice','location','region']<>'{}'::jsonb then raise exception 'Provide the complete explicit six-family selection.'using errcode='WCG03';end if;
 s='{}'::jsonb;
 for k,v in select * from jsonb_each(new.definition)loop
  if v='null'::jsonb then s=s||jsonb_build_object(k,null);continue;end if;
  if jsonb_typeof(v)is distinct from'object'or not(v?&array['itemId','token'])or v-array['itemId','token']<>'{}'::jsonb or jsonb_typeof(v->'itemId')is distinct from'string'or jsonb_typeof(v->'token')is distinct from'string'then raise exception 'Use an exact inspected source or explicit null.'using errcode='WCG03';end if;
  perform 1 from organization_catalog_items where id=v->>'itemId'for share;
  ctx=workforce_classification_source(v->>'itemId',k,new.organization_id,new.legal_entity_id,new.effective_from);
  if ctx is null or v->>'token'is distinct from encode(digest(ctx::text,'sha256'),'hex')then raise exception 'Exact catalog source is unavailable or changed.'using errcode='WCG03';end if;
  s=s||jsonb_build_object(k,ctx);
 end loop;
 if new.sources is distinct from s or new.command is distinct from jsonb_build_object('requestId',new.request_id,'employeeId',new.employee_id,'expectedLatestId',new.previous_event_id,'expectedWorkerToken',new.worker_token,'effectiveFrom',to_char(new.effective_from,'YYYY-MM-DD'),'definition',new.definition,'reason',new.reason)then raise exception 'Retain the exact command and sources.'using errcode='WCG03';end if;
 return new;
end $$;
create trigger guarded_workforce_classification before insert on workforce_classification_events for each row execute function guard_workforce_classification();
create trigger immutable_workforce_classification before update or delete on workforce_classification_events for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_workforce_classification_reference before update or delete on workforce_classification_references for each row execute function reject_commercial_draft_rewrite();
create function guard_workforce_classification_reference()returns trigger language plpgsql as $$declare e workforce_classification_events;s jsonb;begin
 select * into e from workforce_classification_events where id=new.event_id;
 if not exists(select 1 from workforce_classification_events where id=new.event_id and xmin::text=pg_current_xact_id()::text)then raise exception 'Retain classification references in the originating transaction.'using errcode='WCG04';end if;
 perform 1 from organization_catalog_items where id=new.item_id for share;
 s=workforce_classification_source(new.item_id,new.catalog_type,e.organization_id,e.legal_entity_id,e.effective_from);
 if s is null or e.sources->new.catalog_type is distinct from s then raise exception 'Retain the exact scoped classification reference.'using errcode='WCG04';end if;return new;
end $$;
create trigger guarded_workforce_classification_reference before insert on workforce_classification_references for each row execute function guard_workforce_classification_reference();
create function complete_workforce_classification()returns trigger language plpgsql as $$declare prior workforce_classification_events;begin
 select * into prior from workforce_classification_events where id=new.previous_event_id;
 if(select count(*)from workforce_classification_references where event_id=new.id)<>(select count(*)from jsonb_each(new.definition)where value<>'null'::jsonb)or exists(select 1 from jsonb_each(new.definition)d where d.value<>'null'::jsonb and not exists(select 1 from workforce_classification_references where event_id=new.id and catalog_type=d.key and item_id=d.value->>'itemId'))then raise exception 'Complete exact classification references required.'using errcode='WCG04';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.source='Web'and a.module='Workforce Classification'and a.action='Record Worker Classification'and a.entity_type='WorkforceClassificationEvent'and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.reason=new.reason and a.new_value=workforce_classification_event_json(new)and a.old_value is not distinct from(case when prior.id is null then null else workforce_classification_event_json(prior)end))then raise exception 'Atomic exact classification audit required.'using errcode='WCG04';end if;return null;
end $$;
create constraint trigger complete_workforce_classification after insert on workforce_classification_events deferrable initially deferred for each row execute function complete_workforce_classification();
create or replace function business_structure_dependencies(org text,item text)returns jsonb language sql stable as $$
 select jsonb_build_object('catalogChildren',(select count(*)from organization_catalog_items where organization_id=org and parent_id=item),'workingCalendars',(select count(*)from working_calendars where organization_id=org and worker_group_id=item),'capacityVersions',(select count(*)from worker_capacity_versions where organization_id=org and worker_group_id=item),'commercialEngagements',(select count(*)from commercial_engagements where organization_id=org and attribution_id=item),'commercialBindings',(select count(*)from commercial_project_bindings where organization_id=org and attribution_id=item),'workforceClassifications',(select count(*)from workforce_classification_references r join workforce_classification_events e on e.id=r.event_id where e.organization_id=org and r.item_id=item));
$$;
