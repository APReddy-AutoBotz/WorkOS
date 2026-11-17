-- Pre-authentication protection belongs to this isolated buyer deployment/database,
-- before any user/organization identity is trusted. Never store raw IPs or names.
-- Expiring operational counters are mutable; they are not audit/session evidence.
create table authentication_rate_buckets (
  bucket_key text primary key check (bucket_key ~ '^[a-f0-9]{64}$'),
  attempts bigint not null check (attempts between 1 and 9007199254740991),
  reset_at timestamptz not null
);
create index authentication_rate_buckets_expiry on authentication_rate_buckets(reset_at);
