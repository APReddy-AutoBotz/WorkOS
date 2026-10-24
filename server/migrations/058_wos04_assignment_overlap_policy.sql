-- No buyer values, source conversions, defaults, grants or historical evidence
-- are installed. Only actual later source versions receive policy assessments.
create table assignment_overlap_policy_versions(
 id uuid primary key default gen_random_uuid(), organization_id text not null, legal_entity_id text not null,
 sequence integer not null check(sequence>0), effective_from date not null,
 contract_version text not null check(contract_version='assignment-overlap/1'), definition jsonb not null,
 actor_id text not null, active_role text not null, source text not null check(source='Web'), reason text not null check(length(btrim(reason)) between 1 and 1000),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict,
 unique(organization_id,legal_entity_id,sequence), unique(organization_id,legal_entity_id,effective_from)
);
create trigger immutable_assignment_overlap_policy before update or delete on assignment_overlap_policy_versions for each row execute function reject_commercial_draft_rewrite();
create function valid_assignment_overlap_definition(d jsonb) returns boolean language plpgsql immutable as $$
declare k text;v text;
begin
 if jsonb_typeof(d)<>'object' or (select array_agg(key order by key) from jsonb_object_keys(d)key)is distinct from array['blockingThresholdExact','enabled','includedStatus','quantityUnit','warningThresholdExact']
  or jsonb_typeof(d->'enabled')<>'boolean' or d->>'quantityUnit'<>'percentage' or d->>'includedStatus'<>'Active' then return false;end if;
 foreach k in array array['warningThresholdExact','blockingThresholdExact'] loop
  if d->k='null'::jsonb then continue;end if;v=d->>k;
  if jsonb_typeof(d->k)<>'string' or length(v)>100 or v!~'^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' then return false;end if;
 end loop;
 if not(d->>'enabled')::boolean then return d->'warningThresholdExact'='null'::jsonb and d->'blockingThresholdExact'='null'::jsonb;end if;
 return (d->>'warningThresholdExact' is not null or d->>'blockingThresholdExact' is not null)
  and (d->>'warningThresholdExact' is null or d->>'blockingThresholdExact' is null or (d->>'warningThresholdExact')::numeric<=(d->>'blockingThresholdExact')::numeric);
exception when others then return false;end $$;
alter table assignment_overlap_policy_versions add check(valid_assignment_overlap_definition(definition) is true);

-- A sweep over source endpoints, never every date or all pairwise intersecting
-- records. Latest staged row per source ID replaces that source for previews.
create function assignment_percentage_segments(org text,le text,worker text,from_date date,to_date date,changes jsonb default '[]')
returns table(starts_on date,ends_on date,percentage numeric) language sql volatile as $$
 with overlay as(select distinct on(value->>'id') value from jsonb_array_elements(changes)with ordinality t(value,n) order by value->>'id',n desc),
 sources as(
  select a.start_date s,a.end_date e,a.percentage q from project_allocations a where a.organization_id=org and a.legal_entity_id=le and a.employee_id=worker and a.status='Active'
   and a.start_date<=to_date and a.end_date>=from_date and not exists(select 1 from overlay o where o.value->>'id'=a.id)
  union all select (value->>'startsOn')::date,(value->>'endsOn')::date,(value->>'quantityExact')::numeric from overlay where value->>'employeeId'=worker and value->>'status'='Active'
   and (value->>'startsOn')::date<=to_date and (value->>'endsOn')::date>=from_date),
 events as(select greatest(s,from_date) d,q delta from sources union all select least(e,to_date)+1,-q from sources union all select from_date,0::numeric union all select to_date+1,0::numeric),
 deltas as(select d,sum(delta) delta from events group by d),
 totals as(select d,lead(d)over(order by d)-1 e,sum(delta)over(order by d)q from deltas)
 select d,e,q from totals where e is not null and d<=to_date and e>=from_date order by d;
