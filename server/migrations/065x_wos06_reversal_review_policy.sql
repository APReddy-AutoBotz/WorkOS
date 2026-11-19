-- Extends validation for new policy versions. Existing definitions remain invoice-only.
create or replace function valid_invoice_batch_approval_policy(d jsonb) returns boolean language plpgsql immutable as $$
begin
 if d ? 'fullLineReversals' then
   if d->'fullLineReversals' is distinct from 'true'::jsonb then return false; end if;
   if exists (select 1 from jsonb_array_elements(d->'stages') stage
     group by (stage->>'userId')::uuid having count(*)>1) then return false; end if;
   d := d - 'fullLineReversals';
 end if;
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','engagementId','stages','locale','templates','completionInApp']) or (select count(*) from jsonb_object_keys(d))<>6 or d->>'entityType' is distinct from 'InvoiceBatch' or jsonb_typeof(d->'engagementId') is distinct from 'string' or length(btrim(d->>'engagementId')) not between 1 and 200 then return false;end if;
 if not valid_work_approval_definition((d-'engagementId')||jsonb_build_object('entityType','Timesheet','workerIds','[]'::jsonb)) then return false;end if;
 if exists(select 1 from jsonb_array_elements(d->'templates') t where regexp_replace(t->>'subject','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]' or regexp_replace(t->>'body','\{\{(sourceRef|stageNumber)\}\}','','g') ~ '[{}]') then return false;end if;
 return true;
exception when others then return false;end $$;
