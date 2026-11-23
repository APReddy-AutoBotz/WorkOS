-- The line UUID distinguishes a new threshold crossing after a reservation is cancelled.
-- Expiry has one source per released order even if that order was never used.
create function po_expiry_risk_sources(as_of date)
returns table(organization_id text,legal_entity_id text,purchase_order_id text,kind text,source_id text,risk_date date,
  available_before numeric,available_after numeric) language sql stable as $$
select p.organization_id,p.legal_entity_id,p.id as purchase_order_id,'expiry'::text as kind,
       p.id as source_id,p.ends_on+1 as risk_date,null::numeric as available_before,null::numeric as available_after
from commercial_purchase_order_releases r join commercial_purchase_orders p on
 (p.organization_id,p.legal_entity_id,p.id)=(r.organization_id,r.legal_entity_id,r.purchase_order_id)
where p.ends_on<as_of
$$;

create function po_commitment_risk_kinds(amount numeric,threshold numeric,available_before numeric,available_after numeric)
returns table(kind text) language sql immutable strict as $$
 select signal.kind from (values
 ('exhaustion',available_before>0 and available_after=0),
 ('threshold',(available_before=amount or (amount-available_before)*100<amount*threshold)
              and (amount-available_after)*100>=amount*threshold)
 ) signal(kind,reached) where signal.reached
$$;

create view po_risk_sources as
select * from po_expiry_risk_sources((now() at time zone 'UTC')::date)
union all
select p.organization_id,p.legal_entity_id,p.id,signal.kind,c.line_id::text,(c.created_at at time zone 'UTC')::date,
       c.available_before,c.available_after
from commercial_po_line_commitments c join commercial_purchase_orders p on
 (p.organization_id,p.legal_entity_id,p.id)=(c.organization_id,c.legal_entity_id,c.purchase_order_id)
cross join lateral po_commitment_risk_kinds(p.value,p.warning_threshold_percent,c.available_before,c.available_after) signal;

create table po_risk_events (
 id uuid primary key default gen_random_uuid(),
 organization_id text not null, legal_entity_id text not null,
 purchase_order_id text not null references commercial_purchase_order_releases(purchase_order_id),
 kind text not null check(kind in ('expiry','threshold','exhaustion')),source_id text not null,risk_date date not null,
 available_before numeric,available_after numeric,observed_at timestamptz not null default clock_timestamp(),
 unique(purchase_order_id,kind,source_id)
);
create index po_risk_events_by_order on po_risk_events(organization_id,legal_entity_id,purchase_order_id,id);
create function validate_po_risk_event() returns trigger language plpgsql as $$
begin
 if not exists(select from po_risk_sources s where (s.organization_id,s.legal_entity_id,s.purchase_order_id,s.kind,s.source_id,s.risk_date)
   =(new.organization_id,new.legal_entity_id,new.purchase_order_id,new.kind,new.source_id,new.risk_date)
   and s.available_before is not distinct from new.available_before and s.available_after is not distinct from new.available_after) then
   raise exception 'Verified purchase-order risk source required.' using errcode='PRA03';
 end if;
 return new;
end $$;
create trigger verify_po_risk_event before insert on po_risk_events for each row execute function validate_po_risk_event();
create trigger immutable_po_risk_event before update or delete on po_risk_events for each row execute function reject_commercial_draft_rewrite();

insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.po_risk.configure','Commercial','Configure purchase-order risk notices','Set scoped mandatory recipients and the purchase-order notice template.',false);

create table po_risk_notice_policies (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, purchase_order_id text not null,
 version integer not null check(version>0), effective_from date not null,
 manager_id uuid not null references users(id), manager_role text not null,
 finance_id uuid not null references users(id), finance_role text not null,
 locale text not null check(length(locale) between 2 and 64),
 title text not null check(length(trim(title)) between 1 and 200),
 body text not null check(length(trim(body)) between 1 and 2000),
 actor_id uuid not null references users(id), active_role text not null, operation_id text not null,
 reason text not null check(length(trim(reason)) between 3 and 1000),
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,purchase_order_id,version),
 foreign key(purchase_order_id) references commercial_purchase_order_releases(purchase_order_id)
);
create trigger immutable_po_risk_policy before update or delete on po_risk_notice_policies
 for each row execute function reject_commercial_draft_rewrite();


