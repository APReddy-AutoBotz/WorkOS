-- Explicit planning facts, not quantity conversion, reservation or approval.
create function valid_resource_demand(value jsonb) returns boolean language plpgsql immutable as $$
declare c jsonb;
begin
 if jsonb_typeof(value) is distinct from 'object' or value-array['title','role','startsOn','endsOn','quantityUnit','quantityExact','status','criteria','note']<>'{}'::jsonb
   or not(value ?& array['title','role','startsOn','endsOn','quantityUnit','quantityExact','status','criteria','note']) then return false; end if;
 if jsonb_typeof(value->'title') is distinct from 'string' or not valid_capability_label(value->>'title')
   or jsonb_typeof(value->'role') is distinct from 'string' or not valid_capability_label(value->>'role')
   or jsonb_typeof(value->'startsOn') is distinct from 'string' or not valid_capability_date(value->>'startsOn')
   or jsonb_typeof(value->'endsOn') is distinct from 'string' or not valid_capability_date(value->>'endsOn') or value->>'endsOn'<value->>'startsOn'
   or value->>'quantityUnit' not in ('percentage','hours') or jsonb_typeof(value->'quantityUnit') is distinct from 'string'
   or value->>'status' not in ('Open','Closed','Cancelled') or jsonb_typeof(value->'status') is distinct from 'string'
   or jsonb_typeof(value->'quantityExact') is distinct from 'string' or char_length(value->>'quantityExact')>100
   or value->>'quantityExact' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' or (value->>'quantityExact')::numeric<=0 then return false; end if;
 c=value->'criteria';
 if jsonb_typeof(c) is distinct from 'object' or c-array['skill','proficiency','certification']<>'{}'::jsonb or not(c ?& array['skill','proficiency','certification']) then return false; end if;
 if exists(select 1 from jsonb_each(c) i where i.value<>'null'::jsonb and (jsonb_typeof(i.value) is distinct from 'string' or not valid_capability_label(i.value#>>'{}'))) then return false; end if;
 if c->'skill'='null'::jsonb and c->'proficiency'<>'null'::jsonb then return false; end if;
 if value->'note'<>'null'::jsonb and (jsonb_typeof(value->'note') is distinct from 'string' or char_length(value->>'note') not between 1 and 3000
   or value->>'note' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]'
   or value->>'note' ~ '^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]|[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]$') then return false; end if;
 return true;
exception when others then return false;
end $$;
create function resource_capability_matches(profile jsonb,definition jsonb) returns boolean language sql immutable as $$
 select coalesce((definition->'criteria'->'skill'='null'::jsonb or exists(select 1 from jsonb_array_elements(profile->'skills')i
  where (i->>'skill') collate "C"=(definition->'criteria'->>'skill') collate "C"
   and (definition->'criteria'->'proficiency'='null'::jsonb or (i->>'proficiency') collate "C"=(definition->'criteria'->>'proficiency') collate "C")))
 and (definition->'criteria'->'certification'='null'::jsonb or exists(select 1 from jsonb_array_elements(profile->'certifications')i
  where (i->>'certification') collate "C"=(definition->'criteria'->>'certification') collate "C"
  and i->>'validFrom'<=definition->>'startsOn' and (i->'noExpiry'='true'::jsonb or i->>'validThrough'>=definition->>'endsOn'))),false);
$$;
create function resource_assignment_revision(a project_allocations) returns text language sql stable as $$
 select encode(digest(convert_to(((to_jsonb(a)-array['start_date','end_date','created_at','updated_at']) || jsonb_build_object(
 'start_date',to_char(a.start_date,'YYYY-MM-DD'),'end_date',to_char(a.end_date,'YYYY-MM-DD'),
 'created_at',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'updated_at',to_char(a.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text,'UTF8'),'sha256'),'hex');
$$;
create function resource_assignment_snapshot(a project_allocations) returns jsonb language sql stable as $$
 select jsonb_build_object('assignmentId',a.id,'employeeId',a.employee_id,'projectId',a.project_id,'role',a.role_on_project,
 'percentageExact',trim_scale(a.percentage)::text,'startsOn',to_char(a.start_date,'YYYY-MM-DD'),'endsOn',to_char(a.end_date,'YYYY-MM-DD'),
 'billable',a.billable,'status',a.status,'comment',a.comments);
$$;
create table resource_demands(
 id uuid primary key, organization_id text not null,legal_entity_id text not null,project_id text not null,
 actor_id text not null,created_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,project_id) references projects(organization_id,legal_entity_id,id) on delete restrict,
 unique(organization_id,legal_entity_id,id)
);
create table resource_demand_versions(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,demand_id uuid not null,
 sequence integer not null check(sequence>0),contract_version text not null check(contract_version='resource-demand/1'),
 definition jsonb not null check(valid_resource_demand(definition)),links jsonb not null check(jsonb_typeof(links)='array' and jsonb_array_length(links)<=20),
 actor_id text not null,active_role text not null,source text not null check(source='Web'),reason text not null check(char_length(btrim(reason)) between 1 and 1000),created_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,demand_id) references resource_demands(organization_id,legal_entity_id,id) on delete restrict,
 unique(organization_id,legal_entity_id,demand_id,sequence)
);
create trigger immutable_resource_demand before update or delete on resource_demands for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_resource_demand_version before update or delete on resource_demand_versions for each row execute function reject_commercial_draft_rewrite();
create function guard_resource_demand_version() returns trigger language plpgsql as $$
declare root resource_demands; item jsonb;a project_allocations;cap workforce_capability_versions;seq integer;
begin
 if not valid_resource_demand(new.definition) or jsonb_typeof(new.links) is distinct from 'array' or jsonb_array_length(new.links)>20 then raise exception 'Invalid demand definition or links.' using errcode='RDM02'; end if;
 select * into strict root from resource_demands where id=new.demand_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id for update;
 select coalesce(max(sequence),0)+1 into seq from resource_demand_versions where demand_id=new.demand_id;
 if new.sequence<>seq then raise exception 'Demand version is stale.' using errcode='RDM01'; end if;
 if (select count(*)<>count(distinct (i->>'assignmentId') collate "C") from jsonb_array_elements(new.links)i) then raise exception 'Duplicate assignment reference.' using errcode='RDM02'; end if;
 for item in select * from jsonb_array_elements(new.links) loop
  if jsonb_typeof(item) is distinct from 'object' or item-array['assignmentId','revision','assignmentSnapshot','capabilityVersionId','capabilityProfile']<>'{}'::jsonb
   or not(item ?& array['assignmentId','revision','assignmentSnapshot','capabilityVersionId','capabilityProfile'])
   or jsonb_typeof(item->'assignmentId') is distinct from 'string' or jsonb_typeof(item->'revision') is distinct from 'string'
   or item->>'revision' !~ '^[a-f0-9]{64}$' or jsonb_typeof(item->'assignmentSnapshot') is distinct from 'object' then raise exception 'Invalid demand link.' using errcode='RDM02'; end if;
  select * into a from project_allocations where id=item->>'assignmentId' and organization_id=root.organization_id and legal_entity_id=root.legal_entity_id and project_id=root.project_id for share;
  if not found or resource_assignment_revision(a) is distinct from item->>'revision' or resource_assignment_snapshot(a) is distinct from item->'assignmentSnapshot'
    or a.status<>'Active' or a.role_on_project collate "C" is distinct from (new.definition->>'role') collate "C" or a.start_date>(new.definition->>'endsOn')::date or a.end_date<(new.definition->>'startsOn')::date then raise exception 'Demand assignment reference changed or is invalid.' using errcode='RDM02'; end if;
  perform 1 from employees where id=a.employee_id and organization_id=root.organization_id and legal_entity_id=root.legal_entity_id for share;
  select * into cap from workforce_capability_versions where employee_id=a.employee_id and organization_id=root.organization_id and legal_entity_id=root.legal_entity_id order by sequence desc limit 1;
  if to_jsonb(cap.id) is distinct from nullif(item->'capabilityVersionId','null'::jsonb) or cap.profile is distinct from nullif(item->'capabilityProfile','null'::jsonb)
    or not resource_capability_matches(cap.profile,new.definition) then raise exception 'Demand capability reference changed or does not match.' using errcode='RDM02'; end if;
 end loop;
 return new;
end $$;
create trigger guarded_resource_demand_version before insert on resource_demand_versions for each row execute function guard_resource_demand_version();
