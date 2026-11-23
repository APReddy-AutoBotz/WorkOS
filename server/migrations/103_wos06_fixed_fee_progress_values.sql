insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_progress.record','Commercial','Retain fixed-fee effort values','Retain cumulative management value from approved delivery effort.',false);

create function fixed_fee_progress_basis(org text,entity text,eng text,work_through date)
returns jsonb language sql stable as $$
 select jsonb_build_object('engagementId',eng,'through',work_through,'profile','approved_delivery_effort_v1','policyVersion',a.id,
   'contractVersionId',a.contract_version_id,'approvalReference',a.approval_reference,'policyOwner',a.actor_id,
   'effectiveFrom',a.effective_on,'startsOn',a.starts_on,'endsOn',a.ends_on,'currency',e.currency,
   'allocation',trim_scale(a.budget)::text,'budgetHours',trim_scale((a.after_value->'terms'->>'budgetHours')::numeric)::text,
   'precision',(a.after_value->'terms'->>'effortPolicy')::integer,'lifecycleId',l.id,'parentLifecycleId',p.id)
 from commercial_engagements e
 join lateral (select * from commercial_amendments where organization_id=org and legal_entity_id=entity and entity_type='Engagement'
   and entity_id=eng and effective_on<=work_through order by sequence desc limit 1) a on true
 join lateral (select id,state from commercial_lifecycle_events where organization_id=org and legal_entity_id=entity and entity_type='Engagement'
   and entity_id=eng and effective_on<=work_through order by sequence desc limit 1) l on l.state='Active'
 join lateral (select id,state from commercial_lifecycle_events where organization_id=org and legal_entity_id=entity and entity_type='Contract'
   and entity_id=e.contract_id and effective_on<=work_through order by sequence desc limit 1) p on p.state='Active'
 where e.organization_id=org and e.legal_entity_id=entity and e.id=eng and e.model='fixed_fee'
   and work_through<=(now() at time zone 'UTC')::date and work_through between a.starts_on and a.ends_on
   and a.after_value->'terms'->>'effortPolicy' in ('0','1','2','3','4')
   and coalesce(a.after_value->'terms'->>'elapsedTimePolicy','disabled')='disabled'
   and (a.after_value->'terms'->>'budgetHours')::numeric>0 and nullif(trim(a.approval_reference),'') is not null
$$;

create function fixed_fee_progress_amount(allocation numeric, hours numeric, budget numeric, digits integer)
returns numeric language sql immutable strict as $$
 select case when budget>0 and hours>=0 and allocation>=0 and digits between 0 and 4 and round(allocation,digits)=allocation
   then trim_scale(div(2*allocation*power(10::numeric,digits)*least(hours,budget)+budget,2*budget)*power(0.1::numeric,digits)) end
$$;

create table commercial_fixed_fee_progress_values (
 id uuid primary key, organization_id text not null,legal_entity_id text not null,engagement_id text not null,through_date date not null,
 version integer not null check(version>0),report jsonb not null,source_token text not null check(source_token ~ '^[0-9a-f]{64}$'),
 sources jsonb not null check(jsonb_typeof(sources)='array'),actor_id uuid not null references users(id),active_role text not null,
 operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,legal_entity_id,engagement_id,through_date,version),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id)
);
create trigger immutable_fixed_fee_progress before update or delete on commercial_fixed_fee_progress_values for each row execute function reject_commercial_draft_rewrite();
create function complete_fixed_fee_progress() returns trigger language plpgsql as $$
declare expected_sources jsonb; basis jsonb; billable numeric; nonbillable numeric; amount numeric;
begin
 basis:=fixed_fee_progress_basis(new.organization_id,new.legal_entity_id,new.engagement_id,new.through_date);
 select coalesce(jsonb_agg(jsonb_build_object('entryId',t.id,'submissionId',sub.id,'decisionId',d.id,'workerId',sheet.employee_id,
   'workDate',t.work_date,'hours',t.hours::text,'billable',t.billable) order by t.id),'[]'::jsonb) into expected_sources
 from commercial_project_bindings b join timesheet_entries t on t.project_id=b.project_id
 join timesheets sheet on sheet.id=t.timesheet_id and sheet.organization_id=b.organization_id and sheet.legal_entity_id=b.legal_entity_id and sheet.status='Approved'
 left join lateral(select id from work_submission_evidence where organization_id=b.organization_id and legal_entity_id=b.legal_entity_id
   and timesheet_id=sheet.id order by sequence desc limit 1) sub on true
 left join lateral(select id,status from work_submission_decisions where submission_id=sub.id order by created_at desc,id desc limit 1) d on true
 where b.organization_id=new.organization_id and b.legal_entity_id=new.legal_entity_id and b.engagement_id=new.engagement_id and b.model='fixed_fee'
   and t.work_date between (basis->>'startsOn')::date and new.through_date;
 select coalesce(sum((s->>'hours')::numeric) filter(where (s->>'billable')::boolean),0),
        coalesce(sum((s->>'hours')::numeric) filter(where not (s->>'billable')::boolean),0) into billable,nonbillable from jsonb_array_elements(new.sources) s;
 amount:=fixed_fee_progress_amount((basis->>'allocation')::numeric,billable+nonbillable,(basis->>'budgetHours')::numeric,(basis->>'precision')::int);
 if amount is null or new.sources is distinct from expected_sources
   or exists(select from jsonb_array_elements(new.sources) s where s->>'decisionId' is null or s->>'submissionId' is null
      or not exists(select from work_submission_decisions d where d.id=s->>'decisionId' and d.status='Approved'))
   or new.version<>(select coalesce(max(v.version),0)+1 from commercial_fixed_fee_progress_values v where v.organization_id=new.organization_id
      and v.legal_entity_id=new.legal_entity_id and v.engagement_id=new.engagement_id and v.through_date=new.through_date and v.id<>new.id)
   or new.report is distinct from (basis||jsonb_build_object('billableHours',trim_scale(billable)::text,
   'nonBillableHours',trim_scale(nonbillable)::text,'verifiedHours',trim_scale(billable+nonbillable)::text,'entries',jsonb_array_length(new.sources),
   'unresolved',0,'amount',amount::text)) or new.active_role in ('Employee','TeamLead','CountryDirector','ProjectManager') or
   exists(select from unnest(array['commercial.contracts.view','employees.view','reports.view_utilization','commercial.cost_candidates.view',
   'commercial.fixed_fee_cost.view','commercial.fixed_fee_progress.record']) p where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,p) is not true)
   or not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and entity_id=new.id::text
   and module='Commercial Drafting' and entity_type='Fixed Fee Progress Value' and action='Recorded' and source='Web'
   and new_value=jsonb_build_object('engagementId',new.engagement_id,'through',new.through_date,'version',new.version,'sourceToken',new.source_token)) then
   raise exception 'Progress source, permission or audit mismatch' using errcode='MEC01';end if;
 return null;
end $$;
create constraint trigger complete_fixed_fee_progress after insert on commercial_fixed_fee_progress_values deferrable initially deferred
 for each row execute function complete_fixed_fee_progress();
