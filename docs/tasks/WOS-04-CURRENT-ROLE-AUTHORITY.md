# Current selected-role authority

## Scope and invariant

Addresses WOS-IAM-003/005/008/010 and WOS-NFR-SEC-003/004. A signed session must not retain a removed selected role. The shared identity guard checks the current active account and direct role or active application group mapping in PostgreSQL before scope discovery, refresh, role switching and scoped APIs. Both cookie and bearer sessions and legacy/versioned routes use this boundary. Existing permission and data-scope guards remain necessary.

This package ports the bounded identity repair from Draft PR124 onto accepted main without importing the later feature stack. No migration, dependency, permission grant or production fallback is introduced. The current owner's authorization supersedes historical deferred review/merge instructions; independent review and all applicable checks remain required.

## Compatibility and error contract

Removed roles and disabled accounts return 403 with `SESSION_ROLE_REVOKED`; missing/invalid signatures remain 401. Unavailable identity storage returns 503 with `IDENTITY_AUTHORITY_UNAVAILABLE`, including when test scope fallback is configured. The guard does not grant another role to bypass a rejected session.

Entra login retains bounded provider-verified, application-mapped group IDs in the signed session. All verified mapped groups are retained, including multiple groups granting the same role: removing one mapping must not reject a role still granted by another active mapping. Refresh and switching preserve that provenance and reload mappings. Client role lists, request bodies and local-provider group claims cannot provide group authority.

Older mapped-only sessions require fresh provider authentication; directly assigned sessions continue only while the account and selected role remain active. Group membership is the provider snapshot verified at login, not a live directory lookup. Refresh can still select another currently assigned role if assignments change between its guard and subsequent lookup; this patch does not claim transaction-wide role serialization. Existing transactional mutation guards remain in place.

## Executable evidence

The unchanged parent accepted an old Admin token on `/api/permissions/config` with HTTP 200 after Admin was removed, failing the regression's expected 403. The repaired real PostgreSQL/API regression rejects that retained token across ordinary reads, identity/scope discovery, refresh and switch paths, both API prefixes and both transports. Current direct roles and mapped roles remain usable. Mapping removal invalidates original, refreshed and switched sessions; disabled accounts, unassigned signed roles and storage failures fail closed.

Independent candidate review identified loss of a second valid mapping. The real signed-provider callback regression reproduced that failure; retaining all mapped group IDs corrected it. The production identity fixture now proves two mappings grant access, removal of the first preserves access, and removal of both rejects the issued cookie. Existing provider issuer/audience/nonce/replay and production fail-closed checks remain intact.

Local locked installation, focused middleware, expanded PostgreSQL role authority, retained commercial PostgreSQL acceptance, production identity and 54-entry fresh/concurrent/replay/upgrade/rollback migration checks passed. The full aggregate log reached its final passing assignment-service command; its process exit was not retained across the environment reset, so final integrated aggregate/hosted acceptance is still required. Exact final-head results belong in the PR and accepted checkpoint, not inferred from earlier branch results.

## Operations and rollback

Each authenticated request adds a current identity/role lookup; there is no revocation cache delay. No schema conversion is needed. A rollback of this guard reopens stale-role access: prefer a tested forward correction, or keep affected access unavailable while repairing. Preserve production OIDC enforcement and all audit/history records.

This repairs current account/role authority only. Per-session logout revocation, absolute session lifetime, protected identity administration, other frozen-audit findings, buyer identity/UAT and release acceptance remain separate work. No deployment is performed.


## Accepted checkpoint — 2026-11-16

PR162 merged at `0ad02ab3611d9720eb226b481ae68e6cbbd68ec4`. Candidate `f41fab11e7af506116d4c7e161977b44573c8fbe` passed full local integrated type/lint/aggregate, browser, build, PostgreSQL and independent review. Exact-head CI43797328102 and resulting main CI43798387297 each passed all 74 steps, including production identity, 54-entry migrations, dependency/secret scans and container checks. This supersedes earlier pending acceptance statements for this candidate, not the broader limitations above.
