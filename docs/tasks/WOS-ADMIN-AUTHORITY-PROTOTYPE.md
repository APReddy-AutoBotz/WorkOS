# Admin mutation authority prototype

## Status and provenance

**Local, unintegrated prototype. Not a recovered Admin candidate, production fix, or release acceptance.**

Prepared on 2026-11-11 from the verified published main tree:

- Remote main commit: `b9a57f8a462d8585bb3f73129080d6fae5173343`.
- Exact tree: `a05708da043df0c96a15f2d521887adde0b6bd5e`.
- Available local snapshot commit: `d9ae99c`, with the same tree.
- Unavailable Admin candidate: `ea9619448524fff5085e9e80e850213e1d0e5282`, reported tree `150e4cf4566ac8ea0470bde8794ee01f26fb5ce2`.

The unavailable candidate's legal-entity editor, reporting-period editor, revision checks, navigation and prepared PostgreSQL tests have not been recovered or overwritten. This prototype neither reconstructs them nor changes any existing API route. No remote branch, PR, workflow or deployment was changed.

## Intended boundary

The two Admin mutations currently check permission and scope before waiting on their business locks. This module prepares a transaction owner for the legal-entity and reporting-period paths once their exact candidate is available. The caller must preserve authenticated middleware, validation, existing business lock keys, revision checks, overlap/transition/dependency rules and audit. It must return an HTTP response only after this runner resolves.

`runAdminMutation`:

1. Captures the authenticated actor, active role, session expiration, originally requested scope headers and previously selected scope before any await.
2. Starts a new explicit READ COMMITTED transaction and takes the existing server-built business advisory lock.
3. Acquires an alphabetically ordered set of authority-table SHARE ROW EXCLUSIVE locks with NOWAIT.
4. Rechecks active account, currently held active role, effective `settings.manage`, original header ambiguity and exact selected organization/entity using the same client.
5. Checks session and date-based scope expiry, runs the bounded mutation and audit callback, checks expiry again, then commits.
6. Rolls back failed authorization, mutation or audit. A lost commit acknowledgement is reported as unknown, not retried or described as definitely rolled back.

Only a trusted route implementation may supply the callback, business lock key and role-default resolver. The module does not validate a token signature or perform HTTP authentication. The callback must do only transactional SQL through its supplied client, including audit. It must not commit/release, suppress database failures, send a response or perform external effects.

## Missing rows and writer coordination

The prototype locks these existing authority tables: users, roles, user_roles, role_permissions, user_permission_grants, user_organization_scopes, organizations, organization_profile_versions, legal_entities and legal_entity_profile_versions.

Ordinary authority DML conflicts with these table locks without requiring every writer to adopt a new advisory protocol. That covers an empty role-permission configuration and insertion of a second selectable scope. SRE also serializes guarded writers and avoids two SHARE holders both upgrading to write the creator's scope. The lock attempt fails rather than waiting behind an existing conflicting table lock. PostgreSQL documents these lock conflicts and their transaction lifetime in [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html).

This is a deliberately conservative design with deployment-wide write contention, not a scalability claim. Existing row-lock holders or later business/audit locks can still participate in deadlocks; NOWAIT at this table-lock step does not eliminate all possible deadlocks. Test real writer lock orders, fail-closed rollback, latency and conflict rates before adoption. A narrower row/epoch design would require a separate audited protocol covering every authority writer, missing rows and restore/import paths.

## Permission and scope compatibility

- An entirely absent role configuration uses the existing role-default callback.
- Any configured role rows suppress fallback, including disabled rows and rows for other permission keys.
- Direct grants are additive, preserving the existing behavior.
- Removed active-role membership is now denied even when the signed token or a direct grant persists. This is an intentional tightening required by WOS-IAM-003 and SEC-003, and requires compatibility tests.
- Missing authority tables fail closed at lock acquisition; no legacy missing-table fallback applies.
- Original unselected-header ambiguity is re-evaluated. A different singleton scope cannot silently replace the middleware's chosen scope.
- Scope expiration is captured before the mutation. It does not re-run implicit selection after a legal-entity create adds a scope, nor accidentally turn a permitted self-retirement into an unexplained rollback.

## Time and snapshot semantics

