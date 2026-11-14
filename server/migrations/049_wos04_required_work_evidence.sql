-- Additive buyer option: old immutable policies remain NULL/optional.
-- No defaults, grants, work rewrite or historical reference backfill.
alter table work_capture_policy_versions add column evidence_required boolean;

create or replace function validate_capture_policy_append() returns trigger language plpgsql as $$
declare latest work_capture_policy_versions;
begin
 perform pg_advisory_xact_lock(hashtextextended('commercial-lifecycle:'||new.organization_id||':'||new.legal_entity_id,0));
 select * into latest from work_capture_policy_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id order by sequence desc limit 1;
 if new.sequence<>coalesce(latest.sequence,0)+1 or (latest.id is not null and new.effective_from<=latest.effective_from)
   or new.effective_from<(now() at time zone 'UTC')::date then
   raise exception 'Capture policy must append at a new prospective effective date.' using errcode='WCR01';
 end if;
 perform 1 from reporting_periods where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and frequency='Weekly' and starts_on=new.effective_from for share;
 if not found then
   raise exception 'Capture policy activation must align with an authoritative Weekly period start.' using errcode='WCR02';
 end if;
 -- Older API/SQL commands omit this new option: preserve the latest choice.
 if new.evidence_required is null then new.evidence_required=coalesce(latest.evidence_required,false);end if;
 return new;
end $$;

create or replace function assert_capture_header_policy(target uuid) returns void language plpgsql as $$
declare header timesheets; invalid boolean; at_date date;
begin
 select * into header from timesheets where id=target;
 if header.id is null then return; end if;
 for at_date in select distinct e.work_date from timesheet_entries e where e.timesheet_id=header.id order by e.work_date loop
   perform assert_capture_date_open(header.organization_id,header.legal_entity_id,at_date);
 end loop;
 if exists(select 1 from timesheet_entries e where e.timesheet_id=header.id
   and exists(select 1 from work_capture_policy_versions p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.effective_from<=e.work_date)
   and (not exists(select 1 from reporting_periods p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.frequency='Weekly' and e.work_date between p.starts_on and p.ends_on)
     or exists(select 1 from reporting_periods p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and e.work_date between p.starts_on and p.ends_on and p.status<>'Open'))) then
   raise exception 'Effective capture policy requires open authoritative reporting periods.' using errcode='WCR05';
 end if;
 select exists(select 1 from timesheet_entries e join lateral (
   select p.* from work_capture_policy_versions p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.effective_from<=e.work_date order by p.effective_from desc limit 1
 ) p on true where e.timesheet_id=header.id and (mod(e.hours,p.minimum_increment)<>0 or (p.comment_required and e.hours>0 and btrim(coalesce(e.remark,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')=''))) into invalid;
 if invalid then raise exception 'Work entry violates its effective increment or comment policy.' using errcode='WCR03'; end if;
 if exists(select 1 from timesheet_entries e join lateral (
   select p.evidence_required from work_capture_policy_versions p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.effective_from<=e.work_date order by p.effective_from desc limit 1
 ) p on true where e.timesheet_id=header.id and p.evidence_required and e.hours>0 and e.evidence_url is null) then
   raise exception 'Positive work entry requires an evidence URL under its effective policy.' using errcode='WCR06';
 end if;
 -- All headers and all current work states count exactly once. Caller-provided
 -- week_ending is not authority for an aggregate limit.
 with affected as (select distinct p.id,p.starts_on,p.ends_on from timesheet_entries e join reporting_periods p on p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.frequency='Weekly' and e.work_date between p.starts_on and p.ends_on where e.timesheet_id=header.id),
 quantities as (select p.id period_id,e.work_date,sum(e.hours) daily_total from affected p join timesheet_entries e on e.work_date between p.starts_on and p.ends_on join timesheets t on t.id=e.timesheet_id and t.organization_id=header.organization_id and t.legal_entity_id=header.legal_entity_id and t.employee_id=header.employee_id group by p.id,e.work_date),
 totals as (select *,sum(daily_total) over(partition by period_id) weekly_total from quantities)
 select exists(select 1 from totals q join lateral (select p.daily_maximum,p.weekly_maximum from work_capture_policy_versions p where p.organization_id=header.organization_id and p.legal_entity_id=header.legal_entity_id and p.effective_from<=q.work_date order by p.effective_from desc limit 1) p on true
   where (p.daily_maximum is not null and q.daily_total>p.daily_maximum) or (p.weekly_maximum is not null and q.weekly_total>p.weekly_maximum)) into invalid;
 if invalid then raise exception 'Worker aggregate exceeds the effective daily or Weekly period limit.' using errcode='WCR04'; end if;
 return;
end $$;
