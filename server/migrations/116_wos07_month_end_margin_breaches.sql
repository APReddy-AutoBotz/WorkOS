-- A month first becomes observable at the next UTC midnight. Before that
-- instant only its final retained version can enter the monthly decision.
create view commercial_service_margin_breaches as
with observable as (
  select m.id,m.organization_id,m.legal_entity_id,m.engagement_id,m.month_start,m.version,
    m.report->>'marginPercent' as margin_percent, a.status, a.amendment_id, a.ends_on, a.threshold_percent,
    max(m.version) filter (where m.created_at < ((a.ends_on + 1)::timestamp at time zone 'UTC'))
      over (partition by m.organization_id,m.legal_entity_id,m.engagement_id,m.month_start) as closing_version
  from commercial_service_margin_versions m
  join commercial_service_month_end_thresholds a on a.margin_version_id=m.id
  where a.ends_on < (now() at time zone 'UTC')::date
), compared as (
  select observable.*, lag(status) over (
    partition by organization_id,legal_entity_id,engagement_id,month_start order by version
  ) as previous_status
  from observable where (closing_version is null or version>=closing_version) and status in ('Below','AtOrAbove')
)
select id as margin_version_id, amendment_id, organization_id, legal_entity_id, engagement_id,
       ends_on, threshold_percent, margin_percent::numeric as margin_percent
from compared where status='Below' and previous_status is distinct from 'Below';

create table commercial_service_margin_alerts (
  margin_version_id uuid primary key references commercial_service_margin_versions(id),
  amendment_id text not null references commercial_amendments(id),
  observed_at timestamptz not null default clock_timestamp()
);
create trigger immutable_service_margin_alert before update or delete on commercial_service_margin_alerts
  for each row execute function reject_commercial_draft_rewrite();

create function guard_service_margin_alert() returns trigger language plpgsql as $$
begin
  if not exists (select from commercial_service_margin_breaches b
                 where b.margin_version_id=new.margin_version_id and b.amendment_id=new.amendment_id)
  then raise exception 'Verified month-end margin breach required.' using errcode='23514'; end if;
  return new;
end $$;
create trigger validate_service_margin_alert before insert on commercial_service_margin_alerts
  for each row execute function guard_service_margin_alert();

create view service_margin_risk_events as
select a.margin_version_id as id,m.organization_id,m.legal_entity_id,m.engagement_id,m.month_start,
       a.amendment_id,a.observed_at
from commercial_service_margin_alerts a
join commercial_service_margin_versions m on m.id=a.margin_version_id;

create table service_margin_risk_dispatch (
 event_id uuid primary key references commercial_service_margin_alerts(margin_version_id), next_attempt timestamptz not null default now(),
 attempts integer not null default 0 check(attempts>=0), failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 policy_id uuid references fixed_fee_risk_notice_policies(id), delivered_at timestamptz,
 check((delivered_at is null)=(policy_id is null)), check(delivered_at is null or failure is null)
);
create index service_margin_risk_pending on service_margin_risk_dispatch(next_attempt) where delivered_at is null;
create table service_margin_risk_inbox (
 id uuid primary key, event_id uuid not null references commercial_service_margin_alerts(margin_version_id), user_id uuid not null references users(id),
 reasons text[] not null check(cardinality(reasons)>0 and reasons <@ array['commercial_manager','engagement_owner','finance_billing_owner']),
 unique(event_id,user_id)
);
create index service_margin_risk_inbox_user on service_margin_risk_inbox(user_id,id);
create trigger immutable_service_margin_risk_receipt before update or delete on service_margin_risk_inbox
 for each row execute function reject_commercial_draft_rewrite();
