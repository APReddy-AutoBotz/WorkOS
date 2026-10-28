-- No role/user grants, buyer policy or existing occupancy is created.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.invoice_drafts.view','Commercial','View invoice-ready drafts','View scoped draft batches and their billing-safe item lineage.',false),
 ('commercial.invoice_drafts.prepare','Commercial','Prepare invoice-ready drafts','Create scoped draft batches and acquire eligible whole items.',false),
 ('commercial.invoice_drafts.own','Commercial','Own invoice-ready drafts','Be an explicitly named scoped draft owner.',false),
 ('commercial.invoice_drafts.cancel','Commercial','Cancel invoice-ready drafts','Cancel a scoped draft and release current occupancy with retained history.',false);

create table invoice_draft_batches(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,client_id text not null,contract_id text not null,engagement_id text not null,currency text not null check(currency~'^[A-Z]{3}$'),period_start date not null,period_end date not null,period_basis text not null check(period_basis in('WORK_DATE','ELIGIBLE_DATE')),
 owner_user_id uuid not null references users(id),owner_role text not null,preparer_user_id uuid not null references users(id),preparer_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 check(period_end>=period_start),foreign key(organization_id,legal_entity_id,client_id) references clients(organization_id,legal_entity_id,id),foreign key(organization_id,legal_entity_id,contract_id) references commercial_contracts(organization_id,legal_entity_id,id),foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),unique(organization_id,legal_entity_id,preparer_user_id,request_id)
);
create table invoice_draft_lines(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,batch_id uuid not null references invoice_draft_batches(id),sequence integer not null check(sequence>0),item_id uuid not null references approved_unbilled_items(id),item_version integer not null check(item_version=1),event_id uuid not null references billing_eligibility_events(id),snapshot_id uuid not null references commercial_tm_valuations(id),currency text not null check(currency~'^[A-Z]{3}$'),amount numeric(20,4) not null check(amount>0),billing_evidence jsonb not null,
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(batch_id,sequence),unique(batch_id,item_id,item_version),unique(organization_id,legal_entity_id,actor_id,request_id)
);
-- This is the authoritative current control; immutable lines are history only.
create table invoice_draft_occupancies(
 item_id uuid not null references approved_unbilled_items(id),item_version integer not null check(item_version=1),batch_id uuid not null references invoice_draft_batches(id),line_id uuid not null unique references invoice_draft_lines(id),created_at timestamptz not null default clock_timestamp(),primary key(item_id,item_version)
);
create table invoice_draft_cancellations(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,batch_id uuid not null unique references invoice_draft_batches(id),expected_line_count integer not null check(expected_line_count>=0),actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table invoice_draft_owner_losses(batch_id uuid primary key references invoice_draft_batches(id),cause text not null,detected_at timestamptz not null default clock_timestamp());
do $$declare t text;begin foreach t in array array['invoice_draft_batches','invoice_draft_lines','invoice_draft_cancellations','invoice_draft_owner_losses'] loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;

create function invoice_draft_actor_valid(org text,legal text,who uuid,role_name text,action text) returns boolean language plpgsql stable as $$
declare k text;keys text[];begin
 if action not in('view','prepare','own','cancel') or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id where u.id=who and u.status='Active' and r.name=role_name and sc.organization_id=org and sc.legal_entity_id=legal and sc.active) then return false;end if;
 keys=array['commercial.contracts.view','commercial.tm_billing.view','commercial.invoice_drafts.view','employees.view','notifications.view'];
 if action<>'view' then keys=keys||array['commercial.invoice_drafts.'||action];end if;
 foreach k in array keys loop if not exists(select 1 from role_permissions rp where rp.role_name=invoice_draft_actor_valid.role_name and rp.permission_key=k and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=k) then return false;end if;end loop;return true;
end $$;

