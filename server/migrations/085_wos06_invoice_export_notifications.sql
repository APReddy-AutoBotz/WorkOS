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
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','engagementId','financeOwner','integrationAdmin','alertRouteId','locale','templates','completionInApp']) or (select count(*) from jsonb_object_keys(d))<>8 or d->>'entityType'<>'InvoiceExport' or jsonb_typeof(d->'engagementId') is distinct from 'string' or d->>'engagementId'<>btrim(d->>'engagementId') or length(d->>'engagementId') not between 1 and 200 or jsonb_typeof(d->'completionInApp') is distinct from 'boolean' or jsonb_typeof(d->'locale') is distinct from 'string' or d->>'locale' !~ '^[A-Za-z0-9-]{2,35}$' or jsonb_typeof(d->'alertRouteId') is distinct from 'string' or (d->>'alertRouteId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
 for n in select * from jsonb_array_elements(jsonb_build_array(d->'financeOwner',d->'integrationAdmin')) loop
  if jsonb_typeof(n)<>'object' or not(n?&array['userId','role']) or (select count(*) from jsonb_object_keys(n))<>2 or jsonb_typeof(n->'userId') is distinct from 'string' or n->>'userId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or jsonb_typeof(n->'role') is distinct from 'string' or n->>'role'<>btrim(n->>'role') or length(n->>'role') not between 1 and 100 then return false;end if;
 end loop;
 if jsonb_typeof(d->'templates') is distinct from 'array' or jsonb_array_length(d->'templates')<>2 or (select count(distinct x->>'key') from jsonb_array_elements(d->'templates')x)<>2 then return false;end if;
 for t in select * from jsonb_array_elements(d->'templates') loop
  if jsonb_typeof(t)<>'object' or not(t?&array['key','subject','body']) or(select count(*)from jsonb_object_keys(t))<>3 or jsonb_typeof(t->'key') is distinct from 'string' or t->>'key' not in('invoice_batch.export_failed','invoice_batch.exported_or_billed_confirmed') or jsonb_typeof(t->'subject') is distinct from 'string' or jsonb_typeof(t->'body') is distinct from 'string' or t->>'subject'<>btrim(t->>'subject') or t->>'body'<>btrim(t->>'body') or work_period_notice_units(t->>'subject') not between 1 and 200 or work_period_notice_units(t->>'body') not between 1 and 8000 or regexp_replace(t->>'subject','\{\{sourceRef\}\}','','g')~'[{}]' or regexp_replace(t->>'body','\{\{sourceRef\}\}','','g')~'[{}]' then return false;end if;
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

-- Configuration and sanitized audit evidence must commit together. This also
-- rechecks held authority and named relationships at the transaction boundary.
create function complete_invoice_notice_configuration() returns trigger language plpgsql as $$
declare action_name text;expected jsonb;begin
 if tg_table_name='invoice_alert_route_versions' then
  if not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'integrations.invoice_alert_routes.manage') then raise exception 'Alert-route authority changed.' using errcode='INC03';end if;
  action_name='Configure Alert Route';expected=jsonb_build_object('routeId',new.id,'routeKey',new.route_key);
 else
  if not invoice_csv_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'view') or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.invoice_export.configure') or not invoice_notice_named_recipient(new.organization_id,new.legal_entity_id,new.finance_owner_id,new.finance_owner_role) or not invoice_draft_actor_valid(new.organization_id,new.legal_entity_id,new.finance_owner_id,new.finance_owner_role,'view') or not invoice_notice_named_recipient(new.organization_id,new.legal_entity_id,new.integration_admin_id,new.integration_admin_role) or not invoice_alert_route_current(new.route_id,new.organization_id,new.legal_entity_id) then raise exception 'Policy authority, route or recipients changed.' using errcode='INC03';end if;
  action_name='Configure Invoice Notification';expected=jsonb_build_object('policyId',new.id,'engagementId',new.engagement_id,'routeId',new.route_id);
 end if;
 if not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Export Notifications' and a.action=action_name and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=expected) then raise exception 'Configuration and sanitized audit must commit together.' using errcode='INC03';end if;return null;
