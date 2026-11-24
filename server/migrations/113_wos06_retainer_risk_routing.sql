insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.retainer_risk.configure','Commercial','Configure retainer risk notices','Set explicit version assignments and scoped mandatory retainer recipients.',false);

create table retainer_risk_assignments (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, contract_version_id text not null references commercial_contract_versions(id),
 version integer not null check(version>0),engagement_ids text[] not null check(cardinality(engagement_ids)<=200),
 actor_id uuid not null references users(id),active_role text not null,operation_id text not null,reason text not null check(length(trim(reason)) between 3 and 1000),
 created_at timestamptz not null default clock_timestamp(),unique(organization_id,legal_entity_id,contract_version_id,version)
);
create trigger immutable_retainer_risk_assignments before update or delete on retainer_risk_assignments
 for each row execute function reject_commercial_draft_rewrite();

create function guard_retainer_risk_assignments() returns trigger language plpgsql as $$
declare root_contract text;latest integer;
begin
 select contract_id into root_contract from commercial_contract_versions where model='retainer' and id=new.contract_version_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id for update;
 if root_contract is null or nullif(current_setting('workos.retainer_risk_assignment_context',true),'')::jsonb is distinct from
   jsonb_build_object('version',new.contract_version_id,'actor',new.actor_id,'role',new.active_role,'operation',new.operation_id,'organization',new.organization_id,'entity',new.legal_entity_id)
   or exists(select from unnest(array['commercial.contracts.view','commercial.retainer_risk.configure']) p
     where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,p)) then
   raise exception 'Scoped retainer risk authority required.' using errcode='RRA01';
 end if;
 select coalesce(max(version),0) into latest from retainer_risk_assignments where contract_version_id=new.contract_version_id;
 if new.version<>latest+1 or cardinality(new.engagement_ids)<>(select count(*) from commercial_engagements e
   where e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.contract_id=root_contract and e.model='retainer' and e.id=any(new.engagement_ids)) then
   raise exception 'Review version and contract engagement assignments.' using errcode='RRA02';
 end if;
 return new;
end $$;
create trigger validate_retainer_risk_assignments before insert on retainer_risk_assignments for each row execute function guard_retainer_risk_assignments();

create function retainer_risk_engagement_owners(org text,entity text,version_pin text) returns table(engagement_id text,user_id uuid) language sql stable as $$
 select e.id,u.id from commercial_contract_versions p join lateral (
   select a.engagement_ids from retainer_risk_assignments a where a.organization_id=org and a.legal_entity_id=entity and a.contract_version_id=p.id
     order by a.version desc limit 1) a on true
 join commercial_engagements e on e.id=any(a.engagement_ids) and e.organization_id=org and e.legal_entity_id=entity and e.contract_id=p.contract_id and e.model='retainer'
 left join employees w on w.id=e.owner_id and w.organization_id=org and w.legal_entity_id=entity and w.status in ('Active','On Leave')
   and coalesce(w.joining_date,'-infinity'::date)<=(now() at time zone 'UTC')::date and coalesce(w.exit_date,'infinity'::date)>=(now() at time zone 'UTC')::date
 left join users u on u.employee_record_id=w.id and u.status='Active' and exists(select from user_roles ur join roles r on r.id=ur.role_id
   where ur.user_id=u.id and invoice_notice_named_recipient(org,entity,u.id,r.name))
 where p.id=version_pin and p.organization_id=org and p.legal_entity_id=entity
$$;

create function require_retainer_assignment_audit() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id
   and module='Commercial Notifications' and action='Assign Retainer Risk Engagements' and entity_id=new.id::text) then
   raise exception 'Assignment audit required.' using errcode='RRA02';
 end if;
 return null;
end $$;
create constraint trigger retainer_assignment_audit after insert on retainer_risk_assignments deferrable initially deferred
 for each row execute function require_retainer_assignment_audit();

