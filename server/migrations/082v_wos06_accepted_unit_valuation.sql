insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_units.policy','Commercial','Configure service valuation','Select an effective operational valuation policy for managed-service engagements.',false),
 ('commercial.service_units.value','Commercial','Value accepted service units','Retain an operational management value for independently accepted service units.',false);

create table commercial_service_unit_policies (
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 effective_from date not null,profile text not null check(profile in ('accepted_unit','disabled')),
 precision_digits integer check(precision_digits between 0 and 4),reason text not null check(length(btrim(reason)) between 3 and 1000),
 actor_id uuid not null references users(id),active_role text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 check((profile='accepted_unit')=(precision_digits is not null)),unique(organization_id,legal_entity_id,engagement_id,effective_from),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create table commercial_service_unit_valuations (
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 evidence_id uuid not null unique references commercial_service_unit_evidence(id),review_id uuid not null references commercial_service_unit_reviews(id),
 policy_id uuid not null references commercial_service_unit_policies(id),version_id text not null references commercial_contract_versions(id),
 service_date date not null,quantity numeric not null,unit_price numeric not null,amount numeric not null,currency text not null,
 actor_id uuid not null references users(id),active_role text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);

create function guard_service_unit_policy() returns trigger language plpgsql as $$
begin
 if not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_units.policy')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
 or nullif(current_setting('workos.service_valuation',true),'')::jsonb is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id)
 then raise exception 'Policy authority required' using errcode='MSV01'; end if;
 if new.effective_from < (now() at time zone 'UTC')::date or not exists(select 1 from commercial_engagements where id=new.engagement_id
   and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and model='managed_service')
 or exists(select 1 from commercial_service_unit_policies where engagement_id=new.engagement_id and effective_from>=new.effective_from)
 then raise exception 'Policy must advance its engagement schedule' using errcode='MSV02'; end if;
 return new;
end $$;
create trigger validate_service_unit_policy before insert on commercial_service_unit_policies for each row execute function guard_service_unit_policy();
create trigger immutable_service_unit_policy before update or delete on commercial_service_unit_policies for each row execute function reject_commercial_draft_rewrite();

create function guard_service_unit_valuation() returns trigger language plpgsql as $$
declare e commercial_service_unit_evidence; r commercial_service_unit_reviews; p commercial_service_unit_policies; v commercial_contract_versions;
begin
 if not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_units.value')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view')
 or nullif(current_setting('workos.service_valuation',true),'')::jsonb is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id)
 then raise exception 'Valuation authority required' using errcode='MSV01'; end if;
 select * into e from commercial_service_unit_evidence where id=new.evidence_id and engagement_id=new.engagement_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
 select * into r from commercial_service_unit_reviews where id=new.review_id and evidence_id=e.id and decision='Accepted';
 select * into p from commercial_service_unit_policies where engagement_id=e.engagement_id and effective_from<=e.service_date order by effective_from desc limit 1;
 select * into v from commercial_contract_versions where id=e.version_id;
 select (d->>'unitPrice')::numeric into new.unit_price from jsonb_array_elements(v.service_dimensions) d where d->>'code'=e.dimension_code;
 if r.id is null or p.profile is distinct from 'accepted_unit' or p.id is distinct from new.policy_id or new.unit_price is null then
   raise exception 'Accepted priced evidence and effective policy required' using errcode='MSV02'; end if;
 perform id from users where id in(e.actor_id,r.actor_id) order by id for share;
 perform w.id from employees w join users u on u.employee_record_id=w.id where u.id in(e.actor_id,r.actor_id) order by w.id for share of w;
 if exists(select 1 from (values (e.actor_id,e.recorder_worker_id,e.recorder_link_generation),(r.actor_id,r.worker_id,r.reviewer_generation)) x(account,worker,generation)
    where not exists(select 1 from users u join employees w on w.id=u.employee_record_id where u.id=x.account and w.id=x.worker and w.status='Active' and u.status='Active'
      and w.organization_id=e.organization_id and w.legal_entity_id=e.legal_entity_id and x.generation=coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0)))
 then raise exception 'Evidence identity no longer current' using errcode='MSV02'; end if;
 perform assert_tm_financial_period(e.organization_id,e.legal_entity_id,e.service_date);
 new.version_id:=e.version_id;new.currency:=v.currency;new.service_date:=e.service_date;new.quantity:=e.quantity;
 new.amount:=round(e.quantity*new.unit_price,p.precision_digits);
 return new;
end $$;
create trigger validate_service_unit_valuation before insert on commercial_service_unit_valuations for each row execute function guard_service_unit_valuation();
create trigger immutable_service_unit_valuation before update or delete on commercial_service_unit_valuations for each row execute function reject_commercial_draft_rewrite();

create function require_service_valuation_audit() returns trigger language plpgsql as $$
declare kind text; material jsonb;
begin
 if tg_table_name='commercial_service_unit_policies' then
   kind:='Service Valuation Policy';
   material:=jsonb_build_object('engagementId',new.engagement_id,'effectiveFrom',to_char(new.effective_from,'YYYY-MM-DD'),'profile',new.profile,'precision',new.precision_digits,'reason',new.reason);
 else
   kind:='Service Unit Valuation';
   material:=jsonb_build_object('evidenceId',new.evidence_id,'reviewId',new.review_id,'policyId',new.policy_id,'versionId',new.version_id,'currency',new.currency,'quantity',new.quantity::text,'unitPrice',new.unit_price::text,'amount',new.amount::text);
 end if;
 if not exists(select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id::text
   and active_role=new.active_role and operation_id=new.operation_id and source='Web' and module='Commercial Drafting' and entity_id=new.id::text
   and entity_type=kind and action='Recorded' and new_value=material) then raise exception 'Scoped valuation audit required' using errcode='MSV03'; end if;
 return null;
end $$;
create constraint trigger service_unit_policy_audit after insert on commercial_service_unit_policies deferrable initially deferred for each row execute function require_service_valuation_audit();
create constraint trigger service_unit_value_audit after insert on commercial_service_unit_valuations deferrable initially deferred for each row execute function require_service_valuation_audit();
