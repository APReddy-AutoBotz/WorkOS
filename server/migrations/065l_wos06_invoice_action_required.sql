-- No seeded templates, role grants, account grants, external routes or data.
create table invoice_action_templates(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 sequence integer not null check(sequence>0),previous_id uuid references invoice_action_templates(id),effective_from date not null,
 definition jsonb not null,actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,
 request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,engagement_id,sequence),unique(organization_id,legal_entity_id,actor_id,request_id),foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create table invoice_action_events(
 id uuid primary key,organization_id text not null,legal_entity_id text not null,batch_id uuid not null references invoice_draft_batches(id),template_id uuid not null references invoice_action_templates(id),
 event_key text not null check(event_key='invoice_batch.action_required'),policy_class text not null check(policy_class='ACTION_REQUIRED'),trigger_kind text not null check(trigger_kind='EMPTY_DRAFT_ASSESSMENT'),
 lineage_hash text not null check(lineage_hash~'^[a-f0-9]{64}$'),line_count integer not null check(line_count=0),locale text not null,title text not null,body text not null,
 actor_id uuid not null references users(id),active_role text not null,request_id uuid not null,request_fingerprint text not null check(request_fingerprint~'^[a-f0-9]{64}$'),reason text not null check(length(btrim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,actor_id,request_id),unique(batch_id,template_id,lineage_hash,trigger_kind)
);
create table invoice_action_recipients(id uuid primary key,event_id uuid not null references invoice_action_events(id),user_id uuid not null references users(id),reasons text[] not null check(cardinality(reasons)>0 and reasons<@array['invoice_batch_owner','finance_preparer']::text[]),in_app boolean not null check(in_app),channel_decision text not null check(channel_decision='Required'),unique(event_id,user_id));
create table invoice_action_deliveries(id uuid primary key,recipient_id uuid not null unique references invoice_action_recipients(id),channel text not null check(channel='InApp'),status text not null check(status='Delivered'),attempt integer not null check(attempt=1),accepted_at timestamptz not null default clock_timestamp());
create table invoice_action_reads(recipient_id uuid primary key references invoice_action_recipients(id),user_id uuid not null references users(id),read_at timestamptz not null default clock_timestamp());
do $$declare t text;begin foreach t in array array['invoice_action_templates','invoice_action_events','invoice_action_recipients','invoice_action_deliveries','invoice_action_reads']loop execute format('create trigger immutable_%I before update or delete on %I for each row execute function reject_commercial_draft_rewrite()',t,t);end loop;end $$;

-- Guarded source, complete-recipient commit and recipient-owned reads follow.

create function valid_invoice_action_template(d jsonb) returns boolean language plpgsql immutable as $$
begin
 if jsonb_typeof(d) is distinct from 'object' or not(d?&array['entityType','engagementId','locale','key','subject','body']) or (select count(*) from jsonb_object_keys(d))<>6 or exists(select 1 from unnest(array['entityType','engagementId','locale','key','subject','body']) k where jsonb_typeof(d->k) is distinct from 'string') or d->>'entityType'<>'InvoiceBatch' or d->>'key'<>'invoice_batch.action_required' or d->>'engagementId'<>btrim(d->>'engagementId') or length(d->>'engagementId') not between 1 and 200 or d->>'locale' !~ '^[A-Za-z0-9-]{2,35}$' or d->>'subject'<>btrim(d->>'subject') or d->>'body'<>btrim(d->>'body') or work_period_notice_units(d->>'subject') not between 1 and 200 or work_period_notice_units(d->>'body') not between 1 and 8000 or regexp_replace(d->>'subject','\{\{sourceRef\}\}','','g')~'[{}]' or regexp_replace(d->>'body','\{\{sourceRef\}\}','','g')~'[{}]' then return false;end if;
 return true;
exception when others then return false;end $$;
alter table invoice_action_templates add constraint invoice_action_template_shape check(valid_invoice_action_template(definition));

-- Empty drafts are intentionally excluded by invoice_batch_source_current;
-- owner validity and the exact empty lineage are checked independently here.
create function invoice_action_engagement_supported(org text, legal text, eng text)
returns boolean language sql stable as $$
 select exists(select 1 from commercial_engagements e where e.organization_id=org
   and e.legal_entity_id=legal and e.id=eng and e.origin='manual' and e.billable
   and e.model='time_and_materials')
$$;
create function invoice_empty_action_current(b invoice_draft_batches) returns boolean language sql stable as $$
 select coalesce(invoice_action_engagement_supported(b.organization_id,b.legal_entity_id,b.engagement_id) and invoice_batch_governed_state(b.id)='Draft' and invoice_draft_owner_current(b) and not exists(select 1 from invoice_draft_lines l where l.batch_id=b.id) and not exists(select 1 from invoice_draft_occupancies o where o.batch_id=b.id),false)
$$;
create function invoice_action_expected_recipients(b invoice_draft_batches) returns table(recipient uuid,held_role text,recipient_reason text) language sql stable as $$
 select b.owner_user_id,b.owner_role,'invoice_batch_owner'::text union all select b.preparer_user_id,b.preparer_role,'finance_preparer'::text
$$;
create function guard_invoice_action_write() returns trigger language plpgsql as $$
declare ctx jsonb;b invoice_draft_batches;p invoice_action_templates;ev invoice_action_events;rec invoice_action_recipients;rel record;expected text[];latest uuid;begin
 begin ctx=nullif(current_setting('workos.invoice_action_context',true),'')::jsonb;exception when others then ctx=null;end;
 if ctx is null then raise exception 'Exact scoped invoice action command required.' using errcode='IAN01';end if;
 if tg_table_name='invoice_action_templates' then
  new.created_at=clock_timestamp();
  perform pg_advisory_xact_lock(hashtext('invoice-action-template:'||new.organization_id||':'||new.legal_entity_id||':'||new.engagement_id));
  perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
  select id into latest from invoice_action_templates where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and engagement_id=new.engagement_id order by sequence desc limit 1;
  if not invoice_action_engagement_supported(new.organization_id,new.legal_entity_id,new.engagement_id) or new.id::text is distinct from ctx->>'templateId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.previous_id is distinct from latest or new.sequence<>coalesce((select sequence from invoice_action_templates where id=latest),0)+1 or new.definition->>'engagementId'<>new.engagement_id or new.effective_from<(new.created_at at time zone 'UTC')::date or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') then raise exception 'Current scoped manager and exact prospective template are required.' using errcode='IAN01';end if;return new;
 elsif tg_table_name='invoice_action_events' then
  new.created_at=clock_timestamp();
  select * into b from invoice_draft_batches where id=new.batch_id for update;select * into p from invoice_action_templates where id=new.template_id;
  if b.id is null or p.id is null then raise exception 'Exact batch and template required.' using errcode='IAN02';end if;
  perform pg_advisory_xact_lock(hashtext('invoice-action-template:'||b.organization_id||':'||b.legal_entity_id||':'||b.engagement_id));
  perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role);perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,b.owner_user_id,b.owner_role);perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,b.preparer_user_id,b.preparer_role);
  select id into latest from invoice_action_templates where organization_id=b.organization_id and legal_entity_id=b.legal_entity_id and engagement_id=b.engagement_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by effective_from desc,sequence desc limit 1;
  if new.id::text is distinct from ctx->>'eventId' or new.batch_id::text is distinct from ctx->>'batchId' or new.template_id::text is distinct from ctx->>'templateId' or new.organization_id is distinct from ctx->>'organizationId' or new.legal_entity_id is distinct from ctx->>'legalEntityId' or new.actor_id::text is distinct from ctx->>'actorId' or new.active_role is distinct from ctx->>'activeRole' or new.operation_id is distinct from ctx->>'operationId' or new.organization_id<>b.organization_id or new.legal_entity_id<>b.legal_entity_id or p.id is distinct from latest or p.engagement_id<>b.engagement_id or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'prepare') or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,b.preparer_user_id,b.preparer_role,'view') or not invoice_empty_action_current(b) or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or new.locale<>p.definition->>'locale' or new.title<>replace(p.definition->>'subject','{{sourceRef}}','invoice-batch/'||b.id::text) or new.body<>replace(p.definition->>'body','{{sourceRef}}','invoice-batch/'||b.id::text) or exists(select 1 from invoice_batch_approval_transitions t join invoice_batch_approval_instances i on i.id=t.instance_id where i.batch_id=b.id and t.operation_id=new.operation_id) then raise exception 'Current empty scoped draft, actor and pinned template required.' using errcode='IAN02';end if;return new;
 end if;
 if tg_table_name='invoice_action_deliveries' then select * into rec from invoice_action_recipients where id=new.recipient_id;select * into ev from invoice_action_events where id=rec.event_id;else select * into ev from invoice_action_events where id=new.event_id;end if;
 select * into b from invoice_draft_batches where id=ev.batch_id;
 if ev.id is null or b.id is null or ev.id::text is distinct from ctx->>'eventId' or ev.batch_id::text is distinct from ctx->>'batchId' or ev.operation_id is distinct from ctx->>'operationId' then raise exception 'Exact retained action event required.' using errcode='IAN02';end if;
 if tg_table_name='invoice_action_deliveries' then if rec.id is null or not rec.in_app then raise exception 'Required in-app recipient required.' using errcode='IAN02';end if;return new;end if;
 select array_agg(x.recipient_reason order by x.recipient_reason) into expected from invoice_action_expected_recipients(b)x where x.recipient=new.user_id;
 for rel in select * from invoice_action_expected_recipients(b)x where x.recipient=new.user_id loop
  perform lock_commercial_candidate_identity(b.organization_id,b.legal_entity_id,rel.recipient,rel.held_role);
  if not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,rel.recipient,rel.held_role,'view') then raise exception 'Every required recipient must retain scoped access.' using errcode='IAN01';end if;
 end loop;
 if expected is null or (select array_agg(x order by x) from unnest(new.reasons)x) is distinct from expected or not new.in_app or new.channel_decision<>'Required' then raise exception 'Exact mandatory recipient relationships required.' using errcode='IAN02';end if;return new;
