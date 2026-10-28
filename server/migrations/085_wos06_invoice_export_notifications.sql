-- Local-only development safeguard. This migration cannot be installed until
-- scoped configuration, protected event/outbox/inbox guards, failure isolation,
-- and the complete connected acceptance checks have been implemented.
do $$ begin raise exception 'Invoice export notification integration is incomplete'; end $$;

-- Definitions are opt-in; this migration grants no roles or users access.
insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.invoice_export.configure','Commercial','Configure invoice export notices','Configure prospective scoped invoice-export recipient and template policy.',false),
 ('integrations.invoice_alert_routes.manage','Integrations','Manage invoice alert routes','Configure prospective invoice operational-alert outbox routes.',false);

-- A route is an explicitly named internal outbox target. No address, network
-- endpoint, credential, external provider or live delivery is configured here.
create table invoice_alert_route_versions(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,route_key uuid not null,sequence int not null check(sequence>0),previous_id uuid references invoice_alert_route_versions(id),
 route_kind text not null check(route_kind='INTERNAL_OUTBOX'),label text not null check(length(btrim(label)) between 1 and 200),active boolean not null,
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,route_key,sequence),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table invoice_export_notice_policies(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,sequence int not null check(sequence>0),previous_id uuid references invoice_export_notice_policies(id),effective_from date not null,
 route_id uuid not null references invoice_alert_route_versions(id),finance_owner_id uuid not null references users(id),finance_owner_role text not null,integration_admin_id uuid not null references users(id),integration_admin_role text not null,
 definition jsonb not null,actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,engagement_id,sequence),unique(organization_id,legal_entity_id,actor_id,request_id)
);
create table invoice_export_notice_events(
 id uuid primary key,batch_id uuid not null references invoice_draft_batches(id),policy_id uuid not null references invoice_export_notice_policies(id),artifact_id uuid references invoice_csv_artifacts(id),failure_id uuid references invoice_csv_failures(id),
 event_key text not null check(event_key in('invoice_batch.export_failed','invoice_batch.exported_or_billed_confirmed')),policy_class text not null check(policy_class in('OPERATIONAL_CRITICAL','INFORMATIONAL')),
 operation_id text not null,locale text not null,title text not null,body text not null,created_at timestamptz not null default clock_timestamp(),
 check((event_key='invoice_batch.export_failed' and policy_class='OPERATIONAL_CRITICAL' and failure_id is not null and artifact_id is null) or (event_key='invoice_batch.exported_or_billed_confirmed' and policy_class='INFORMATIONAL' and artifact_id is not null and failure_id is null)),unique(artifact_id),unique(failure_id)
);
create table invoice_export_notice_recipients(
 id uuid primary key,event_id uuid not null references invoice_export_notice_events(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons)>0 and reasons<@array['invoice_batch_owner','finance_billing_owner','integration_administrator']::text[]),
 in_app boolean not null,channel_decision text not null check(channel_decision in('Required','Enabled','SuppressedPreference','SuppressedPolicy')),unique(event_id,user_id)
);
create table invoice_export_notice_deliveries(id uuid primary key,recipient_id uuid not null unique references invoice_export_notice_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt int not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table invoice_export_notice_reads(recipient_id uuid primary key references invoice_export_notice_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
create table invoice_export_alert_outbox(id uuid primary key,event_id uuid not null unique references invoice_export_notice_events(id),route_id uuid not null references invoice_alert_route_versions(id),status text not null check(status='Pending'),created_at timestamptz not null default clock_timestamp());
create table invoice_export_notice_failures(id uuid primary key,event_id uuid not null unique references invoice_export_notice_events(id),code text not null check(code='NOTIFICATION_PERSISTENCE_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp());
do $$declare t text;begin foreach t in array array['invoice_alert_route_versions','invoice_export_notice_policies','invoice_export_notice_events','invoice_export_notice_recipients','invoice_export_notice_deliveries','invoice_export_notice_reads','invoice_export_alert_outbox','invoice_export_notice_failures'] loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;
-- TODO: protected prospective policy/route admission and version validation;
-- exact source-scoped event and relationship guards; deferred complete-set or
-- failure evidence; durable required outbox; current-recipient inbox/read;
-- and integration with the export transaction must precede sentinel removal.

-- Validate exact shape, named roles, canonical event/template keys, and the
-- only allowed rendered variable. Application validation also canonicalizes
-- locale and these SQL checks remain independent at the persistence boundary.
create function valid_invoice_export_notice_policy(d jsonb) returns boolean language plpgsql immutable as $$
declare n jsonb;t jsonb;begin
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','engagementId','financeOwner','integrationAdmin','alertRouteId','locale','templates','completionInApp']) or (select count(*) from jsonb_object_keys(d))<>8 or d->>'entityType'<>'InvoiceExport' or jsonb_typeof(d->'engagementId')<>'string' or d->>'engagementId'<>btrim(d->>'engagementId') or length(d->>'engagementId') not between 1 and 200 or jsonb_typeof(d->'completionInApp')<>'boolean' or jsonb_typeof(d->'locale')<>'string' or d->>'locale' !~ '^[A-Za-z0-9-]{2,35}$' or (d->>'alertRouteId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
 for n in select * from jsonb_array_elements(jsonb_build_array(d->'financeOwner',d->'integrationAdmin')) loop
  if jsonb_typeof(n)<>'object' or not(n?&array['userId','role']) or (select count(*) from jsonb_object_keys(n))<>2 or n->>'userId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or jsonb_typeof(n->'role')<>'string' or n->>'role'<>btrim(n->>'role') or length(n->>'role') not between 1 and 100 then return false;end if;
 end loop;
 if jsonb_typeof(d->'templates')<>'array' or jsonb_array_length(d->'templates')<>2 or (select count(distinct x->>'key') from jsonb_array_elements(d->'templates')x)<>2 then return false;end if;
 for t in select * from jsonb_array_elements(d->'templates') loop
  if jsonb_typeof(t)<>'object' or not(t?&array['key','subject','body']) or(select count(*)from jsonb_object_keys(t))<>3 or t->>'key' not in('invoice_batch.export_failed','invoice_batch.exported_or_billed_confirmed') or jsonb_typeof(t->'subject')<>'string' or jsonb_typeof(t->'body')<>'string' or t->>'subject'<>btrim(t->>'subject') or t->>'body'<>btrim(t->>'body') or work_period_notice_units(t->>'subject') not between 1 and 200 or work_period_notice_units(t->>'body') not between 1 and 8000 or regexp_replace(t->>'subject','\{\{sourceRef\}\}','','g')~'[{}]' or regexp_replace(t->>'body','\{\{sourceRef\}\}','','g')~'[{}]' then return false;end if;
 end loop;return true;
exception when others then return false;end $$;
alter table invoice_export_notice_policies add constraint invoice_export_notice_definition_valid check(valid_invoice_export_notice_policy(definition));
alter table invoice_export_notice_policies add foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id);

create function invoice_notice_actor_has(org text,legal text,who uuid,role_name text,permission text) returns boolean language sql stable as $$
 select exists(select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_organization_scopes sc on sc.user_id=u.id where u.id=who and u.status='Active' and r.name=role_name and sc.organization_id=org and sc.legal_entity_id=legal and sc.active) and (exists(select 1 from role_permissions rp where rp.role_name=invoice_notice_actor_has.role_name and rp.permission_key=permission and rp.enabled) or exists(select 1 from user_permission_grants g where g.user_id=who and g.permission_key=permission))
$$;
create function invoice_notice_named_recipient(org text,legal text,who uuid,role_name text) returns boolean language sql stable as $$
 select invoice_notice_actor_has(org,legal,who,role_name,'notifications.view') and invoice_notice_actor_has(org,legal,who,role_name,'employees.view')
$$;
create function invoice_alert_route_current(route uuid,org text,legal text) returns boolean language sql stable as $$
 select exists(select 1 from invoice_alert_route_versions x where x.id=route and x.organization_id=org and x.legal_entity_id=legal and x.active and not exists(select 1 from invoice_alert_route_versions later where later.organization_id=x.organization_id and later.legal_entity_id=x.legal_entity_id and later.route_key=x.route_key and later.sequence>x.sequence))
$$;

create function guard_invoice_notice_configuration() returns trigger language plpgsql as $$
declare ctx jsonb;last_route invoice_alert_route_versions;last_policy invoice_export_notice_policies;begin
 begin ctx=nullif(current_setting('workos.invoice_notice_context',true),'')::jsonb;exception when others then ctx=null;end;
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if ctx is null or new.id::text is distinct from ctx->>'recordId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' then raise exception 'Use the exact authenticated scoped configuration command.' using errcode='INC01';end if;
 if tg_table_name='invoice_alert_route_versions' then
  if not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'integrations.invoice_alert_routes.manage') then raise exception 'Current scoped alert-route management authority required.' using errcode='INC01';end if;
  perform pg_advisory_xact_lock(hashtext('invoice-alert-route:'||new.organization_id||':'||new.legal_entity_id||':'||new.route_key::text));select * into last_route from invoice_alert_route_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and route_key=new.route_key order by sequence desc limit 1;
  if new.sequence<>coalesce(last_route.sequence,0)+1 or new.previous_id is distinct from last_route.id then raise exception 'Alert-route version changed.' using errcode='INC02';end if;
 else
  if not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'view') or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.invoice_export.configure') or not invoice_notice_named_recipient(new.organization_id,new.legal_entity_id,new.finance_owner_id,new.finance_owner_role) or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.finance_owner_id,new.finance_owner_role,'view') or not invoice_notice_named_recipient(new.organization_id,new.legal_entity_id,new.integration_admin_id,new.integration_admin_role) or not invoice_alert_route_current(new.route_id,new.organization_id,new.legal_entity_id) then raise exception 'Current scoped configuration, recipients and route are required.' using errcode='INC01';end if;
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.finance_owner_id,new.finance_owner_role);perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.integration_admin_id,new.integration_admin_role);perform pg_advisory_xact_lock(hashtext('invoice-notice-policy:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));select * into last_policy from invoice_export_notice_policies where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
  if new.sequence<>coalesce(last_policy.sequence,0)+1 or new.previous_id is distinct from last_policy.id or new.effective_from<(clock_timestamp() at time zone 'UTC')::date or new.definition->>'engagementId'<>new.engagement_id or new.definition->>'alertRouteId'<>new.route_id::text or new.definition->'financeOwner'<>jsonb_build_object('userId',new.finance_owner_id::text,'role',new.finance_owner_role) or new.definition->'integrationAdmin'<>jsonb_build_object('userId',new.integration_admin_id::text,'role',new.integration_admin_role) then raise exception 'Prospective policy version or named configuration changed.' using errcode='INC02';end if;
 end if;return new;
end $$;
create trigger guard_invoice_alert_route before insert on invoice_alert_route_versions for each row execute function guard_invoice_notice_configuration();
create trigger guard_invoice_export_notice_policy before insert on invoice_export_notice_policies for each row execute function guard_invoice_notice_configuration();
