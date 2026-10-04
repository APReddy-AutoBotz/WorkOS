-- WOS-02 final closure: scoped identity and effective-dated ownership.
create extension if not exists btree_gist;

alter table users add column if not exists employee_record_id text;
update users u set employee_record_id=e.id
from employees e where u.employee_record_id is null and u.employee_id=e.employee_id
  and not exists (select 1 from employees x where x.employee_id=e.employee_id and x.id<>e.id);
do $$ begin
  if exists (select 1 from users where employee_id is not null and employee_record_id is null) then
    raise exception 'Ambiguous user to employee identity; scoped reconciliation required';
  end if;
end $$;
alter table users drop constraint if exists users_employee_id_key;
create unique index if not exists uq_users_employee_record on users(employee_record_id) where employee_record_id is not null;
alter table users drop constraint if exists users_employee_record_fk;
alter table users add constraint users_employee_record_fk foreign key(employee_record_id) references employees(id) on delete restrict;

alter table worker_history add column if not exists legal_entity_id text;
update worker_history h set legal_entity_id=e.legal_entity_id from employees e
where h.employee_id=e.id and h.organization_id=e.organization_id and h.legal_entity_id is null;
alter table worker_history alter column legal_entity_id set not null;
alter table worker_history drop constraint if exists worker_history_organization_legal_entity_fk;
alter table worker_history add constraint worker_history_organization_legal_entity_fk
  foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id) on delete restrict;
alter table working_calendars drop constraint if exists working_calendar_versions_no_overlap;
alter table working_calendars add constraint working_calendar_versions_no_overlap exclude using gist
 (organization_id with =, coalesce(legal_entity_id,'') with =, code with =,
  daterange(effective_from,coalesce(effective_to + 1,'infinity'::date),'[)') with &&);
