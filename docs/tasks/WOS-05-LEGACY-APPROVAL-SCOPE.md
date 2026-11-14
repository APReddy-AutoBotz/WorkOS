# Legacy approval scope and delegation ownership

Requirements: WOS-CORE-003/005, WOS-IAM-003/005/010, WOS-APR-004 and WOS-NFR-SEC-004/012. Governing feature contract: APPROVAL_AND_POLICY_ENGINE_SPEC.md.

## Evidence and scope

A real disposable PostgreSQL/API reproduction confirmed that a named delegate with approvals.view can discover a legacy delegation ID, submit their own worker as the new delegator, and overwrite the retained owner's record. The existing self-service check examines submitted ownership rather than the locked previous row. Separately, the shared legacy approval/SLA scope returns true for Admin/HR and its delegation branch lacks a selected organization/legal-entity boundary.

Correct the retained-owner mutation check and immutable delegator ownership, serialize conflicting writes, and scope delegation participants and listings to the authorized selected entity. Extract the legacy delegation routes into a bounded module rather than adding more unrelated logic to the server entry point. Preserve cancellation/editing by the original owner and authorized scoped administration, with atomic before/after audit.

The common approval reader/decision/SLA scope must apply the selected organization/legal entity before role or delegation relationships. Canonical commercial and invoice approvals remain on their dedicated source-authoritative paths. Legacy delegation must not widen the selected scope; malformed dates and stale/inactive participants must fail visibly. No new grants, automatic policy adoption, defaults or historical data rewriting.

## Acceptance

Real HTTP negatives for recipient takeover, unrelated/foreign owner IDs, cross-entity participants and read/SLA scope; valid owner/admin edits; missing/removed permissions and roles; participant lifecycle changes; conflict/concurrent writes and audit rollback. Compare protected records and audit after refusals. Retain canonical delegation/approval and browser journeys, production/build/unit gates and migration evidence when applicable. Final diff must be reviewed for secrets, branding and unrelated edits before publication.

## Operations and limits

Retained records with unresolved or cross-entity ownership are unavailable rather than silently transferred or deleted. Older application code restores these gaps, so prefer forward correction. This work does not imply full approval-policy coverage, UAT, integration or production deployment. Publish only after both preceding work packages and this package's gates pass.

## Implemented behavior and evidence

The bounded legacy delegation module rejects retained-owner replacement, constrains historical and submitted participants to the selected entity, serializes supplied IDs and overlapping writes, validates calendar dates and keeps mutation/audit atomic. Activation requires both participants' active accounts, persisted role, selected entity membership and approval-view permission. Scoped revocation remains possible after worker exit. No grants or historical adoption are added.

The extracted common approval scope applies organization/legal entity before every role/delegation branch. Delegated reads revalidate the owner's active account, role, permission, entity membership, lifecycle and current subject relationship. SLA excludes the same dedicated commercial approval types as the legacy inbox. Existing source-specific decision guards remain authoritative; this does not assert that legacy delegation alone authorizes leave or timesheet decisions.

Real PostgreSQL/API tests pass takeover denial with unchanged audit, valid owner/admin edits, cross-entity reads/decisions and retained edits denied, competing-owner same-ID writes with one audit, overlapping creates, invalid dates and injected audit rollback. Activation negatives cover absent role, disabled owner/recipient, missing entity membership and permission; individual-grant activation passes. TeamLead delegated inbox/SLA positives and immediate revocation after account, role, scope, permission, reporting relationship, expiry and participant lifecycle changes pass.

The real production React page now catches delegation failures, retains inputs, disables saving while a request is active and distinguishes acknowledged save from failed list refresh. New creates omit the empty ID. A real browser/API/PostgreSQL journey passes visible invalid-role denial with zero writes followed by corrected successful submission. Accessible form labels and status feedback support that journey.

Canonical four-domain delegation, populated068-to069 upgrade/replay and independent leave decision regressions pass. Full aggregate unit/contracts passed before the final form/payload edit; the final form is covered by the passing real browser journey. Final typecheck, lint (541 modules) and production build pass; the inherited large-bundle warning remains. Signed production identity and fail-closed startup checks pass against a freshly migrated disposable database. Production dependency audit reports zero vulnerabilities; no dependency changes and the verified parent lockfile installation is reused. CI gates, traceability and operations documentation include both new regressions. Independent source review found no new actionable bypass; suggested race, retained-foreign and creation-authority test gaps were added and pass.

CountryDirector and ProjectManager delegated-read positives and revocation cases pass, including removed director qualification/cohort, project-manager relationship and assigned role. The first director-negative fixture attempted an invalid null required director; it was corrected to a valid alternate director, preserving the schema constraint. Remaining acceptance: all 51 broader PostgreSQL entry points passed; final diff review is complete and exact-head hosted CI remains required. No new migration or dependency. This is not full-product acceptance or production deployment.

Review correction: the inherited work-approval immutability test concatenated the table and WHERE tokens, so any SQL parser error satisfied its rejection assertion. The query now has valid syntax, requires immutable-guard SQLSTATE55000, and compares complete retained table snapshots after refusal. The affected real PostgreSQL/API suite passes, including populated062 upgrade/replay and source/decision/notification rollback checks. This is test-evidence repair, not a newly demonstrated production mutation bypass. The broader matrix was already running and is supplemented by this explicit corrected rerun.

Final package diff reviewed for source scope, synthetic fixtures, branding, credentials and generated artifacts. Only approval/delegation authority, related UI/transport, regression evidence and governance files are included. A trailing blank line was removed; runtime behavior is unchanged. All 51 broader PostgreSQL entry points passed. The run began on033a0ba and included subsequent test/documentation/whitespace-only changes; runtime behavior and SQL were unchanged. The corrected immutable-guard assertion also passed its explicit independent rerun. Exact-head hosted CI remains a separate gate.