end $$;
create trigger guard_invoice_action_template before insert on invoice_action_templates for each row execute function guard_invoice_action_write();
create trigger guard_invoice_action_event before insert on invoice_action_events for each row execute function guard_invoice_action_write();
create trigger guard_invoice_action_recipient before insert on invoice_action_recipients for each row execute function guard_invoice_action_write();
create trigger guard_invoice_action_delivery before insert on invoice_action_deliveries for each row execute function guard_invoice_action_write();

create function complete_invoice_action_write() returns trigger language plpgsql as $$
declare b invoice_draft_batches;p invoice_action_templates;expected uuid[];u uuid;reasons text[];rec invoice_action_recipients;rel record;begin
 if tg_table_name='invoice_action_templates' then
  if not invoice_action_engagement_supported(new.organization_id,new.legal_entity_id,new.engagement_id) or not invoice_batch_approval_actor_valid(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'manager') or not exists(select 1 from audit_logs a where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Action Notice' and a.action='Configure Template' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('templateId',new.id,'engagementId',new.engagement_id)) then raise exception 'Template authority and sanitized audit must commit together.' using errcode='IAN03';end if;return null;
 end if;
 select * into b from invoice_draft_batches where id=new.batch_id;select * into p from invoice_action_templates where id=new.template_id;
 if b.id is null or p.id is null or p.id is distinct from (select id from invoice_action_templates where organization_id=b.organization_id and legal_entity_id=b.legal_entity_id and engagement_id=b.engagement_id and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by effective_from desc,sequence desc limit 1) or not invoice_empty_action_current(b) or new.lineage_hash<>invoice_batch_lineage_hash(b.id) or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.actor_id,new.active_role,'prepare') then raise exception 'Current empty source and scoped actor must remain valid through commit.' using errcode='IAN03';end if;
 if not exists(select 1 from audit_logs a where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id and a.user_id=new.actor_id::text and a.active_role=new.active_role and a.module='Invoice Action Notice' and a.action='Assess Empty Draft' and a.entity_id=new.id::text and a.operation_id=new.operation_id and a.new_value=jsonb_build_object('eventId',new.id,'batchId',b.id,'templateId',p.id,'lineageHash',new.lineage_hash)) then raise exception 'Event and sanitized audit must commit together.' using errcode='IAN03';end if;
 select array_agg(distinct x.recipient order by x.recipient) into expected from invoice_action_expected_recipients(b)x;
 if cardinality(expected) not between 1 and 2 or (select count(*) from invoice_action_recipients where event_id=new.id)<>cardinality(expected) then raise exception 'Complete mandatory recipient set required.' using errcode='IAN03';end if;
 foreach u in array expected loop
  select * into rec from invoice_action_recipients where event_id=new.id and user_id=u;select array_agg(x.recipient_reason order by x.recipient_reason) into reasons from invoice_action_expected_recipients(b)x where x.recipient=u;
  if rec.id is null or rec.reasons is distinct from reasons or not rec.in_app or rec.channel_decision<>'Required' or not exists(select 1 from invoice_action_deliveries x where x.recipient_id=rec.id and x.channel='InApp' and x.status='Delivered' and x.attempt=1) then raise exception 'Complete exact mandatory in-app delivery required.' using errcode='IAN03';end if;
  for rel in select * from invoice_action_expected_recipients(b)x where x.recipient=u loop if not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,rel.recipient,rel.held_role,'view') then raise exception 'Every recipient must retain current scoped access through commit.' using errcode='IAN03';end if;end loop;
 end loop;return null;
