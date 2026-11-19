-- Check the event's own UTC eligibility date for every source entering the register.
-- A rejected insert rolls back its approval decision and register membership together.
create function guard_billing_eligibility_period() returns trigger language plpgsql as $$
begin
  perform assert_tm_financial_period(new.organization_id, new.legal_entity_id, new.eligible_on);
  return new;
end $$;

create trigger verify_billing_eligibility_period before insert on billing_eligibility_events
for each row execute function guard_billing_eligibility_period();
