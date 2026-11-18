-- Explicit buyer adoption only; no catalog values, classification backfill or grants.
create function valid_work_category_definition(d jsonb)returns boolean language plpgsql immutable as $$
declare c text;last_context text;context_count integer;
begin
 if d is null or jsonb_typeof(d)<>'object' or (select array_agg(key order by key)from jsonb_object_keys(d)key)is distinct from array['active','billability','code','contexts','includeInUtilization','kind','label']
  or jsonb_typeof(d->'code')<>'string' or d->>'code'!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' or jsonb_typeof(d->'label')<>'string' or char_length(d->>'label')not between 1 and 120 or d->>'label' collate "C"~U&'[\0001-\001F\007F-\009F]' or d->>'label' collate "C"~U&'^[\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|[\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
  or coalesce(d->>'kind','')not in('billable_client','non_billable_client','internal_delivery','pre_sales','training','administration','buyer_defined')
  or jsonb_typeof(d->'active')<>'boolean' or jsonb_typeof(d->'includeInUtilization')<>'boolean' or coalesce(d->>'billability','')not in('project_bound','non_billable') or jsonb_typeof(d->'contexts')<>'array' then return false;end if;
 context_count=jsonb_array_length(d->'contexts');if context_count not between 1 and 3 or exists(select 1 from jsonb_array_elements(d->'contexts')v where jsonb_typeof(v)<>'string')then return false;end if;
 for c in select value#>>'{}' from jsonb_array_elements(d->'contexts')loop
  if c not in('client_description','none','project') or last_context is not null and c collate "C"<=last_context collate "C" then return false;end if;last_context=c;
 end loop;
 if d->>'kind'='billable_client' and (d->>'billability'<>'project_bound' or d->'contexts'<>'["project"]')then return false;end if;
 if d->>'kind' not in('billable_client','buyer_defined')and d->>'billability'<>'non_billable'then return false;end if;
 if d->>'kind'='non_billable_client'and d->'contexts'?'none'then return false;end if;
 if d->>'billability'='project_bound'and d->'contexts'<>'["project"]'then return false;end if;return true;
exception when others then return false;end $$;
create function valid_work_category_catalog(d jsonb)returns boolean language plpgsql immutable as $$
begin
 if d is null or jsonb_typeof(d)<>'object' or (select array_agg(key order by key)from jsonb_object_keys(d)key)is distinct from array['categories','enabled'] or jsonb_typeof(d->'enabled')<>'boolean' or jsonb_typeof(d->'categories')<>'array' or jsonb_array_length(d->'categories')>100 then return false;end if;
 if(d->>'enabled')::boolean<>(jsonb_array_length(d->'categories')>0)or(d->>'enabled')::boolean and not exists(select 1 from jsonb_array_elements(d->'categories')c where(c->>'active')::boolean)or exists(select 1 from jsonb_array_elements(d->'categories')c where valid_work_category_definition(c)is not true)or exists(select 1 from jsonb_array_elements(d->'categories')c group by c->>'code' having count(*)>1)then return false;end if;return true;
exception when others then return false;end $$;
create table work_category_catalog_versions(
 id uuid primary key default gen_random_uuid(),organization_id text not null,legal_entity_id text not null,sequence integer not null check(sequence>0),effective_from date not null,
 contract_version text not null check(contract_version='work-category/1'),definition jsonb not null check(valid_work_category_catalog(definition)is true),actor_id text not null,active_role text not null,source text not null check(source='Web'),reason text not null check(length(btrim(reason))between 1 and 1000),created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id)on delete restrict,unique(organization_id,legal_entity_id,sequence),unique(organization_id,legal_entity_id,effective_from)
);
create trigger immutable_work_category_catalog before update or delete on work_category_catalog_versions for each row execute function reject_commercial_draft_rewrite();
create function guard_work_category_catalog()returns trigger language plpgsql as $$
declare previous work_category_catalog_versions;ctx jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 begin ctx=nullif(current_setting('workos.category_catalog_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx->>'actorId'is distinct from new.actor_id or ctx->>'activeRole'is distinct from new.active_role or ctx->>'organizationId'is distinct from new.organization_id or ctx->>'legalEntityId'is distinct from new.legal_entity_id then raise exception 'Use the scoped category catalog command.'using errcode='WCC01';end if;
 select * into previous from work_category_catalog_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(previous.sequence,0)+1 or new.effective_from<(clock_timestamp()at time zone'UTC')::date or previous.id is not null and new.effective_from<=previous.effective_from or coalesce(previous.sequence,0)>=1000 then raise exception 'Category catalog adoption is not prospective or its source changed.'using errcode='WCC04';end if;
 if not exists(select 1 from reporting_periods where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and frequency='Weekly' and starts_on=new.effective_from and status='Open')or exists(select 1 from reporting_periods where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and new.effective_from between starts_on and ends_on and status<>'Open')then raise exception 'Category adoption requires an open authoritative Weekly start.'using errcode='WCC05';end if;
 if exists(select 1 from timesheet_entries e join timesheets t on t.id=e.timesheet_id where t.organization_id=new.organization_id and t.legal_entity_id=new.legal_entity_id and e.work_date>=new.effective_from)then raise exception 'Recorded work cannot be retroactively classified. Choose a clean prospective boundary.'using errcode='WCC06';end if;return new;
end $$;
create trigger guarded_work_category_catalog before insert on work_category_catalog_versions for each row execute function guard_work_category_catalog();
create function protect_work_category_boundary()returns trigger language plpgsql as $$
begin
 if old.frequency='Weekly'and(tg_op='DELETE'or(to_jsonb(new)-array['name','code','status','created_at','updated_at'])is distinct from(to_jsonb(old)-array['name','code','status','created_at','updated_at']))and exists(select 1 from work_category_catalog_versions p where p.organization_id=old.organization_id and p.legal_entity_id=old.legal_entity_id and p.effective_from=old.starts_on)then raise exception 'Adopted category boundaries cannot be reshaped.'using errcode='23514';end if;if tg_op='DELETE'then return old;end if;return new;
end $$;
create trigger category_catalog_boundary before update or delete on reporting_periods for each row execute function protect_work_category_boundary();

alter table timesheet_entries add column category_code text,add column category_reference jsonb;
alter table timesheet_entries drop constraint timesheet_entries_work_type_check;
alter table timesheet_entries add constraint timesheet_entries_work_type_check check(work_type in('Project Work','Client Misc Task','Non-client Work'));
alter table timesheet_entries add constraint governed_work_category_pair check((category_code is null and category_reference is null)or(category_code is not null and category_reference is not null and category_reference->>'code'=category_code and category_reference->>'contractVersion'='work-category/1')is true);
create function resolve_work_category(org text,le text,worker text,at_date date,code text,worktype text,project text,client text,requested_billable boolean,legacy_category text)
returns jsonb language plpgsql volatile as $$
declare p work_category_catalog_versions;d jsonb;context text;actual_billable boolean;ref jsonb;
begin
 select * into p from work_category_catalog_versions where organization_id=org and legal_entity_id=le and effective_from<=at_date order by effective_from desc limit 1;
 if p.id is null or not(p.definition->>'enabled')::boolean then
  if code is not null or worktype='Non-client Work'then raise exception 'A governed category is unavailable for this work date.'using errcode='WCC02';end if;
  return jsonb_build_object('code',null,'reference',null,'category',legacy_category,'billable',requested_billable);
 end if;
 if code is null then raise exception 'Choose an explicit governed work category for this date.'using errcode='WCC02';end if;
 select value into d from jsonb_array_elements(p.definition->'categories')where value->>'code'=code and(value->>'active')::boolean;
 if d is null then raise exception 'The category is unavailable or retired on this date.'using errcode='WCC02';end if;
 context=case when worktype='Project Work'and project is not null then 'project' when worktype='Client Misc Task'and project is null and nullif(btrim(client),'')is not null then 'client_description' when worktype='Non-client Work'and project is null and nullif(btrim(coalesce(client,'')),'')is null then 'none' end;
 if context is null or not(d->'contexts'?context)then raise exception 'This category does not permit the selected work context.'using errcode='WCC03';end if;
 actual_billable=false;
 if d->>'billability'='project_bound' then
  select coalesce(requested_billable,false)and pr.billable and coalesce(b.billable,true)and exists(select 1 from project_allocations a where a.project_id=pr.id and a.organization_id=org and a.legal_entity_id=le and a.employee_id=worker and a.status='Active'and a.billable and at_date between a.start_date and a.end_date)into actual_billable from projects pr left join commercial_project_bindings b on b.project_id=pr.id and b.organization_id=pr.organization_id and b.legal_entity_id=pr.legal_entity_id where pr.id=project and pr.organization_id=org and pr.legal_entity_id=le;
  actual_billable=coalesce(actual_billable,false);
 end if;
 if d->>'kind'='billable_client'and not actual_billable then raise exception 'Billable client work needs an authorized billable project assignment.'using errcode='WCC03';end if;
 ref=d||jsonb_build_object('contractVersion','work-category/1','catalogId',p.id,'sequence',p.sequence,'effectiveFrom',to_char(p.effective_from,'YYYY-MM-DD'),'context',context);
 return jsonb_build_object('code',code,'reference',ref,'category',d->>'label','billable',actual_billable);
end $$;
-- Canonical references and worker/project billability are server-authoritative.
create function apply_work_category_entry()returns trigger language plpgsql as $$
declare h timesheets;r jsonb;
begin
 select * into h from timesheets where id=new.timesheet_id;if h.id is null then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||h.organization_id||':'||h.legal_entity_id,0));
 r=resolve_work_category(h.organization_id,h.legal_entity_id,h.employee_id,new.work_date,new.category_code,new.work_type,new.project_id,new.client_name,new.billable,new.category);
 new.category_code=r->>'code';new.category_reference=nullif(r->'reference','null'::jsonb);new.category=r->>'category';new.billable=(r->>'billable')::boolean;return new;
end $$;
create trigger category_entry_authority before insert or update on timesheet_entries for each row execute function apply_work_category_entry();

-- Preserve every legacy claim byte-for-byte. Governed classification is material
-- content only for newly governed entries; no old claim or evidence is rewritten.
create or replace function work_source_payload(worker text,week_ending date,entry jsonb)returns jsonb language sql immutable as $$
 select jsonb_build_object('version','work-source/1','employeeId',worker,'weekEnding',week_ending,
 'workDate',(entry->>'work_date')::date,'workType',entry->>'work_type','projectId',nullif(entry->>'project_id',''),
 'clientName',nullif(entry->>'client_name',''),'category',nullif(entry->>'category',''),'hours',(entry->>'hours')::numeric,
 'billable',(entry->>'billable')::boolean,'remark',nullif(entry->>'remark',''),'evidenceUrl',nullif(entry->>'evidence_url',''),'workReference',nullif(entry->>'work_reference',''))
 ||case when entry->'category_reference'is not null and entry->'category_reference'<>'null'::jsonb then jsonb_build_object('categoryCode',entry->'category_code','categoryReference',entry->'category_reference')else'{}'::jsonb end
$$;
