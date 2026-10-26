-- Empty additive country/group authoring. Existing071 legal-entity commands stay intact.
create function calendar_scope_authority(kind text,ref text,org text,leg text,as_of date)returns jsonb language sql stable as $$
 select case when kind='country'then(
  select jsonb_build_object('type','country','referenceId',p.country_code,'sourceId',p.id::text,'code',p.country_code,'label',p.legal_name,'ownerLegalEntityId',leg,'effectiveFrom',to_char(p.effective_from,'YYYY-MM-DD'),'effectiveTo',to_char((select min(d)from unnest(array[p.effective_to,p.authority_effective_to,e.effective_to])d),'YYYY-MM-DD'))
  from legal_entity_profile_versions p join legal_entities e on e.id=p.legal_entity_id and e.organization_id=p.organization_id
  where p.organization_id=org and p.legal_entity_id=leg and p.country_code=ref and e.country_code=ref and e.status='Active'and p.status='Active'
   and as_of>=e.effective_from and as_of between p.effective_from and coalesce(p.effective_to,'infinity'::date)and as_of<=coalesce(p.authority_effective_to,'infinity'::date)and as_of<=coalesce(e.effective_to,'infinity'::date)
 )when kind='worker_group'then(
  select jsonb_build_object('type','worker_group','referenceId',g.id,'sourceId',g.id,'code',g.code,'label',g.name,'ownerLegalEntityId',leg,'effectiveFrom',to_char(g.effective_from,'YYYY-MM-DD'),'effectiveTo',to_char(g.effective_to,'YYYY-MM-DD'))
  from organization_catalog_items g where g.id=ref and g.organization_id=org and g.legal_entity_id=leg and g.catalog_type='business_unit'and g.active and as_of between g.effective_from and coalesce(g.effective_to,'infinity'::date)
 )else null end;
$$;
create table calendar_scope_authoring_lineages(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,applicability_type text not null check(applicability_type in('country','worker_group')),reference_id text not null,
 code text not null check(code~'^[A-Z0-9][A-Z0-9_-]{0,49}$'),actor_id uuid not null references users(id),active_role text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,applicability_type,reference_id,code),unique(organization_id,legal_entity_id,id),
 check((applicability_type='country'and reference_id~'^[A-Z]{2}$')or(applicability_type='worker_group'and length(reference_id)between 1 and 200))
);
create table calendar_scope_authoring_versions(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,lineage_id uuid not null,sequence integer not null check(sequence>0),previous_version_id uuid references calendar_scope_authoring_versions(id),
 contract_version text not null check(contract_version='calendar-scope-authoring/1'),effective_from date not null,definition jsonb not null check(valid_calendar_authoring_definition(definition)),authority jsonb not null,authority_token text not null check(authority_token=encode(digest(authority::text,'sha256'),'hex')),
 calendar_id text not null unique references working_calendars(id)deferrable initially deferred,request_id uuid not null,command jsonb not null,request_fingerprint text not null check(request_fingerprint=encode(digest(command::text,'sha256'),'hex')),
 actor_id uuid not null references users(id),active_role text not null,source text not null check(source='Web'),reason text not null check(reason=btrim(reason)and length(reason)between 1 and 1000 and reason!~'[\x01-\x1f\x7f-\x9f]'),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,lineage_id)references calendar_scope_authoring_lineages(organization_id,legal_entity_id,id),unique(lineage_id,sequence),unique(lineage_id,effective_from),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create index calendar_scope_authoring_versions_latest on calendar_scope_authoring_versions(lineage_id,sequence desc);
