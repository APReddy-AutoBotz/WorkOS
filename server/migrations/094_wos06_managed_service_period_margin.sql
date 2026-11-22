insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.service_margin.view','Commercial','View managed-service margins','Read financial period versions for managed-service engagements.',false),
 ('commercial.service_margin.record','Commercial','Retain managed-service margins','Retain a new managed-service period version from current evidence.',false);

create table commercial_service_margin_versions (
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 month_start date not null check(extract(day from month_start)=1),version integer not null check(version>0),
 report jsonb not null,actor_id uuid not null references users(id),active_role text not null,operation_id text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,engagement_id,month_start,version),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create trigger immutable_service_margin before update or delete on commercial_service_margin_versions
 for each row execute function reject_commercial_draft_rewrite();

-- Attribute charges and their corrections to the month of delivery (period charges use their end date).
create function service_margin_report(org text,legal text,eng text,month_start date) returns jsonb language sql stable as $$
 with scope as (
   select id,currency from commercial_engagements where organization_id=org and legal_entity_id=legal and id=eng and model='managed_service'
 ), receipts as (
   select e.id,e.version_id,e.recorder_worker_id,e.source_reference,e.service_date,e.effort_hours,r.id review,r.decision,
     c.id cost_id,c.amount cost from commercial_service_unit_evidence e
   left join commercial_service_unit_reviews r on r.evidence_id=e.id
   left join commercial_service_effort_costs c on c.evidence_id=e.id and c.review_id=r.id
   where e.organization_id=org and e.legal_entity_id=legal and e.engagement_id=eng
     and e.service_date>=month_start and e.service_date<month_start+interval '1 month'
 ), charges as (
   select b.id,b.amount from billing_eligibility_events b
   left join receipts r on r.review=b.service_review_id
   left join commercial_service_period_reviews p on p.id=b.service_period_review_id
   where b.organization_id=org and b.legal_entity_id=legal and b.engagement_id=eng
     and (r.id is not null or (p.ends_on>=month_start and p.ends_on<month_start+interval '1 month'))
 ), events as (
   select * from charges union all
   select b.id,b.amount from billing_eligibility_events b join charges on charges.id=b.reverses_event_id
     where b.organization_id=org and b.legal_entity_id=legal and b.engagement_id=eng and b.source_type='FULL_LINE_REVERSAL'
 ), work as (
   select t.id,t.hours,t.work_date,t.work_reference,s.employee_id,sub.id submission,d.id approval,
     case when d.status='Approved' and item.matches=1 then item.version_id end version_id
   from commercial_project_bindings b join timesheet_entries t on t.project_id=b.project_id
   join timesheets s on s.id=t.timesheet_id and s.organization_id=b.organization_id and s.legal_entity_id=b.legal_entity_id and s.status='Approved'
   join commercial_engagements g on g.organization_id=b.organization_id and g.legal_entity_id=b.legal_entity_id and g.id=b.engagement_id
   left join lateral(select id,entries from work_submission_evidence where organization_id=org and legal_entity_id=legal and timesheet_id=s.id order by sequence desc limit 1) sub on true
   left join lateral(select id,status from work_submission_decisions where submission_id=sub.id order by created_at desc,id desc limit 1) d on true
   left join lateral(select count(*) matches,min(i->'references'->0->>'contractVersionId') version_id from jsonb_array_elements(sub.entries) i
     where i->>'entryId'=t.id::text and i->>'kind'='governed' and i->>'bindingId'=b.id and i->>'projectId'=t.project_id
       and i->>'workDate'=t.work_date::text and i->>'workReference'=t.work_reference and (i->>'hours')::numeric=t.hours
       and (i->>'billable')::boolean=t.billable and i->>'workType'=t.work_type
       and nullif(i->>'clientName','') is not distinct from nullif(t.client_name,'')
       and nullif(i->>'category','') is not distinct from nullif(t.category,'')
       and nullif(i->>'remark','') is not distinct from nullif(t.remark,'')
       and nullif(i->>'evidenceUrl','') is not distinct from nullif(t.evidence_url,'')
       and nullif(i->'sourceIdentity','null'::jsonb) is not distinct from t.source_identity
       and i->>'categoryCode'=t.category_code and i->'categoryReference'=t.category_reference
       and (select count(*) from jsonb_array_elements(sub.entries) candidate where candidate->>'entryId'=t.id::text)=1
       and commercial_tm_terms_match(b,g,i->'references',t.work_date)) item on true
   where b.organization_id=org and b.legal_entity_id=legal and b.engagement_id=eng and b.model='managed_service'
     and t.work_date>=month_start and t.work_date<month_start+interval '1 month'
 ), work_by_reference as (
   select employee_id,work_date,work_reference,version_id,count(*) n,sum(hours) hours from work
   where version_id is not null group by employee_id,work_date,work_reference,version_id
 ), reconciled as (
   select r.*,coalesce(w.n,0) n,w.hours,
     count(*) filter(where r.effort_hours is not null and r.decision is distinct from 'Rejected')
       over(partition by r.recorder_worker_id,r.source_reference,r.version_id,r.service_date) claim_count
   from receipts r left join work_by_reference w on w.employee_id=r.recorder_worker_id and w.work_date=r.service_date
     and w.work_reference=r.source_reference and w.version_id=r.version_id
 ), coverage as (
   select count(*) filter(where decision='Accepted') accepted,
     count(*) filter(where decision is null) pending,
     count(*) filter(where decision='Accepted' and cost_id is null) missing_cost,
     coalesce(sum(n) filter(where decision='Accepted' and claim_count=1 and hours=effort_hours),0) verified_entries,
     count(*) filter(where decision='Accepted' and effort_hours is not null and
       (claim_count<>1 or hours is distinct from effort_hours)) unresolved_receipts,
     coalesce(sum(cost) filter(where decision='Accepted'),0) retained_cost from reconciled
 ), amounts as (
   select coverage.*,coalesce((select sum(amount) from events),0) billable,(select count(*) from work) entries from coverage
 ), totals as (
   select *,case when accepted>0 and missing_cost=0 and pending=0 and verified_entries=entries and unresolved_receipts=0
     then billable-retained_cost end margin from amounts
 )
 select jsonb_build_object('calculationVersion','managed-service-month/1','currency',scope.currency,
   'billable',trim_scale(billable)::text,'retainedCost',trim_scale(retained_cost)::text,'margin',trim_scale(margin)::text,
   'marginPercent',case when billable>0 then ((sign(margin)*(div(abs(margin)*10000,billable)+case when mod(abs(margin)*10000,billable)*2>=billable then 1 else 0 end))::numeric(40,0)*0.01)::text end,
   'accepted',accepted,'pending',pending,'missingCosts',missing_cost,'unresolvedReceipts',unresolved_receipts,
   'approvedEntries',entries,'verifiedEntries',verified_entries,'approvedHours',trim_scale(coalesce((select sum(hours) from work),0))::text,
   'billingEvents',coalesce((select jsonb_agg(id order by id) from events),'[]'),
   'receipts',coalesce((select jsonb_agg(jsonb_build_array(id,review,cost_id) order by id) from receipts),'[]'),
   'workers',coalesce((select jsonb_agg(worker order by worker) from (select recorder_worker_id worker from receipts union select employee_id from work) workers),'[]'),
   'work',coalesce((select jsonb_agg(jsonb_build_array(id,submission,approval) order by id) from work),'[]'))
 from totals cross join scope
