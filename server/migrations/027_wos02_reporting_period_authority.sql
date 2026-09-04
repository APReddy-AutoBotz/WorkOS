-- WOS-02 authoritative, legally-scoped reporting-period lifecycle.
create extension if not exists btree_gist;

alter table reporting_periods drop constraint if exists reporting_periods_status_check;
update reporting_periods set status='Financially Locked' where status='Locked';

do $$ begin
  if exists (select 1 from reporting_periods where legal_entity_id is null) then
    raise exception 'Reporting periods without legal-entity ownership require reconciliation';
  end if;
end $$;

alter table reporting_periods alter column legal_entity_id set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='reporting_periods_status_check') then
    alter table reporting_periods add constraint reporting_periods_status_check check
      (status in ('Planned','Open','Submission Closed','Approval Closed','Financially Locked','Closed'));
  end if;
end $$;

alter table reporting_periods drop constraint if exists reporting_periods_organization_id_code_key;
create unique index if not exists uq_reporting_periods_org_legal_code
  on reporting_periods(organization_id, legal_entity_id, code);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='reporting_period_ranges_no_overlap') then
    alter table reporting_periods add constraint reporting_period_ranges_no_overlap exclude using gist
      (organization_id with =, legal_entity_id with =, daterange(starts_on,ends_on + 1,'[)') with &&);
  end if;
end $$;