create table retainer_risk_scans (
 version_id text primary key references commercial_contract_versions(id), next_check timestamptz not null default now(),
 failure text check(failure='EVALUATION_UNAVAILABLE')
);
create index retainer_risk_due_scans on retainer_risk_scans(next_check,version_id);
create table retainer_risk_events (
 id uuid primary key, organization_id text not null,legal_entity_id text not null, version_id text not null references commercial_contract_versions(id),
 starts_on date not null, ends_on date not null check(ends_on>=starts_on),kind text not null check(kind in ('expiry','overconsumption')),
 hours numeric not null check(hours>0), included_hours numeric not null check(included_hours>=0),
 carried_in numeric not null check(carried_in>=0),consumed numeric not null check(consumed>=0),carried_out numeric not null check(carried_out>=0),
 check(hours=case kind when 'expiry' then included_hours+carried_in-consumed-carried_out else consumed-included_hours-carried_in end),
 observed_at timestamptz not null default clock_timestamp(), unique(id,version_id)
);
create index retainer_events_by_period on retainer_risk_events(version_id,starts_on,kind);
create trigger immutable_retainer_risk_event before update or delete on retainer_risk_events for each row execute function reject_commercial_draft_rewrite();
create function guard_retainer_risk_event() returns trigger language plpgsql as $$
begin
 if nullif(current_setting('workos.retainer_risk_observation',true),'') is distinct from new.id::text or
 not exists(select from commercial_contract_versions v cross join lateral jsonb_to_recordset(v.retainer_periods) p("startsOn" date,"endsOn" date,"includedHours" numeric)
   where v.id=new.version_id and v.organization_id=new.organization_id and v.legal_entity_id=new.legal_entity_id and v.model='retainer'
     and v.retainer_capacity_policy is not null and p."startsOn"=new.starts_on and p."endsOn"=new.ends_on and p."includedHours"=new.included_hours and new.starts_on>=v.effective_from
     and new.starts_on<=(now() at time zone 'UTC')::date and (new.kind<>'expiry' or new.ends_on<(now() at time zone 'UTC')::date))
   or exists(select from retainer_risk_events e where e.version_id=new.version_id and e.starts_on=new.starts_on and e.kind=new.kind
     and not exists(select from retainer_risk_resolutions r where r.event_id=e.id))
 then raise exception 'Current governed retainer observation required.' using errcode='RRN06'; end if;
 return new;
end $$;
create trigger validate_retainer_risk_event before insert on retainer_risk_events for each row execute function guard_retainer_risk_event();
create table retainer_risk_resolutions (
 event_id uuid primary key, version_id text not null, observed_at timestamptz not null default clock_timestamp(),
 foreign key(event_id,version_id) references retainer_risk_events(id,version_id)
);
create trigger immutable_retainer_risk_resolution before update or delete on retainer_risk_resolutions for each row execute function reject_commercial_draft_rewrite();
create table retainer_risk_notice_policies (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, version_id text not null,
 version integer not null check(version>0), effective_from date not null,
 manager_id uuid not null references users(id), manager_role text not null,
 finance_id uuid not null references users(id), finance_role text not null,
 locale text not null check(length(locale) between 2 and 64),
 title text not null check(length(trim(title)) between 1 and 200),
 body text not null check(length(trim(body)) between 1 and 2000),
 actor_id uuid not null references users(id), active_role text not null, operation_id text not null,
 reason text not null check(length(trim(reason)) between 3 and 1000),
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,version_id,version),
 foreign key(version_id) references commercial_contract_versions(id)
);
create trigger immutable_retainer_risk_policy before update or delete on retainer_risk_notice_policies
 for each row execute function reject_commercial_draft_rewrite();


create function retainer_risk_named_recipient(org text,entity text,version_pin text,who uuid,held text) returns boolean language sql stable as $$
 select invoice_notice_named_recipient(org,entity,who,held) and invoice_notice_actor_has(org,entity,who,held,'commercial.contracts.view')
 and exists(select from users u join employees w on w.id=u.employee_record_id where u.id=who and w.organization_id=org and w.legal_entity_id=entity
   and w.status in ('Active','On Leave') and coalesce(w.joining_date,'-infinity'::date)<=(now() at time zone 'UTC')::date
   and coalesce(w.exit_date,'infinity'::date)>=(now() at time zone 'UTC')::date)
 and not exists(select from retainer_risk_engagement_owners(org,entity,version_pin) o join commercial_engagements e on e.id=o.engagement_id
   where not rate_candidate_worker_visible(jsonb_build_object('actorId',who,'activeRole',held,'organizationId',org,'legalEntityId',entity),e.owner_id))
