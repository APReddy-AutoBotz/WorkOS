-- Empty, explicit NEW legal-entity calendar lineages. No backfill or grants.
create function valid_calendar_authoring_definition(d jsonb)returns boolean language plpgsql stable as $$
declare h jsonb;day jsonb;prior_day integer=-1;prior_date date;dt date;
begin
 if jsonb_typeof(d)is distinct from'object'or not(d?&array['name','timezone','workingDays','hoursPerDayExact','holidays'])or d-array['name','timezone','workingDays','hoursPerDayExact','holidays']<>'{}'::jsonb then return false;end if;
 if jsonb_typeof(d->'name')is distinct from'string'or length(d->>'name')not between 1 and 150 or btrim(d->>'name')<>d->>'name'or(d->>'name')~'[\x01-\x1f\x7f-\x9f]'or jsonb_typeof(d->'timezone')is distinct from'string'or length(d->>'timezone')not between 1 and 80 or not exists(select 1 from pg_timezone_names where name=d->>'timezone')then return false;end if;
 if jsonb_typeof(d->'hoursPerDayExact')is distinct from'string'or(d->>'hoursPerDayExact')!~'^(0|[1-9][0-9]?)(\.[0-9]{1,2})?$'or(d->>'hoursPerDayExact')::numeric<=0 or(d->>'hoursPerDayExact')::numeric>24 or jsonb_typeof(d->'workingDays')is distinct from'array'or jsonb_array_length(d->'workingDays')not between 1 and 7 or jsonb_typeof(d->'holidays')is distinct from'array'or jsonb_array_length(d->'holidays')>200 then return false;end if;
 for day in select * from jsonb_array_elements(d->'workingDays')loop
  if jsonb_typeof(day)is distinct from'number'or(day#>>'{}')!~'^[0-6]$'or(day#>>'{}')::integer<=prior_day then return false;end if;prior_day=(day#>>'{}')::integer;
 end loop;
 for h in select * from jsonb_array_elements(d->'holidays')loop
  if jsonb_typeof(h)is distinct from'object'or not(h?&array['date','label','type'])or h-array['date','label','type']<>'{}'::jsonb or jsonb_typeof(h->'date')is distinct from'string'or(h->>'date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'or jsonb_typeof(h->'label')is distinct from'string'or length(h->>'label')not between 1 and 150 or btrim(h->>'label')<>h->>'label'or(h->>'label')~'[\x01-\x1f\x7f-\x9f]'or jsonb_typeof(h->'type')is distinct from'string'or h->>'type'not in('Public','Company')then return false;end if;
  dt=(h->>'date')::date;if to_char(dt,'YYYY-MM-DD')<>h->>'date'or(prior_date is not null and dt<=prior_date)then return false;end if;prior_date=dt;
 end loop;return true;
exception when others then return false;end $$;
create table calendar_authoring_lineages(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,code text not null check(code~'^[A-Z0-9][A-Z0-9_-]{0,49}$'),
 actor_id uuid not null references users(id),active_role text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,code),unique(organization_id,legal_entity_id,id)
);
create table calendar_authoring_versions(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,lineage_id uuid not null,sequence integer not null check(sequence>0),previous_version_id uuid references calendar_authoring_versions(id),
 contract_version text not null check(contract_version='calendar-authoring/1'),effective_from date not null,definition jsonb not null check(valid_calendar_authoring_definition(definition)),
 calendar_id text not null unique references working_calendars(id)deferrable initially deferred,
 request_id uuid not null,command jsonb not null,request_fingerprint text not null check(request_fingerprint=encode(digest(command::text,'sha256'),'hex')),
 actor_id uuid not null references users(id),active_role text not null,source text not null check(source='Web'),reason text not null check(reason=btrim(reason)and length(reason)between 1 and 1000 and reason!~'[\x01-\x1f\x7f-\x9f]'),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,lineage_id)references calendar_authoring_lineages(organization_id,legal_entity_id,id),
 unique(lineage_id,sequence),unique(lineage_id,effective_from),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create index calendar_authoring_versions_latest on calendar_authoring_versions(lineage_id,sequence desc);
create function calendar_authoring_context()returns jsonb language plpgsql stable as $$begin
 return nullif(current_setting('workos.calendar_authoring_context',true),'')::jsonb;exception when others then return null;end $$;
create function calendar_authoring_actor(ctx jsonb)returns boolean language sql stable as $$
 select ctx is not null and exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes s on s.user_id=u.id
 where u.id::text=ctx->>'actorId'and u.status='Active'and r.name=ctx->>'activeRole'and s.active and s.organization_id=ctx->>'organizationId'and s.legal_entity_id=ctx->>'legalEntityId'
 and(exists(select 1 from role_permissions where role_name=r.name and permission_key='settings.manage'and enabled)or exists(select 1 from user_permission_grants where user_id=u.id and permission_key='settings.manage')));
