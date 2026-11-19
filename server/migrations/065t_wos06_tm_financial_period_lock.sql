-- New valuation evidence must be authorized by the periods covering the work date.
-- Replays and historical reads do not insert a valuation.
create function guard_tm_financial_period() returns trigger language plpgsql as $$
declare
  work_day date;
  period_row record;
  has_week boolean := false;
  frequency_name text;
begin
  select e.work_date into strict work_day from timesheet_entries e where e.id=new.entry_id;
  -- Coordinate with organization setup, including creation of an overlapping
  -- Monthly or Fiscal period that would not yet appear in the row-lock query.
  foreach frequency_name in array array['Fiscal','Monthly','Weekly'] loop
    perform pg_advisory_xact_lock_shared(hashtext(
      'reporting-period:' || new.organization_id || ':' || new.legal_entity_id || ':' || frequency_name));
  end loop;
  for period_row in
    select frequency,status from reporting_periods
    where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
      and work_day between starts_on and ends_on
    order by frequency,id for share
  loop
    if period_row.status not in ('Open','Submission Closed','Approval Closed') then
      raise exception 'Reporting period prohibits financial valuation' using errcode='CTM04';
    end if;
    if period_row.frequency='Weekly' then has_week := true; end if;
  end loop;
  if not has_week then
    raise exception 'Weekly financial period authority is missing' using errcode='CTM04';
  end if;
  return new;
end $$;

create trigger verify_tm_financial_period before insert on commercial_tm_valuations
for each row execute function guard_tm_financial_period();
