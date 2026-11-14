-- Preserve exact percentage multiplication without numeric division rounding.
create or replace function valid_capacity_profile(value jsonb) returns boolean language plpgsql immutable as $$
declare q jsonb;baseline numeric;percentage numeric;
begin
 if jsonb_typeof(value) is distinct from 'object' or value-array['fullTimeWeeklyHoursExact','partTimePercentExact','hoursByWeekdayExact','utilizationEligible','workerGroupId','calendarOverrideId']<>'{}'::jsonb
   or not(value ?& array['fullTimeWeeklyHoursExact','partTimePercentExact','hoursByWeekdayExact','utilizationEligible','workerGroupId','calendarOverrideId']) then return false;end if;
 for q in select value->'fullTimeWeeklyHoursExact' union all select value->'partTimePercentExact' loop
  if jsonb_typeof(q) is distinct from 'string' or char_length(q#>>'{}')>100 or q#>>'{}' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' then return false;end if;
 end loop;
 baseline=(value->>'fullTimeWeeklyHoursExact')::numeric;percentage=(value->>'partTimePercentExact')::numeric;
 if baseline<=0 or baseline>168 or percentage<0 or percentage>100 or jsonb_typeof(value->'hoursByWeekdayExact') is distinct from 'array' or jsonb_array_length(value->'hoursByWeekdayExact')<>7 or jsonb_typeof(value->'utilizationEligible') is distinct from 'boolean' then return false;end if;
 for q in select * from jsonb_array_elements(value->'hoursByWeekdayExact') loop
  if jsonb_typeof(q) is distinct from 'string' or char_length(q#>>'{}')>100 or q#>>'{}' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' or (q#>>'{}')::numeric<0 or (q#>>'{}')::numeric>24 then return false;end if;
 end loop;
 for q in select value->'workerGroupId' union all select value->'calendarOverrideId' loop
  if q<>'null'::jsonb and (jsonb_typeof(q) is distinct from 'string' or char_length(q#>>'{}') not between 1 and 200 or btrim(q#>>'{}')<>q#>>'{}' or q#>>'{}' ~ '[\x01-\x1f\x7f-\x9f]') then return false;end if;
 end loop;
 return capacity_weekly_hours(value)=baseline*percentage*0.01;
exception when others then return false;
end $$;