$$;
create function guard_calendar_authoring_append()returns trigger language plpgsql as $$
declare ctx jsonb=calendar_authoring_context();l calendar_authoring_lineages;prior calendar_authoring_versions;h jsonb;
begin
 if not calendar_authoring_actor(ctx)or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Use current scoped calendar-authoring authority.'using errcode='GCA01';end if;
 if tg_table_name='calendar_authoring_lineages'then
  if new.id::text is distinct from ctx->>'lineageId'or exists(select 1 from working_calendars where organization_id=new.organization_id and applicability_type='legal_entity'and legal_entity_id=new.legal_entity_id and code=new.code)then raise exception 'Legacy or retired calendar lineage cannot be adopted implicitly.'using errcode='GCA02';end if;return new;
 end if;
 select * into l from calendar_authoring_lineages where id=new.lineage_id for update;select * into prior from calendar_authoring_versions where lineage_id=l.id order by sequence desc limit 1;
 if new.id::text is distinct from ctx->>'versionId'or new.lineage_id::text is distinct from ctx->>'lineageId'or new.calendar_id is distinct from ctx->>'calendarId'or new.request_id::text is distinct from ctx->>'requestId'or new.operation_id is distinct from ctx->>'operationId'or new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_version_id is distinct from prior.id or new.effective_from<=(clock_timestamp()at time zone'UTC')::date or(prior.id is not null and new.effective_from<=prior.effective_from)then raise exception 'Calendar version is stale or is not prospective.'using errcode='GCA02';end if;
 if jsonb_typeof(new.command)is distinct from'object'or not(new.command?&array['requestId','lineageId','expectedLatestId','code','effectiveFrom','definition','reason'])or new.command-array['requestId','lineageId','expectedLatestId','code','effectiveFrom','definition','reason']<>'{}'::jsonb or new.command->>'requestId'is distinct from new.request_id::text or new.command->>'lineageId'is distinct from(case when prior.id is null then null else l.id::text end)or new.command->>'expectedLatestId'is distinct from prior.id::text or new.command->>'code'is distinct from l.code or new.command->>'effectiveFrom'is distinct from to_char(new.effective_from,'YYYY-MM-DD')or new.command->'definition'is distinct from new.definition or new.command->>'reason'is distinct from new.reason then raise exception 'Retain the complete exact calendar command.'using errcode='GCA03';end if;
 for h in select * from jsonb_array_elements(new.definition->'holidays')loop if(h->>'date')::date<new.effective_from then raise exception 'Holiday precedes its calendar version.'using errcode='GCA03';end if;end loop;return new;
end $$;
create trigger guarded_calendar_authoring_lineage before insert on calendar_authoring_lineages for each row execute function guard_calendar_authoring_append();
create trigger guarded_calendar_authoring_version before insert on calendar_authoring_versions for each row execute function guard_calendar_authoring_append();
create trigger immutable_calendar_authoring_lineage before update or delete on calendar_authoring_lineages for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_calendar_authoring_version before update or delete on calendar_authoring_versions for each row execute function reject_commercial_draft_rewrite();
create function validate_calendar_authoring_lineage_commit()returns trigger language plpgsql as $$begin
 if not exists(select 1 from calendar_authoring_versions where lineage_id=new.id and sequence=1 and actor_id=new.actor_id and active_role=new.active_role)then raise exception 'Create the complete initial calendar version atomically.'using errcode='GCA05';end if;return null;
end $$;
create constraint trigger authored_calendar_lineage_commit after insert on calendar_authoring_lineages deferrable initially deferred for each row execute function validate_calendar_authoring_lineage_commit();

