-- Retain immutable submission provenance; scope every decision lookup.
create index leave_submitter_provenance_idx
  on audit_logs (entity_id, organization_id, legal_entity_id, user_id)
  where module='Leave' and action='Submit Leave' and entity_type='LeaveRequest';
