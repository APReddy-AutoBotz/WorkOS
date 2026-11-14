-- Optional buyer configuration only; no default policy, work/history rewrite or grant.
alter table work_capture_policy_versions add column overtime_rule jsonb;
alter table import_export_logs add column capture_warnings jsonb check(capture_warnings is null or jsonb_typeof(capture_warnings)='array');
create function valid_capture_overtime_rule(rule jsonb) returns boolean language plpgsql immutable as $$
declare value text; cap numeric; key text;
begin
 if rule is null then return true;end if;
 if jsonb_typeof(rule)<>'object' or not(rule ?& array['action','dailyThreshold','weeklyThreshold']) or rule-array['action','dailyThreshold','weeklyThreshold']<>'{}'::jsonb then return false;end if;
 if rule->>'action'='off' then return rule->'dailyThreshold'='null'::jsonb and rule->'weeklyThreshold'='null'::jsonb;end if;
 if rule->>'action' not in ('warn','block') or coalesce(rule->>'action','')='' or (rule->'dailyThreshold'='null'::jsonb and rule->'weeklyThreshold'='null'::jsonb) then return false;end if;
 foreach key in array array['dailyThreshold','weeklyThreshold'] loop
  if rule->key='null'::jsonb then continue;end if;
  value=rule->>key;cap=case when key='dailyThreshold' then 24 else 168 end;
  if jsonb_typeof(rule->key)<>'string' or value!~'^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$' then return false;end if;
  if value::numeric<=0 or value::numeric>cap then return false;end if;
 end loop;return true;
end $$;
alter table work_capture_policy_versions add constraint work_capture_overtime_shape check(valid_capture_overtime_rule(overtime_rule));

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
 -- Omitted legacy commands inherit; an explicit off object disables prospectively.
 if new.overtime_rule is null then new.overtime_rule=latest.overtime_rule;end if;
 return new;
end $$;

-- Bulk current-warning projection: one scan per affected worker/Weekly period,
-- not one request/query per returned header. No other header hours are exposed.
create function work_capture_overtime_warnings(targets uuid[]) returns jsonb language sql stable as $$
 with applicable as (
  select distinct t.id,t.organization_id,t.legal_entity_id,t.employee_id,e.work_date,r.id policy_id,r.overtime_rule rule
  from timesheets t join timesheet_entries e on e.timesheet_id=t.id
  join lateral(select p.id,p.overtime_rule from work_capture_policy_versions p where p.organization_id=t.organization_id and p.legal_entity_id=t.legal_entity_id and p.effective_from<=e.work_date order by p.effective_from desc limit 1) r on true
  where t.id=any(targets) and r.overtime_rule->>'action' in ('warn','block')
 ), unavailable as (
  select distinct a.id from applicable a where (select count(*) from reporting_periods p where p.organization_id=a.organization_id and p.legal_entity_id=a.legal_entity_id and p.frequency='Weekly' and a.work_date between p.starts_on and p.ends_on)<>1
 ), target_dates as (
  select a.*,p.id period_id,p.code period_code,p.starts_on,p.ends_on from applicable a
  join reporting_periods p on p.organization_id=a.organization_id and p.legal_entity_id=a.legal_entity_id and p.frequency='Weekly' and a.work_date between p.starts_on and p.ends_on
  where not exists(select 1 from unavailable u where u.id=a.id)
 ), affected as (select distinct organization_id,legal_entity_id,employee_id,period_id,starts_on,ends_on from target_dates),
 daily as (
  select a.organization_id,a.legal_entity_id,a.employee_id,a.period_id,e.work_date,sum(e.hours) daily_total
  from affected a join timesheets t on t.organization_id=a.organization_id and t.legal_entity_id=a.legal_entity_id and t.employee_id=a.employee_id
  join timesheet_entries e on e.timesheet_id=t.id and e.work_date between a.starts_on and a.ends_on
  group by a.organization_id,a.legal_entity_id,a.employee_id,a.period_id,e.work_date
 ), totals as(select *,sum(daily_total) over(partition by organization_id,legal_entity_id,employee_id,period_id) weekly_total from daily),
 checked as (
  select d.id,d.work_date,d.period_id,d.period_code,q.daily_total,q.weekly_total,d.policy_id,d.rule
  from target_dates d join totals q on q.organization_id=d.organization_id and q.legal_entity_id=d.legal_entity_id and q.employee_id=d.employee_id and q.period_id=d.period_id and q.work_date=d.work_date
 ), conditions as (
  select id,policy_id,'daily' kind,work_date,period_code,rule from checked where daily_total>(rule->>'dailyThreshold')::numeric
  union
  select id,policy_id,'weekly' kind,null::date,period_code,rule from checked where weekly_total>(rule->>'weeklyThreshold')::numeric
 ), grouped as (
  select id,jsonb_agg(jsonb_build_object('version','overtime-capture/1','policyId',policy_id,'action',rule->>'action','kind',kind,'workDate',work_date::text,'periodCode',period_code,'threshold',rule->>(case when kind='daily' then 'dailyThreshold' else 'weeklyThreshold' end)) order by period_code,kind,work_date,policy_id) warnings
  from conditions group by id
 ), result as (select id,warnings from grouped union all select id,null::jsonb warnings from unavailable)
 select coalesce(jsonb_object_agg(id::text,warnings),'{}'::jsonb) from result
$$;
create function assert_capture_overtime(target uuid) returns void language plpgsql as $$
declare warnings jsonb;
begin
 warnings=work_capture_overtime_warnings(array[target])->target::text;
 if warnings='null'::jsonb then raise exception 'Overtime policy requires unambiguous Weekly period authority.' using errcode='WCR05';end if;
 if exists(select 1 from jsonb_array_elements(coalesce(warnings,'[]'::jsonb)) w where w->>'action'='block') then
  raise exception 'Recorded work exceeds the effective blocking overtime threshold.' using errcode='WOT01';
 end if;
end $$;
-- Existing before-writer scope/worker locks and original guards stay untouched.
create function validate_overtime_entry_state() returns trigger language plpgsql as $$
begin perform assert_capture_overtime(case when tg_op='DELETE' then old.timesheet_id else new.timesheet_id end);return null;end $$;
create constraint trigger capture_overtime_entry_state after insert or update or delete on timesheet_entries deferrable initially deferred for each row execute function validate_overtime_entry_state();
create function validate_overtime_header_state() returns trigger language plpgsql as $$
begin
 if tg_op='INSERT' then perform assert_capture_overtime(new.id);
 elsif new.employee_id is distinct from old.employee_id or new.organization_id is distinct from old.organization_id or new.legal_entity_id is distinct from old.legal_entity_id then perform assert_capture_overtime(new.id);end if;
 return null;
end $$;
create constraint trigger capture_overtime_header_state after insert or update on timesheets deferrable initially deferred for each row execute function validate_overtime_header_state();
