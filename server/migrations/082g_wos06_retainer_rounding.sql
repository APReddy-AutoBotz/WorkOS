alter table commercial_contract_versions add column retainer_rounding jsonb,
  add constraint retainer_rounding_valid check (
    retainer_rounding is null or (
      model='retainer' and retainer_overage_policy is not null and
      jsonb_typeof(retainer_rounding)='object' and retainer_rounding ?& array['precision','mode'] and
      retainer_rounding - 'precision' - 'mode' = '{}'::jsonb and
      (retainer_rounding->'precision') in ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) and
      (retainer_rounding->'mode') in ('"HALF_UP"'::jsonb,'"HALF_EVEN"'::jsonb,'"DOWN"'::jsonb)
    )
  );