$$;
create function retainer_risk_recipients(org text,entity text,version_pin text,manager uuid,manager_role text,finance uuid,finance_role text)
returns table(user_id uuid, reason text) language sql stable as $$
 with owners as (select * from retainer_risk_engagement_owners(org,entity,version_pin))
 select distinct o.user_id,'engagement_owner' from owners o
 where exists(select from owners) and not exists(select from owners where owners.user_id is null)
   and retainer_risk_named_recipient(org,entity,version_pin,manager,manager_role) and retainer_risk_named_recipient(org,entity,version_pin,finance,finance_role)
 union all
 select named.id,named.reason from (values(manager,'commercial_manager'),(finance,'finance_billing_owner')) named(id,reason)
 where exists(select from owners) and not exists(select from owners where owners.user_id is null)
   and retainer_risk_named_recipient(org,entity,version_pin,manager,manager_role) and retainer_risk_named_recipient(org,entity,version_pin,finance,finance_role)
$$;
create function guard_retainer_risk_policy() returns trigger language plpgsql as $$
declare prior retainer_risk_notice_policies; ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.retainer_notice_policy_context',true),'')::jsonb;
 if ctx is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'role',new.active_role,'organization',new.organization_id,'entity',new.legal_entity_id,'version',new.version_id,'operation',new.operation_id)
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.retainer_risk.configure')
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
   or not exists(select from commercial_contract_versions where model='retainer' and id=new.version_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id)
 then raise exception 'Current scoped configuration authority required.' using errcode='RRN01'; end if;
 perform pg_advisory_xact_lock(hashtextextended('retainer-risk-policy:'||new.version_id,0));
 select * into prior from retainer_risk_notice_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and version_id=new.version_id order by version desc limit 1;
 if new.version<>coalesce(prior.version,0)+1 or new.effective_from<(now() at time zone 'UTC')::date or new.effective_from<prior.effective_from
 then raise exception 'Prospective notice policy version required.' using errcode='RRN02'; end if;
 if not exists(select from retainer_risk_recipients(new.organization_id,new.legal_entity_id,new.version_id,new.manager_id,new.manager_role,new.finance_id,new.finance_role))
 then raise exception 'Current scoped recipients required.' using errcode='RRN03'; end if;
 return new;
end $$;
create trigger validate_retainer_risk_policy before insert on retainer_risk_notice_policies
 for each row execute function guard_retainer_risk_policy();

create table retainer_risk_dispatch (
 event_id uuid primary key references retainer_risk_events(id), next_attempt timestamptz not null default now(),
 attempts integer not null default 0 check(attempts>=0), failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 policy_id uuid references retainer_risk_notice_policies(id), delivered_at timestamptz,
 check((delivered_at is null)=(policy_id is null)), check(delivered_at is null or failure is null)
);
create index retainer_risk_pending on retainer_risk_dispatch(next_attempt) where delivered_at is null;
create table retainer_risk_inbox (
 id uuid primary key, event_id uuid not null references retainer_risk_events(id), user_id uuid not null references users(id),
 reasons text[] not null check(cardinality(reasons)>0 and reasons <@ array['commercial_manager','engagement_owner','finance_billing_owner']),
 unique(event_id,user_id)
);
create index retainer_risk_inbox_user on retainer_risk_inbox(user_id,id);
create trigger immutable_retainer_risk_receipt before update or delete on retainer_risk_inbox
 for each row execute function reject_commercial_draft_rewrite();