end $$;
create constraint trigger complete_invoice_alert_route after insert on invoice_alert_route_versions deferrable initially deferred for each row execute function complete_invoice_notice_configuration();
create constraint trigger complete_invoice_export_notice_policy after insert on invoice_export_notice_policies deferrable initially deferred for each row execute function complete_invoice_notice_configuration();

create function invoice_export_expected_recipients(ev invoice_export_notice_events) returns table(recipient uuid,held_role text,recipient_reason text) language plpgsql stable as $$
declare b invoice_draft_batches;p invoice_export_notice_policies;begin
 select * into b from invoice_draft_batches where id=ev.batch_id;select * into p from invoice_export_notice_policies where id=ev.policy_id;
 if b.id is null or p.id is null or b.organization_id<>p.organization_id or b.legal_entity_id<>p.legal_entity_id or b.engagement_id<>p.engagement_id then raise exception 'Retained invoice notification relationships are unavailable.' using errcode='INC02';end if;
 recipient=b.owner_user_id;held_role=b.owner_role;recipient_reason='invoice_batch_owner';return next;
 recipient=p.finance_owner_id;held_role=p.finance_owner_role;recipient_reason='finance_billing_owner';return next;
 if ev.event_key='invoice_batch.export_failed' then recipient=p.integration_admin_id;held_role=p.integration_admin_role;recipient_reason='integration_administrator';return next;end if;
