-- Existing profiles keep the deployment defaults until an administrator saves branding.
alter table organization_profile_versions
  add column branding jsonb not null default '{}'::jsonb
  check (jsonb_typeof(branding) = 'object');
