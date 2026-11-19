insert into permission_definitions(permission_key,module,label,description,protected)
values ('periods.financial_reopen','Admin','Reopen financial periods','Permit a financial lock to return to Approval Closed with a recorded reason.',false);

alter table reporting_periods add column revision integer not null default 1 check(revision>0);

create function revise_reporting_period() returns trigger language plpgsql as $$
begin
  if old.status='Financially Locked' and new.status not in ('Financially Locked','Closed','Approval Closed') then
    raise exception 'Financial reopen must retain approval closure' using errcode='RPF01';
  end if;
  if old.status='Financially Locked' and new.status='Approval Closed'
    and (to_jsonb(new)-array['status','revision','updated_at']) is distinct from (to_jsonb(old)-array['status','revision','updated_at']) then
    raise exception 'Financial reopening cannot reshape a reporting period' using errcode='RPF01';
  end if;
  new.revision := old.revision + 1;
  return new;
end $$;
create trigger revise_reporting_period before update on reporting_periods
for each row execute function revise_reporting_period();

create function require_financial_reopen_evidence() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from audit_logs a join users u on u.id::text=a.user_id and u.status='Active'
    join user_roles ur on ur.user_id=u.id join roles role on role.id=ur.role_id and role.name=a.active_role
    join user_organization_scopes s on s.user_id=u.id and s.organization_id=new.organization_id and s.legal_entity_id=new.legal_entity_id and s.active
    where a.organization_id=new.organization_id and a.legal_entity_id=new.legal_entity_id and a.entity_id=new.id
      and a.module='Organization Setup' and a.action='Reopen Financial Period' and a.entity_type='Reporting Period'
      and a.operation_id=current_setting('workos.financial_period_operation',true)
      and length(btrim(a.reason))>=3 and a.old_value=to_jsonb(old) and a.new_value=to_jsonb(new)
      and not exists(select 1 from unnest(array['settings.manage','periods.financial_reopen']) k
        where not exists(select 1 from role_permissions rp where rp.role_name=role.name and rp.permission_key=k and rp.enabled)
        and not exists(select 1 from user_permission_grants g where g.user_id=u.id and g.permission_key=k))
  ) then raise exception 'Financial reopening requires scoped authority and matching audit evidence' using errcode='RPF01'; end if;
  return null;
end $$;
create constraint trigger require_financial_reopen_evidence after update on reporting_periods
deferrable initially deferred for each row when (old.status='Financially Locked' and new.status='Approval Closed')
execute function require_financial_reopen_evidence();
