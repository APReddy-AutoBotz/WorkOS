-- Terms belong to the immutable contract version and use its currency.
create function valid_service_period_charges(terms jsonb, contract_model text, first_day date, last_day date)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare term jsonb; starts date; ends date; previous_end date;
begin
 if jsonb_typeof(terms) is distinct from 'array' then return false; end if;
 if jsonb_array_length(terms)>120 or (terms<>'[]'::jsonb and contract_model<>'managed_service') then return false; end if;
 for term in select value from jsonb_array_elements(terms) loop
   if jsonb_typeof(term) is distinct from 'object' then return false; end if;
   if (term - array['startsOn','endsOn','amount']) <> '{}'::jsonb
     or jsonb_typeof(term->'startsOn') is distinct from 'string'
     or jsonb_typeof(term->'endsOn') is distinct from 'string'
     or jsonb_typeof(term->'amount') is distinct from 'string'
     or (term->>'startsOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or (term->>'endsOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or (term->>'amount') !~ '^(0|[1-9][0-9]{0,13})([.][0-9]{1,4})?$' then return false; end if;
   starts:=(term->>'startsOn')::date;
   ends:=(term->>'endsOn')::date;
   if starts<first_day or ends>last_day or starts>ends or starts<=previous_end or (term->>'amount')::numeric<=0 then return false; end if;
   previous_end:=ends;
 end loop;
 return true;
exception when datetime_field_overflow or invalid_datetime_format then return false;
end $$;
alter table commercial_contract_versions add column service_period_charges jsonb not null default '[]'::jsonb,
 add constraint service_period_charges_valid check(valid_service_period_charges(service_period_charges,model,starts_on,ends_on));
