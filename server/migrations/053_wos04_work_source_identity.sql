-- Explicit create/conflict contract only. No inferred identities, backfill or grants.
alter table timesheet_entries add column source_identity jsonb;
create function valid_work_source_check(value jsonb) returns boolean language plpgsql immutable as $$
begin
 if value is null then return true;end if;
 if jsonb_typeof(value)<>'object' or not(value ?& array['version','linkedEntries','mode']) or value-array['version','linkedEntries','mode']<>'{}'::jsonb or value->>'version' is distinct from 'work-source/1' or coalesce(value->>'mode','') not in ('preview','apply') or jsonb_typeof(value->'linkedEntries')<>'number' or (value->>'linkedEntries')!~'^[0-9]+$' then return false;end if;
 return (value->>'linkedEntries')::numeric between 0 and 9007199254740991;
end $$;
alter table import_export_logs add column source_identity_check jsonb check(valid_work_source_check(source_identity_check));
create function protect_work_source_check() returns trigger language plpgsql as $$
begin if new.source_identity_check is distinct from old.source_identity_check then raise exception 'Recorded source validation cannot be rewritten or inferred later.' using errcode='23514';end if;return new;end $$;
create trigger immutable_work_source_check before update on import_export_logs for each row execute function protect_work_source_check();

create function valid_work_source_identity(value jsonb) returns boolean language plpgsql immutable as $$
declare namespace text; external_id text;
begin
 if value is null then return true;end if;
 if jsonb_typeof(value)<>'object' or not(value ?& array['namespace','externalId']) or value-array['namespace','externalId']<>'{}'::jsonb or jsonb_typeof(value->'namespace')<>'string' or jsonb_typeof(value->'externalId')<>'string' then return false;end if;
 namespace=value->>'namespace';external_id=value->>'externalId';
 return namespace collate "C"~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' and char_length(external_id) between 1 and 200
 and external_id collate "C"!~U&'[\0001-\001F\007F-\009F\2028\2029]'
 and external_id collate "C"!~U&'^[\0020\00A0\1680\2000-\200A\202F\205F\3000\FEFF]|[\0020\00A0\1680\2000-\200A\202F\205F\3000\FEFF]$';
end $$;
alter table timesheet_entries add constraint timesheet_entry_source_identity_shape check(valid_work_source_identity(source_identity));
create table work_entry_source_claims (
 organization_id text not null,legal_entity_id text not null,
 namespace text collate "C" not null,external_id text collate "C" not null,
 timesheet_id uuid not null references timesheets(id) on delete restrict,
 payload jsonb not null,created_at timestamptz not null default now(),
 primary key(organization_id,legal_entity_id,namespace,external_id),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict
);
create index ix_work_source_claim_header on work_entry_source_claims(timesheet_id);
create trigger immutable_work_source_claim before update or delete on work_entry_source_claims for each row execute function reject_commercial_draft_rewrite();
-- Explicit allowlist/version: generated entry IDs, last-writer context, policy
-- references and future nullable columns never change the source fingerprint.
create function work_source_payload(worker text,week_ending date,entry jsonb) returns jsonb language sql immutable as $$
 select jsonb_build_object('version','work-source/1','employeeId',worker,'weekEnding',week_ending,
 'workDate',(entry->>'work_date')::date,'workType',entry->>'work_type','projectId',nullif(entry->>'project_id',''),
 'clientName',nullif(entry->>'client_name',''),'category',nullif(entry->>'category',''),'hours',(entry->>'hours')::numeric,
 'billable',(entry->>'billable')::boolean,'remark',nullif(entry->>'remark',''),'evidenceUrl',nullif(entry->>'evidence_url',''),'workReference',nullif(entry->>'work_reference',''))
$$;
create function register_work_source_entry() returns trigger language plpgsql as $$
declare header timesheets; existing work_entry_source_claims; material jsonb;
begin
 if new.source_identity is null then return new;end if;
 select * into header from timesheets where id=new.timesheet_id;
 material=work_source_payload(header.employee_id,header.week_ending,to_jsonb(new));
 select * into existing from work_entry_source_claims where organization_id=header.organization_id and legal_entity_id=header.legal_entity_id and namespace=new.source_identity->>'namespace' and external_id=new.source_identity->>'externalId';
 if found then
  if existing.timesheet_id<>header.id or existing.payload<>material then raise exception 'Source identity is already captured or content differs.' using errcode='WSI01';end if;
 else
  insert into work_entry_source_claims(organization_id,legal_entity_id,namespace,external_id,timesheet_id,payload) values(header.organization_id,header.legal_entity_id,new.source_identity->>'namespace',new.source_identity->>'externalId',header.id,material);
 end if;return new;
end $$;
create trigger register_work_source_entry after insert or update on timesheet_entries for each row execute function register_work_source_entry();
create function assert_work_source_header(target uuid) returns void language plpgsql as $$
declare header timesheets;
begin
 select * into header from timesheets where id=target;if not found then return;end if;
 if exists(select 1 from timesheet_entries e where e.timesheet_id=target and e.source_identity is not null group by e.source_identity having count(*)>1) then raise exception 'A source identity may appear only once in recorded work.' using errcode='WSI01';end if;
 if exists(select 1 from work_entry_source_claims c where c.timesheet_id=target and (c.organization_id<>header.organization_id or c.legal_entity_id<>header.legal_entity_id or (select count(*) from timesheet_entries e where e.timesheet_id=target and e.source_identity->>'namespace'=c.namespace and e.source_identity->>'externalId'=c.external_id and work_source_payload(header.employee_id,header.week_ending,to_jsonb(e))=c.payload)<>1)) then raise exception 'Recorded source-linked work cannot be changed, cleared, removed or rebound.' using errcode='WSI02';end if;
end $$;
create function validate_work_source_entry_state() returns trigger language plpgsql as $$
begin
 if tg_op<>'INSERT' then perform assert_work_source_header(old.timesheet_id);end if;
 if tg_op<>'DELETE' then perform assert_work_source_header(new.timesheet_id);end if;return null;
end $$;
create constraint trigger work_source_entry_state after insert or update or delete on timesheet_entries deferrable initially deferred for each row execute function validate_work_source_entry_state();
create function validate_work_source_header_state() returns trigger language plpgsql as $$
begin perform assert_work_source_header(new.id);return null;end $$;
create constraint trigger work_source_header_state after insert or update on timesheets deferrable initially deferred for each row execute function validate_work_source_header_state();
-- Claims can only register matching actual work, never a free-standing key reservation.
create function validate_work_source_claim_insert() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from timesheets t join timesheet_entries e on e.timesheet_id=t.id where t.id=new.timesheet_id and t.organization_id=new.organization_id and t.legal_entity_id=new.legal_entity_id and e.source_identity->>'namespace'=new.namespace and e.source_identity->>'externalId'=new.external_id and work_source_payload(t.employee_id,t.week_ending,to_jsonb(e))=new.payload) then raise exception 'Source claims require matching scoped work.' using errcode='WSI02';end if;return new;
end $$;
create trigger validate_work_source_claim before insert on work_entry_source_claims for each row execute function validate_work_source_claim_insert();
