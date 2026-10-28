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
