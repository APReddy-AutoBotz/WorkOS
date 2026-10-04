-- WOS-02 reporting-period schedule authority.
alter table reporting_periods add column if not exists frequency text;
update reporting_periods set frequency='Weekly' where frequency is null;
alter table reporting_periods alter column frequency set not null;

alter table reporting_periods drop constraint if exists reporting_periods_frequency_check;
alter table reporting_periods add constraint reporting_periods_frequency_check
  check (frequency in ('Weekly','Monthly','Fiscal'));

drop index if exists uq_reporting_periods_org_legal_code;
create unique index if not exists uq_reporting_periods_org_legal_frequency_code
  on reporting_periods(organization_id, legal_entity_id, frequency, code);

alter table reporting_periods drop constraint if exists reporting_period_ranges_no_overlap;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='reporting_period_frequency_ranges_no_overlap') then
    alter table reporting_periods add constraint reporting_period_frequency_ranges_no_overlap exclude using gist
      (organization_id with =, legal_entity_id with =, frequency with =,
       daterange(starts_on,ends_on + 1,'[)') with &&);
  end if;
end $$;