create function po_risk_named_recipient(org text,entity text,po text,who uuid,held text) returns boolean language sql stable as $$
 select invoice_notice_named_recipient(org,entity,who,held) and invoice_notice_actor_has(org,entity,who,held,'commercial.contracts.view')
 and exists(select from users u join employees w on w.id=u.employee_record_id where u.id=who and w.organization_id=org and w.legal_entity_id=entity
   and w.status in ('Active','On Leave') and coalesce(w.joining_date,'-infinity'::date)<=(now() at time zone 'UTC')::date
   and coalesce(w.exit_date,'infinity'::date)>=(now() at time zone 'UTC')::date)
 and not exists(select from po_risk_engagement_owners(org,entity,po) o join commercial_engagements e on e.id=o.engagement_id
   where not rate_candidate_worker_visible(jsonb_build_object('actorId',who,'activeRole',held,'organizationId',org,'legalEntityId',entity),e.owner_id))
$$;
create function po_risk_recipients(org text,entity text,po text,manager uuid,manager_role text,finance uuid,finance_role text)
returns table(user_id uuid, reason text) language sql stable as $$
 with owners as (select * from po_risk_engagement_owners(org,entity,po))
 select distinct o.user_id,'engagement_owner' from owners o
 where exists(select from owners) and not exists(select from owners where owners.user_id is null)
   and po_risk_named_recipient(org,entity,po,manager,manager_role) and po_risk_named_recipient(org,entity,po,finance,finance_role)
 union all
 select named.id,named.reason from (values(manager,'commercial_manager'),(finance,'finance_billing_owner')) named(id,reason)
 where exists(select from owners) and not exists(select from owners where owners.user_id is null)
   and po_risk_named_recipient(org,entity,po,manager,manager_role) and po_risk_named_recipient(org,entity,po,finance,finance_role)
$$;
create function guard_po_risk_policy() returns trigger language plpgsql as $$
declare prior po_risk_notice_policies; ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.po_notice_policy_context',true),'')::jsonb;
 if ctx is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'role',new.active_role,'organization',new.organization_id,'entity',new.legal_entity_id,'order',new.purchase_order_id,'operation',new.operation_id)
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.po_risk.configure')
   or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
   or not exists(select from commercial_purchase_order_releases where purchase_order_id=new.purchase_order_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id)
 then raise exception 'Current scoped configuration authority required.' using errcode='PRN01'; end if;
 perform pg_advisory_xact_lock(hashtextextended('po-risk-policy:'||new.purchase_order_id,0));
 select * into prior from po_risk_notice_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and purchase_order_id=new.purchase_order_id order by version desc limit 1;
 if new.version<>coalesce(prior.version,0)+1 or new.effective_from<(now() at time zone 'UTC')::date or new.effective_from<prior.effective_from
 then raise exception 'Prospective notice policy version required.' using errcode='PRN02'; end if;
 if not exists(select from po_risk_recipients(new.organization_id,new.legal_entity_id,new.purchase_order_id,new.manager_id,new.manager_role,new.finance_id,new.finance_role))
 then raise exception 'Current scoped recipients required.' using errcode='PRN03'; end if;
 return new;
end $$;
create trigger validate_po_risk_policy before insert on po_risk_notice_policies
 for each row execute function guard_po_risk_policy();

create table po_risk_dispatch (
 event_id uuid primary key references po_risk_events(id), next_attempt timestamptz not null default now(),
 attempts integer not null default 0 check(attempts>=0), failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 policy_id uuid references po_risk_notice_policies(id), delivered_at timestamptz,
 check((delivered_at is null)=(policy_id is null)), check(delivered_at is null or failure is null)
);
create index po_risk_pending on po_risk_dispatch(next_attempt) where delivered_at is null;
create table po_risk_inbox (
 id uuid primary key, event_id uuid not null references po_risk_events(id), user_id uuid not null references users(id),
 reasons text[] not null check(cardinality(reasons)>0 and reasons <@ array['commercial_manager','engagement_owner','finance_billing_owner']),
 unique(event_id,user_id)
);
create index po_risk_inbox_user on po_risk_inbox(user_id,id);
create trigger immutable_po_risk_receipt before update or delete on po_risk_inbox
 for each row execute function reject_commercial_draft_rewrite();
