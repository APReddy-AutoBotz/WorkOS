-- Require the engagement owner's held role to open the canonical employee inbox.
alter function fixed_fee_risk_recipients(text,text,text,uuid,text,uuid,text) rename to fixed_fee_risk_relationship_candidates;
create function fixed_fee_risk_recipients(org text,entity text,eng text,manager uuid,manager_role text,finance uuid,finance_role text)
returns table(user_id uuid,reason text) language sql stable as $$
 with current_relationships as (select * from fixed_fee_risk_relationship_candidates(org,entity,eng,manager,manager_role,finance,finance_role))
 select r.user_id,r.reason from current_relationships r where exists(select from current_relationships owner
   join user_roles ur on ur.user_id=owner.user_id join roles held on held.id=ur.role_id where owner.reason='engagement_owner'
     and invoice_notice_named_recipient(org,entity,owner.user_id,held.name))
$$;

create index commercial_warning_engagements on commercial_amendments(organization_id,legal_entity_id,entity_id,effective_on)
 where entity_type='Engagement' and after_value->'terms'->>'budgetWarningPercent' ~ '^[1-9][0-9]*$';
create table fixed_fee_risk_scans (
 organization_id text not null, legal_entity_id text not null, engagement_id text not null,
 through_date date not null, next_check timestamptz not null default now(), failure text check(failure in ('EVALUATION_UNAVAILABLE')),
 primary key(organization_id,legal_entity_id,engagement_id),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create index fixed_fee_risk_due on fixed_fee_risk_scans(next_check,through_date);
create table fixed_fee_risk_events (
 id uuid primary key, organization_id text not null, legal_entity_id text not null, engagement_id text not null,
 source_id text not null references commercial_amendments(id), metric text not null check(metric in ('effort','laborCost')),
 through_date date not null, actual numeric not null check(actual>0), budget numeric not null check(budget>=0),
 percent integer not null check(percent between 1 and 100 and actual*100>=budget*percent),
 created_at timestamptz not null default clock_timestamp(), unique(organization_id,legal_entity_id,engagement_id,metric,source_id),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create trigger immutable_fixed_fee_risk_event before update or delete on fixed_fee_risk_events
 for each row execute function reject_commercial_draft_rewrite();
create table fixed_fee_risk_dispatch (
 event_id uuid primary key references fixed_fee_risk_events(id), next_attempt timestamptz not null default now(),
 attempts integer not null default 0 check(attempts>=0), failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 policy_id uuid references fixed_fee_risk_notice_policies(id), delivered_at timestamptz,
 check((delivered_at is null)=(policy_id is null)), check(delivered_at is null or failure is null)
);
create index fixed_fee_risk_pending on fixed_fee_risk_dispatch(next_attempt) where delivered_at is null;
create table fixed_fee_risk_inbox (
 id uuid primary key, event_id uuid not null references fixed_fee_risk_events(id), user_id uuid not null references users(id),
 reasons text[] not null check(cardinality(reasons)>0 and reasons <@ array['commercial_manager','engagement_owner','finance_billing_owner']),
 unique(event_id,user_id)
);
create index fixed_fee_risk_inbox_user on fixed_fee_risk_inbox(user_id,id);
create trigger immutable_fixed_fee_risk_receipt before update or delete on fixed_fee_risk_inbox
 for each row execute function reject_commercial_draft_rewrite();
create table fixed_fee_risk_reads (
 recipient_id uuid primary key references fixed_fee_risk_inbox(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp()
);
create trigger immutable_fixed_fee_risk_read before update or delete on fixed_fee_risk_reads
 for each row execute function reject_commercial_draft_rewrite();

insert into fixed_fee_risk_scans(organization_id,legal_entity_id,engagement_id,through_date)
 select organization_id,legal_entity_id,entity_id,greatest(min(effective_on),(now() at time zone 'UTC')::date)
 from commercial_amendments where entity_type='Engagement' and after_value->'terms'->>'budgetWarningPercent' ~ '^[1-9][0-9]*$'
 group by organization_id,legal_entity_id,entity_id;
create function fixed_fee_risk_receipt_visible(receipt uuid,who uuid,held_role text,org text,entity text)
returns boolean language sql stable as $$
 select exists(select from fixed_fee_risk_inbox i join fixed_fee_risk_events e on e.id=i.event_id
   join fixed_fee_risk_dispatch d on d.event_id=e.id and d.delivered_at is not null
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
create function guard_fixed_fee_risk_read() returns trigger language plpgsql as $$
declare ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.work_approval_context',true),'')::jsonb;
 if ctx->>'actorId' is distinct from new.user_id::text or fixed_fee_risk_receipt_visible(new.recipient_id,new.user_id,
   ctx->>'activeRole',ctx->>'organizationId',ctx->>'legalEntityId') is not true then
   raise exception 'Recipient notice unavailable.' using errcode='FRN04';
 end if;
 return new;
end $$;
create trigger validate_fixed_fee_risk_read before insert on fixed_fee_risk_reads
 for each row execute function guard_fixed_fee_risk_read();

-- Verify the committed recipient set even if a writer omits or redirects one receipt.
create function complete_fixed_fee_risk_delivery() returns trigger language plpgsql as $$
declare event_key uuid; ev fixed_fee_risk_events; d fixed_fee_risk_dispatch; p fixed_fee_risk_notice_policies;
begin
 event_key:=new.event_id;
 select * into ev from fixed_fee_risk_events where id=event_key;
 select * into d from fixed_fee_risk_dispatch where event_id=event_key;
 if d.delivered_at is null then
   if exists(select from fixed_fee_risk_inbox where event_id=event_key) then
     raise exception 'Partial receipt set unavailable.' using errcode='FRN05';
   end if;
   return null;
 end if;
 select * into p from fixed_fee_risk_notice_policies where organization_id=ev.organization_id and legal_entity_id=ev.legal_entity_id
   and engagement_id=ev.engagement_id and effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1;
 if p.id is distinct from d.policy_id or not exists(select from fixed_fee_risk_inbox where event_id=event_key) or exists (
   with required as (select user_id,array_agg(reason order by reason) reasons from fixed_fee_risk_recipients(ev.organization_id,
     ev.legal_entity_id,ev.engagement_id,p.manager_id,p.manager_role,p.finance_id,p.finance_role) group by user_id),
   receipts as (select user_id,reasons from fixed_fee_risk_inbox where event_id=event_key)
   select from required full join receipts using(user_id) where required.reasons is distinct from receipts.reasons
 ) then raise exception 'Complete current scoped receipts required.' using errcode='FRN05'; end if;
 return null;
end $$;
create constraint trigger complete_fixed_fee_risk_inbox after insert on fixed_fee_risk_inbox
 deferrable initially deferred for each row execute function complete_fixed_fee_risk_delivery();
create constraint trigger complete_fixed_fee_risk_dispatch after insert or update on fixed_fee_risk_dispatch
 deferrable initially deferred for each row execute function complete_fixed_fee_risk_delivery();

create function guard_fixed_fee_risk_dispatch() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or old.delivered_at is not null or old.event_id is distinct from new.event_id then
   raise exception 'Retained risk delivery is immutable.' using errcode='FRN05';
 end if;
 return new;
end $$;
create trigger protect_fixed_fee_risk_dispatch before update or delete on fixed_fee_risk_dispatch
 for each row execute function guard_fixed_fee_risk_dispatch();

create function validate_fixed_fee_warning_source() returns trigger language plpgsql as $$
declare budget_key text; source_id text; terms jsonb;
begin
 budget_key:=case new.metric when 'effort' then 'budgetHours' else 'laborCostBudget' end;
 select a.after_value->'terms' into terms from commercial_amendments a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id
   and a.entity_type='Engagement' and a.entity_id=new.engagement_id and a.effective_on<=new.through_date order by a.sequence desc limit 1;
 select a.id into source_id from commercial_amendments a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id
   and a.entity_type='Engagement' and a.entity_id=new.engagement_id and a.effective_on<=new.through_date and (
   (a.before_value->'terms'->>'budgetWarningPercent') is distinct from (a.after_value->'terms'->>'budgetWarningPercent')
   or (a.before_value->'terms'->>budget_key)::numeric is distinct from (a.after_value->'terms'->>budget_key)::numeric)
   order by a.sequence desc limit 1;
 if new.source_id is distinct from source_id or new.percent::text is distinct from (terms->>'budgetWarningPercent')
   or new.budget is distinct from (terms->>budget_key)::numeric or new.through_date>(now() at time zone 'UTC')::date then
   raise exception 'Verified effective warning source required.' using errcode='FRN06';
 end if;
 return new;
end $$;
create trigger validate_fixed_fee_warning_source before insert on fixed_fee_risk_events
 for each row execute function validate_fixed_fee_warning_source();
