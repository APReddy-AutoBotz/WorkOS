-- One ordered, prospective classification timeline per scoped employee.
create table worker_type_assignments (
 id uuid primary key default gen_random_uuid(),
 organization_id text not null,
 legal_entity_id text not null,
 employee_id text not null,
 effective_from date not null,
 previous_id uuid references worker_type_assignments(id),
 worker_type_id text,
 recorded_label text,
 actor_id uuid not null references users(id),
 active_role text not null,
 reason text not null check(char_length(trim(reason)) between 3 and 500),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,employee_id) references employees(organization_id,legal_entity_id,id),
 foreign key(organization_id,worker_type_id) references organization_catalog_items(organization_id,id),
 unique(organization_id,legal_entity_id,employee_id,effective_from),
 check((worker_type_id is null)=(recorded_label is null))
);
create trigger immutable_worker_type_assignments before update or delete on worker_type_assignments
 for each row execute function reject_commercial_draft_rewrite();

create function protect_worker_type_assignment_dates() returns trigger language plpgsql as $$
declare today date := (statement_timestamp() at time zone 'UTC')::date;
begin
 if exists(select 1 from worker_type_assignments a where a.worker_type_id=old.id
   and not exists(select 1 from worker_type_assignments later where later.employee_id=a.employee_id
     and later.effective_from>a.effective_from and later.effective_from<=greatest(today,a.effective_from))
   and (not new.active or greatest(today,a.effective_from) not between new.effective_from and coalesce(new.effective_to,'infinity'::date))
   and greatest(today,a.effective_from) between old.effective_from and coalesce(old.effective_to,'infinity'::date))
 then raise exception 'Worker type has a current or scheduled assignment.' using errcode='WKT01'; end if;
 return new;
end $$;
create index worker_type_assignment_catalog on worker_type_assignments(worker_type_id) where worker_type_id is not null;
create trigger guard_assigned_worker_type before update of active,effective_from,effective_to on organization_catalog_items
 for each row when(old.catalog_type='worker_type') execute function protect_worker_type_assignment_dates();

create function guard_worker_type_assignment() returns trigger language plpgsql as $$
declare prior worker_type_assignments; kind organization_catalog_items;
begin
 perform 1 from employees where id=new.employee_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id for update;
 select * into prior from worker_type_assignments where employee_id=new.employee_id and organization_id=new.organization_id
   and legal_entity_id=new.legal_entity_id order by effective_from desc limit 1;
 if new.previous_id is distinct from prior.id or new.effective_from<=prior.effective_from
    or new.effective_from<(statement_timestamp() at time zone 'UTC')::date then
   raise exception 'Worker type assignment conflicts with the timeline.' using errcode='WKT02';
 end if;
 if new.worker_type_id is not null then
   select * into kind from organization_catalog_items where id=new.worker_type_id and organization_id=new.organization_id
     and (legal_entity_id is null or legal_entity_id=new.legal_entity_id) and active and catalog_type='worker_type'
     and new.effective_from between effective_from and coalesce(effective_to,'infinity'::date) for share;
   if kind.id is null or new.recorded_label is distinct from kind.name then
     raise exception 'Worker type assignment lacks a valid scoped catalog version.' using errcode='WKT02';
   end if;
 end if;
 return new;
end $$;
create trigger validate_worker_type_assignment before insert on worker_type_assignments
 for each row execute function guard_worker_type_assignment();

create function complete_worker_type_assignment() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs x where x.organization_id=new.organization_id and x.legal_entity_id=new.legal_entity_id
   and x.user_id=new.actor_id::text and x.active_role=new.active_role and x.source='Web' and x.module='Workforce'
   and x.action='Schedule Worker Type' and x.entity_id=new.employee_id and x.reason=new.reason
   and x.new_value=jsonb_build_object('id',new.id,'effectiveFrom',new.effective_from,'workerTypeId',new.worker_type_id,
     'label',new.recorded_label,'reason',new.reason))
 then raise exception 'Worker classification requires matching audit evidence.' using errcode='WKT03'; end if;
 return null;
end $$;
create constraint trigger complete_worker_type_assignment after insert on worker_type_assignments
 deferrable initially deferred for each row execute function complete_worker_type_assignment();