create table service_margin_risk_reads (
 recipient_id uuid primary key references service_margin_risk_inbox(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp()
);
create trigger immutable_service_margin_risk_read before update or delete on service_margin_risk_reads
 for each row execute function reject_commercial_draft_rewrite();

create function service_margin_risk_receipt_visible(receipt uuid,who uuid,held_role text,org text,entity text)
returns boolean language sql stable as $$
 select exists(select from service_margin_risk_inbox i join service_margin_risk_events e on e.id=i.event_id
   join service_margin_risk_dispatch d on d.event_id=e.id and d.delivered_at is not null
   join lateral(select * from fixed_fee_risk_notice_policies p where p.organization_id=e.organization_id and p.legal_entity_id=e.legal_entity_id
     and p.engagement_id=e.engagement_id and p.effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1) p on true
   join commercial_engagements eng on eng.id=e.engagement_id and eng.organization_id=org and eng.legal_entity_id=entity
   join users u on u.id=i.user_id join employees worker on worker.id=u.employee_record_id and worker.organization_id=org and worker.legal_entity_id=entity
   where i.id=receipt and i.user_id=who and e.organization_id=org and e.legal_entity_id=entity
     and worker.status in ('Active','On Leave') and coalesce(worker.joining_date,'-infinity'::date)<=(now() at time zone 'UTC')::date
     and coalesce(worker.exit_date,'infinity'::date)>=(now() at time zone 'UTC')::date
     and invoice_notice_named_recipient(org,entity,who,held_role)
     and ((worker.id=eng.owner_id and 'engagement_owner'=any(i.reasons)) or (
       invoice_notice_actor_has(org,entity,who,held_role,'commercial.contracts.view')
       and rate_candidate_worker_visible(jsonb_build_object('actorId',who,'activeRole',held_role,'organizationId',org,'legalEntityId',entity),eng.owner_id)
       and ((who=p.manager_id and held_role=p.manager_role and 'commercial_manager'=any(i.reasons))
         or (who=p.finance_id and held_role=p.finance_role and 'finance_billing_owner'=any(i.reasons))))))
$$;
create function guard_service_margin_risk_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
 if ctx->>'actorId' is distinct from new.user_id::text or service_margin_risk_receipt_visible(new.recipient_id,new.user_id,
   ctx->>'activeRole',ctx->>'organizationId',ctx->>'legalEntityId') is not true then
   raise exception 'Recipient notice unavailable.' using errcode='FRN04';
 end if;
 return new;
end $$;
create trigger validate_service_margin_risk_read before insert on service_margin_risk_reads
 for each row execute function guard_service_margin_risk_read();

-- Verify the committed recipient set even if a writer omits or redirects one receipt.
create function complete_service_margin_risk_delivery() returns trigger language plpgsql as $$
declare event_key uuid; ev service_margin_risk_events; d service_margin_risk_dispatch; p fixed_fee_risk_notice_policies;
begin
 event_key:=new.event_id;
 select * into ev from service_margin_risk_events where id=event_key;
 select * into d from service_margin_risk_dispatch where event_id=event_key;
 if d.delivered_at is null then
   if exists(select from service_margin_risk_inbox where event_id=event_key) then
     raise exception 'Partial receipt set unavailable.' using errcode='FRN05';
   end if;
   return null;
 end if;
 select * into p from fixed_fee_risk_notice_policies where organization_id=ev.organization_id and legal_entity_id=ev.legal_entity_id
   and engagement_id=ev.engagement_id and effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1;
 if p.id is distinct from d.policy_id or not exists(select from service_margin_risk_inbox where event_id=event_key) or exists (
   with required as (select user_id,array_agg(reason order by reason) reasons from engagement_risk_recipients('managed_service',ev.organization_id,
     ev.legal_entity_id,ev.engagement_id,p.manager_id,p.manager_role,p.finance_id,p.finance_role) group by user_id),
   receipts as (select user_id,reasons from service_margin_risk_inbox where event_id=event_key)
   select from required full join receipts using(user_id) where required.reasons is distinct from receipts.reasons
 ) then raise exception 'Complete current scoped receipts required.' using errcode='FRN05'; end if;
 return null;
end $$;
create constraint trigger complete_service_margin_risk_inbox after insert on service_margin_risk_inbox
 deferrable initially deferred for each row execute function complete_service_margin_risk_delivery();
create constraint trigger complete_service_margin_risk_dispatch after insert or update on service_margin_risk_dispatch
 deferrable initially deferred for each row execute function complete_service_margin_risk_delivery();

create function guard_service_margin_risk_dispatch() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or old.delivered_at is not null or old.event_id is distinct from new.event_id then
   raise exception 'Retained risk delivery is immutable.' using errcode='FRN05';
 end if;
 return new;
end $$;
create trigger protect_service_margin_risk_dispatch before update or delete on service_margin_risk_dispatch
 for each row execute function guard_service_margin_risk_dispatch();

create table service_margin_risk_delivery_attempts (
 event_id uuid not null references commercial_service_margin_alerts(margin_version_id),
 attempt integer not null check(attempt>0),
 attempted_at timestamptz not null default clock_timestamp(),
 failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 delivered_at timestamptz, next_attempt timestamptz, policy_id uuid references fixed_fee_risk_notice_policies(id),
 primary key(event_id,attempt),
 check ((failure is null)=(delivered_at is not null)),
 check ((delivered_at is null)=(next_attempt is not null)),
 check ((delivered_at is null)=(policy_id is null))
);
create trigger immutable_margin_risk_delivery_attempt before update or delete on service_margin_risk_delivery_attempts
 for each row execute function reject_commercial_draft_rewrite();

create function record_service_margin_risk_attempt() returns trigger language plpgsql as $$
begin
 if new.attempts<>old.attempts+1 then raise exception 'Attempt sequence must advance once.' using errcode='FRN05'; end if;
 insert into service_margin_risk_delivery_attempts(event_id,attempt,failure,delivered_at,next_attempt,policy_id)
 values(new.event_id,new.attempts,new.failure,new.delivered_at,
   case when new.delivered_at is null then new.next_attempt end,new.policy_id);
 return new;
end $$;
create trigger retain_margin_risk_delivery_attempt after update of attempts on service_margin_risk_dispatch
 for each row execute function record_service_margin_risk_attempt();