create function calendar_scope_authoring_context()returns jsonb language plpgsql stable as $$begin return nullif(current_setting('workos.calendar_scope_authoring_context',true),'')::jsonb;exception when others then return null;end $$;
create function guard_calendar_scope_authoring_append()returns trigger language plpgsql as $$
declare ctx jsonb=calendar_scope_authoring_context();l calendar_scope_authoring_lineages;prior calendar_scope_authoring_versions;h jsonb;current_authority jsonb;
begin
 if not calendar_authoring_actor(ctx)or new.organization_id is distinct from ctx->>'organizationId'or new.legal_entity_id is distinct from ctx->>'legalEntityId'or new.actor_id::text is distinct from ctx->>'actorId'or new.active_role is distinct from ctx->>'activeRole'or new.created_at<statement_timestamp()or new.created_at>clock_timestamp()then raise exception 'Use current scoped calendar authority.'using errcode='SCA01';end if;
 if tg_table_name='calendar_scope_authoring_lineages'then
  if new.id::text is distinct from ctx->>'lineageId'or new.applicability_type is distinct from ctx->>'applicabilityType'or new.reference_id is distinct from ctx->>'referenceId'or exists(select 1 from working_calendars c where c.organization_id=new.organization_id and c.applicability_type=new.applicability_type and c.code=new.code and(case when new.applicability_type='country'then c.country_code=new.reference_id else c.worker_group_id=new.reference_id end))then raise exception 'Existing or retired calendar keys cannot be adopted implicitly.'using errcode='SCA02';end if;return new;
 end if;
 select * into l from calendar_scope_authoring_lineages where id=new.lineage_id for update;select * into prior from calendar_scope_authoring_versions where lineage_id=l.id order by sequence desc limit 1;
 if new.id::text is distinct from ctx->>'versionId'or new.lineage_id::text is distinct from ctx->>'lineageId'or new.calendar_id is distinct from ctx->>'calendarId'or new.request_id::text is distinct from ctx->>'requestId'or new.operation_id is distinct from ctx->>'operationId'or new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_version_id is distinct from prior.id or new.effective_from<=(clock_timestamp()at time zone'UTC')::date or(prior.id is not null and new.effective_from<=prior.effective_from)then raise exception 'Calendar source is stale or not prospective.'using errcode='SCA02';end if;
 current_authority=calendar_scope_authority(l.applicability_type,l.reference_id,l.organization_id,l.legal_entity_id,new.effective_from);
 if current_authority is null or new.authority is distinct from current_authority then raise exception 'Selected country or group authority changed or is unavailable.'using errcode='SCA03';end if;
 if jsonb_typeof(new.command)is distinct from'object'or not(new.command?&array['requestId','lineageId','expectedLatestId','applicability','expectedAuthorityToken','code','effectiveFrom','definition','reason'])or new.command-array['requestId','lineageId','expectedLatestId','applicability','expectedAuthorityToken','code','effectiveFrom','definition','reason']<>'{}'::jsonb
  or new.command->>'requestId'is distinct from new.request_id::text or new.command->>'lineageId'is distinct from(case when prior.id is null then null else l.id::text end)or new.command->>'expectedLatestId'is distinct from prior.id::text or new.command->'applicability'is distinct from jsonb_build_object('type',l.applicability_type,'referenceId',l.reference_id)or new.command->>'expectedAuthorityToken'is distinct from new.authority_token or new.command->>'code'is distinct from l.code or new.command->>'effectiveFrom'is distinct from to_char(new.effective_from,'YYYY-MM-DD')or new.command->'definition'is distinct from new.definition or new.command->>'reason'is distinct from new.reason then raise exception 'Retain the complete exact scoped calendar command.'using errcode='SCA03';end if;
 for h in select * from jsonb_array_elements(new.definition->'holidays')loop if(h->>'date')::date<new.effective_from then raise exception 'Holiday precedes calendar authority.'using errcode='SCA03';end if;end loop;return new;
end $$;
create trigger guarded_calendar_scope_lineage before insert on calendar_scope_authoring_lineages for each row execute function guard_calendar_scope_authoring_append();
create trigger guarded_calendar_scope_version before insert on calendar_scope_authoring_versions for each row execute function guard_calendar_scope_authoring_append();
create trigger immutable_calendar_scope_lineage before update or delete on calendar_scope_authoring_lineages for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_calendar_scope_version before update or delete on calendar_scope_authoring_versions for each row execute function reject_commercial_draft_rewrite();
create function validate_calendar_scope_lineage_commit()returns trigger language plpgsql as $$begin if not exists(select 1 from calendar_scope_authoring_versions where lineage_id=new.id and sequence=1 and actor_id=new.actor_id and active_role=new.active_role)then raise exception 'Create the complete first calendar version atomically.'using errcode='SCA05';end if;return null;end $$;
create constraint trigger calendar_scope_lineage_commit after insert on calendar_scope_authoring_lineages deferrable initially deferred for each row execute function validate_calendar_scope_lineage_commit();

