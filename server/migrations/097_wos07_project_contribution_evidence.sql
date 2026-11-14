-- Additive, empty operational report evidence. No source history or grants change.
create table project_contribution_evidence (
 id uuid primary key,
 organization_id text not null,
 legal_entity_id text not null,
 project_id text not null references projects(id) on delete restrict,
 actor_id uuid not null references users(id) on delete restrict,
 active_role text not null,
 request_id uuid not null,
 request_fingerprint text not null check(request_fingerprint ~ '^[a-f0-9]{64}$'),
 starts_on date not null,
 ends_on date not null check(ends_on >= starts_on and ends_on-starts_on < 366),
 calculation_version text not null check(calculation_version='project-contribution/1'),
 input_canonical text not null,
 source_token text not null check(source_token ~ '^[a-f0-9]{64}$'),
 result jsonb not null,
 worker_ids text[] not null check(cardinality(worker_ids)<=500),
 artifact_csv text not null,
 artifact_sha256 text not null check(artifact_sha256 ~ '^[a-f0-9]{64}$'),
 artifact_bytes integer not null check(artifact_bytes>0),
 source text not null check(source='Web'),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict,
 unique(organization_id,legal_entity_id,project_id,actor_id,active_role,request_id)
);
create index project_contribution_evidence_period on project_contribution_evidence
 (organization_id,legal_entity_id,project_id,starts_on,ends_on,created_at desc,id);
create trigger immutable_project_contribution_evidence before update or delete on project_contribution_evidence
 for each row execute function reject_commercial_draft_rewrite();

create function guard_project_contribution_evidence() returns trigger language plpgsql as $$
declare ctx jsonb; ids text[]; permission text;
begin
 begin ctx=nullif(current_setting('workos.project_contribution_context',true),'')::jsonb;
 exception when others then ctx=null; end;
 if ctx is null or ctx->>'actorId' is distinct from new.actor_id::text
   or ctx->>'activeRole' is distinct from new.active_role or ctx->>'recordId' is distinct from new.id::text
   or ctx->>'organizationId' is distinct from new.organization_id or ctx->>'legalEntityId' is distinct from new.legal_entity_id
   or not exists(select 1 from projects p where p.id=new.project_id and p.organization_id=new.organization_id and p.legal_entity_id=new.legal_entity_id)
 then raise exception 'Use the scoped project contribution command.' using errcode='PCE01'; end if;
 foreach permission in array array['projects.view','employees.view','reports.view_utilization','reports.export'] loop
   if not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
     join user_organization_scopes s on s.user_id=u.id where u.id=new.actor_id and u.status='Active'
     and r.name=new.active_role and s.organization_id=new.organization_id and s.legal_entity_id=new.legal_entity_id and s.active)
     or not (exists(select 1 from role_permissions rp where rp.role_name=new.active_role and rp.permission_key=permission and rp.enabled)
       or exists(select 1 from user_permission_grants g where g.user_id=new.actor_id and g.permission_key=permission))
   then raise exception 'Current export authority is required.' using errcode='PCE01'; end if;
 end loop;
 if new.result->>'calculationVersion' is distinct from new.calculation_version
   or new.result->>'projectId' is distinct from new.project_id
   or new.result->>'startsOn' is distinct from new.starts_on::text or new.result->>'endsOn' is distinct from new.ends_on::text
   or new.result->>'sourceToken' is distinct from new.source_token
   or new.source_token<>encode(digest(new.input_canonical,'sha256'),'hex')
   or new.artifact_sha256<>encode(digest(new.artifact_csv,'sha256'),'hex')
   or new.artifact_bytes<>octet_length(new.artifact_csv)
 then raise exception 'Project contribution evidence does not match its source or artifact.' using errcode='PCE02'; end if;
 if jsonb_typeof(new.result->'rows')='array' then
   select coalesce(array_agg(x->>'employeeId' order by n),array[]::text[]) into ids
     from jsonb_array_elements(new.result->'rows') with ordinality as rows(x,n);
 elsif new.result->'rows'='null'::jsonb and new.result->>'status'='unavailable' then ids=array[]::text[];
 else raise exception 'Invalid retained cohort.' using errcode='PCE02'; end if;
 if ids is distinct from new.worker_ids or cardinality(ids)<>(select count(distinct x) from unnest(ids) x)
   or exists(select 1 from unnest(ids) x where not exists(select 1 from employees e where e.id=x
     and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id))
 then raise exception 'Invalid retained cohort ownership.' using errcode='PCE02'; end if;
 return new;
end $$;
create trigger guarded_project_contribution_evidence before insert on project_contribution_evidence
 for each row execute function guard_project_contribution_evidence();