create function guard_authored_calendar_projection()returns trigger language plpgsql as $$
declare ctx jsonb=calendar_authoring_context();l calendar_authoring_lineages;v calendar_authoring_versions;prior calendar_authoring_versions;h jsonb;
begin
 if tg_table_name='working_calendars'then
  if tg_op<>'DELETE'and new.applicability_type='legal_entity'then perform pg_advisory_xact_lock(hashtext('calendar:'||new.organization_id||':legal_entity:'||new.legal_entity_id||':'||new.code));end if;
  if tg_op='INSERT'then select * into l from calendar_authoring_lineages where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and code=new.code and new.applicability_type='legal_entity';
  else select x.* into l from calendar_authoring_lineages x join calendar_authoring_versions a on a.lineage_id=x.id where a.calendar_id=old.id;
   if l.id is null and tg_op='UPDATE'and new.applicability_type='legal_entity'then select * into l from calendar_authoring_lineages where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and code=new.code;end if;
  end if;
 else
  if tg_op='INSERT'then select x.* into l from calendar_authoring_lineages x join calendar_authoring_versions a on a.lineage_id=x.id where a.calendar_id=new.calendar_id;
  else select x.* into l from calendar_authoring_lineages x join calendar_authoring_versions a on a.lineage_id=x.id where a.calendar_id=old.calendar_id;
   if l.id is null and tg_op='UPDATE'then select x.* into l from calendar_authoring_lineages x join calendar_authoring_versions a on a.lineage_id=x.id where a.calendar_id=new.calendar_id;end if;
  end if;
 end if;
 if l.id is null then if tg_op='DELETE'then return old;else return new;end if;end if;
 if not calendar_authoring_actor(ctx)or ctx->>'lineageId'is distinct from l.id::text then raise exception 'Use governed prospective calendar authoring; source bypass refused.'using errcode='GCA04';end if;
 select * into v from calendar_authoring_versions where id::text=ctx->>'versionId'and lineage_id=l.id;select * into prior from calendar_authoring_versions where id=v.previous_version_id;
 if v.id is null then raise exception 'Matching complete calendar version required.'using errcode='GCA04';end if;
 if tg_table_name='working_calendars'and tg_op='UPDATE'and old.id=prior.calendar_id and new.effective_to=v.effective_from-1 and(to_jsonb(new)-'effective_to')=(to_jsonb(old)-'effective_to')then return new;end if;
 if tg_op<>'INSERT'then raise exception 'Authored calendar and holiday history is immutable.'using errcode='GCA04';end if;
 if tg_table_name='working_calendars'then
  if new.id<>v.calendar_id or new.organization_id<>l.organization_id or new.legal_entity_id is distinct from l.legal_entity_id or new.applicability_type<>'legal_entity'or new.country_code is not null or new.country_authority_legal_entity_id is not null or new.worker_group_id is not null or new.code<>l.code or new.name<>v.definition->>'name'or new.timezone<>v.definition->>'timezone'or to_jsonb(new.working_days)<>v.definition->'workingDays'or new.hours_per_day<>(v.definition->>'hoursPerDayExact')::numeric or new.effective_from<>v.effective_from or new.effective_to is not null or not new.active then raise exception 'Project the exact authored calendar.'using errcode='GCA04';end if;
 else
  if new.calendar_id<>v.calendar_id or new.organization_id<>l.organization_id or new.effective_from<>v.effective_from or new.effective_to is not null or not new.active or new.created_by is distinct from v.actor_id or not exists(select 1 from jsonb_array_elements(v.definition->'holidays')q where(q->>'date')::date=new.holiday_date and q->>'label'=new.label and q->>'type'=new.holiday_type)then raise exception 'Project the exact authored holiday bundle.'using errcode='GCA04';end if;
 end if;return new;
end $$;
create trigger authored_calendar_projection before insert or update or delete on working_calendars for each row execute function guard_authored_calendar_projection();
create trigger authored_holiday_projection before insert or update or delete on working_calendar_holidays for each row execute function guard_authored_calendar_projection();
create constraint trigger authored_calendar_projection_commit after insert or update or delete on working_calendars deferrable initially deferred for each row execute function guard_authored_calendar_projection();
create constraint trigger authored_holiday_projection_commit after insert or update or delete on working_calendar_holidays deferrable initially deferred for each row execute function guard_authored_calendar_projection();
create function validate_calendar_authoring_commit()returns trigger language plpgsql as $$
declare c working_calendars;l calendar_authoring_lineages;expected_end date;
begin
 select * into c from working_calendars where id=new.calendar_id;select * into l from calendar_authoring_lineages where id=new.lineage_id;select min(effective_from)-1 into expected_end from calendar_authoring_versions where lineage_id=new.lineage_id and sequence>new.sequence;
 if c.id is null or c.organization_id<>new.organization_id or c.legal_entity_id is distinct from new.legal_entity_id or c.code<>l.code or c.applicability_type<>'legal_entity'or c.name<>new.definition->>'name'or c.timezone<>new.definition->>'timezone'or to_jsonb(c.working_days)<>new.definition->'workingDays'or c.hours_per_day<>(new.definition->>'hoursPerDayExact')::numeric or c.effective_from<>new.effective_from or c.effective_to is distinct from expected_end or not c.active then raise exception 'Complete exact calendar projection required.'using errcode='GCA05';end if;
 if(select count(*)from working_calendar_holidays where calendar_id=c.id)<>jsonb_array_length(new.definition->'holidays')or exists(select 1 from jsonb_array_elements(new.definition->'holidays')q where not exists(select 1 from working_calendar_holidays h where h.calendar_id=c.id and h.organization_id=new.organization_id and h.holiday_date=(q->>'date')::date and h.label=q->>'label'and h.holiday_type=q->>'type'and h.effective_from=new.effective_from and h.effective_to is null and h.active))then raise exception 'Complete exact holiday projection required.'using errcode='GCA05';end if;
 if new.previous_version_id is not null and not exists(select 1 from calendar_authoring_versions p join working_calendars pc on pc.id=p.calendar_id where p.id=new.previous_version_id and pc.effective_to=new.effective_from-1)then raise exception 'Retain the preceding calendar boundary.'using errcode='GCA05';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.module='Calendar Authoring'and a.entity_id=new.id::text and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.operation_id=new.operation_id and a.reason=new.reason and a.new_value->>'versionId'=new.id::text and a.new_value->'definition'=new.definition)then raise exception 'Atomic authored-calendar audit required.'using errcode='GCA05';end if;return null;
end $$;
create constraint trigger authored_calendar_commit after insert on calendar_authoring_versions deferrable initially deferred for each row execute function validate_calendar_authoring_commit();