READ COMMITTED provides a new snapshot for the authority reads after a business-lock wait. Do not use a frozen REPEATABLE READ snapshot for this algorithm. See [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Scope dates use post-lock statement time in the database session's existing time zone. Session expiry and the earliest current organization/profile/authority end date are checked using wall-clock time both before and after the mutation. This avoids transaction-start `current_date` remaining stale across midnight. See [Date/Time Functions](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

If either original scope header was omitted, the deadline is additionally capped at the next database-local midnight. A different pre-existing scope can become effective then and make implicit selection ambiguous without a writer. The conservative cap forces rollback/reload across that boundary, even if selection would remain unique. It avoids re-resolving after the mutation itself creates a scope or retires its selected entity.

Every guarded mutation also requires the wall-clock database-local date to equal the date captured by its authority query. This conservatively refuses any date transition, including the first transition in a time zone with an ambiguous/repeated midnight, where converting a local midnight to an instant could choose the later offset. Real date/time-zone behavior remains untested.

The final time check is immediately before COMMIT, not an atomic test of the physical commit timestamp. A clock boundary crossed between that check and commit is not proven excluded. If the acceptance rule requires that stronger guarantee, resolve it before integration. Database and API clock consistency, midnight boundaries and time-zone behavior need real tests.

## Acceptance still required

No PostgreSQL server, test identity, credential or hosted resource was created or accessed for this prototype. Contract doubles prove JavaScript ordering, branching and cleanup only; they cannot prove the SQL, database constraints, lock conflicts, actual waits, commit visibility or rollback durability.

On an independently verified disposable PostgreSQL/API fixture, test at least:

- Revocation commits while the mutation is held on its business lock: role permission, direct grant, role membership, user status and selected scope; no mutation or audit persists.
- Mutation obtains authority locks first: conflicting ordinary revocation DML cannot commit before the mutation; no early success response.
- A writer already holds each relevant table lock: NOWAIT refuses cleanly with no partial effects.
- Empty role configuration followed by first disabled row insertion, and absent/default selection followed by another scope insertion.
- Two legal-entity creates, create plus role/scope writer, concurrent period writes and realistic row-lock inversions; bounded deadlock handling with no partial write or audit.
- No defaults when any role configuration exists; held-role requirement with direct grants; matching existing successful roles.
- Real audit failure and lost connection/commit acknowledgement; verify state before retrying.
- Scope/date and token expiry across both business-lock waits and mutation/audit waits; test database time zones and midnight.
- Recovered revision checks, legacy-client compatibility, legal-entity creator scope, self-retirement and unchanged period transition/overlap/lock behavior.
- Application-role privileges to take the proposed locks; deployment-wide contention and performance.

Restore and verify the exact held Admin candidate before porting. Review the new module and its integration independently. Existing formal security review, real PostgreSQL/API, migration and integrated browser/UAT gates remain open. Do not claim a fixed vulnerability or readiness to merge from this prototype.

## Operational and rollback notes

There is no migration, dependency addition, new permission grant or live route registration. Removing this unused module/test and their documentation has no runtime effect. Integration would create 409 authority-busy responses under contention and a 503 unknown-save outcome; UI reconciliation must be verified before enabling it. Do not automatically retry an uncertain commit.

## Requirements supported, not accepted

WOS-CORE-003/005, WOS-ORG-002/009, WOS-IAM-003/004/005/008/010, WOS-NFR-SEC-003/004, WOS-NFR-REL-003, WOS-NFR-DAT-005 and WOS-NFR-MNT-001/005. This local prototype earns no programme acceptance credit.

## Local verification, 2026-11-11

- `npm run test:admin-authority`: 31 contract-double tests passed, none skipped. No database or network required.
- TypeScript, JavaScript syntax lint, frontend build, existing organization-setup smoke, backend-contract smoke and authorization-convergence smoke passed.
- Existing permission smoke passed with the repository CI's documented test-mode/fallback environment. An initial invocation without that profile failed because production-mode fallback is disabled, not because of this unused module.
- `npm ci --offline --ignore-scripts` did not complete: the local npm cache lacked the locked zod package. No online install was attempted. Dependency-requiring checks used the existing sibling checkout's installed packages through a temporary local symlink, so this is not a clean locked-install verification.
- Local Node was v24.22.1; the repository CI specifies Node 22. Full CI, full aggregate tests, migration execution, production startup, browser/UAT and dependency/security scans were not run.
- A separate ordinary engineering review found two time-boundary gaps in the initial prototype: implicit scope activation and repeated midnight. The final code adds conservative deadline/date checks and corresponding doubles. This review is not a formal security review and does not waive that outstanding gate.

Reproduce the new isolated suite with `node --test tests/admin-mutation-authority-smoke.mjs`. It uses only Node built-ins. No live route imports this prototype.