create table retainer_risk_reads (
 recipient_id uuid primary key references retainer_risk_inbox(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp()
);
create trigger immutable_retainer_risk_read before update or delete on retainer_risk_reads
 for each row execute function reject_commercial_draft_rewrite();

create function retainer_risk_receipt_visible(receipt uuid,who uuid,held_role text,org text,entity text)
returns boolean language sql stable as $$
 select exists(select from retainer_risk_inbox i join retainer_risk_events e on e.id=i.event_id
   join retainer_risk_dispatch d on d.event_id=e.id and d.delivered_at is not null
   join lateral(select * from retainer_risk_notice_policies p where p.organization_id=org and p.legal_entity_id=entity
     and p.version_id=e.version_id and p.effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1) p on true
   where i.id=receipt and i.user_id=who and e.organization_id=org and e.legal_entity_id=entity and invoice_notice_named_recipient(org,entity,who,held_role)
     and (('engagement_owner'=any(i.reasons) and exists(select from retainer_risk_engagement_owners(org,entity,e.version_id) o where o.user_id=who))
       or (retainer_risk_named_recipient(org,entity,e.version_id,who,held_role) and (
           ('commercial_manager'=any(i.reasons) and p.manager_id=who and p.manager_role=held_role)
        or ('finance_billing_owner'=any(i.reasons) and p.finance_id=who and p.finance_role=held_role)))))
$$;
create function guard_retainer_risk_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
 if ctx->>'actorId' is distinct from new.user_id::text or retainer_risk_receipt_visible(new.recipient_id,new.user_id,
   ctx->>'activeRole',ctx->>'organizationId',ctx->>'legalEntityId') is not true then
   raise exception 'Recipient notice unavailable.' using errcode='RRN04';
 end if;
 return new;
end $$;
create trigger validate_retainer_risk_read before insert on retainer_risk_reads
 for each row execute function guard_retainer_risk_read();

-- Verify the committed recipient set even if a writer omits or redirects one receipt.
create function complete_retainer_risk_delivery() returns trigger language plpgsql as $$
declare event_key uuid; ev retainer_risk_events; d retainer_risk_dispatch; p retainer_risk_notice_policies;
begin
 event_key:=new.event_id;
 select * into ev from retainer_risk_events where id=event_key;
 select * into d from retainer_risk_dispatch where event_id=event_key;
 if d.delivered_at is null then
   if exists(select from retainer_risk_inbox where event_id=event_key) then
     raise exception 'Partial receipt set unavailable.' using errcode='RRN05';
   end if;
   return null;
 end if;
 select * into p from retainer_risk_notice_policies where organization_id=ev.organization_id and legal_entity_id=ev.legal_entity_id
   and version_id=ev.version_id and effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1;
 if p.id is distinct from d.policy_id or not exists(select from retainer_risk_inbox where event_id=event_key) or exists (
   with required as (select user_id,array_agg(reason order by reason) reasons from retainer_risk_recipients(ev.organization_id,
     ev.legal_entity_id,ev.version_id,p.manager_id,p.manager_role,p.finance_id,p.finance_role) group by user_id),
   receipts as (select user_id,reasons from retainer_risk_inbox where event_id=event_key)
   select from required full join receipts using(user_id) where required.reasons is distinct from receipts.reasons
 ) then raise exception 'Complete current scoped receipts required.' using errcode='RRN05'; end if;
 return null;
end $$;
create constraint trigger complete_retainer_risk_inbox after insert on retainer_risk_inbox
 deferrable initially deferred for each row execute function complete_retainer_risk_delivery();
create constraint trigger complete_retainer_risk_dispatch after insert or update on retainer_risk_dispatch
 deferrable initially deferred for each row execute function complete_retainer_risk_delivery();

create function guard_retainer_risk_dispatch() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or old.delivered_at is not null or old.event_id is distinct from new.event_id then
   raise exception 'Retained risk delivery is immutable.' using errcode='RRN05';
 end if;
 return new;
end $$;
create trigger protect_retainer_risk_dispatch before update or delete on retainer_risk_dispatch
 for each row execute function guard_retainer_risk_dispatch();

create table retainer_risk_delivery_attempts (
 event_id uuid not null references retainer_risk_events(id),
 attempt integer not null check(attempt>0),
 attempted_at timestamptz not null default clock_timestamp(),
 failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 delivered_at timestamptz, next_attempt timestamptz, policy_id uuid references retainer_risk_notice_policies(id),
 primary key(event_id,attempt),
 check ((failure is null)=(delivered_at is not null)),
 check ((delivered_at is null)=(next_attempt is not null)),
 check ((delivered_at is null)=(policy_id is null))
);
create trigger immutable_risk_delivery_attempt before update or delete on retainer_risk_delivery_attempts
 for each row execute function reject_commercial_draft_rewrite();

create function record_retainer_risk_attempt() returns trigger language plpgsql as $$
begin
 if new.attempts<>old.attempts+1 then raise exception 'Attempt sequence must advance once.' using errcode='RRN05'; end if;
 insert into retainer_risk_delivery_attempts(event_id,attempt,failure,delivered_at,next_attempt,policy_id)
 values(new.event_id,new.attempts,new.failure,new.delivered_at,
   case when new.delivered_at is null then new.next_attempt end,new.policy_id);
 return new;
end $$;
create trigger retain_risk_delivery_attempt after update of attempts on retainer_risk_dispatch
 for each row execute function record_retainer_risk_attempt();


create function require_retainer_risk_policy_audit() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id
   and module='Commercial Notifications' and action='Configure Retainer Risk Notices' and entity_id=new.id::text) then
   raise exception 'Policy audit required.' using errcode='RRN02';
 end if;
 return null;
end $$;
create constraint trigger retainer_notice_policy_audit after insert on retainer_risk_notice_policies deferrable initially deferred
 for each row execute function require_retainer_risk_policy_audit();
