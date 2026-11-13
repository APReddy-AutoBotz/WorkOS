# Current assigned-role authority

## Outcome and scope

Addresses WOS-IAM-003, WOS-IAM-005, WOS-IAM-008, WOS-IAM-010 and WOS-NFR-SEC-003/004. A valid signature establishes that a token was issued; it must not preserve a role after that role is removed. The common identity middleware now checks the active account and current role assignment in PostgreSQL before attaching identity, discovering scope, refreshing a session or reaching any scoped API. This covers both cookie and bearer sessions and both legacy and versioned routes.

The selected role must still be assigned. The server does not silently switch to another role or infer authority from the token's historical role list. Removed roles and disabled accounts return a stable forbidden response, preserving the existing domain-level authorization contract. Missing/invalid signatures remain unauthorized. Unavailable identity storage returns service unavailable and cannot use the test scope fallback.

## Verification

The database regression was run against the unchanged parent API: after removing Admin from the account, the retained token still read `/api/permissions/config` with HTTP 200, failing the expected denial. The repaired API rejects the same retained token on permission configuration, employee reads, commercial reads, scope discovery, role switching and session refresh, through both API prefixes and both cookie/bearer transports. A newly authenticated remaining role continues to work. Signed unassigned roles, disabled users and unauthenticated callers are also covered.

`test:identity-access` covers current-role loss and unavailable identity storage, including the explicit test-fallback configuration. `test:current-role-postgres` runs in CI against disposable migrated PostgreSQL databases. Exact-head full-suite and hosted results are recorded in the Draft PR; no skipped production or database check counts as acceptance.

Local Windows evidence: focused middleware and real PostgreSQL/API tests passed; `npm test` passed all 127 top-level commands with the documented synthetic test-mode environment; `npm run typecheck` and `npm run lint` passed (515 modules). The first aggregate invocation lacked the required demo-test environment and failed closed; rerunning with the existing CI test flags passed. Database/production acceptance remains separately required in hosted CI. Dependencies reuse the parent's successful locked installation; no dependency or migration changed.

## Operations and rollback

No migration or token-format change. Existing valid sessions retain access only while their selected role and account remain active. After removing a role, the user must authenticate again and select a currently assigned role. Every authenticated request adds one indexed identity/role lookup; no cache delays revocation. Existing transaction-level guards remain in place for concurrent financial/approval mutations.

This is immediate role/account authority validation, not complete per-session logout revocation or an absolute session-lifetime implementation; those remain separate review findings. Employee role-assignment authorization also remains a separate repair. Reverting this change reopens stale-role access, so prefer a tested forward correction. No production deployment or data conversion is performed.
