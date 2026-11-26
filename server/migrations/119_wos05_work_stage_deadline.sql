-- Keep the original policy shape, including the validator reused by assignment approvals.
alter table work_approval_policy_versions drop constraint work_approval_definition_shape;
alter table work_approval_policy_versions add constraint work_approval_definition_shape check (
  valid_work_approval_definition(definition - 'stageDueMinutes')
  and case when definition ? 'stageDueMinutes' then
    case when jsonb_typeof(definition->'stageDueMinutes') = 'number' then
      (definition->>'stageDueMinutes')::numeric between 1 and 2147483647
      and trunc((definition->>'stageDueMinutes')::numeric) = (definition->>'stageDueMinutes')::numeric
    else false end
  else true end
);