$$;
create function assignment_overlap_assess(org text,le text,worker text,from_date date,to_date date,changes jsonb default '[]')
returns jsonb language plpgsql volatile as $$
declare checks jsonb;
begin
 if exists(select 1 from assignment_overlap_policy_versions where organization_id=org and legal_entity_id=le and effective_from<=to_date) and (
  exists(select 1 from project_allocations a where a.organization_id=org and a.legal_entity_id=le and a.employee_id=worker and a.status='Active' and a.start_date<=to_date and a.end_date>=from_date and (a.percentage is null or a.percentage<0 or a.percentage::text in('NaN','Infinity','-Infinity')) and not exists(select 1 from jsonb_array_elements(changes)c where c->>'id'=a.id))
  or exists(select 1 from jsonb_array_elements(changes)c where c->>'employeeId'=worker and c->>'status'='Active' and ((c->>'quantityExact') is null or (c->>'quantityExact')::numeric<0 or (c->>'quantityExact')::numeric::text in('NaN','Infinity','-Infinity')))) then
  raise exception 'Native percentage authority is unavailable.' using errcode='ALP02';end if;
 with policies as(select p.*,lead(effective_from)over(order by effective_from)-1 until_date from assignment_overlap_policy_versions p where organization_id=org and legal_entity_id=le),
 segments as(select * from assignment_percentage_segments(org,le,worker,from_date,to_date,changes)),
 peaks as(select p.id,p.sequence,p.effective_from,p.definition,greatest(from_date,p.effective_from)s,least(to_date,coalesce(p.until_date,to_date))e,max(g.percentage)peak
  from policies p join segments g on g.starts_on<=coalesce(p.until_date,to_date) and g.ends_on>=p.effective_from where p.effective_from<=to_date and coalesce(p.until_date,to_date)>=from_date
  group by p.id,p.sequence,p.effective_from,p.definition,p.until_date)
 select coalesce(jsonb_agg(jsonb_build_object('policyId',id,'sequence',sequence,'effectiveFrom',to_char(effective_from,'YYYY-MM-DD'),'startsOn',to_char(s,'YYYY-MM-DD'),'endsOn',to_char(e,'YYYY-MM-DD'),
  'enabled',(definition->>'enabled')::boolean,'warningThresholdExact',definition->'warningThresholdExact','blockingThresholdExact',definition->'blockingThresholdExact','peakPercentageExact',trim_scale(peak)::text,
  'warningExceeded',(definition->>'enabled')::boolean and (definition->>'warningThresholdExact') is not null and peak>(definition->>'warningThresholdExact')::numeric,
  'blockingExceeded',(definition->>'enabled')::boolean and (definition->>'blockingThresholdExact') is not null and peak>(definition->>'blockingThresholdExact')::numeric)order by sequence),'[]'::jsonb) into checks from peaks;
 return jsonb_build_object('contractVersion','assignment-overlap/1','employeeId',worker,'startsOn',to_char(from_date,'YYYY-MM-DD'),'endsOn',to_char(to_date,'YYYY-MM-DD'),'quantityUnit','percentage','includedStatus','Active','policyState',case when jsonb_array_length(checks)=0 then 'unconfigured' else 'assessed' end,'checks',checks);