create function guard_calendar_scope_projection()returns trigger language plpgsql as $$
declare ctx jsonb=calendar_scope_authoring_context();l calendar_scope_authoring_lineages;v calendar_scope_authoring_versions;prior calendar_scope_authoring_versions;owner_leg text;
begin
 if tg_table_name='working_calendars'then
  if tg_op<>'DELETE'and new.applicability_type in('country','worker_group')then
   perform pg_advisory_xact_lock(hashtext('calendar:'||new.organization_id||':'||new.applicability_type||':'||coalesce(new.country_code,new.worker_group_id)||':'||new.code));
  end if;
  if tg_op<>'INSERT'then select x.* into l from calendar_scope_authoring_lineages x join calendar_scope_authoring_versions a on a.lineage_id=x.id where a.calendar_id=old.id;end if;
  if l.id is null and tg_op<>'DELETE'then select * into l from calendar_scope_authoring_lineages where organization_id=new.organization_id and applicability_type=new.applicability_type and reference_id=coalesce(new.country_code,new.worker_group_id)and code=new.code;end if;
 else
  if tg_op<>'INSERT'then select x.* into l from calendar_scope_authoring_lineages x join calendar_scope_authoring_versions a on a.lineage_id=x.id where a.calendar_id=old.calendar_id;end if;
  if l.id is null and tg_op<>'DELETE'then select x.* into l from calendar_scope_authoring_lineages x join calendar_scope_authoring_versions a on a.lineage_id=x.id where a.calendar_id=new.calendar_id;end if;
 end if;
 if l.id is null then if tg_op='DELETE'then return old;else return new;end if;end if;
 if not calendar_authoring_actor(ctx)or ctx->>'lineageId'is distinct from l.id::text then raise exception 'Use governed country/group calendar authoring; source bypass refused.'using errcode='SCA04';end if;
 select * into v from calendar_scope_authoring_versions where id::text=ctx->>'versionId'and lineage_id=l.id;select * into prior from calendar_scope_authoring_versions where id=v.previous_version_id;
 if v.id is null then raise exception 'Matching complete scoped calendar version required.'using errcode='SCA04';end if;
 if tg_table_name='working_calendars'and tg_op='UPDATE'and old.id=prior.calendar_id and new.effective_to=v.effective_from-1 and(to_jsonb(new)-'effective_to')=(to_jsonb(old)-'effective_to')then return new;end if;
 if tg_op<>'INSERT'then raise exception 'Scoped calendar and holiday history is immutable.'using errcode='SCA04';end if;
 if tg_table_name='working_calendars'then
  if new.id<>v.calendar_id or new.organization_id<>l.organization_id or new.legal_entity_id is not null or new.applicability_type<>l.applicability_type or new.code<>l.code or new.name<>v.definition->>'name'or new.timezone<>v.definition->>'timezone'or to_jsonb(new.working_days)<>v.definition->'workingDays'or new.hours_per_day<>(v.definition->>'hoursPerDayExact')::numeric or new.effective_from<>v.effective_from or new.effective_to is not null or not new.active
   or(l.applicability_type='country'and(new.country_code is distinct from l.reference_id or new.country_authority_legal_entity_id is distinct from l.legal_entity_id or new.worker_group_id is not null))or(l.applicability_type='worker_group'and(new.worker_group_id is distinct from l.reference_id or new.country_code is not null or new.country_authority_legal_entity_id is not null))then raise exception 'Project the exact scoped calendar and authority.'using errcode='SCA04';end if;
 else
  if new.calendar_id<>v.calendar_id or new.organization_id<>l.organization_id or new.effective_from<>v.effective_from or new.effective_to is not null or not new.active or new.created_by is distinct from v.actor_id or not exists(select 1 from jsonb_array_elements(v.definition->'holidays')q where(q->>'date')::date=new.holiday_date and q->>'label'=new.label and q->>'type'=new.holiday_type)then raise exception 'Project the exact scoped holiday bundle.'using errcode='SCA04';end if;
 end if;return new;
