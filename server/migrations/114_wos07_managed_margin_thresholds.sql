-- The worker and finance inspection use the same retained amount and approved terms.
create view commercial_service_month_end_thresholds as
select m.organization_id, m.legal_entity_id, m.engagement_id, m.id as margin_version_id,
       m.month_start, period.ends_on, terms.id as amendment_id, terms.effective_on,
       case when period.ends_on < (now() at time zone 'UTC')::date
            then nullif(terms.threshold, 'disabled')::numeric end as threshold_percent,
       case when period.ends_on >= (now() at time zone 'UTC')::date then 'Open'
            when terms.threshold is null or terms.threshold = 'disabled' then 'Inactive'
            when m.report->>'marginPercent' is null then 'Unavailable'
            when (m.report->>'marginPercent')::numeric < terms.threshold::numeric then 'Below'
            else 'AtOrAbove' end as status
from commercial_service_margin_versions m
cross join lateral (select (m.month_start + interval '1 month' - interval '1 day')::date as ends_on) period
left join lateral (
    select a.id, a.effective_on, a.ends_on, a.after_value->'terms'->>'marginThresholdPercent' as threshold
    from commercial_amendments a
    where a.organization_id = m.organization_id and a.legal_entity_id = m.legal_entity_id
      and a.entity_type = 'Engagement' and a.entity_id = m.engagement_id
      and a.effective_on <= period.ends_on
    order by a.effective_on desc
    limit 1
) terms on period.ends_on <= terms.ends_on and period.ends_on < (now() at time zone 'UTC')::date;