end $$;
create function guard_invoice_export_notice() returns trigger language plpgsql as $$
declare ctx jsonb;ev invoice_export_notice_events;b invoice_draft_batches;p invoice_export_notice_policies;t jsonb;src record;rel record;expected text[];pref boolean;decision text;rec invoice_export_notice_recipients;latest uuid;begin
 begin ctx=nullif(current_setting('workos.invoice_notice_event_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null then raise exception 'An exact protected notification operation is required.' using errcode='INC01';end if;
 if tg_table_name='invoice_export_notice_events' then
  select * into b from invoice_draft_batches where id=new.batch_id;select * into p from invoice_export_notice_policies where id=new.policy_id;
  if new.artifact_id is not null then select id,batch_id,actor_id,active_role,operation_id into src from invoice_csv_artifacts where id=new.artifact_id;else select id,batch_id,actor_id,active_role,operation_id into src from invoice_csv_failures where id=new.failure_id;end if;
  select id into latest from invoice_export_notice_policies where organization_id=b.organization_id and legal_entity_id=b.legal_entity_id and engagement_id=b.engagement_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by effective_from desc,sequence desc limit 1;
  select x into t from jsonb_array_elements(p.definition->'templates')x where x->>'key'=new.event_key;
  if b.id is null or p.id is null or src.id is null or t is null or new.id::text is distinct from ctx->>'eventId' or b.id::text is distinct from ctx->>'batchId' or p.id::text is distinct from ctx->>'policyId' or src.id::text is distinct from ctx->>'resultId' or src.actor_id::text is distinct from ctx->>'actorId' or src.active_role is distinct from ctx->>'activeRole' or src.operation_id is distinct from ctx->>'operationId' or new.operation_id<>src.operation_id or src.batch_id<>b.id or b.organization_id is distinct from ctx->>'organizationId' or b.legal_entity_id is distinct from ctx->>'legalEntityId' or p.organization_id<>b.organization_id or p.legal_entity_id<>b.legal_entity_id or p.engagement_id<>b.engagement_id or p.id is distinct from latest or new.locale is distinct from p.definition->>'locale' or new.title is distinct from replace(t->>'subject','{{sourceRef}}','invoice-batch/'||b.id::text) or new.body is distinct from replace(t->>'body','{{sourceRef}}','invoice-batch/'||b.id::text) then raise exception 'Exact operation, current policy and sanitized event required.' using errcode='INC02';end if;return new;
 end if;
 if tg_table_name='invoice_export_notice_deliveries' then select * into rec from invoice_export_notice_recipients where id=new.recipient_id;select * into ev from invoice_export_notice_events where id=rec.event_id;else select * into ev from invoice_export_notice_events where id=new.event_id;end if;select * into b from invoice_draft_batches where id=ev.batch_id;select * into p from invoice_export_notice_policies where id=ev.policy_id;
 if ev.id is null or ev.id::text is distinct from ctx->>'eventId' or b.id::text is distinct from ctx->>'batchId' or p.id::text is distinct from ctx->>'policyId' or ev.operation_id is distinct from ctx->>'operationId' then raise exception 'Exact retained event is required.' using errcode='INC02';end if;
 if tg_table_name='invoice_export_alert_outbox' then
  if ev.event_key<>'invoice_batch.export_failed' or new.route_id<>p.route_id or new.status<>'Pending' then raise exception 'Exact configured operational route is required.' using errcode='INC02';end if;return new;
 elsif tg_table_name='invoice_export_notice_failures' then return new;
 elsif tg_table_name='invoice_export_notice_deliveries' then
  select * into rec from invoice_export_notice_recipients where id=new.recipient_id;
  if rec.id is null or not rec.in_app then raise exception 'Delivery must match its in-app recipient.' using errcode='INC02';end if;return new;
 end if;
 select array_agg(distinct x.recipient_reason order by x.recipient_reason) into expected from invoice_export_expected_recipients(ev)x where x.recipient=new.user_id;
 for rel in select * from invoice_export_expected_recipients(ev)x where x.recipient=new.user_id loop
  perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,rel.recipient,rel.held_role);
  if not invoice_notice_named_recipient(b.organization_id,b.legal_entity_id,rel.recipient,rel.held_role) or (rel.recipient_reason='finance_billing_owner' and (not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,rel.recipient,rel.held_role,'view') or exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and not tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,rel.recipient,rel.held_role)))) then raise exception 'Current scoped notification recipient required.' using errcode='INC01';end if;
 end loop;
 select n.in_app into pref from notification_preferences n join users u on u.employee_record_id=n.employee_id where u.id=new.user_id and n.event_type=ev.event_key for share of n;
 decision=case when ev.event_key='invoice_batch.export_failed' then 'Required' when not(p.definition->>'completionInApp')::boolean then 'SuppressedPolicy' when pref is false then 'SuppressedPreference' else 'Enabled' end;
 if expected is null or (select array_agg(x order by x) from unnest(new.reasons)x) is distinct from expected or new.channel_decision<>decision or new.in_app is distinct from(decision in('Required','Enabled')) then raise exception 'Exact recipient reasons and channel policy required.' using errcode='INC02';end if;return new;
end $$;
create trigger guard_invoice_export_notice_event before insert on invoice_export_notice_events for each row execute function guard_invoice_export_notice();
create trigger guard_invoice_export_notice_recipient before insert on invoice_export_notice_recipients for each row execute function guard_invoice_export_notice();
create trigger guard_invoice_export_notice_delivery before insert on invoice_export_notice_deliveries for each row execute function guard_invoice_export_notice();
create trigger guard_invoice_export_notice_failure before insert on invoice_export_notice_failures for each row execute function guard_invoice_export_notice();
create trigger guard_invoice_export_alert_outbox before insert on invoice_export_alert_outbox for each row execute function guard_invoice_export_notice();

