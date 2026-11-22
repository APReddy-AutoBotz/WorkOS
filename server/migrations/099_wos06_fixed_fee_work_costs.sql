insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_cost.view','Commercial','View fixed-fee worker costs','Inspect scoped approved fixed-fee work and adopted hourly costs.',false),
 ('commercial.fixed_fee_cost.record','Commercial','Retain fixed-fee worker costs','Record an immutable cost for verified fixed-fee work.',false);

create table commercial_fixed_fee_work_costs (
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 entry_id uuid not null unique references timesheet_entries(id),submission_id text not null references work_submission_evidence(id),
 decision_id text not null references work_submission_decisions(id),contract_version_id text not null references commercial_contract_versions(id),
 adoption_id uuid not null references commercial_rate_adoptions(id),candidate_id uuid not null references commercial_rate_candidates(id),
 worker_id text not null references employees(id),work_date date not null,effective_from date not null,effective_to date not null,
 resolution_rule text not null default 'worker-hourly-priority/1' check(resolution_rule='worker-hourly-priority/1'),
 priority integer not null,currency text not null,hours numeric not null,hourly_rate numeric not null,amount numeric not null,
 actor_id uuid not null references users(id),active_role text not null,operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);

create function fixed_fee_work_cost_source(org text,legal text,eng text,entry uuid)
returns table(submission_id text,decision_id text,contract_version_id text,worker_id text,work_date date,hours numeric,
 adoption_id uuid,candidate_id uuid,effective_from date,effective_to date,currency text,priority int,hourly_rate numeric,amount numeric)
language sql stable as $$
 with work as (
select s.organization_id,s.legal_entity_id,b.engagement_id,g.currency,t.id,t.hours,t.work_date,t.work_reference,s.employee_id,sub.id submission,d.id approval,
     case when d.status='Approved' and item.matches=1 then item.version_id end version_id
   from commercial_project_bindings b join timesheet_entries t on t.project_id=b.project_id
   join timesheets s on s.id=t.timesheet_id and s.organization_id=b.organization_id and s.legal_entity_id=b.legal_entity_id and s.status='Approved'
   join commercial_engagements g on g.organization_id=b.organization_id and g.legal_entity_id=b.legal_entity_id and g.id=b.engagement_id
   left join lateral(select id,entries from work_submission_evidence where organization_id=org and legal_entity_id=legal and timesheet_id=s.id order by sequence desc limit 1) sub on true
   left join lateral(select id,status from work_submission_decisions where submission_id=sub.id order by created_at desc,id desc limit 1) d on true
   left join lateral(select count(*) matches,min(i->'references'->0->>'contractVersionId') version_id from jsonb_array_elements(sub.entries) i
     where i->>'entryId'=t.id::text and i->>'kind'='governed' and i->>'bindingId'=b.id and i->>'projectId'=t.project_id
       and i->>'workDate'=t.work_date::text and nullif(i->>'workReference','') is not distinct from nullif(t.work_reference,'') and (i->>'hours')::numeric=t.hours
       and (i->>'billable')::boolean=t.billable and i->>'workType'=t.work_type
       and nullif(i->>'clientName','') is not distinct from nullif(t.client_name,'')
       and nullif(i->>'category','') is not distinct from nullif(t.category,'')
       and nullif(i->>'remark','') is not distinct from nullif(t.remark,'')
       and nullif(i->>'evidenceUrl','') is not distinct from nullif(t.evidence_url,'')
       and nullif(i->'sourceIdentity','null'::jsonb) is not distinct from t.source_identity
       and i->>'categoryCode'=t.category_code and i->'categoryReference'=t.category_reference
       and (select count(*) from jsonb_array_elements(sub.entries) candidate where candidate->>'entryId'=t.id::text)=1
       and commercial_tm_terms_match(b,g,i->'references',t.work_date)) item on true
   where b.organization_id=org and b.legal_entity_id=legal and b.engagement_id=eng and b.model='fixed_fee'
     and t.id=entry
 ), matching as (
   select w.*,a.id adoption,c.id candidate,c.effective_from,c.effective_to,c.priority,c.amount rate,
     rank() over(order by c.priority desc) precedence
   from work w join commercial_rate_candidates c on c.organization_id=w.organization_id and c.legal_entity_id=w.legal_entity_id
     and c.kind='cost' and c.binding_type='worker' and c.binding_id=w.employee_id and c.unit='HOUR'
     and c.currency=w.currency and w.work_date between c.effective_from and c.effective_to
   join commercial_rate_adoptions a on a.candidate_id=c.id and a.organization_id=c.organization_id and a.legal_entity_id=c.legal_entity_id
   where w.version_id is not null
 ), leaders as (select * from matching where precedence=1)
 select submission,approval,version_id,employee_id,work_date,hours,adoption,candidate,effective_from,effective_to,currency,priority,rate,hours*rate
 from leaders where (select count(*) from leaders)=1