$$;

create function require_service_margin_version() returns trigger language plpgsql as $$
declare previous commercial_service_margin_versions;
begin
 if exists(select from unnest(array['commercial.contracts.view','employees.view','reports.view_utilization','commercial.cost_candidates.view',
    'commercial.service_cost.view','commercial.service_margin.view','commercial.service_margin.record']) p
    where not invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,p))
    or new.active_role in ('Employee','TeamLead','ProjectManager','CountryDirector') then
   raise exception 'Current financial reporting authority required' using errcode='MGM01';end if;
 select * into previous from commercial_service_margin_versions where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and engagement_id=new.engagement_id and month_start=new.month_start and version<new.version order by version desc limit 1;
 if new.version<>coalesce(previous.version,0)+1 or previous.report=new.report or new.month_start>(now() at time zone 'UTC')::date
   or exists(select from jsonb_array_elements_text(new.report->'workers') worker where not rate_candidate_worker_visible(
      jsonb_build_object('organizationId',new.organization_id,'legalEntityId',new.legal_entity_id,'actorId',new.actor_id,'activeRole',new.active_role),worker))
   or (new.report->'receipts'='[]' and new.report->'work'='[]' and new.report->'billingEvents'='[]')
   or new.report is distinct from service_margin_report(new.organization_id,new.legal_entity_id,new.engagement_id,new.month_start)
   or not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
      and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and entity_id=new.id::text
      and module='Commercial Drafting' and action='Retain Margin' and entity_type='Service Period Margin' and source='Web'
      and new_value=jsonb_build_object('engagementId',new.engagement_id,'monthStart',new.month_start,'version',new.version)) then
   raise exception 'Period inputs or audit changed' using errcode='MGM02';end if;
 return null;
end $$;
create constraint trigger complete_service_margin after insert on commercial_service_margin_versions
 deferrable initially deferred for each row execute function require_service_margin_version();