end $$;
create trigger calendar_scope_projection before insert or update or delete on working_calendars for each row execute function guard_calendar_scope_projection();
create trigger calendar_scope_holiday_projection before insert or update or delete on working_calendar_holidays for each row execute function guard_calendar_scope_projection();
create constraint trigger calendar_scope_projection_commit after insert or update or delete on working_calendars deferrable initially deferred for each row execute function guard_calendar_scope_projection();
create constraint trigger calendar_scope_holiday_commit after insert or update or delete on working_calendar_holidays deferrable initially deferred for each row execute function guard_calendar_scope_projection();
create function validate_calendar_scope_commit()returns trigger language plpgsql as $$
declare c working_calendars;l calendar_scope_authoring_lineages;expected_end date;
begin
 select * into c from working_calendars where id=new.calendar_id;select * into l from calendar_scope_authoring_lineages where id=new.lineage_id;select min(effective_from)-1 into expected_end from calendar_scope_authoring_versions where lineage_id=new.lineage_id and sequence>new.sequence;
 if c.id is null or c.organization_id<>new.organization_id or c.legal_entity_id is not null or c.code<>l.code or c.applicability_type<>l.applicability_type or c.name<>new.definition->>'name'or c.timezone<>new.definition->>'timezone'or to_jsonb(c.working_days)<>new.definition->'workingDays'or c.hours_per_day<>(new.definition->>'hoursPerDayExact')::numeric or c.effective_from<>new.effective_from or c.effective_to is distinct from expected_end or not c.active
  or(l.applicability_type='country'and(c.country_code is distinct from l.reference_id or c.country_authority_legal_entity_id is distinct from l.legal_entity_id or c.worker_group_id is not null))or(l.applicability_type='worker_group'and(c.worker_group_id is distinct from l.reference_id or c.country_code is not null or c.country_authority_legal_entity_id is not null))then raise exception 'Complete exact scoped calendar projection required.'using errcode='SCA05';end if;
 if new.authority is distinct from calendar_scope_authority(l.applicability_type,l.reference_id,l.organization_id,l.legal_entity_id,new.effective_from)then raise exception 'Selected calendar authority changed before commit.'using errcode='SCA03';end if;
 if(select count(*)from working_calendar_holidays where calendar_id=c.id)<>jsonb_array_length(new.definition->'holidays')or exists(select 1 from jsonb_array_elements(new.definition->'holidays')q where not exists(select 1 from working_calendar_holidays h where h.calendar_id=c.id and h.organization_id=new.organization_id and h.holiday_date=(q->>'date')::date and h.label=q->>'label'and h.holiday_type=q->>'type'and h.effective_from=new.effective_from and h.effective_to is null and h.active))then raise exception 'Complete exact scoped holiday projection required.'using errcode='SCA05';end if;
 if new.previous_version_id is not null and not exists(select 1 from calendar_scope_authoring_versions p join working_calendars pc on pc.id=p.calendar_id where p.id=new.previous_version_id and pc.effective_to=new.effective_from-1)then raise exception 'Retain the previous scoped calendar boundary.'using errcode='SCA05';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.module='Calendar Scope Authoring'and a.entity_id=new.id::text and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.operation_id=new.operation_id and a.reason=new.reason and a.new_value->>'versionId'=new.id::text and a.new_value->'definition'=new.definition and a.new_value->'authority'=new.authority)then raise exception 'Atomic scoped calendar audit required.'using errcode='SCA05';end if;return null;
end $$;
create constraint trigger calendar_scope_version_commit after insert on calendar_scope_authoring_versions deferrable initially deferred for each row execute function validate_calendar_scope_commit();
