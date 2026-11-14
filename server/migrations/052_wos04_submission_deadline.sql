-- Additive optional configuration and immutable timing evidence; no backfill/default/grant.
alter table work_capture_policy_versions add column submission_deadline jsonb;
alter table work_submission_evidence add column submission_timing jsonb check(submission_timing is null or jsonb_typeof(submission_timing)='array');
alter table import_export_logs add column submission_timing jsonb check(submission_timing is null or jsonb_typeof(submission_timing)='array');
create function valid_submission_deadline(rule jsonb) returns boolean language plpgsql immutable as $$
begin
 if rule is null or rule='{"enabled":false}'::jsonb then return true;end if;
 if jsonb_typeof(rule)<>'object' or not(rule ?& array['anchor','timezone','daysAfterPeriodEnd','time','graceMinutes','lateTreatment']) or rule-array['anchor','timezone','daysAfterPeriodEnd','time','graceMinutes','lateTreatment']<>'{}'::jsonb then return false;end if;
 if rule->>'anchor' is distinct from 'weekly-end-date' or rule->>'timezone' is distinct from 'UTC' or coalesce(rule->>'lateTreatment','') not in ('warn','block') or coalesce(rule->>'time','')!~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then return false;end if;
 if jsonb_typeof(rule->'daysAfterPeriodEnd')<>'number' or (rule->>'daysAfterPeriodEnd')!~'^[0-9]+$' or jsonb_typeof(rule->'graceMinutes')<>'number' or (rule->>'graceMinutes')!~'^[0-9]+$' then return false;end if;
 return (rule->>'daysAfterPeriodEnd')::numeric between 0 and 366 and (rule->>'graceMinutes')::numeric between 0 and 527040;
end $$;
alter table work_capture_policy_versions add constraint work_capture_deadline_shape check(valid_submission_deadline(submission_deadline));
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
 if new.submission_deadline is null then new.submission_deadline=latest.submission_deadline;end if;
 return new;
end $$;


-- One statement/snapshot per date set. A caller-provided instant is available for
-- deterministic arithmetic tests; production routes/guards never accept one.
create function work_submission_timing(organization text,legal_entity text,dates date[],evaluated_at timestamptz default clock_timestamp()) returns jsonb language sql stable as $$
 with requested as(select distinct unnest(dates) work_date),
 authority as(select d.work_date,count(p.id) count from requested d left join reporting_periods p on p.organization_id=organization and p.legal_entity_id=legal_entity and p.frequency='Weekly' and d.work_date between p.starts_on and p.ends_on group by d.work_date),
 applicable as(select distinct p.id,p.code,p.starts_on,p.ends_on,r.id policy_id,r.submission_deadline rule
 from requested d join reporting_periods p on p.organization_id=organization and p.legal_entity_id=legal_entity and p.frequency='Weekly' and d.work_date between p.starts_on and p.ends_on
 join lateral(select id,submission_deadline from work_capture_policy_versions where organization_id=organization and legal_entity_id=legal_entity and effective_from<=p.starts_on order by effective_from desc limit 1) r on true
 where r.submission_deadline is not null and r.submission_deadline<>'{"enabled":false}'::jsonb),
 calculated as(select *,((ends_on+(rule->>'daysAfterPeriodEnd')::integer)+(rule->>'time')::time) at time zone 'UTC' deadline_at from applicable),
 grace as(select *,deadline_at+(rule->>'graceMinutes')::integer*interval '1 minute' grace_ends_at from calculated)
 select case when exists(select 1 from authority a where count<>1 and exists(select 1 from lateral(select submission_deadline rule from work_capture_policy_versions where organization_id=organization and legal_entity_id=legal_entity and effective_from<=a.work_date order by effective_from desc limit 1) p where p.rule is not null and p.rule<>'{"enabled":false}'::jsonb)) then null::jsonb else coalesce((select jsonb_agg(jsonb_build_object('version','submission-deadline/1','policyId',policy_id,'periodId',id,'periodCode',code,'timezone','UTC','checkedAt',evaluated_at,'deadlineAt',deadline_at,'graceEndsAt',grace_ends_at,'lateTreatment',rule->>'lateTreatment','state',case when evaluated_at<=deadline_at then 'before-deadline' when evaluated_at<=grace_ends_at then 'grace' else 'overdue' end) order by starts_on,id) from grace),'[]'::jsonb) end
$$;
create function validate_submission_deadline_state() returns trigger language plpgsql as $$
declare header timesheets; checks jsonb;
begin
 if new.status<>'Submitted' then return null;end if;
 if tg_op='UPDATE' and old.status='Submitted' then return null;end if;
 select * into header from timesheets where id=new.id;if not found then return null;end if;
 select work_submission_timing(header.organization_id,header.legal_entity_id,array[header.week_ending]||coalesce(array_agg(e.work_date),'{}'::date[])) into checks from timesheet_entries e where e.timesheet_id=header.id;
 if checks is null then raise exception 'Submission timing requires unambiguous Weekly authority.' using errcode='WDL02';end if;
 if exists(select 1 from jsonb_array_elements(checks) c where c->>'state'='overdue' and c->>'lateTreatment'='block') then raise exception 'Submission deadline and grace have elapsed.' using errcode='WDL01';end if;
 return null;
end $$;
create constraint trigger submission_deadline_state after insert or update on timesheets deferrable initially deferred for each row execute function validate_submission_deadline_state();
