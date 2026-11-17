# Auditing session lifetime changes

WOS-IAM-008 requires each effective change to the buyer deployment's session lifetime to be auditable. WOS-IAM-010 requires negative authorization coverage. Production currently obtains the duration from Compose. The underlying environment value identifies neither the editor nor their authority.

## Authority decision

The buyer can keep ownership in its release process and identify the authenticated release principal plus the approved change record. Alternatively, a dedicated WorkOS permission can authorize a named administrator to change the policy. This decision determines how WorkOS authenticates the writer. Neither a display name supplied with a request nor an operator name copied from an environment variable establishes identity.

## Acceptance

- Record the deployment scope, policy key, authenticated principal, active role, source, reason, timestamp, previous duration and new duration. Use the effective duration in milliseconds so equivalent configuration values compare equally.
- On upgrade, record the first observed setting as a baseline with an unknown previous value. Preserve existing signed expiries and distinguish this baseline from a change.
- Commit each policy change and its audit evidence atomically. Refuse unauthorized changes and stale writes. A retry or a replica restart with the same effective configuration must leave the history intact.
- Verify that a stale replica cannot issue a new session with a superseded lifetime. Cover concurrent writers, audit storage failure, ordinary sign-in, refresh and role switching. Observe the expiry of a signed session using the real API.
- For rollback, restore a prior duration through a new audited change, preserving the intervening history. Verify fresh installation and an upgrade from the current migration ledger if the implementation changes the schema.

These are delivery criteria. The choice of writer and the runtime implementation are outstanding.
