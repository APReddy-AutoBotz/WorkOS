-- All writers, including direct database callers, use the same period authority
-- as work costs and billing. Historical reads and idempotent replays do not insert.
create function guard_fixed_fee_value_period() returns trigger language plpgsql as $$
begin
  if tg_table_name='commercial_fixed_fee_elapsed_values' then
    perform assert_tm_financial_period(new.organization_id,new.legal_entity_id,new.service_day);
  else
    perform assert_tm_financial_period(new.organization_id,new.legal_entity_id,new.through_date);
  end if;
  return new;
end $$;

create trigger verify_elapsed_financial_period before insert on commercial_fixed_fee_elapsed_values
 for each row execute function guard_fixed_fee_value_period();
create trigger verify_progress_financial_period before insert on commercial_fixed_fee_progress_values
 for each row execute function guard_fixed_fee_value_period();

create function guard_fixed_fee_transition_period() returns trigger language plpgsql as $$
declare
  first_day date;
  last_day date;
  reviewed_through date;
  boundary date;
  future_status text;
begin
  select effective_on,ends_on into strict first_day,last_day from commercial_amendments
   where id=new.policy_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
     and entity_type='Engagement' and entity_id=new.engagement_id;
  reviewed_through:=greatest(first_day,least(last_day,(now() at time zone 'UTC')::date));
  perform assert_tm_financial_period(new.organization_id,new.legal_entity_id,first_day);
  -- Coverage changes only when a reporting period starts or ends. Checking those
  -- boundaries catches both overlapping locks and gaps in historical weekly coverage.
  for boundary in
    with periods as (select starts_on,ends_on from reporting_periods
      where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
        and starts_on<=reviewed_through and ends_on>=first_day),
    boundaries(day) as (select starts_on from periods union select ends_on+1 from periods)
    select day from boundaries where day>first_day and day<=reviewed_through order by day
  loop
    perform assert_tm_financial_period(new.organization_id,new.legal_entity_id,boundary);
  end loop;
  -- A forward schedule may extend beyond configured weeks. Honor every existing
  -- lock in that future interval without requiring uncreated weeks to be opened.
  for future_status in select status from reporting_periods where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
    and starts_on<=last_day and ends_on>reviewed_through order by frequency,id for share
  loop
    if future_status not in ('Open','Submission Closed','Approval Closed') then
      raise exception 'Transition overlaps a locked reporting period' using errcode='CTM04';
    end if;
  end loop;
  return new;
end $$;
create trigger verify_transition_financial_period before insert on commercial_fixed_fee_transition_approvals
 for each row execute function guard_fixed_fee_transition_period();
