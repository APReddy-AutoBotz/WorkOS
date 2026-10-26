-- New legal-owned catalog lineages only. No adoption, backfill, grants or defaults.
create function valid_business_structure_definition(d jsonb) returns boolean language sql immutable as $$
 select jsonb_typeof(d)='object' and d ?& array['name','parentId'] and d-array['name','parentId']='{}'::jsonb
 and jsonb_typeof(d->'name')='string' and length(d->>'name')between 1 and 150 and btrim(d->>'name')=d->>'name' and(d->>'name')!~'[\x01-\x1f\x7f-\x9f]'
 and(d->'parentId'='null'::jsonb or(jsonb_typeof(d->'parentId')='string'and length(d->>'parentId')between 1 and 200 and btrim(d->>'parentId')=d->>'parentId'and(d->>'parentId')!~'[\x01-\x1f\x7f-\x9f]'));
$$;
create table business_structure_events(
 id uuid primary key,lineage_id uuid not null,organization_id text not null,legal_entity_id text not null,
 catalog_type text not null check(catalog_type in('business_unit','department','cost_centre','practice','location','region')),
 code text not null check(length(code)between 1 and 50 and btrim(code)=code and code!~'[\x01-\x1f\x7f-\x9f]'),
 sequence integer not null check(sequence>0),previous_event_id uuid references business_structure_events(id),
 action text not null check(action in('Append','Retire')),effective_from date not null,retired_on date,
 definition jsonb not null check(valid_business_structure_definition(definition)),native_item_id text not null references organization_catalog_items(id) deferrable initially deferred,
 parent_snapshot jsonb,parent_token text,contract_version text not null check(contract_version='business-structure/1'),
 request_id uuid not null,command jsonb not null,request_fingerprint text not null check(request_fingerprint=encode(digest(command::text,'sha256'),'hex')),
 actor_id uuid not null references users(id),active_role text not null,source text not null check(source='Web'),
 reason text not null check(length(reason)between 1 and 1000 and btrim(reason)=reason and reason!~'[\x01-\x1f\x7f-\x9f]'),operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),
 unique(lineage_id,sequence),unique(organization_id,legal_entity_id,actor_id,request_id),
 check((action='Append'and retired_on is null)or(action='Retire'and retired_on>=effective_from)),
 check((parent_snapshot is null and parent_token is null)or parent_token=encode(digest(parent_snapshot::text,'sha256'),'hex'))
);
create unique index business_structure_native_append on business_structure_events(native_item_id)where action='Append';
create index business_structure_scope_type on business_structure_events(organization_id,legal_entity_id,catalog_type,lineage_id,sequence desc);
create index business_structure_native_key on business_structure_events(organization_id,legal_entity_id,catalog_type,code,sequence desc);
create index business_structure_catalog_page on organization_catalog_items(organization_id,legal_entity_id,catalog_type,(id collate "C"));
create index business_structure_parent_references on organization_catalog_items(organization_id,parent_id);
create index business_structure_calendar_references on working_calendars(organization_id,worker_group_id);
create index business_structure_capacity_references on worker_capacity_versions(organization_id,worker_group_id);
create index business_structure_engagement_references on commercial_engagements(organization_id,attribution_id);
create index business_structure_binding_references on commercial_project_bindings(organization_id,attribution_id);
create function business_structure_event_json(e business_structure_events)returns jsonb language sql stable as $$
 select jsonb_build_object('eventId',e.id,'lineageId',e.lineage_id,'type',e.catalog_type,'code',e.code,'sequence',e.sequence,'previousEventId',e.previous_event_id,
 'action',e.action,'effectiveFrom',to_char(e.effective_from,'YYYY-MM-DD'),'retiredOn',to_char(e.retired_on,'YYYY-MM-DD'),'definition',e.definition,'nativeItemId',e.native_item_id,
 'parentSource',e.parent_snapshot,'parentToken',e.parent_token,'requestId',e.request_id,'requestFingerprint',e.request_fingerprint,'actorUserId',e.actor_id,'activeRole',e.active_role,
 'source',e.source,'reason',e.reason,'createdAt',to_char(e.created_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
create function business_structure_parent_snapshot(item text,org text,leg text,kind text,at_date date,target uuid)returns jsonb language plpgsql stable as $$
declare p organization_catalog_items;bad boolean;
begin
 select * into p from organization_catalog_items where id=item and organization_id=org and legal_entity_id=leg and catalog_type=kind and active and at_date between effective_from and coalesce(effective_to,'infinity'::date);
 if p.id is null then return null;end if;
 with recursive chain as(
  select c.*,array[c.id]path,false cycle,1 depth from organization_catalog_items c where id=item
  union all select c.*,x.path||c.id,c.id=any(x.path),x.depth+1 from organization_catalog_items c join chain x on c.id=x.parent_id where not x.cycle and x.depth<100
 )select exists(select 1 from chain x where x.cycle or x.depth=100 or x.organization_id<>org or x.legal_entity_id is distinct from leg or x.catalog_type<>kind
  or exists(select 1 from business_structure_events e where e.lineage_id=target and e.native_item_id=x.id))into bad;
 if bad then return null;end if;
 return jsonb_build_object('itemId',p.id,'type',p.catalog_type,'code',p.code,'name',p.name,'ownerLegalEntityId',p.legal_entity_id,'effectiveFrom',to_char(p.effective_from,'YYYY-MM-DD'),'effectiveTo',to_char(p.effective_to,'YYYY-MM-DD'));
end $$;
create function business_structure_dependencies(org text,item text)returns jsonb language sql stable as $$
 select jsonb_build_object(
 'catalogChildren',(select count(*)from organization_catalog_items where organization_id=org and parent_id=item),
 'workingCalendars',(select count(*)from working_calendars where organization_id=org and worker_group_id=item),
 'capacityVersions',(select count(*)from worker_capacity_versions where organization_id=org and worker_group_id=item),
 'commercialEngagements',(select count(*)from commercial_engagements where organization_id=org and attribution_id=item),
 'commercialBindings',(select count(*)from commercial_project_bindings where organization_id=org and attribution_id=item));
$$;
create function business_structure_context()returns jsonb language plpgsql stable as $$begin
 return nullif(current_setting('workos.business_structure_context',true),'')::jsonb;exception when others then return null;end $$;
create function guard_business_structure_event()returns trigger language plpgsql as $$
declare ctx jsonb=business_structure_context();prior business_structure_events;p jsonb;today date=(clock_timestamp()at time zone'UTC')::date;deps jsonb;
begin
 if not calendar_authoring_actor(ctx)or new.id::text is distinct from ctx->>'eventId'or new.lineage_id::text is distinct from ctx->>'lineageId'
 or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'
 or new.active_role is distinct from ctx->>'activeRole'or new.native_item_id is distinct from ctx->>'nativeItemId'or new.request_id::text is distinct from ctx->>'requestId'
 or new.operation_id is distinct from ctx->>'operationId'or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Use current scoped business-structure authority.'using errcode='BSG01';end if;
 perform pg_advisory_xact_lock(hashtext(new.organization_id||':'||new.legal_entity_id||':'||new.catalog_type||':'||new.code));
 select * into prior from business_structure_events where lineage_id=new.lineage_id order by sequence desc limit 1;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_event_id is distinct from prior.id or(prior.id is not null and(prior.organization_id<>new.organization_id or prior.legal_entity_id<>new.legal_entity_id or prior.catalog_type<>new.catalog_type or prior.code<>new.code or prior.action='Retire'))then raise exception 'Catalog source changed or lineage is terminal.'using errcode='BSG02';end if;
 if prior.id is null and(new.action<>'Append'or exists(select 1 from organization_catalog_items where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and catalog_type=new.catalog_type and code=new.code)
 or exists(select 1 from business_structure_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and catalog_type=new.catalog_type and code=new.code))then raise exception 'Existing or retired native keys are not implicitly adopted.'using errcode='BSG02';end if;
 if jsonb_typeof(new.command)is distinct from'object'or not(new.command?&array['requestId','lineageId','expectedLatestId','type','code','action','effectiveFrom','definition','expectedParentToken','reason'])or new.command-array['requestId','lineageId','expectedLatestId','type','code','action','effectiveFrom','definition','expectedParentToken','reason']<>'{}'::jsonb
 or new.command->>'requestId'is distinct from new.request_id::text or new.command->>'lineageId'is distinct from(case when prior.id is null then null else new.lineage_id::text end)
 or new.command->>'expectedLatestId'is distinct from prior.id::text or new.command->>'type'is distinct from new.catalog_type or new.command->>'code'is distinct from new.code
 or new.command->>'action'is distinct from new.action or new.command->>'effectiveFrom'is distinct from to_char(new.effective_from,'YYYY-MM-DD')or new.command->'definition'is distinct from new.definition or new.command->>'reason'is distinct from new.reason then raise exception 'Retain the exact complete catalog command.'using errcode='BSG03';end if;
 if new.action='Append'then
  if new.effective_from<today or(prior.id is not null and new.effective_from<=prior.effective_from)or new.native_item_id<>'structure-item-'||new.id::text or new.retired_on is not null then raise exception 'Use an explicit current/future increasing source date.'using errcode='BSG02';end if;
  if new.definition->>'parentId'is not null then
   perform 1 from organization_catalog_items where id=new.definition->>'parentId'for share;
   p=business_structure_parent_snapshot(new.definition->>'parentId',new.organization_id,new.legal_entity_id,new.catalog_type,new.effective_from,new.lineage_id);
   if p is null then raise exception 'Selected exact parent is unavailable or cyclic.'using errcode='BSG03';end if;
  end if;
  if new.parent_snapshot is distinct from p or new.parent_token is distinct from(case when p is null then null else encode(digest(p::text,'sha256'),'hex')end)or new.command->>'expectedParentToken'is distinct from new.parent_token then raise exception 'Selected parent source changed.'using errcode='BSG03';end if;
 else
  if prior.id is null or new.native_item_id<>prior.native_item_id or new.definition<>prior.definition or new.effective_from<>prior.effective_from or new.effective_from>today or new.retired_on is distinct from today
   or new.parent_snapshot is distinct from prior.parent_snapshot or new.parent_token is distinct from prior.parent_token or new.command->>'expectedParentToken'is not null then raise exception 'Retire only the inspected current unused latest source.'using errcode='BSG02';end if;
  perform 1 from organization_catalog_items where id=new.native_item_id for update;
  deps=business_structure_dependencies(new.organization_id,new.native_item_id);
  if exists(select 1 from jsonb_each_text(deps)where value::bigint>0)then raise exception 'Current or retained references prevent unused-node retirement.'using errcode='BSG05';end if;
 end if;
 return new;
end $$;
create trigger guarded_business_structure_event before insert on business_structure_events for each row execute function guard_business_structure_event();
create trigger immutable_business_structure_event before update or delete on business_structure_events for each row execute function reject_commercial_draft_rewrite();
create function guard_business_structure_projection()returns trigger language plpgsql as $$
declare ctx jsonb=business_structure_context();e business_structure_events;prior business_structure_events;governed boolean;
begin
 if tg_op<>'DELETE'then perform pg_advisory_xact_lock(hashtext(new.organization_id||':'||coalesce(new.legal_entity_id,'')||':'||new.catalog_type||':'||new.code));end if;
 select exists(select 1 from business_structure_events where native_item_id=case when tg_op='DELETE'then old.id else new.id end
  or(tg_op<>'DELETE'and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and catalog_type=new.catalog_type and code=new.code))into governed;
 if tg_op<>'INSERT'then governed=governed or exists(select 1 from business_structure_events where native_item_id=old.id);end if;
 if not governed and(tg_op='DELETE'or new.id not like 'structure-item-%')then return case when tg_op='DELETE'then old else new end;end if;
 select * into e from business_structure_events where id::text=ctx->>'eventId';
 if e.id is null or not calendar_authoring_actor(ctx)or e.actor_id::text is distinct from ctx->>'actorId'or e.operation_id is distinct from ctx->>'operationId'or tg_op='DELETE'then raise exception 'Use governed catalog commands.'using errcode='BSG04';end if;
 select * into prior from business_structure_events where id=e.previous_event_id;
 if tg_op='INSERT'then
  if e.action<>'Append'or new.id<>e.native_item_id or new.organization_id<>e.organization_id or new.legal_entity_id is distinct from e.legal_entity_id or new.catalog_type<>e.catalog_type or new.code<>e.code
   or new.name<>e.definition->>'name'or new.parent_id is distinct from e.definition->>'parentId'or new.effective_from<>e.effective_from or new.effective_to is not null or not new.active then raise exception 'Project the exact authored catalog source.'using errcode='BSG04';end if;
 else
  if(to_jsonb(new)-array['effective_to','active','updated_at'])<>(to_jsonb(old)-array['effective_to','active','updated_at'])then raise exception 'Catalog material source is immutable.'using errcode='BSG04';end if;
  if e.action='Append'then
   if prior.id is null or old.id<>prior.native_item_id or not old.active or not new.active or old.effective_to is not null or new.effective_to is distinct from e.effective_from-1 then raise exception 'Close only the prior exact source interval.'using errcode='BSG04';end if;
  elsif old.id<>e.native_item_id or not old.active or new.active or old.effective_to is not null or new.effective_to is distinct from e.retired_on then raise exception 'Retire the exact unused current source.'using errcode='BSG04';end if;
 end if;return new;
end $$;
create trigger governed_business_structure_projection before insert or update or delete on organization_catalog_items for each row execute function guard_business_structure_projection();
create function guard_business_structure_reference()returns trigger language plpgsql as $$
declare item text;p organization_catalog_items;bad boolean;
begin
 item=case tg_table_name when'organization_catalog_items'then to_jsonb(new)->>'parent_id'when'working_calendars'then to_jsonb(new)->>'worker_group_id'when'worker_capacity_versions'then to_jsonb(new)->>'worker_group_id'else to_jsonb(new)->>'attribution_id'end;
 if item is null or not exists(select 1 from business_structure_events where native_item_id=item and action='Append')then return new;end if;
 select * into p from organization_catalog_items where id=item for share;
 if p.organization_id<>new.organization_id or p.legal_entity_id is distinct from new.legal_entity_id and tg_table_name<>'working_calendars'or not p.active then raise exception 'Governed catalog reference is retired or unavailable in this scope.'using errcode='BSG05';end if;
 if tg_table_name='organization_catalog_items'then
  if(to_jsonb(new)->>'catalog_type')<>p.catalog_type or business_structure_parent_snapshot(item,p.organization_id,p.legal_entity_id,p.catalog_type,new.effective_from,null)is null then raise exception 'Use an exact same-family effective parent.'using errcode='BSG05';end if;
  with recursive chain as(select c.id,c.parent_id,array[c.id]path,false cycle,1 depth from organization_catalog_items c where id=item
   union all select c.id,c.parent_id,x.path||c.id,c.id=any(x.path),x.depth+1 from organization_catalog_items c join chain x on c.id=x.parent_id where not x.cycle and x.depth<100)
  select exists(select 1 from chain where id=new.id or cycle or depth=100)into bad;
  if bad then raise exception 'Catalog parent cycle is unavailable.'using errcode='BSG05';end if;
 elsif tg_table_name in('working_calendars','worker_capacity_versions')and p.catalog_type<>'business_unit'then raise exception 'An existing business-unit reference is required.'using errcode='BSG05';
 elsif tg_table_name in('commercial_engagements','commercial_project_bindings')and p.catalog_type not in('business_unit','cost_centre')then raise exception 'An existing business-unit or cost-centre attribution is required.'using errcode='BSG05';end if;
 return new;
end $$;
create trigger business_structure_parent_reference before insert or update of parent_id on organization_catalog_items for each row execute function guard_business_structure_reference();
create trigger business_structure_calendar_reference before insert or update of worker_group_id on working_calendars for each row execute function guard_business_structure_reference();
create trigger business_structure_capacity_reference before insert or update of worker_group_id on worker_capacity_versions for each row execute function guard_business_structure_reference();
create trigger business_structure_engagement_reference before insert or update of attribution_id on commercial_engagements for each row execute function guard_business_structure_reference();
create trigger business_structure_binding_reference before insert on commercial_project_bindings for each row execute function guard_business_structure_reference();
create function check_business_structure_commit()returns trigger language plpgsql as $$
declare c organization_catalog_items;prior business_structure_events;later business_structure_events;retired business_structure_events;expected_end date;expected_active boolean=true;
begin
 select * into prior from business_structure_events where id=new.previous_event_id;
 select * into c from organization_catalog_items where id=new.native_item_id;
 if new.action='Append'then
  select * into later from business_structure_events where lineage_id=new.lineage_id and sequence>new.sequence and action='Append'order by sequence limit 1;
  select * into retired from business_structure_events where lineage_id=new.lineage_id and native_item_id=new.native_item_id and action='Retire'limit 1;
  expected_end=case when retired.id is not null then retired.retired_on when later.id is not null then later.effective_from-1 else null end;expected_active=retired.id is null;
 else expected_end=new.retired_on;expected_active=false;end if;
 if c.id is null or c.organization_id<>new.organization_id or c.legal_entity_id is distinct from new.legal_entity_id or c.catalog_type<>new.catalog_type or c.code<>new.code or c.name<>new.definition->>'name'
 or c.parent_id is distinct from new.definition->>'parentId'or c.effective_from<>new.effective_from or c.effective_to is distinct from expected_end or c.active<>expected_active then raise exception 'Complete exact catalog projection is required.'using errcode='BSG04';end if;
 if new.action='Retire'and exists(select 1 from jsonb_each_text(business_structure_dependencies(new.organization_id,new.native_item_id))where value::bigint>0)then raise exception 'Retirement gained a retained reference.'using errcode='BSG05';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.source='Web'
  and a.module='Business Structure'and a.action=new.action||' Catalog Source'and a.entity_type='BusinessStructureEvent'and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.reason=new.reason
  and a.new_value=business_structure_event_json(new)and a.old_value is not distinct from(case when prior.id is null then null else business_structure_event_json(prior)end))then raise exception 'Atomic exact catalog audit is required.'using errcode='BSG04';end if;
 return null;
end $$;
create constraint trigger complete_business_structure_event after insert on business_structure_events deferrable initially deferred for each row execute function check_business_structure_commit();
