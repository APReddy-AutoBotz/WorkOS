-- Buyer-entered planning information only. No defaults, grants or backfill.
create function valid_capability_label(value text) returns boolean language sql immutable as $$
 select value is not null and char_length(value) between 1 and 100
   and value !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029\ufeff]'
   and value !~ '^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]|[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]$';
$$;
create function valid_capability_date(value text) returns boolean language plpgsql immutable as $$
begin
 if value is null or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or value<'0001-01-01' then return false; end if;
 return to_char(value::date,'YYYY-MM-DD')=value;
exception when others then return false;
end $$;
create function valid_workforce_capabilities(value jsonb) returns boolean language plpgsql immutable as $$
declare item jsonb;
begin
 if jsonb_typeof(value) is distinct from 'object' or value - array['skills','certifications','availabilityNote'] <> '{}'::jsonb
   or not(value ?& array['skills','certifications','availabilityNote']) then return false; end if;
 if jsonb_typeof(value->'skills') is distinct from 'array' or jsonb_typeof(value->'certifications') is distinct from 'array' then return false; end if;
 if jsonb_array_length(value->'skills')>50 or jsonb_array_length(value->'certifications')>50 then return false; end if;
 for item in select * from jsonb_array_elements(value->'skills') loop
  if jsonb_typeof(item) is distinct from 'object' or item-array['skill','proficiency'] <> '{}'::jsonb or not(item ?& array['skill','proficiency'])
    or jsonb_typeof(item->'skill') is distinct from 'string' or not valid_capability_label(item->>'skill')
    or (item->'proficiency'<>'null'::jsonb and (jsonb_typeof(item->'proficiency') is distinct from 'string' or not valid_capability_label(item->>'proficiency'))) then return false; end if;
 end loop;
 if (select count(*)<>count(distinct (i->>'skill') collate "C") from jsonb_array_elements(value->'skills') i) then return false; end if;
 for item in select * from jsonb_array_elements(value->'certifications') loop
  if jsonb_typeof(item) is distinct from 'object' or item-array['certification','validFrom','validThrough','noExpiry']<>'{}'::jsonb
    or not(item ?& array['certification','validFrom','validThrough','noExpiry'])
    or jsonb_typeof(item->'certification') is distinct from 'string' or not valid_capability_label(item->>'certification')
    or jsonb_typeof(item->'validFrom') is distinct from 'string' or not valid_capability_date(item->>'validFrom')
    or jsonb_typeof(item->'noExpiry') is distinct from 'boolean' then return false; end if;
  if item->'noExpiry'='true'::jsonb then
   if item->'validThrough'<>'null'::jsonb then return false; end if;
  elsif jsonb_typeof(item->'validThrough') is distinct from 'string' or not valid_capability_date(item->>'validThrough') or item->>'validThrough'<item->>'validFrom' then return false;
  end if;
 end loop;
 if (select count(*)<>count(distinct (i->>'certification') collate "C") from jsonb_array_elements(value->'certifications') i) then return false; end if;
 if value->'availabilityNote'<>'null'::jsonb and (jsonb_typeof(value->'availabilityNote') is distinct from 'string'
   or char_length(value->>'availabilityNote') not between 1 and 3000
   or value->>'availabilityNote' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]'
   or value->>'availabilityNote' ~ '^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]|[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]$') then return false; end if;
 return true;
end $$;
create table workforce_capability_versions (
 id uuid primary key,
 organization_id text not null,
 legal_entity_id text not null,
 employee_id text not null,
 sequence integer not null check(sequence>0),
 contract_version text not null check(contract_version='workforce-capabilities/1'),
 profile jsonb not null check(valid_workforce_capabilities(profile)),
 actor_id text not null,
 active_role text not null,
 source text not null check(source='Web'),
 reason text not null check(char_length(btrim(reason)) between 1 and 1000),
 created_at timestamptz not null default now(),
 foreign key(organization_id,legal_entity_id,employee_id) references employees(organization_id,legal_entity_id,id) on delete restrict,
 unique(organization_id,legal_entity_id,employee_id,sequence)
);
create trigger immutable_workforce_capability_versions before update or delete on workforce_capability_versions
 for each row execute function reject_commercial_draft_rewrite();
