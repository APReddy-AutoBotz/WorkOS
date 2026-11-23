create table fixed_fee_risk_delivery_attempts (
 event_id uuid not null references fixed_fee_risk_events(id),
 attempt integer not null check(attempt>0),
 attempted_at timestamptz not null default clock_timestamp(),
 failure text check(failure in ('POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE','DELIVERY_UNAVAILABLE')),
 delivered_at timestamptz, next_attempt timestamptz, policy_id uuid references fixed_fee_risk_notice_policies(id),
 primary key(event_id,attempt),
 check ((failure is null)=(delivered_at is not null)),
 check ((delivered_at is null)=(next_attempt is not null)),
 check ((delivered_at is null)=(policy_id is null))
);
create trigger immutable_risk_delivery_attempt before update or delete on fixed_fee_risk_delivery_attempts
 for each row execute function reject_commercial_draft_rewrite();

create function record_fixed_fee_risk_attempt() returns trigger language plpgsql as $$
begin
 if new.attempts<>old.attempts+1 then raise exception 'Attempt sequence must advance once.' using errcode='FRN05'; end if;
 insert into fixed_fee_risk_delivery_attempts(event_id,attempt,failure,delivered_at,next_attempt,policy_id)
 values(new.event_id,new.attempts,new.failure,new.delivered_at,
   case when new.delivered_at is null then new.next_attempt end,new.policy_id);
 return new;
end $$;
create trigger retain_risk_delivery_attempt after update of attempts on fixed_fee_risk_dispatch
 for each row execute function record_fixed_fee_risk_attempt();