-- Mirrors the existing scoped employee reader for historical cancellation;
-- unlike new work creation, a retained exited worker is not silently hidden.
create function invoice_historical_worker_visible(org text,legal text,worker text,who uuid,role_name text) returns boolean language plpgsql stable as $$
declare u record;e employees;begin
 select u0.*,cd.id country_director_id into u from users u0 left join employees a on a.id=u0.employee_record_id left join country_directors cd on cd.id=a.primary_country_director_id and(lower(a.designation)in('country director','regional lead','director')or lower(a.department)='regional leadership') where u0.id=who and u0.status='Active';
 if u.id is null or(not exists(select 1 from role_permissions rp where rp.role_name=invoice_historical_worker_visible.role_name and rp.permission_key='employees.view' and rp.enabled) and not exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key='employees.view')) then return false;end if;
 select * into e from employees where id=worker and organization_id=org and legal_entity_id=legal;if e.id is null then return false;end if;
 if role_name='Employee' then return e.id=u.employee_record_id or e.employee_id=u.employee_id;
 elsif role_name='TeamLead' then return e.id=u.employee_record_id or e.employee_id=u.employee_id or exists(with recursive chain as(select id from employees where reporting_manager_id in(u.employee_record_id,u.employee_id) union select x.id from employees x join chain c on x.reporting_manager_id=c.id)select 1 from chain where id=e.id);
 elsif role_name='CountryDirector' then return e.primary_country_director_id=u.country_director_id or exists(select 1 from employee_country_director_map where employee_id=e.id and country_director_id=u.country_director_id);
 elsif role_name='ProjectManager' then return e.id=u.employee_record_id or e.employee_id=u.employee_id or exists(select 1 from project_allocations a join projects p on p.id=a.project_id where a.employee_id=e.id and p.manager_id in(u.employee_record_id,u.employee_id));end if;
 return true;
end $$;

create function invoice_draft_owner_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own') and not exists(select 1 from invoice_draft_owner_losses z where z.batch_id=b.id)
 and not exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,b.owner_user_id,b.owner_role))
$$;

create function guard_invoice_draft_append() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;e commercial_engagements;line invoice_draft_lines;item approved_unbilled_items;evt billing_eligibility_events;v commercial_tm_valuations;cancel invoice_draft_cancellations;n int;worker_id text;basis date;
begin
 begin ctx=nullif(current_setting('workos.invoice_draft_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or not exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id where u.id::text=ctx->>'actorId' and u.status='Active' and r.name=ctx->>'activeRole' and sc.organization_id=ctx->>'organizationId' and sc.legal_entity_id=ctx->>'legalEntityId' and sc.active) then raise exception 'Use the authenticated scoped invoice draft command.' using errcode='IDR01';end if;
 if tg_table_name='invoice_draft_batches' then
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role);perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role);
  select * into e from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and id=new.engagement_id for share;
  if new.id::text is distinct from ctx->>'batchId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.preparer_user_id::text is distinct from ctx->>'actorId' or new.preparer_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.preparer_user_id,new.preparer_role,'prepare') or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.owner_user_id,new.owner_role,'own') or e.id is null or e.origin<>'manual' or e.model<>'time_and_materials' or not e.billable or e.client_id is distinct from new.client_id or e.contract_id is distinct from new.contract_id or e.currency is distinct from new.currency then raise exception 'Explicit scoped draft, owner and native source required.' using errcode='IDR01';end if;return new;
 elsif tg_table_name='invoice_draft_occupancies' and tg_op='DELETE' then
  select * into b from invoice_draft_batches where id=old.batch_id;select * into cancel from invoice_draft_cancellations where batch_id=old.batch_id;
  if b.id is null or cancel.id is null or b.id::text is distinct from ctx->>'batchId' or cancel.id::text is distinct from ctx->>'cancellationId' or cancel.actor_id::text is distinct from ctx->>'actorId' or cancel.active_role is distinct from ctx->>'activeRole' or cancel.operation_id is distinct from ctx->>'operationId' or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,cancel.actor_id,cancel.active_role,'cancel') then raise exception 'Only exact protected draft cancellation may release occupancy.' using errcode='IDR01';end if;return old;
 elsif tg_table_name='invoice_draft_occupancies' then
  select * into line from invoice_draft_lines where id=new.line_id;select * into b from invoice_draft_batches where id=new.batch_id;
  if b.id is null or line.id is null or b.id::text is distinct from ctx->>'batchId' or line.id::text is distinct from ctx->>'lineId' or line.batch_id<>b.id or line.item_id<>new.item_id or line.item_version<>new.item_version or line.actor_id::text is distinct from ctx->>'actorId' or line.active_role is distinct from ctx->>'activeRole' or line.operation_id is distinct from ctx->>'operationId' or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,line.actor_id,line.active_role,'prepare') or exists(select 1 from invoice_draft_cancellations where batch_id=b.id) then raise exception 'Occupancy must follow its exact new line.' using errcode='IDR02';end if;return new;
 end if;
 select * into b from invoice_draft_batches where id=new.batch_id for update;
 if b.id is null or b.id::text is distinct from ctx->>'batchId' or b.organization_id is distinct from ctx->>'organizationId' or b.legal_entity_id is distinct from ctx->>'legalEntityId' or exists(select 1 from invoice_draft_cancellations where batch_id=b.id) then raise exception 'Current scoped Draft unavailable.' using errcode='IDR02';end if;
 if tg_table_name='invoice_draft_cancellations' then
  perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role);select count(*)::int into n from invoice_draft_lines where batch_id=b.id;
  if new.id::text is distinct from ctx->>'cancellationId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.expected_line_count<>n or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'cancel') then raise exception 'Current scoped cancellation authority and line version required.' using errcode='IDR01';end if;
  for line in select * from invoice_draft_lines where batch_id=b.id order by sequence loop
   perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,line.snapshot_id,new.actor_id,new.active_role);
   select h.employee_id into worker_id from commercial_tm_valuations w join work_submission_evidence s on s.id=w.submission_id join timesheets h on h.id=s.timesheet_id where w.id=line.snapshot_id;
   if not invoice_historical_worker_visible(b.organization_id,b.legal_entity_id,worker_id,new.actor_id,new.active_role) then raise exception 'Current historical worker scope is required to cancel.' using errcode='IDR01';end if;
  end loop;return new;
 end if;
 perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role);perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role);
 select * into item from approved_unbilled_items where id=new.item_id and organization_id=b.organization_id and legal_entity_id=b.legal_entity_id;select * into evt from billing_eligibility_events where id=item.event_id;select * into v from commercial_tm_valuations where id=evt.snapshot_id;
 if v.id is not null then perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,v.id,new.actor_id,new.active_role);perform lock_tm_billing_worker_witness(b.organization_id,b.legal_entity_id,v.id,b.owner_user_id,b.owner_role);perform 1 from timesheets h join work_submission_evidence s on s.timesheet_id=h.id join timesheet_entries te on te.id=v.entry_id and te.timesheet_id=h.id where s.id=v.submission_id for share of h,te;end if;
 select count(*)::int into n from invoice_draft_lines where batch_id=b.id;basis=case b.period_basis when 'WORK_DATE' then (evt.billing_evidence->>'workDate')::date else evt.eligible_on end;
 if new.id::text is distinct from ctx->>'lineId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.sequence<>n+1 or n::text is distinct from ctx->>'expectedLineCount' or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'prepare') or not invoice_draft_owner_current(b) or item.id is null or evt.id is null or v.id is null or item.version<>new.item_version or evt.id<>new.event_id or v.id<>new.snapshot_id or evt.source_type<>'TM_SNAPSHOT' or evt.client_id<>b.client_id or evt.contract_id<>b.contract_id or evt.engagement_id<>b.engagement_id or evt.currency<>b.currency or new.currency<>evt.currency or new.amount<>evt.amount or new.billing_evidence is distinct from evt.billing_evidence or basis not between b.period_start and b.period_end or not tm_billing_source_valid(b.organization_id,b.legal_entity_id,b.engagement_id,v.id) or not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,v.id,new.actor_id,new.active_role) or not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,v.id,b.owner_user_id,b.owner_role) then raise exception 'A current whole scoped billing item, owner, period and native currency are required.' using errcode='IDR02';end if;return new;
