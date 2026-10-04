create table if not exists entra_auth_transactions (
  id uuid primary key,
  state_hash text not null unique,
  browser_binding_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists entra_auth_transactions_expires_at_idx
  on entra_auth_transactions (expires_at);