end $$;
create function guard_assignment_overlap_policy() returns trigger language plpgsql as $$
declare previous assignment_overlap_policy_versions;ctx jsonb;w record;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 begin ctx=nullif(current_setting('workos.assignment_overlap_policy_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx->>'actorId' is distinct from new.actor_id or ctx->>'activeRole' is distinct from new.active_role or ctx->>'organizationId' is distinct from new.organization_id or ctx->>'legalEntityId' is distinct from new.legal_entity_id then
  raise exception 'Use the scoped assignment policy command.' using errcode='ALP02';end if;
 select * into previous from assignment_overlap_policy_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(previous.sequence,0)+1 or new.effective_from<(clock_timestamp()at time zone'UTC')::date or previous.id is not null and new.effective_from<=previous.effective_from then
  raise exception 'Assignment policy source changed or adoption is not prospective.' using errcode='ALP04';end if;
 if coalesce(previous.sequence,0)>=1000 or not valid_assignment_overlap_definition(new.definition) then raise exception 'Invalid native assignment policy definition.' using errcode='ALP02';end if;
 if (new.definition->>'enabled')::boolean and new.definition->>'blockingThresholdExact' is not null then
  for w in select employee_id,max(end_date)e from project_allocations where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and status='Active' and end_date>=new.effective_from group by employee_id loop
   if exists(select 1 from project_allocations where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and employee_id=w.employee_id and status='Active' and end_date>=new.effective_from and (percentage is null or percentage<0 or percentage::text in('NaN','Infinity','-Infinity')))
    or exists(select 1 from assignment_percentage_segments(new.organization_id,new.legal_entity_id,w.employee_id,new.effective_from,w.e) where percentage>(new.definition->>'blockingThresholdExact')::numeric) then
    raise exception 'Policy would block existing future assignments. Remediate sources or choose a compatible explicit threshold.' using errcode='ALP03';end if;
  end loop;
 end if;return new;
end $$;
create trigger guarded_assignment_overlap_policy before insert on assignment_overlap_policy_versions for each row execute function guard_assignment_overlap_policy();

create function enforce_assignment_overlap_source() returns trigger language plpgsql as $$
declare a project_allocations;k text;change jsonb;result jsonb;
begin
 if tg_op<>'INSERT' then a=old;end if;
 for k in select distinct v.key from(values(case when tg_op<>'INSERT' then 'commercial-lifecycle:'||old.organization_id||':'||old.legal_entity_id end),(case when tg_op<>'DELETE' then 'commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id end))v(key)where key is not null order by 1 loop perform pg_advisory_xact_lock(hashtextextended(k,0));end loop;
 if tg_op='DELETE' then change=jsonb_build_object('id',old.id,'employeeId',old.employee_id,'quantityExact','0','startsOn',old.start_date,'endsOn',old.end_date,'status','Completed');
 else a=new;change=jsonb_build_object('id',new.id,'employeeId',new.employee_id,'quantityExact',new.percentage::text,'startsOn',new.start_date,'endsOn',new.end_date,'status',new.status);end if;
 result=assignment_overlap_assess(a.organization_id,a.legal_entity_id,a.employee_id,a.start_date,a.end_date,jsonb_build_array(change));
 if exists(select 1 from jsonb_array_elements(result->'checks')c where(c->>'blockingExceeded')::boolean) then raise exception 'Declared simultaneous assignment percentages exceed the adopted blocking threshold.' using errcode='ALP01';end if;
 return a;
end $$;
create trigger assignment_overlap_source_guard before insert or update or delete on project_allocations for each row execute function enforce_assignment_overlap_source();
create table assignment_overlap_evidence(
 assignment_version_id uuid primary key references assignment_versions(id)on delete restrict,
 organization_id text not null,legal_entity_id text not null,decision jsonb not null check(jsonb_typeof(decision)='object' and decision->>'contractVersion'='assignment-overlap/1'),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id)on delete restrict
);
create trigger immutable_assignment_overlap_evidence before update or delete on assignment_overlap_evidence for each row execute function reject_commercial_draft_rewrite();
create function guard_assignment_overlap_evidence_origin()returns trigger language plpgsql as $$
begin
 if pg_trigger_depth()<2 or not exists(select 1 from assignment_versions v where v.id=new.assignment_version_id and v.organization_id=new.organization_id and v.legal_entity_id=new.legal_entity_id and v.change_kind<>'ObservedBaseline')then raise exception 'Assignment policy evidence is source managed.' using errcode='ALP02';end if;return new;
end $$;
create trigger guarded_assignment_overlap_evidence before insert on assignment_overlap_evidence for each row execute function guard_assignment_overlap_evidence_origin();
create function retain_assignment_overlap_source()returns trigger language plpgsql as $$
declare a project_allocations;v uuid;result jsonb;
begin
 a=case when tg_op='DELETE' then old else new end;
 select id into v from assignment_versions where assignment_id=a.id and organization_id=a.organization_id and legal_entity_id=a.legal_entity_id and source_revision=resource_assignment_revision(a) order by sequence desc limit 1;
 if v is null then raise exception 'Tracked assignment version is unavailable.' using errcode='ALP02';end if;
 result=assignment_overlap_assess(a.organization_id,a.legal_entity_id,a.employee_id,a.start_date,a.end_date);
 insert into assignment_overlap_evidence values(v,a.organization_id,a.legal_entity_id,result);return a;
end $$;
-- AFTER triggers run by name: source-managed versions precede their evidence.
create trigger zz_retained_assignment_overlap after insert or update or delete on project_allocations for each row execute function retain_assignment_overlap_source();
alter table import_export_logs add column assignment_policy_warnings jsonb check(assignment_policy_warnings is null or jsonb_typeof(assignment_policy_warnings)='array');