end $$;
create trigger guarded_invoice_draft_batch before insert on invoice_draft_batches for each row execute function guard_invoice_draft_append();
create trigger guarded_invoice_draft_line before insert on invoice_draft_lines for each row execute function guard_invoice_draft_append();
create trigger guarded_invoice_draft_cancel before insert on invoice_draft_cancellations for each row execute function guard_invoice_draft_append();
create trigger guarded_invoice_draft_occupancy before insert or delete on invoice_draft_occupancies for each row execute function guard_invoice_draft_append();
create trigger immutable_invoice_draft_occupancy before update on invoice_draft_occupancies for each row execute function reject_commercial_draft_rewrite();

create function complete_invoice_draft_commit() returns trigger language plpgsql as $$
declare b invoice_draft_batches;v commercial_tm_valuations;action_name text;actor uuid;role_name text;op text;expected jsonb;begin
 if tg_table_name='invoice_draft_batches' then b=new;actor=new.preparer_user_id;role_name=new.preparer_role;op=new.operation_id;action_name='Create Draft';expected=jsonb_build_object('batchId',new.id);
  if not invoice_draft_owner_current(b) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'prepare') then raise exception 'Draft owner and preparer must remain eligible through commit.' using errcode='IDR03';end if;
 elsif tg_table_name='invoice_draft_lines' then select * into b from invoice_draft_batches where id=new.batch_id;actor=new.actor_id;role_name=new.active_role;op=new.operation_id;action_name='Acquire Item';expected=jsonb_build_object('batchId',new.batch_id,'lineId',new.id,'itemId',new.item_id);
  select * into v from commercial_tm_valuations where id=new.snapshot_id;
  if not invoice_draft_owner_current(b) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'prepare') or not tm_billing_source_valid(b.organization_id,b.legal_entity_id,b.engagement_id,v.id) or not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,v.id,actor,role_name) or not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,v.id,b.owner_user_id,b.owner_role) or not exists(select 1 from invoice_draft_occupancies o where o.item_id=new.item_id and o.item_version=new.item_version and o.batch_id=b.id and o.line_id=new.id) then raise exception 'Current source, scoped owner and unique occupancy must commit together.' using errcode='IDR03';end if;
 else select * into b from invoice_draft_batches where id=new.batch_id;actor=new.actor_id;role_name=new.active_role;op=new.operation_id;action_name='Cancel Draft';expected=jsonb_build_object('batchId',new.batch_id,'cancellationId',new.id);
  if not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,actor,role_name,'cancel') or exists(select 1 from invoice_draft_occupancies o where o.batch_id=b.id) or exists(select 1 from invoice_draft_lines l join commercial_tm_valuations w on w.id=l.snapshot_id join work_submission_evidence s on s.id=w.submission_id join timesheets h on h.id=s.timesheet_id where l.batch_id=b.id and not invoice_historical_worker_visible(b.organization_id,b.legal_entity_id,h.employee_id,actor,role_name)) or(select count(*) from invoice_draft_lines l where l.batch_id=b.id)<>new.expected_line_count then raise exception 'Cancellation, retained lines and complete release must commit together.' using errcode='IDR03';end if;
 end if;
 if b.id is null or not exists(select 1 from audit_logs a where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id and a.user_id=actor::text and a.active_role=role_name and a.module='Invoice Draft' and a.action=action_name and a.entity_id=new.id::text and a.operation_id=op and a.new_value=expected) then raise exception 'Invoice draft operation and redacted audit must commit together.' using errcode='IDR03';end if;return null;
