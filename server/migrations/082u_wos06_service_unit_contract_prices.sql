-- Keep the original shape, label, model and uniqueness checks for all dimensions.
create function valid_priced_service_dimensions(dimensions jsonb, contract_model text)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare unit jsonb; unpriced jsonb := '[]'::jsonb;
begin
 if jsonb_typeof(dimensions) is distinct from 'array' then return false; end if;
 if jsonb_array_length(dimensions)>50 then return false; end if;
 for unit in select value from jsonb_array_elements(dimensions) loop
   if jsonb_typeof(unit) is distinct from 'object' then return false; end if;
   if unit ? 'unitPrice' and (jsonb_typeof(unit->'unitPrice') is distinct from 'string'
      or (unit->>'unitPrice') collate "C" !~ '^(0|[1-9][0-9]{0,13})([.][0-9]{1,4})?$') then return false; end if;
   unpriced:=unpriced || jsonb_build_array(unit-'unitPrice');
 end loop;
 return public.valid_service_dimensions(unpriced,contract_model);
end $$;
alter table commercial_contract_versions drop constraint managed_service_dimensions_valid,
 add constraint managed_service_dimensions_valid check(valid_priced_service_dimensions(service_dimensions,model));
