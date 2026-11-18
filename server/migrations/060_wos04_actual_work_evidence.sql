-- Empty operational evidence only: no work, approval, profile or buyer defaults.
create table actual_work_evidence(
 id uuid primary key default gen_random_uuid(),organization_id text not null,legal_entity_id text not null,employee_id text not null,
 sequence integer not null check(sequence>0),request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),
 starts_on date not null,ends_on date not null check(ends_on>=starts_on and ends_on-starts_on<366),calculation_version text not null check(calculation_version='actual-work/1'),
 input_canonical text not null,source_token text not null check(source_token~'^[a-f0-9]{64}$'),result jsonb not null,
 artifact_csv text not null,artifact_sha256 text not null check(artifact_sha256~'^[a-f0-9]{64}$'),artifact_bytes integer not null check(artifact_bytes>0),
 actor_id text not null,active_role text not null,source text not null check(source='Web'),reason text not null check(length(btrim(reason))between 1 and 1000),created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id)on delete restrict,
 foreign key(employee_id)references employees(id)on delete restrict,
 unique(organization_id,legal_entity_id,employee_id,sequence),unique(organization_id,legal_entity_id,employee_id,request_id),
 check(result->>'calculationVersion'='actual-work/1'and result->>'employeeId'=employee_id and result->>'sourceToken'=source_token and(result->>'startsOn')::date=starts_on and(result->>'endsOn')::date=ends_on)
);
create trigger immutable_actual_work_evidence before update or delete on actual_work_evidence for each row execute function reject_commercial_draft_rewrite();
create function guard_actual_work_evidence()returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 begin ctx=nullif(current_setting('workos.actual_work_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx->>'actorId'is distinct from new.actor_id or ctx->>'activeRole'is distinct from new.active_role or ctx->>'organizationId'is distinct from new.organization_id or ctx->>'legalEntityId'is distinct from new.legal_entity_id or ctx->>'employeeId'is distinct from new.employee_id or not exists(select 1 from employees e where e.id=new.employee_id and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id)then raise exception 'Use the scoped actual-work evidence command.'using errcode='WAC01';end if;
 if new.source_token<>encode(digest(new.input_canonical,'sha256'),'hex')or new.artifact_sha256<>encode(digest(new.artifact_csv,'sha256'),'hex')or new.artifact_bytes<>octet_length(new.artifact_csv)then raise exception 'Actual-work inputs or artifact hash do not match.'using errcode='WAC02';end if;return new;
end $$;
create trigger guarded_actual_work_evidence before insert on actual_work_evidence for each row execute function guard_actual_work_evidence();
