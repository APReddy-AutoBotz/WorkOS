insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_units.capture','Commercial','Record managed-service units','Record delivered quantities against effective engagement terms.',false);

create table commercial_service_unit_evidence (
 id uuid primary key default gen_random_uuid(),
 organization_id text not null, legal_entity_id text not null, engagement_id text not null,
 contract_id text not null, version_id text not null, service_date date not null,
 dimension_code text not null, quantity numeric not null check(quantity>0 and quantity<1000000000000 and scale(quantity)<=4),
 source_reference text not null check(length(source_reference) between 1 and 120 and source_reference=btrim(source_reference)),
 actor_id uuid not null references users(id), active_role text not null, operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),
 foreign key(organization_id,legal_entity_id,contract_id,version_id) references commercial_contract_versions(organization_id,legal_entity_id,contract_id,id),
 unique(organization_id,legal_entity_id,engagement_id,dimension_code,source_reference)
);

create function guard_service_unit_evidence() returns trigger language plpgsql as $$
declare eng commercial_engagements; ver commercial_contract_versions; life commercial_lifecycle_events;
 amendment commercial_amendments; kind text; target text; precision_limit int;
begin
 if not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_units.capture')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
 or nullif(current_setting('workos.service_unit_evidence',true),'')::jsonb is distinct from
 jsonb_build_object('actor',new.actor_id,'operation',new.operation_id,'id',new.id)
 then raise exception 'Scoped capture authority required' using errcode='MSU01'; end if;
 select * into eng from commercial_engagements where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
 and id=new.engagement_id and contract_id=new.contract_id and model='managed_service';
 select * into ver from commercial_contract_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
 and contract_id=new.contract_id and id=new.version_id and model='managed_service';
 if eng.id is null or ver.id is null or new.service_date not between greatest(ver.effective_from,ver.starts_on) and ver.ends_on
 or new.service_date>(now() at time zone 'UTC')::date then
 raise exception 'Service date or managed-service terms are invalid' using errcode='MSU02'; end if;
 foreach kind in array array['Contract','Engagement'] loop
   target:=case kind when 'Contract' then new.contract_id else new.engagement_id end;
   select * into life from commercial_lifecycle_events where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
    and entity_type=kind and entity_id=target and effective_on<=new.service_date order by sequence desc limit 1;
   select * into amendment from commercial_amendments where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
    and entity_type=kind and entity_id=target and effective_on<=new.service_date order by sequence desc limit 1;
   if life.state is distinct from 'Active' or coalesce(amendment.contract_version_id,life.contract_version_id) is distinct from new.version_id
    or (kind='Engagement' and new.service_date not between coalesce(amendment.starts_on,eng.starts_on) and coalesce(amendment.ends_on,eng.ends_on))
    or (amendment.id is not null and new.service_date not between amendment.starts_on and amendment.ends_on) then
    raise exception 'Active adopted terms required on service date' using errcode='MSU02'; end if;
 end loop;
 select (unit->>'precision')::int into precision_limit from jsonb_array_elements(ver.service_dimensions) unit where unit->>'code'=new.dimension_code;
 if precision_limit is null or scale(new.quantity)>precision_limit then
 raise exception 'Quantity must match a configured unit and precision' using errcode='MSU02'; end if;
 return new;
end $$;
create trigger validate_service_unit_evidence before insert on commercial_service_unit_evidence for each row execute function guard_service_unit_evidence();
create trigger immutable_service_unit_evidence before update or delete on commercial_service_unit_evidence for each row execute function reject_commercial_draft_rewrite();
create index service_unit_evidence_history on commercial_service_unit_evidence(organization_id,legal_entity_id,engagement_id,created_at desc,id desc);

create function require_service_unit_evidence_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and module='Commercial Drafting'
   and action='Recorded' and entity_type='Managed Service Evidence' and entity_id=new.id::text and source='Web'
   and new_value=jsonb_build_object('engagementId',new.engagement_id,'versionId',new.version_id,'dimensionCode',new.dimension_code,
     'quantity',new.quantity::text,'serviceDate',to_char(new.service_date,'YYYY-MM-DD'),'sourceReference',new.source_reference))
 then raise exception 'Scoped service capture audit required' using errcode='MSU03'; end if;
 return null;
end $$;
create constraint trigger service_unit_evidence_audit after insert on commercial_service_unit_evidence
 deferrable initially deferred for each row execute function require_service_unit_evidence_audit();
