-- Match the shared renderer in one pass. A source value containing braces is literal text.
create function render_stage_overdue_text(pattern text, worker text, source_ref text, stage_number integer)
returns text language sql immutable strict set search_path = pg_catalog,public,pg_temp as $$
  select coalesce(string_agg(case part[1]
    when '{{workerCode}}' then worker when '{{sourceRef}}' then source_ref
    when '{{stageNumber}}' then stage_number::text when '{{decisionReason}}' then ''
    else part[1] end,'' order by position),'')
  from regexp_matches(pattern,'([{][{](?:workerCode|sourceRef|stageNumber|decisionReason)[}][}]|[^{]+|[{])','g')
    with ordinality token(part,position);
$$;

create function valid_stage_overdue_message(d jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog,public,pg_temp as $$
declare t jsonb:=d->'overdueTemplate'; field text; raw text; rendered text;
begin
  if not(d?'overdueTemplate') then return true; end if;
  if not(d?'stageDueMinutes') or jsonb_typeof(t) is distinct from 'object'
     or not(t ?& array['key','subject','body']) or t-array['key','subject','body']<>'{}'::jsonb
     or t->>'key' is distinct from 'approval.overdue_or_escalated' then return false; end if;
  foreach field in array array['subject','body'] loop
    raw:=t->>field;
    if jsonb_typeof(t->field) is distinct from 'string' or length(raw) not between 1 and
      (case when field='subject' then 200 else 8000 end)
      or regexp_replace(raw,'[{][{](workerCode|sourceRef|stageNumber|decisionReason)[}][}]','','g')~'[{}]'
      or raw ~ '^[[:space:]]|[[:space:]]$'
      or translate(raw,chr(9)||chr(10)||chr(13),'') ~ '[[:cntrl:]]' then return false; end if;
    rendered:=render_stage_overdue_text(raw,repeat('w',200),
      repeat('s',case when d->>'entityType'='LeaveRequest' then 239 else 250 end),10);
    if length(rendered) not between 1 and (case when field='subject' then 1200 else 12000 end)
       or rendered ~ '^[[:space:]]|[[:space:]]$' then return false; end if;
  end loop;
  return true;
end $$;

create or replace function valid_assignment_approval_definition(d jsonb)returns boolean language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
 if not valid_stage_overdue_message(d) or not valid_approval_escalation_target(d) or not valid_approval_stage_reminder(d) or not valid_approval_stage_duration(d) or not valid_work_approval_definition((d-'overdueTemplate'-'escalationUserId'-'reminderLeadMinutes'-'stageDueMinutes'-'materialFields'-'creationRequired')||jsonb_build_object('entityType','Timesheet')) or d->>'entityType'is distinct from'Assignment' or jsonb_typeof(d->'materialFields')is distinct from'array' or jsonb_array_length(d->'materialFields')not between 0 and 7 or(jsonb_array_length(d->'materialFields')=0 and not(d?'creationRequired'))or(d?'creationRequired'and jsonb_typeof(d->'creationRequired')is distinct from'boolean') or length(d->>'locale')>100 then return false;end if;
 if(select count(distinct v)from jsonb_array_elements_text(d->'materialFields')v)<>jsonb_array_length(d->'materialFields')then return false;end if;
 for k in select jsonb_array_elements_text(d->'materialFields')loop if k not in('billable','comment','endsOn','quantityExact','role','startsOn','status')then return false;end if;end loop;return true;
exception when others then return false;end $$;

create or replace function valid_leave_approval_definition(d jsonb)returns boolean language sql immutable set search_path = pg_catalog, public, pg_temp as $$
 select coalesce(d->>'entityType'='LeaveRequest'and valid_stage_overdue_message(d) and valid_approval_escalation_target(d) and valid_approval_stage_reminder(d) and valid_approval_stage_duration(d) and valid_work_approval_definition((d-'overdueTemplate'-'escalationUserId'-'reminderLeadMinutes'-'stageDueMinutes')||jsonb_build_object('entityType','Timesheet')),false);
$$;

alter table assignment_leave_overdue_attempts drop constraint assignment_leave_overdue_attempts_failure_check;
alter table assignment_leave_overdue_attempts add constraint assignment_leave_overdue_attempts_failure_check
 check (failure in ('RECIPIENT_UNAVAILABLE','TEMPLATE_UNAVAILABLE'));

create function render_assignment_leave_overdue_receipt() returns trigger language plpgsql as $$
declare s assignment_leave_overdue_sources; original_policy uuid; worker text; reference text; template jsonb;
begin
 select * into strict s from assignment_leave_overdue_sources where breach_id=new.breach_id;
 template:=s.definition->'overdueTemplate';
 if template is null then return new; end if;
 select e.employee_id into worker from employees e where e.id=s.employee_id and e.organization_id=s.organization_id
   and e.legal_entity_id=s.legal_entity_id;
 if s.kind='Leave' then
   select policy_id into strict original_policy from leave_approval_instances where id=s.instance_id;
   reference:='leave/'||s.request_id;
 else
   select policy_id into strict original_policy from assignment_approval_instances where id=s.instance_id;
   reference:='assignment/'||s.assignment_id;
 end if;
 new.title:=render_stage_overdue_text(template->>'subject',worker,reference,s.stage+1);
 new.body:=render_stage_overdue_text(template->>'body',worker,reference,s.stage+1);
 if worker is null or length(worker) not between 1 and 200 or length(new.title) not between 1 and 1200
    or length(new.body) not between 1 and 12000 or worker ~ '^[[:space:]]|[[:space:]]$'
    or translate(worker,chr(9)||chr(10)||chr(13),'') ~ '[[:cntrl:]]' then
   raise exception 'Overdue template evidence unavailable.' using errcode='WGA06';
 end if;
 new.template_id:=original_policy;
 new.locale:=s.definition->>'locale';
 return new;
end $$;
create trigger render_assignment_leave_overdue_receipt before insert on assignment_leave_overdue_receipts
for each row execute function render_assignment_leave_overdue_receipt();
