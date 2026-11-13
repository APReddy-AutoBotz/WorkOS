# Revocable sessions and absolute expiry

Addresses the revocation/expiry aspects of WOS-IAM-008/010 and WOS-NFR-SEC-003/004/012. Previously logout only cleared a cookie: a copied bearer token remained usable. A disposable baseline reproduction confirmed logout returned 200 and the copied token still returned 200 from the session endpoint. Auditing deployment-level session-duration configuration changes remains an operational governance requirement; this package does not add a configuration-change audit interface.

New logins receive an unpredictable session-family identifier. Refresh and role changes preserve that identifier and the original expiry; cookie lifetime is limited to the remaining session lifetime. Every authenticated request checks current account/role authority and the database revocation ledger. Logout atomically records a hashed family identifier and an actor/role/source audit event. Copies, refreshed tokens and role variants then receive 401. Repeated logout is idempotent; other independently created sessions remain usable. Missing revocation storage fails closed. Audit failure rolls back the revocation and returns an explicit unconfirmed result.

The browser clears local credentials and organization selection before waiting for the network. Generation checks prevent a delayed refresh from restoring cleared credentials. Logout delivery failure displays an explicit warning that the server session may remain active until expiry. It does not report a successful server revocation when offline.

## Schema and compatibility

Migration 094 adds an append-only session_revocations ledger and indexes. Identity ownership is by user across authorized organization scopes; retained actor identifiers deliberately have no cascading user foreign key. Only a hash is stored, not a bearer token or reusable session identifier. There is no data backfill, permission grant, dependency change or financial change.

Previously issued tokens acquire a deterministic family derived from the signed token. Their subsequent refreshes share revocation. Independently refreshed tokens issued before this upgrade cannot retrospectively be grouped. Allow those bounded old sessions to expire or rotate the session signing secret during a controlled rollout when immediate invalidation of all old tokens is required. This package implements current-session logout, not an administrator's revoke-all-sessions interface. Already admitted requests may complete after logout.

Historical domain-upgrade tests populate older business schemas through the current API. Explicit historicalSessionSchema fixture calls install the real 094 session DDL in an isolated test schema, behind public in the API search path. Public migrations still execute in order with exact expected IDs; public before/after business snapshots remain intact. The helper asserts that no revocation was written to the compatibility schema. These fixtures establish domain upgrade compatibility, not session-revocation continuity; the dedicated session suite verifies continuity and missing-storage failure on the actual current schema. No production fallback was added.

## Executable evidence

- Dedicated PostgreSQL/API acceptance passes: bearer/cookie replay denial, role/refresh family, absolute expiry, independent sessions, old-token transition, restart persistence, idempotent audited logout, immutable evidence and storage/audit failure.
- Actual browser login and sidebar logout passes, including a held refresh response, failed logout delivery, cleared device state and an honest server-status warning.
- Signed production identity/startup acceptance passes, including provider-issued cookie logout and denial of the original cookie and refreshed bearer.
- Full 90-entry migration runner passes fresh, concurrent, replay, upgrade and rollback checks on disposable PostgreSQL.
- Parent lockfile installation is reused without dependency changes. Aggregate unit/contract checks, type checking, syntax checks and the production build pass. Broader affected domain-upgrade regression verification is tracked before publication; exact-head hosted CI remains a separate gate.
- Dependency audit reports zero vulnerabilities. The legacy bootstrap scanner still reports the parent's 166 raw findings: 87 unique credential-like diagnostics plus 10 other unique diagnostics (including three runtime-brand files and URL parsing/allowlist cases). No new findings remain. New session fixture passwords are generated randomly per run. Credential diagnostics were traced to synthetic tests/revision tokens, not demonstrated live credentials; scanner precision and runtime-brand corrections remain separate work. This is not a passing scan. Hosted full-history Gitleaks remains required.

## Operations and rollback

Apply migrations before serving the new API. Unavailable revocation storage causes authenticated requests to fail closed, so monitor those 503 responses and preserve database availability. Preserve revocation and audit ledgers through backup/restore. Keep the configured absolute session duration appropriate to buyer policy; refreshing the page no longer extends it indefinitely.

Do not roll back by dropping or rewriting the ledger. Older code ignores revocations and can reopen copied-token access; prefer a forward correction. A controlled old-code recovery requires expiring existing sessions by rotating the signing secret and preserving the migrated database and audit evidence. Production rollout, buyer UAT, restore drills and final integration remain separate release gates.
