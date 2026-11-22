insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_cost.view','Commercial','View managed-service effort cost','Inspect scoped worker costs for accepted service effort.',false),
 ('commercial.service_cost.record','Commercial','Record managed-service effort cost','Retain the adopted hourly worker cost for accepted service effort.',false);

create table commercial_service_effort_costs (
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 evidence_id uuid not null unique references commercial_service_unit_evidence(id), review_id uuid not null references commercial_service_unit_reviews(id),
 adoption_id uuid not null references commercial_rate_adoptions(id),candidate_id uuid not null references commercial_rate_candidates(id),
 worker_id text not null references employees(id),service_date date not null,effective_from date not null,effective_to date not null,
 resolution_rule text not null default 'worker-hourly-priority/1' check(resolution_rule='worker-hourly-priority/1'),
 priority integer not null check(priority between 0 and 1000),currency text not null,hours numeric not null,hourly_rate numeric not null,amount numeric not null,
 actor_id uuid not null references users(id),active_role text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);

create function service_effort_cost_source(e commercial_service_unit_evidence)
returns table(review_id uuid,adoption_id uuid,candidate_id uuid,effective_from date,effective_to date,currency text,priority integer,resolution_rule text,hourly_rate numeric,amount numeric)
language sql stable as $$
 with matching as (
   select r.id reviewed,a.id adoption,c.*,rank() over(order by c.priority desc) as precedence
   from commercial_service_unit_reviews r join users u on u.id=r.actor_id and u.status='Active'
   join employees w on w.id=u.employee_record_id and w.id=r.worker_id and w.status='Active'
   join commercial_engagements g on g.id=e.engagement_id and g.organization_id=e.organization_id and g.legal_entity_id=e.legal_entity_id
   join commercial_rate_candidates c on c.organization_id=g.organization_id and c.legal_entity_id=g.legal_entity_id
     and c.currency=g.currency and c.kind='cost' and c.unit='HOUR' and c.binding_type='worker' and c.binding_id=e.recorder_worker_id
     and e.service_date between c.effective_from and c.effective_to
   join commercial_rate_adoptions a on a.candidate_id=c.id and a.organization_id=c.organization_id and a.legal_entity_id=c.legal_entity_id
   where r.evidence_id=e.id and r.decision='Accepted' and e.effort_hours is not null and service_unit_effort_recorder_current(e)
     and w.organization_id=e.organization_id and w.legal_entity_id=e.legal_entity_id
     and r.reviewer_generation=coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0)
 ), leaders as (select * from matching where precedence=1)
 select reviewed,adoption,id,effective_from,effective_to,currency,priority,'worker-hourly-priority/1'::text,amount,e.effort_hours*amount
 from leaders where (select count(*) from leaders)=1
$$;

create function guard_service_effort_cost() returns trigger language plpgsql as $$
declare e commercial_service_unit_evidence; r commercial_service_unit_reviews; c commercial_rate_candidates; resolved record;
 ctx jsonb=jsonb_build_object('actorId',new.actor_id,'activeRole',new.active_role,'organizationId',new.organization_id,'legalEntityId',new.legal_entity_id);
begin
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if nullif(current_setting('workos.service_effort_cost',true),'')::jsonb is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id)
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_cost.view')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.service_cost.record')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.cost_candidates.view')
 or not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,'commercial.contracts.view') then
   raise exception 'Current effort cost authority required' using errcode='MEC01';
 end if;
 select * into e from commercial_service_unit_evidence where id=new.evidence_id and engagement_id=new.engagement_id
   and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id for share;
 select * into r from commercial_service_unit_reviews where id=new.review_id and evidence_id=e.id for share;
 if e.id is null or r.id is null then raise exception 'Accepted service effort required' using errcode='MEC02';end if;
 perform u.id from users u where u.id in(e.actor_id,r.actor_id) order by u.id for share;
 perform w.id from employees w where w.id in(e.recorder_worker_id,r.worker_id) order by w.id for share;
 perform pg_advisory_xact_lock(hashtext('commercial-tm-rate:'||new.organization_id||':'||new.legal_entity_id||':cost:worker:'||e.recorder_worker_id));
 select * into resolved from service_effort_cost_source(e);
 if resolved.adoption_id is distinct from new.adoption_id or resolved.review_id is distinct from new.review_id then
   raise exception 'Unique current adopted worker cost required' using errcode='MEC02';end if;
 select * into strict c from commercial_rate_candidates where id=resolved.candidate_id;
 perform lock_commercial_candidate_worker_witness(c,new.actor_id,new.active_role);
 if rate_candidate_worker_visible(ctx,e.recorder_worker_id) is not true then raise exception 'Worker cost scope required' using errcode='MEC01';end if;
 perform assert_tm_financial_period(e.organization_id,e.legal_entity_id,e.service_date);
 new.candidate_id=c.id;new.worker_id=e.recorder_worker_id;new.service_date=e.service_date;
 new.hours=e.effort_hours;new.effective_from=c.effective_from;new.effective_to=c.effective_to;new.currency=c.currency;
 new.priority=c.priority;new.created_at=clock_timestamp();new.hourly_rate=c.amount;new.amount=resolved.amount;return new;
end $$;
create trigger guard_service_effort_cost before insert on commercial_service_effort_costs for each row execute function guard_service_effort_cost();
create trigger immutable_service_effort_cost before update or delete on commercial_service_effort_costs for each row execute function reject_commercial_draft_rewrite();
create function complete_service_effort_cost() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and entity_id=new.id::text
   and module='Commercial Drafting' and entity_type='Managed Service Effort Cost' and action='Recorded' and source='Web'
   and new_value=jsonb_build_object('costId',new.id,'evidenceId',new.evidence_id,'adoptionId',new.adoption_id)) then
   raise exception 'Protected cost evidence and audit must commit together' using errcode='MEC03';end if;return null;
end $$;
create constraint trigger service_effort_cost_audit after insert on commercial_service_effort_costs deferrable initially deferred
 for each row execute function complete_service_effort_cost();
