alter table commercial_contract_versions add column retainer_capacity_policy text,
  add constraint retainer_capacity_policy_valid check (
    retainer_capacity_policy is null or
    (model = 'retainer' and jsonb_array_length(retainer_periods) > 0 and
     retainer_capacity_policy in ('billable_expire','all_expire','billable_rollover','all_rollover'))
  );
