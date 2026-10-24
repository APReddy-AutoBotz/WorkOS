-- Immutable diagnostic metadata only. No work rewrite, inferred past check,
-- rejection rule, default policy, grant or financial exclusion is introduced.
alter table work_submission_evidence add column duplicate_entry_check jsonb;
alter table work_submission_evidence add constraint work_submission_duplicate_check_shape check (
 duplicate_entry_check is null or coalesce(
  jsonb_typeof(duplicate_entry_check)='object'
  and duplicate_entry_check->>'version'='exact-entry-content/1'
  and jsonb_typeof(duplicate_entry_check->'groups')='array',false)
);
