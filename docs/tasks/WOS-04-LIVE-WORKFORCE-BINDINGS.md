# Current workforce authority for authenticated sessions

Addresses WOS-CORE-003, WOS-IAM-005/009/010, WOS-WKF-008 and WOS-NFR-SEC-004.

A real local login followed by an authorized employee update reproduced obsolete director access: the retained token still listed the previous director's workers while a fresh login did not. A signature establishes issuance, not continuing workforce relationships.

The shared authentication boundary will reload worker record, worker code and qualified director binding alongside the existing active-account/role check. Signed historical bindings must not override current database values, including null values. Existing organization/legal-entity scope and permission checks remain authoritative. Missing storage fails closed. No new grants, buyer defaults, schema or financial behavior are introduced.

Acceptance requires a real issued-token reassignment regression, null/unlinked/changed-designation and signed stale-binding negatives, current positive scope, cookie and bearer checks, middleware contracts, production identity checks and affected domain regressions. Fixtures that only signed worker claims must establish actual database ownership; tests must not weaken runtime authority to retain old assumptions.

Already admitted requests may finish under their request-start authority. No retrospective data alteration or session-wide administrative revocation is included. Older code restores stale-token scope, so prefer forward correction; any controlled rollback must invalidate outstanding sessions. Production rollout and final integration remain separate gates.

## Verification evidence

- Real PostgreSQL/API regression passes supported director reassignment, qualification removal, null identity linkage, bearer/cookie parity, foreign legal-entity denial and positive current legacy-code scope for Employee, TeamLead and ProjectManager despite obsolete signed bindings.
- Existing current-role, session-revocation and setup-read-boundary suites pass. The setup fixture now uses distinct actual worker and team-lead links; migration availability fixtures now establish their named account's worker/director relationship.
- All 91 migration runner entries pass fresh/concurrent/replay/upgrade/rollback checks. No migration is added or rewritten.
- Typecheck, lint (534 modules), full aggregate unit/contract suite and production build pass. The existing large-bundle warning remains. Locked dependency audit reports zero vulnerabilities; dependencies are unchanged and use the verified parent lockfile installation.
- Signed production identity/startup checks and actual workforce-directory React/API/PostgreSQL journey pass. The first provider check stopped because OpenSSL was absent from PATH; the successful rerun used the installed utility and a newly created disposable database.
- Independent source review found no new actionable regression. Broader affected PostgreSQL acceptance and exact-head hosted CI remain required before package completion; local results do not establish release acceptance.
