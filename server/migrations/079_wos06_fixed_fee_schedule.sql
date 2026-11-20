create function valid_contract_installments(schedule jsonb, model text, starts date, ends date, total numeric)
returns boolean language plpgsql immutable strict as $$
declare item jsonb; due date; previous_due date; amount numeric; scheduled numeric := 0;
begin
  if jsonb_typeof(schedule) <> 'array' then return false; end if;
  if jsonb_array_length(schedule) = 0 then return true; end if;
  if model <> 'fixed_fee' or jsonb_array_length(schedule) > 120 then return false; end if;
  for item in select value from jsonb_array_elements(schedule) loop
    if jsonb_typeof(item) <> 'object' then return false; end if;
    if item - 'dueOn' - 'amount' <> '{}'::jsonb
      or jsonb_typeof(item->'dueOn') is distinct from 'string'
      or jsonb_typeof(item->'amount') is distinct from 'string'
      or item->>'dueOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or item->>'amount' !~ '^(0|[1-9][0-9]{0,13})([.][0-9]{1,4})?$' then return false; end if;
    due := (item->>'dueOn')::date;
    amount := (item->>'amount')::numeric;
    if due < starts or due > ends or due < previous_due or amount <= 0 then return false; end if;
    previous_due := due;
    scheduled := scheduled + amount;
  end loop;
  return scheduled = total;
exception when datetime_field_overflow or invalid_datetime_format then return false;
end $$;

alter table commercial_contract_versions add column installments jsonb not null default '[]'::jsonb,
  add constraint fixed_fee_installments_valid check (
    valid_contract_installments(installments, model, starts_on, ends_on, value)
  );
