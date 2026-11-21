create function valid_service_dimensions(dimensions jsonb, contract_model text)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare dimension jsonb;
begin
 if jsonb_typeof(dimensions) is distinct from 'array' then return false; end if;
 if jsonb_array_length(dimensions)=0 then return true; end if;
 if contract_model is distinct from 'managed_service' or jsonb_array_length(dimensions)>50 then return false; end if;
 for dimension in select value from jsonb_array_elements(dimensions) loop
   if jsonb_typeof(dimension) is distinct from 'object' then return false; end if;
   if not (dimension ?& array['code','label','precision']) or dimension-array['code','label','precision'] <> '{}'::jsonb
      or jsonb_typeof(dimension->'code') is distinct from 'string' or (dimension->>'code') collate "C" !~ '^[A-Z][A-Z0-9_]{0,39}$'
      or jsonb_typeof(dimension->'label') is distinct from 'string' or length(dimension->>'label') not between 1 and 80
      or not public.valid_capability_label(dimension->>'label')
      or jsonb_typeof(dimension->'precision') is distinct from 'number' or dimension->>'precision' !~ '^[0-4]$'
   then return false; end if;
 end loop;
 return (select count(*)=count(distinct (v->>'code') collate "C") from jsonb_array_elements(dimensions) v);
end $$;
alter table commercial_contract_versions add column service_dimensions jsonb not null default '[]'::jsonb,
 add constraint managed_service_dimensions_valid check(valid_service_dimensions(service_dimensions,model));