create function complete_invoice_export_notice() returns trigger language plpgsql as $$
declare b invoice_draft_batches;p invoice_export_notice_policies;has_failure boolean;expected_users uuid[];u uuid;expected_reasons text[];rec invoice_export_notice_recipients;actual_count int;begin
 select * into b from invoice_draft_batches where id=new.batch_id;select * into p from invoice_export_notice_policies where id=new.policy_id;
 if b.id is null or p.id is null then raise exception 'Retained event scope is required.' using errcode='INC03';end if;
 has_failure=exists(select 1 from invoice_export_notice_failures where event_id=new.id);
 if new.event_key='invoice_batch.export_failed' and not exists(select 1 from invoice_export_alert_outbox x where x.event_id=new.id and x.route_id=p.route_id and x.status='Pending') then raise exception 'A durable configured operational outbox entry is required.' using errcode='INC03';end if;
 select array_agg(distinct x.recipient order by x.recipient) into expected_users from invoice_export_expected_recipients(new)x;
 select count(*)::int into actual_count from invoice_export_notice_recipients where event_id=new.id;
 if expected_users is null or(not has_failure and actual_count<>cardinality(expected_users)) or(has_failure and actual_count not in(0,cardinality(expected_users))) then raise exception 'Recipient evidence must be complete or visibly unavailable.' using errcode='INC03';end if;
 if actual_count>0 then foreach u in array expected_users loop
  select array_agg(distinct x.recipient_reason order by x.recipient_reason) into expected_reasons from invoice_export_expected_recipients(new)x where x.recipient=u;
  select * into rec from invoice_export_notice_recipients where event_id=new.id and user_id=u;
  if rec.id is null or(select array_agg(x order by x) from unnest(rec.reasons)x) is distinct from expected_reasons or(new.event_key='invoice_batch.export_failed' and(not rec.in_app or rec.channel_decision<>'Required')) or(rec.in_app and not exists(select 1 from invoice_export_notice_deliveries d where d.recipient_id=rec.id and d.channel='InApp' and d.status='Delivered')) then raise exception 'Exact recipient and delivery evidence must commit.' using errcode='INC03';end if;
 end loop;end if;
 return null;
end $$;
create constraint trigger complete_invoice_export_notice after insert on invoice_export_notice_events deferrable initially deferred for each row execute function complete_invoice_export_notice();

create function require_invoice_export_notice() returns trigger language plpgsql as $$
begin
 if tg_table_name='invoice_csv_artifacts' then
  if not exists(select 1 from invoice_export_notice_events where artifact_id=new.id and batch_id=new.batch_id and event_key='invoice_batch.exported_or_billed_confirmed' and operation_id=new.operation_id) then raise exception 'An accepted export requires its retained canonical event.' using errcode='INC03';end if;
 else
  if not exists(select 1 from invoice_export_notice_events where failure_id=new.id and batch_id=new.batch_id and event_key='invoice_batch.export_failed' and operation_id=new.operation_id) then raise exception 'A recorded failure requires its retained canonical event.' using errcode='INC03';end if;
 end if;return null;
end $$;
create constraint trigger require_invoice_csv_artifact_notice after insert on invoice_csv_artifacts deferrable initially deferred for each row execute function require_invoice_export_notice();
create constraint trigger require_invoice_csv_failure_notice after insert on invoice_csv_failures deferrable initially deferred for each row execute function require_invoice_export_notice();

