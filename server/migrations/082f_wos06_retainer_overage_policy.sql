alter table commercial_contract_versions add column retainer_overage_policy text,
  add constraint retainer_overage_policy_valid check (
    retainer_overage_policy is null or
    (model='retainer' and retainer_capacity_policy is not null
     and retainer_overage_policy in ('no_charge','contract_hourly_at_period_end'))
  );
