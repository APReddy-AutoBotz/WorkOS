-- Future source mutations only; never reconstruct historical authors or policy.
create function assignment_version_snapshot(a project_allocations) returns jsonb language sql stable as $$
 select (resource_assignment_snapshot(a)-'percentageExact')||jsonb_build_object('quantityUnit','percentage','quantityExact',trim_scale(a.percentage)::text);
$$;
create function assignment_binding_observation(a project_allocations) returns jsonb language sql stable as $$
 select coalesce((select jsonb_build_object('status','observed_binding','bindingId',b.id,'model',b.model,'engagementId',b.engagement_id,'contractId',b.contract_id,'contractVersionId',b.contract_version_id)
  from commercial_project_bindings b where b.project_id=a.project_id and b.organization_id=a.organization_id and b.legal_entity_id=a.legal_entity_id),jsonb_build_object('status','not_recorded'));
$$;
create table assignment_versions(
 id uuid primary key default gen_random_uuid(),organization_id text not null,legal_entity_id text not null,assignment_id text not null,
 sequence integer not null check(sequence>0),contract_version text not null check(contract_version='assignment-version/1'),
 change_kind text not null check(change_kind in('Created','Updated','Ended','Deleted','ObservedBaseline')),
 source_revision text not null check(source_revision~'^[a-f0-9]{64}$'),snapshot jsonb not null check(jsonb_typeof(snapshot)='object' and snapshot->>'assignmentId'=assignment_id and snapshot->>'quantityUnit'='percentage'),
 binding_observation jsonb not null check(jsonb_typeof(binding_observation)='object'),
 actor_id text not null,active_role text,source text not null check(source in('Web','Allocation Control CSV','Database')),reason text,
 import_batch_id uuid,source_identifier text,recorded_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict,
 unique(assignment_id,sequence)
);
create index assignment_versions_scope_history on assignment_versions(organization_id,legal_entity_id,assignment_id,sequence desc);
create trigger immutable_assignment_versions before update or delete on assignment_versions for each row execute function reject_commercial_draft_rewrite();
create function guard_assignment_version_origin() returns trigger language plpgsql as $$
begin
 if pg_trigger_depth()<2 then raise exception 'Assignment versions are source managed.' using errcode='ASV01';end if;
 return new;
end $$;
create trigger guarded_assignment_version_origin before insert on assignment_versions for each row execute function guard_assignment_version_origin();
create function capture_assignment_source_version() returns trigger language plpgsql as $$
declare a project_allocations;ctx jsonb;seq integer;actor text;role text;origin text;kind text;binding jsonb;
begin
 a=case when tg_op='DELETE' then old else new end;
 begin ctx=nullif(current_setting('workos.assignment_version_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx->>'employeeId' is distinct from a.employee_id or ctx->>'projectId' is distinct from a.project_id or ctx->>'organizationId' is distinct from a.organization_id or ctx->>'legalEntityId' is distinct from a.legal_entity_id
  or nullif(ctx->>'actorId','') is null or nullif(ctx->>'activeRole','') is null or coalesce(ctx->>'source','') not in('Web','Allocation Control CSV') then ctx=null;end if;
 actor=coalesce(ctx->>'actorId',session_user);role=ctx->>'activeRole';origin=coalesce(ctx->>'source','Database');
 select coalesce(max(sequence),0) into seq from assignment_versions where assignment_id=a.id;
 if seq=0 and tg_op<>'INSERT' then
  insert into assignment_versions(organization_id,legal_entity_id,assignment_id,sequence,contract_version,change_kind,source_revision,snapshot,binding_observation,actor_id,active_role,source,reason,import_batch_id,source_identifier)
   values(old.organization_id,old.legal_entity_id,old.id,1,'assignment-version/1','ObservedBaseline',resource_assignment_revision(old),assignment_version_snapshot(old),'{"status":"not_recorded"}',actor,role,origin,'Observed before first tracked change; original author and treatment history are not recorded.',(ctx->>'importBatchId')::uuid,ctx->>'sourceIdentifier');seq=1;
 end if;
 kind=case when tg_op='INSERT' then 'Created' when tg_op='DELETE' then 'Deleted' when ctx->>'operation'='End' then 'Ended' else 'Updated' end;
 binding=assignment_binding_observation(a);
 insert into assignment_versions(organization_id,legal_entity_id,assignment_id,sequence,contract_version,change_kind,source_revision,snapshot,binding_observation,actor_id,active_role,source,reason,import_batch_id,source_identifier)
  values(a.organization_id,a.legal_entity_id,a.id,seq+1,'assignment-version/1',kind,resource_assignment_revision(a),assignment_version_snapshot(a),binding,actor,role,origin,ctx->>'reason',(ctx->>'importBatchId')::uuid,ctx->>'sourceIdentifier');
 return a;
end $$;
create trigger tracked_assignment_source after insert or update or delete on project_allocations for each row execute function capture_assignment_source_version();