$$;

create function guard_fixed_fee_work_cost() returns trigger language plpgsql as $$
declare worker text; resolved record; candidate commercial_rate_candidates;
 ctx jsonb=jsonb_build_object('actorId',new.actor_id,'activeRole',new.active_role,'organizationId',new.organization_id,'legalEntityId',new.legal_entity_id);
begin
 perform lock_commercial_candidate_identity(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role);
 if nullif(current_setting('workos.fixed_fee_work_cost',true),'')::jsonb is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id)
 or exists(select from unnest(array['commercial.fixed_fee_cost.view','commercial.fixed_fee_cost.record','commercial.cost_candidates.view',
     'commercial.contracts.view','reports.view_utilization','employees.view']) permission where
     invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,permission) is not true) then
   raise exception 'Current fixed-fee cost authority required' using errcode='MEC01';end if;
 select s.employee_id into strict worker from timesheet_entries t join timesheets s on s.id=t.timesheet_id
 where t.id=new.entry_id and s.organization_id=new.organization_id and s.legal_entity_id=new.legal_entity_id for share of t,s;
 perform pg_advisory_xact_lock(hashtext('commercial-tm-rate:'||new.organization_id||':'||new.legal_entity_id||':cost:worker:'||worker));
 select * into resolved from fixed_fee_work_cost_source(new.organization_id,new.legal_entity_id,new.engagement_id,new.entry_id);
 if resolved.adoption_id is null or resolved.adoption_id is distinct from new.adoption_id or resolved.decision_id is distinct from new.decision_id then
   raise exception 'Approved work and unique adopted rate required' using errcode='MEC02';end if;
 select * into strict candidate from commercial_rate_candidates where id=resolved.candidate_id;
 perform lock_commercial_candidate_worker_witness(candidate,new.actor_id,new.active_role);
 if rate_candidate_worker_visible(ctx,worker) is not true then raise exception 'Worker scope required' using errcode='MEC01';end if;
 perform assert_tm_financial_period(new.organization_id,new.legal_entity_id,resolved.work_date);
 new.worker_id=worker;new.submission_id=resolved.submission_id;new.contract_version_id=resolved.contract_version_id;
 new.work_date=resolved.work_date;new.hours=resolved.hours;new.candidate_id=resolved.candidate_id;new.effective_from=resolved.effective_from;
 new.effective_to=resolved.effective_to;new.currency=resolved.currency;new.priority=resolved.priority;new.hourly_rate=resolved.hourly_rate;
 new.amount=resolved.amount;new.created_at=clock_timestamp();return new;
end $$;
create trigger guard_fixed_fee_work_cost before insert on commercial_fixed_fee_work_costs for each row execute function guard_fixed_fee_work_cost();
create trigger immutable_fixed_fee_work_cost before update or delete on commercial_fixed_fee_work_costs for each row execute function reject_commercial_draft_rewrite();
create function complete_fixed_fee_work_cost() returns trigger language plpgsql as $$
begin
 if not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and entity_id=new.id::text
   and module='Commercial Drafting' and entity_type='Fixed Fee Work Cost' and action='Recorded' and source='Web'
   and new_value=jsonb_build_object('costId',new.id,'entryId',new.entry_id,'adoptionId',new.adoption_id)) then
   raise exception 'Protected cost evidence and audit must commit together' using errcode='MEC03';end if;return null;
end $$;
create constraint trigger fixed_fee_work_cost_audit after insert on commercial_fixed_fee_work_costs deferrable initially deferred
 for each row execute function complete_fixed_fee_work_cost();