create function guard_invoice_export_notice_read() returns trigger language plpgsql as $$
declare ctx jsonb;begin
 begin ctx=nullif(current_setting('workos.invoice_notice_read_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null or new.user_id::text is distinct from ctx->>'actorId' or not exists(select 1 from invoice_export_notice_recipients r join invoice_export_notice_events ev on ev.id=r.event_id join invoice_draft_batches b on b.id=ev.batch_id where r.id=new.recipient_id and r.user_id=new.user_id and r.in_app and b.organization_id=ctx->>'organizationId' and b.legal_entity_id=ctx->>'legalEntityId' and invoice_notice_actor_has(b.organization_id,b.legal_entity_id,new.user_id,ctx->>'activeRole','notifications.view')) then raise exception 'Only the current scoped named recipient may acknowledge this notice.' using errcode='INC01';end if;return new;
end $$;
create trigger guard_invoice_export_notice_read before insert on invoice_export_notice_reads for each row execute function guard_invoice_export_notice_read();

-- If the canonical event itself cannot be persisted, the valid export/failure
-- can still commit with explicit recovery evidence and no partial event rows.
create table invoice_export_notice_producer_failures(
 id uuid primary key,batch_id uuid not null references invoice_draft_batches(id),policy_id uuid not null references invoice_export_notice_policies(id),artifact_id uuid references invoice_csv_artifacts(id),failure_id uuid references invoice_csv_failures(id),operation_id text not null,code text not null check(code='NOTIFICATION_EVENT_UNAVAILABLE'),created_at timestamptz not null default clock_timestamp(),check((artifact_id is null)<>(failure_id is null)),unique(artifact_id),unique(failure_id)
);
create trigger immutable_invoice_export_notice_producer_failures before update or delete on invoice_export_notice_producer_failures for each row execute function reject_commercial_draft_rewrite();
create function guard_invoice_export_notice_producer_failure() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;p invoice_export_notice_policies;src record;begin
 begin ctx=nullif(current_setting('workos.invoice_notice_event_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into b from invoice_draft_batches where id=new.batch_id;select * into p from invoice_export_notice_policies where id=new.policy_id;
 if new.artifact_id is not null then select id,batch_id,actor_id,active_role,operation_id into src from invoice_csv_artifacts where id=new.artifact_id;else select id,batch_id,actor_id,active_role,operation_id into src from invoice_csv_failures where id=new.failure_id;end if;
 if ctx is null or b.id is null or p.id is null or src.id is null or b.id::text is distinct from ctx->>'batchId' or p.id::text is distinct from ctx->>'policyId' or src.id::text is distinct from ctx->>'resultId' or src.actor_id::text is distinct from ctx->>'actorId' or src.active_role is distinct from ctx->>'activeRole' or src.operation_id is distinct from ctx->>'operationId' or new.operation_id<>src.operation_id or src.batch_id<>b.id or b.organization_id is distinct from ctx->>'organizationId' or b.legal_entity_id is distinct from ctx->>'legalEntityId' or p.organization_id<>b.organization_id or p.legal_entity_id<>b.legal_entity_id or p.engagement_id<>b.engagement_id or exists(select 1 from invoice_export_notice_events ev where (new.artifact_id is not null and ev.artifact_id=new.artifact_id) or (new.failure_id is not null and ev.failure_id=new.failure_id)) then raise exception 'Exact operation and visible isolated notification failure required.' using errcode='INC02';end if;return new;
end $$;
create trigger guard_invoice_export_notice_producer_failure before insert on invoice_export_notice_producer_failures for each row execute function guard_invoice_export_notice_producer_failure();
create or replace function require_invoice_export_notice() returns trigger language plpgsql as $$
begin
 if tg_table_name='invoice_csv_artifacts' then
  if not exists(select 1 from invoice_export_notice_events where artifact_id=new.id and batch_id=new.batch_id and event_key='invoice_batch.exported_or_billed_confirmed' and operation_id=new.operation_id) and not exists(select 1 from invoice_export_notice_producer_failures where artifact_id=new.id and batch_id=new.batch_id and operation_id=new.operation_id) then raise exception 'Accepted export requires a canonical event or visible recovery evidence.' using errcode='INC03';end if;
 else
  if not exists(select 1 from invoice_export_notice_events where failure_id=new.id and batch_id=new.batch_id and event_key='invoice_batch.export_failed' and operation_id=new.operation_id) and not exists(select 1 from invoice_export_notice_producer_failures where failure_id=new.id and batch_id=new.batch_id and operation_id=new.operation_id) then raise exception 'Recorded failure requires a canonical event or visible recovery evidence.' using errcode='INC03';end if;
 end if;return null;
end $$;
