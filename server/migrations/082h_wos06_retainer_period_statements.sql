insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.retainer_statements.prepare','Commercial','Prepare retainer statements','Retain closed-period pricing and approved work evidence for review.',false);

create table commercial_retainer_statements (
 id uuid primary key default gen_random_uuid(),
 organization_id text not null, legal_entity_id text not null, contract_id text not null references commercial_contracts(id),
 version_id text not null references commercial_contract_versions(id), starts_on date not null, ends_on date not null,
 sequence integer not null check(sequence>0), previous_id uuid references commercial_retainer_statements(id),
 evidence jsonb not null, source_hash text not null, actor_id uuid not null references users(id), active_role text not null,
 reason text not null check(length(trim(reason)) between 3 and 1000), operation_id text not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id),
 unique(organization_id,legal_entity_id,version_id,starts_on,sequence)
);

create function guard_retainer_statement() returns trigger language plpgsql as $$
declare v commercial_contract_versions; prior commercial_retainer_statements; ctx jsonb;
begin
 ctx:=nullif(current_setting('workos.retainer_statement',true),'')::jsonb;
 if ctx is null or ctx is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id,'hash',new.source_hash)
   or exists(select 1 from unnest(array['commercial.contracts.view','commercial.contracts.manage','employees.view','reports.view_utilization',
       'commercial.rate_candidates.view','commercial.retainer_statements.prepare']) k
     where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,k))
 then raise exception 'Scoped statement preparation authority required.' using errcode='RST01'; end if;
 select * into v from commercial_contract_versions where id=new.version_id and contract_id=new.contract_id
   and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and model='retainer';
 select * into prior from commercial_retainer_statements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and version_id=new.version_id and starts_on=new.starts_on order by sequence desc limit 1;
 if v.id is null or v.retainer_rounding is null or new.starts_on<v.effective_from or new.ends_on>=(now() at time zone 'UTC')::date
   or not exists(select 1 from jsonb_array_elements(v.retainer_periods) p where p->>'startsOn'=new.starts_on::text and p->>'endsOn'=new.ends_on::text)
   or new.sequence<>coalesce(prior.sequence,0)+1 or new.previous_id is distinct from prior.id
   or new.source_hash<>encode(sha256(convert_to(new.evidence::text,'UTF8')),'hex')
   or (new.evidence->'closed') is distinct from 'true'::jsonb
   or (new.evidence->>'format') is distinct from 'retainer-statement/1'
   or (new.evidence->>'versionId') is distinct from v.id or (new.evidence->>'contractId') is distinct from v.contract_id
   or (new.evidence->>'currency') is distinct from v.currency or (new.evidence->'rounding') is distinct from v.retainer_rounding
   or (new.evidence->'price'->>'startsOn') is distinct from new.starts_on::text
   or (new.evidence->'price'->>'endsOn') is distinct from new.ends_on::text
   or jsonb_typeof(new.evidence->'price'->'periodPrice') is distinct from 'object'
 then raise exception 'Statement source or predecessor changed.' using errcode='RST02'; end if;
 return new;
end $$;
create trigger validate_retainer_statement before insert on commercial_retainer_statements for each row execute function guard_retainer_statement();
create trigger immutable_retainer_statement before update or delete on commercial_retainer_statements for each row execute function reject_commercial_draft_rewrite();
create function require_retainer_statement_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and
  user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and module='Commercial Drafting'
  and action='Prepare' and entity_type='Retainer Statement' and entity_id=new.id::text and new_value->>'sourceHash'=new.source_hash)
 then raise exception 'Scoped statement audit required.' using errcode='RST03'; end if;
 return null;
end $$;
create constraint trigger retainer_statement_audit after insert on commercial_retainer_statements deferrable initially deferred
 for each row execute function require_retainer_statement_audit();
