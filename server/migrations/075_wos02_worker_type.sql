-- Explicit new worker-type lineage. Existing native references and legacy fields are not rewritten.
create table worker_type_labels(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,kind text not null check(kind in('employee','contractor','fixed_term','intern','external_resource')),
 sequence integer not null check(sequence>0),previous_id uuid references worker_type_labels(id),effective_from date not null,
 label text not null check(length(label)between 1 and 150 and btrim(label)=label and label!~'[\x01-\x1f\x7f-\x9f]'),
 request_id uuid not null,command jsonb not null,actor_id uuid not null references users(id),active_role text not null,reason text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(organization_id,legal_entity_id,kind,sequence),unique(organization_id,legal_entity_id,kind,effective_from),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table worker_type_assignments(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,employee_id text not null references employees(id),
 sequence integer not null check(sequence>0),previous_id uuid references worker_type_assignments(id),effective_from date not null,
 kind text not null check(kind in('employee','contractor','fixed_term','intern','external_resource')),label_event_id uuid not null references worker_type_labels(id),label_snapshot text not null,
 worker_snapshot jsonb not null,worker_token text not null,request_id uuid not null,command jsonb not null,actor_id uuid not null references users(id),active_role text not null,reason text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id)references legal_entities(organization_id,id),unique(employee_id,sequence),unique(employee_id,effective_from),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create index worker_type_labels_asof on worker_type_labels(organization_id,legal_entity_id,kind,effective_from desc);
create index worker_type_assignments_asof on worker_type_assignments(organization_id,legal_entity_id,employee_id,effective_from desc);
create function worker_type_context()returns jsonb language plpgsql stable as $$begin return nullif(current_setting('workos.worker_type_context',true),'')::jsonb;exception when others then return null;end$$;
create function guard_worker_type_event()returns trigger language plpgsql as $$
declare ctx jsonb=worker_type_context();prior record;e employees;label_row worker_type_labels;permitted boolean;begin
 if tg_table_name='worker_type_labels'then permitted=calendar_authoring_actor(ctx);else permitted=workforce_classification_actor(ctx,new.employee_id);end if;
 if not coalesce(permitted,false)or new.id::text is distinct from ctx->>'eventId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.created_at<statement_timestamp()or new.created_at>clock_timestamp() then raise exception 'Use current scoped worker-type authority.'using errcode='WTG01';end if;
 perform pg_advisory_xact_lock(hashtext('worker-type-label:'||new.organization_id||':'||new.legal_entity_id||':'||new.kind));
 if tg_table_name='worker_type_labels'then
  select id,sequence,effective_from into prior from worker_type_labels where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and kind=new.kind order by sequence desc limit 1;
  if new.command is distinct from jsonb_build_object('requestId',new.request_id,'kind',new.kind,'expectedLatestId',prior.id,'effectiveFrom',to_char(new.effective_from,'YYYY-MM-DD'),'label',new.label,'reason',new.reason)then raise exception 'Retain the exact label command.'using errcode='WTG03';end if;
 else
  select * into e from employees where id=new.employee_id for update;
  select id,sequence,effective_from into prior from worker_type_assignments where employee_id=new.employee_id order by sequence desc limit 1;
  if new.worker_snapshot is distinct from workforce_classification_worker(e)or new.worker_token is distinct from encode(digest(new.worker_snapshot::text,'sha256'),'hex')then raise exception 'Worker observation changed.'using errcode='WTG02';end if;
  select * into label_row from worker_type_labels where id=new.label_event_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and kind=new.kind and effective_from<=new.effective_from;
  if label_row.id is null or label_row.label<>new.label_snapshot or label_row.id is distinct from(select id from worker_type_labels where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and kind=new.kind and effective_from<=new.effective_from order by effective_from desc limit 1)then raise exception 'Current exact label source unavailable.'using errcode='WTG03';end if;
  if new.command is distinct from jsonb_build_object('requestId',new.request_id,'employeeId',new.employee_id,'expectedLatestId',prior.id,'expectedWorkerToken',new.worker_token,'effectiveFrom',to_char(new.effective_from,'YYYY-MM-DD'),'kind',new.kind,'labelEventId',new.label_event_id,'reason',new.reason)then raise exception 'Retain the exact assignment command.'using errcode='WTG03';end if;
 end if;
 if new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id or new.effective_from<(clock_timestamp()at time zone'UTC')::date or(prior.id is not null and new.effective_from<=prior.effective_from)then raise exception 'Append a current or future version after the prior version.'using errcode='WTG02';end if;
 if length(new.reason)not between 1 and 1000 or btrim(new.reason)<>new.reason or new.reason~'[\x01-\x1f\x7f-\x9f]'then raise exception 'Explicit reason required.'using errcode='WTG03';end if;return new;
end$$;
create trigger guard_worker_type_label before insert on worker_type_labels for each row execute function guard_worker_type_event();
create trigger guard_worker_type_assignment before insert on worker_type_assignments for each row execute function guard_worker_type_event();
create trigger immutable_worker_type_labels before update or delete on worker_type_labels for each row execute function reject_commercial_draft_rewrite();
create trigger immutable_worker_type_assignments before update or delete on worker_type_assignments for each row execute function reject_commercial_draft_rewrite();
create function complete_worker_type_event()returns trigger language plpgsql as $$begin
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.source='Web'and a.module='Worker Type'and a.entity_type=tg_table_name and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.reason=new.reason and a.new_value=to_jsonb(new))then raise exception 'Atomic exact worker-type audit required.'using errcode='WTG04';end if;return null;
end$$;
create constraint trigger complete_worker_type_label after insert on worker_type_labels deferrable initially deferred for each row execute function complete_worker_type_event();
create constraint trigger complete_worker_type_assignment after insert on worker_type_assignments deferrable initially deferred for each row execute function complete_worker_type_event();
