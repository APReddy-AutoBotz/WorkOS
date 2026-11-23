insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.fixed_fee_transition.approve','Commercial','Approve fixed-fee valuation transitions','Approve the verified closing effort and remaining elapsed-time schedule.',false);

-- Only an uninterrupted, approved, direct switch can use the residual schedule.
create function fixed_fee_transition_terms(org text,entity text,eng text,as_of date)
returns table(policy text,closing_date date,first_day date,last_day date,allocation numeric,digits int,currency text)
language sql stable as $$
 select a.id,a.effective_on-1,a.effective_on,a.ends_on,a.budget,(a.after_value->'terms'->>'elapsedTimePolicy')::int,e.currency
 from commercial_engagements e join commercial_amendments a on a.organization_id=e.organization_id and a.legal_entity_id=e.legal_entity_id
   and a.entity_type='Engagement' and a.entity_id=e.id
 join commercial_amendments prior on prior.organization_id=a.organization_id and prior.legal_entity_id=a.legal_entity_id
   and prior.entity_type='Engagement' and prior.entity_id=e.id and prior.sequence=a.sequence-1
 where e.organization_id=org and e.legal_entity_id=entity and e.id=eng and e.model='fixed_fee'
   and as_of<=(now() at time zone 'UTC')::date and as_of between a.effective_on-1 and a.ends_on
   and (as_of>=a.effective_on or as_of=(now() at time zone 'UTC')::date)
   and prior.after_value->'terms'->>'effortPolicy' in ('0','1','2','3','4')
   and a.after_value->'terms'->>'elapsedTimePolicy' in ('0','1','2','3','4')
   and not exists(select from commercial_amendments n where n.organization_id=org and n.legal_entity_id=entity
     and n.entity_type='Engagement' and n.entity_id=eng and n.sequence>a.sequence and n.effective_on<=as_of)
   and not exists(select from commercial_lifecycle_events l where l.organization_id=org and l.legal_entity_id=entity
     and ((l.entity_type='Engagement' and l.entity_id=eng) or (l.entity_type='Contract' and l.entity_id=e.contract_id))
     and l.effective_on between a.effective_on and greatest(as_of,a.effective_on) and l.state<>'Active')
$$;

-- Standalone daily valuation uses the whole allocation. Once effort was adopted,
-- only the separately reconciled transition may value the residual.
alter function fixed_fee_elapsed_report(text,text,text,date) rename to fixed_fee_full_elapsed_report;
create function fixed_fee_elapsed_report(org text,entity text,eng text,service_day date)
returns jsonb language sql stable as $$
 select case when not exists(select from commercial_amendments where organization_id=org and legal_entity_id=entity
   and entity_type='Engagement' and entity_id=eng and effective_on<=service_day
   and after_value->'terms'->>'effortPolicy' in ('0','1','2','3','4'))
 then fixed_fee_full_elapsed_report(org,entity,eng,service_day) end
$$;

create table commercial_fixed_fee_transition_approvals (
 id uuid primary key,organization_id text not null,legal_entity_id text not null,engagement_id text not null,
 policy_id text not null references commercial_amendments(id),snapshot_id uuid not null references commercial_fixed_fee_progress_values(id),
 reason text not null check(length(trim(reason)) between 3 and 1000),actor_id uuid not null references users(id),active_role text not null,
 operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id,engagement_id) references commercial_engagements(organization_id,legal_entity_id,id),
 unique(policy_id,snapshot_id)
);
create trigger immutable_fixed_fee_transition before update or delete on commercial_fixed_fee_transition_approvals
 for each row execute function reject_commercial_draft_rewrite();
create function complete_fixed_fee_transition() returns trigger language plpgsql as $$
begin
 if new.active_role in ('Employee','TeamLead','CountryDirector','ProjectManager') or
 exists(select from unnest(array['commercial.contracts.view','commercial.fixed_fee_cost.view','commercial.cost_candidates.view',
   'employees.view','reports.view_utilization','commercial.fixed_fee_transition.approve']) p
   where invoice_notice_actor_has(new.organization_id,new.legal_entity_id,new.actor_id,new.active_role,p) is not true)
 or not exists(select from fixed_fee_transition_terms(new.organization_id,new.legal_entity_id,new.engagement_id,(now() at time zone 'UTC')::date) t
   join lateral(select * from commercial_fixed_fee_progress_values v where v.organization_id=new.organization_id and v.legal_entity_id=new.legal_entity_id
     and v.engagement_id=new.engagement_id and v.through_date=t.closing_date order by version desc limit 1) v on true
   where t.policy=new.policy_id and v.id=new.snapshot_id and v.report->>'currency'=t.currency
     and (v.report-array['billableHours','nonBillableHours','verifiedHours','entries','unresolved','amount'])
       =fixed_fee_progress_basis(new.organization_id,new.legal_entity_id,new.engagement_id,t.closing_date)
     and fixed_fee_progress_amount(t.allocation-(v.report->>'amount')::numeric,1,1,t.digits) is not null)
 or not exists(select from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and entity_id=new.id::text
   and module='Commercial Drafting' and entity_type='Fixed Fee Transition' and action='Approved' and source='Web'
   and new_value->>'policyId'=new.policy_id and new_value->>'snapshotId'=new.snapshot_id::text and new_value->>'reason'=new.reason)
 then raise exception 'Verified transition, current authority and matching approval audit required' using errcode='MFT01';end if;
 return null;
end $$;
create constraint trigger complete_fixed_fee_transition after insert on commercial_fixed_fee_transition_approvals
 deferrable initially deferred for each row execute function complete_fixed_fee_transition();
