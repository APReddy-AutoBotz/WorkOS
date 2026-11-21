create function valid_retainer_periods(periods jsonb, model text, starts date, ends date)
returns boolean language plpgsql immutable strict as $$
declare
  period jsonb;
  period_start date;
  period_end date;
  previous_end date;
  decimal_pattern constant text := '^(0|[1-9][0-9]{0,13})([.][0-9]{1,4})?$';
begin
  if jsonb_typeof(periods) <> 'array' then return false; end if;
  if jsonb_array_length(periods) = 0 then return true; end if;
  if model <> 'retainer' or jsonb_array_length(periods) > 120 then return false; end if;
  for period in select value from jsonb_array_elements(periods) loop
    if jsonb_typeof(period) <> 'object'
      or period - 'startsOn' - 'endsOn' - 'includedHours' - 'baseFee' <> '{}'::jsonb
      or jsonb_typeof(period->'startsOn') is distinct from 'string'
      or jsonb_typeof(period->'endsOn') is distinct from 'string'
      or jsonb_typeof(period->'includedHours') is distinct from 'string'
      or jsonb_typeof(period->'baseFee') is distinct from 'string'
      or period->>'startsOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or period->>'endsOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or period->>'includedHours' !~ decimal_pattern
      or period->>'baseFee' !~ decimal_pattern then return false; end if;
    period_start := (period->>'startsOn')::date;
    period_end := (period->>'endsOn')::date;
    if period_start < starts or period_end > ends or period_end < period_start
      or period_start <= previous_end or (period->>'includedHours')::numeric <= 0 then return false; end if;
    previous_end := period_end;
  end loop;
  return true;
exception when datetime_field_overflow or invalid_datetime_format then return false;
end $$;

alter table commercial_contract_versions add column retainer_periods jsonb not null default '[]'::jsonb,
  add constraint retainer_periods_valid check (valid_retainer_periods(retainer_periods, model, starts_on, ends_on));
