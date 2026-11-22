alter table commercial_service_unit_evidence add column effort_hours numeric
 check (effort_hours > 0 and effort_hours <= 24 and scale(effort_hours) <= 4);

create function service_unit_effort_recorder_current(e commercial_service_unit_evidence) returns boolean language sql stable as $$
 select exists(select from users u join employees w on w.id=u.employee_record_id
   where u.id=e.actor_id and u.status='Active' and w.id=e.recorder_worker_id and w.status='Active'
   and w.organization_id=e.organization_id and w.legal_entity_id=e.legal_entity_id and e.recorder_link_generation=
     coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0))
$$;

create or replace function require_service_unit_evidence_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id
   and user_id=new.actor_id::text and active_role=new.active_role and operation_id=new.operation_id and module='Commercial Drafting'
   and action='Recorded' and entity_type='Managed Service Evidence' and entity_id=new.id::text and source='Web'
   and new_value=(jsonb_build_object('engagementId',new.engagement_id,'versionId',new.version_id,'dimensionCode',new.dimension_code,
     'quantity',new.quantity::text,'serviceDate',to_char(new.service_date,'YYYY-MM-DD'),'sourceReference',new.source_reference) || case when new.effort_hours is null then '{}'::jsonb
       else jsonb_build_object('effortHours',trim_scale(new.effort_hours)::text) end))
 then raise exception 'Scoped service capture audit required' using errcode='MSU03'; end if;
 return null;
end $$;
