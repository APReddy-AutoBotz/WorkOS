-- Empty per-date authority for new full-day requests; no legacy conversion/default/grant.
alter table leave_requests add column calendar_evidence_id uuid;
create table leave_calendar_evidence(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,employee_id text not null,request_id text not null references leave_requests(id) on delete restrict,
 sequence integer not null check(sequence>0),starts_on date not null,ends_on date not null check(ends_on>=starts_on and ends_on-starts_on<366 and extract(year from starts_on)=extract(year from ends_on)),
 total_days numeric not null check(total_days>0 and total_days<=366),input_canonical text not null,source_token text not null check(source_token~'^[a-f0-9]{64}$'),quote jsonb not null,
 actor_id text not null,active_role text not null,source text not null check(source='Web'),created_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,employee_id) references employees(organization_id,legal_entity_id,id) on delete restrict,
 unique(request_id,sequence)
);
alter table leave_requests add foreign key(calendar_evidence_id) references leave_calendar_evidence(id) on delete restrict;
create function guard_calendar_leave_evidence() returns trigger language plpgsql as $$
declare ctx jsonb;r leave_requests;q jsonb;d jsonb;count_days integer:=0;prior integer;
begin
 ctx=nullif(current_setting('workos.calendar_leave_context',true),'')::jsonb;
 if ctx is null or ctx->>'actorId' is distinct from new.actor_id or ctx->>'activeRole' is distinct from new.active_role or ctx->>'organizationId' is distinct from new.organization_id or ctx->>'legalEntityId' is distinct from new.legal_entity_id or ctx->>'employeeId' is distinct from new.employee_id then raise exception 'Calendar leave writer context required.' using errcode='WCL01';end if;
 select * into r from leave_requests where id=new.request_id for update;
 if r.id is null or r.employee_id<>new.employee_id or r.status<>'Submitted' or r.start_date<>new.starts_on or r.end_date<>new.ends_on or r.total_days<>new.total_days then raise exception 'Calendar leave request changed.' using errcode='WCL02';end if;
 select coalesce(max(sequence),0) into prior from leave_calendar_evidence where request_id=new.request_id;
 if new.sequence<>prior+1 or encode(public.digest(convert_to(new.input_canonical,'UTF8'),'sha256'),'hex')<>new.source_token then raise exception 'Calendar leave evidence source/revision invalid.' using errcode='WCL02';end if;
 q=new.quote;
 if jsonb_typeof(q) is distinct from 'object' or not(q ?& array['calculationVersion','employeeId','startsOn','endsOn','mode','status','totalDaysExact','days','sourceToken']) or jsonb_typeof(q->'days') is distinct from 'array' then raise exception 'Calendar leave quote shape invalid.' using errcode='WCL02';end if;
 if q->>'calculationVersion' is distinct from 'calendar-leave/1' or q->>'employeeId' is distinct from new.employee_id or q->>'startsOn' is distinct from new.starts_on::text or q->>'endsOn' is distinct from new.ends_on::text or q->>'mode' is distinct from 'calendar' or q->>'status' is distinct from 'available' or q->>'sourceToken' is distinct from new.source_token or (q->>'totalDaysExact')::numeric is distinct from new.total_days or jsonb_array_length(q->'days')<>new.ends_on-new.starts_on+1 then raise exception 'Calendar leave quote invalid.' using errcode='WCL02';end if;
 for d in select * from jsonb_array_elements(q->'days') loop
  if d->>'date' is distinct from (new.starts_on+count_days)::text or d->>'status' is distinct from 'available' or d->>'fractionExact' is null or d->>'fractionExact' not in('0','1') then raise exception 'Calendar leave date allocation invalid.' using errcode='WCL02';end if;count_days=count_days+1;
 end loop;
 if(select sum((value->>'fractionExact')::numeric) from jsonb_array_elements(q->'days'))<>new.total_days then raise exception 'Calendar leave day totals do not reconcile.' using errcode='WCL02';end if;
 return new;
end $$;
create trigger guarded_calendar_leave_evidence before insert on leave_calendar_evidence for each row execute function guard_calendar_leave_evidence();
create trigger immutable_calendar_leave_evidence before update or delete on leave_calendar_evidence for each row execute function reject_commercial_draft_rewrite();
create function guard_calendar_leave_request() returns trigger language plpgsql as $$
declare e leave_calendar_evidence;r leave_requests;
begin
 if tg_op='UPDATE'and old.calendar_evidence_id is not null and old.status in('Approved','Rejected','Cancelled')and(row(new.employee_id,new.leave_type_id,new.start_date,new.end_date,new.total_days,new.calendar_evidence_id) is distinct from row(old.employee_id,old.leave_type_id,old.start_date,old.end_date,old.total_days,old.calendar_evidence_id))then raise exception 'Retained calendar leave dimensions are immutable.' using errcode='WCL02';end if;
 select * into r from leave_requests where id=new.id;
 if r.calendar_evidence_id is not null then
  select * into e from leave_calendar_evidence where id=r.calendar_evidence_id;
  if e.id is null or e.request_id<>r.id or e.employee_id<>r.employee_id or e.starts_on<>r.start_date or e.ends_on<>r.end_date or e.total_days<>r.total_days then raise exception 'Calendar leave evidence does not match request.' using errcode='WCL02';end if;
 end if;return new;
end $$;
-- Deferred matching permits one atomic Submitted edit + append + reference switch.
create constraint trigger matching_calendar_leave_request after insert or update on leave_requests deferrable initially deferred for each row execute function guard_calendar_leave_request();