create table po_risk_reads (
 recipient_id uuid primary key references po_risk_inbox(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp()
);
create trigger immutable_po_risk_read before update or delete on po_risk_reads
 for each row execute function reject_commercial_draft_rewrite();

create function po_risk_receipt_visible(receipt uuid,who uuid,held_role text,org text,entity text)
returns boolean language sql stable as $$
 select exists(select from po_risk_inbox i join po_risk_events e on e.id=i.event_id
   join po_risk_dispatch d on d.event_id=e.id and d.delivered_at is not null
   join lateral(select * from po_risk_notice_policies p where p.organization_id=org and p.legal_entity_id=entity
     and p.purchase_order_id=e.purchase_order_id and p.effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1) p on true
   where i.id=receipt and i.user_id=who and e.organization_id=org and e.legal_entity_id=entity and invoice_notice_named_recipient(org,entity,who,held_role)
     and (('engagement_owner'=any(i.reasons) and exists(select from po_risk_engagement_owners(org,entity,e.purchase_order_id) o where o.user_id=who))
       or (po_risk_named_recipient(org,entity,e.purchase_order_id,who,held_role) and (
           ('commercial_manager'=any(i.reasons) and p.manager_id=who and p.manager_role=held_role)
        or ('finance_billing_owner'=any(i.reasons) and p.finance_id=who and p.finance_role=held_role)))))
$$;
create function guard_po_risk_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
 if ctx->>'actorId' is distinct from new.user_id::text or po_risk_receipt_visible(new.recipient_id,new.user_id,
   ctx->>'activeRole',ctx->>'organizationId',ctx->>'legalEntityId') is not true then
   raise exception 'Recipient notice unavailable.' using errcode='PRN04';
 end if;
 return new;
end $$;
create trigger validate_po_risk_read before insert on po_risk_reads
 for each row execute function guard_po_risk_read();

-- Verify the committed recipient set even if a writer omits or redirects one receipt.
create function complete_po_risk_delivery() returns trigger language plpgsql as $$
declare event_key uuid; ev po_risk_events; d po_risk_dispatch; p po_risk_notice_policies;
begin
 event_key:=new.event_id;
 select * into ev from po_risk_events where id=event_key;
 select * into d from po_risk_dispatch where event_id=event_key;
 if d.delivered_at is null then
   if exists(select from po_risk_inbox where event_id=event_key) then
     raise exception 'Partial receipt set unavailable.' using errcode='PRN05';
   end if;
   return null;
 end if;
 select * into p from po_risk_notice_policies where organization_id=ev.organization_id and legal_entity_id=ev.legal_entity_id
   and purchase_order_id=ev.purchase_order_id and effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1;
 if p.id is distinct from d.policy_id or not exists(select from po_risk_inbox where event_id=event_key) or exists (
   with required as (select user_id,array_agg(reason order by reason) reasons from po_risk_recipients(ev.organization_id,
     ev.legal_entity_id,ev.purchase_order_id,p.manager_id,p.manager_role,p.finance_id,p.finance_role) group by user_id),
   receipts as (select user_id,reasons from po_risk_inbox where event_id=event_key)
   select from required full join receipts using(user_id) where required.reasons is distinct from receipts.reasons
 ) then raise exception 'Complete current scoped receipts required.' using errcode='PRN05'; end if;
 return null;
end $$;
create constraint trigger complete_po_risk_inbox after insert on po_risk_inbox
 deferrable initially deferred for each row execute function complete_po_risk_delivery();
create constraint trigger complete_po_risk_dispatch after insert or update on po_risk_dispatch
 deferrable initially deferred for each row execute function complete_po_risk_delivery();

create function guard_po_risk_dispatch() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or old.delivered_at is not null or old.event_id is distinct from new.event_id then
   raise exception 'Retained risk delivery is immutable.' using errcode='PRN05';
 end if;
 return new;
end $$;
create trigger protect_po_risk_dispatch before update or delete on po_risk_dispatch
 for each row execute function guard_po_risk_dispatch();

create table po_risk_delivery_attempts (
 event_id uuid not null references po_risk_events(id),
 attempt integer not null check(attempt>0),
 attempted_at timestamptz not null default clock_timestamp(),
 failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 delivered_at timestamptz, next_attempt timestamptz, policy_id uuid references po_risk_notice_policies(id),
 primary key(event_id,attempt),
 check ((failure is null)=(delivered_at is not null)),
 check ((delivered_at is null)=(next_attempt is not null)),
 check ((delivered_at is null)=(policy_id is null))
);
create trigger immutable_risk_delivery_attempt before update or delete on po_risk_delivery_attempts
 for each row execute function reject_commercial_draft_rewrite();

create function record_po_risk_attempt() returns trigger language plpgsql as $$
begin
 if new.attempts<>old.attempts+1 then raise exception 'Attempt sequence must advance once.' using errcode='PRN05'; end if;
 insert into po_risk_delivery_attempts(event_id,attempt,failure,delivered_at,next_attempt,policy_id)
 values(new.event_id,new.attempts,new.failure,new.delivered_at,
   case when new.delivered_at is null then new.next_attempt end,new.policy_id);
 return new;
end $$;
create trigger retain_risk_delivery_attempt after update of attempts on po_risk_dispatch
 for each row execute function record_po_risk_attempt();


create function require_po_risk_policy_audit() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id
   and module='Commercial Notifications' and action='Configure Purchase Order Risk Notices' and entity_id=new.id::text) then
   raise exception 'Policy audit required.' using errcode='PRN02';
 end if;
 return null;
end $$;
create constraint trigger po_notice_policy_audit after insert on po_risk_notice_policies deferrable initially deferred
 for each row execute function require_po_risk_policy_audit();