end $$;
create constraint trigger complete_invoice_action_template after insert on invoice_action_templates deferrable initially deferred for each row execute function complete_invoice_action_write();
create constraint trigger complete_invoice_action_event after insert on invoice_action_events deferrable initially deferred for each row execute function complete_invoice_action_write();

create function guard_invoice_action_read() returns trigger language plpgsql as $$
declare ctx jsonb;rec invoice_action_recipients;ev invoice_action_events;b invoice_draft_batches;begin
 begin ctx=nullif(current_setting('workos.invoice_action_read_context',true),'')::jsonb;exception when others then ctx=null;end;
 select * into rec from invoice_action_recipients where id=new.recipient_id;select * into ev from invoice_action_events where id=rec.event_id;select * into b from invoice_draft_batches where id=ev.batch_id;
 if ctx is null or rec.id is null or ev.id is null or b.id is null or not invoice_action_engagement_supported(b.organization_id,b.legal_entity_id,b.engagement_id) or new.user_id is distinct from rec.user_id or new.user_id::text is distinct from ctx->>'actorId' or b.organization_id is distinct from ctx->>'organizationId' or b.legal_entity_id is distinct from ctx->>'legalEntityId' or not invoice_draft_actor_valid(b.organization_id,b.legal_entity_id,new.user_id,ctx->>'activeRole','view') or exists(select 1 from invoice_draft_lines l where l.batch_id=b.id and tm_billing_worker_visible(b.organization_id,b.legal_entity_id,l.snapshot_id,new.user_id,ctx->>'activeRole') is not true) then raise exception 'Only the currently scoped recipient may acknowledge this event.' using errcode='IAN01';end if;return new;
end $$;
create trigger guard_invoice_action_read before insert on invoice_action_reads for each row execute function guard_invoice_action_read();