end $$;
create constraint trigger complete_invoice_draft_batch after insert on invoice_draft_batches deferrable initially deferred for each row execute function complete_invoice_draft_commit();
create constraint trigger complete_invoice_draft_line after insert on invoice_draft_lines deferrable initially deferred for each row execute function complete_invoice_draft_commit();
create constraint trigger complete_invoice_draft_cancel after insert on invoice_draft_cancellations deferrable initially deferred for each row execute function complete_invoice_draft_commit();

-- An owner authority loss at a committed boundary makes a pending Draft stale;
-- restored access does not silently revive its authority to acquire new items.
create function guard_invoice_draft_owner_loss() returns trigger language plpgsql as $$begin if pg_trigger_depth()<2 then raise exception 'Draft owner loss follows actual scoped authority changes only.' using errcode='IDR01';end if;return new;end $$;
create trigger guarded_invoice_draft_owner_loss before insert on invoice_draft_owner_losses for each row execute function guard_invoice_draft_owner_loss();
create function record_invoice_draft_owner_loss() returns trigger language plpgsql as $$
declare changed_user uuid;changed_role text;begin
 if tg_table_name in('users','user_roles','user_organization_scopes','user_permission_grants') then
  if tg_table_name='users' then if tg_op='DELETE' then changed_user=old.id;else changed_user=new.id;end if;
  else if tg_op='DELETE' then changed_user=old.user_id;elsif tg_op='UPDATE' and old.user_id is distinct from new.user_id then changed_user=null;else changed_user=new.user_id;end if;end if;
 elsif tg_table_name='role_permissions' then if tg_op='DELETE' then changed_role=old.role_name;elsif tg_op='UPDATE' and old.role_name is distinct from new.role_name then changed_role=null;else changed_role=new.role_name;end if;
 elsif tg_table_name='roles' then changed_role=old.name;end if;
 insert into invoice_draft_owner_losses(batch_id,cause)
 select b.id,tg_table_name from invoice_draft_batches b where(changed_user is null or b.owner_user_id=changed_user) and(changed_role is null or b.owner_role=changed_role) and not exists(select 1 from invoice_draft_cancellations z where z.batch_id=b.id)
 and(not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role,'own') or exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,b.owner_user_id,b.owner_role))) on conflict(batch_id)do nothing;
 return null;
end $$;
create constraint trigger invoice_owner_loss_users after update or delete on users deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_user_roles after insert or update or delete on user_roles deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_scopes after insert or update or delete on user_organization_scopes deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_user_grants after insert or update or delete on user_permission_grants deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_role_permissions after insert or update or delete on role_permissions deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_roles after update or delete on roles deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_employees after update or delete on employees deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_allocations after insert or update or delete on project_allocations deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_projects after update or delete on projects deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_country_map after insert or update or delete on employee_country_director_map deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
create constraint trigger invoice_owner_loss_directors after update or delete on country_directors deferrable initially deferred for each row execute function record_invoice_draft_owner_loss();
