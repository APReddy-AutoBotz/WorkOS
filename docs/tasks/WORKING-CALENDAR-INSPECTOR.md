# Working calendar inspector: bounded WOS-02 increment

## Authority and non-overlap reconciliation

This separate dependent Draft covers only the read-only calendar administration portion of WOS-ORG-008 and calendar entry point of WOS-ORG-010. It is stacked on unchanged PR48, head `5d002f4004b5169404d47857a54b97451626aeb5`, tree `33c9eeb5f9101a17ea90b68913c5abddf216c1d9`. Existing WOS-02 foundation authority is retained; no new business decision is needed for this inspector.

Before product writes, read-only reconciliation on 2026-10-20 at 03:45 UTC confirmed unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`, unchanged Draft PR48, successful exact-head CI39364690076, successful latest controller329 CI39356845274, no queued/in-progress/waiting/requested/pending repository run, and no active local WorkOS process. Prior writer released ownership and the parent confirmed no competing WorkOS writer. The isolated snapshot exactly matches the accepted PR48 tree; its prior staged snapshot and evidence are untouched. This is the separate bounded WOS-02 non-overlap decision, recorded before implementation. Protected acceptance work is not interrupted. The issue4 legacy checkpoint is historical, not merge authority.

## Bounded outcome

Standalone settings-management inspector linked independently from Admin navigation and Governance Settings. Use only existing captured-scope GET calendars and lazy selected-calendar GET holidays, with one consistently captured current effective date. Show persisted code/name/applicability/timezone/weekdays/hours/effective bounds/active status and holiday date/label/type/bounds/status. Display saved worker-group version-row ID, not inferred lineage/name. Disclose possible additional rows when either unchanged server cap of 200 is reached. Empty means no records returned for this snapshot, never exhaustive absence.

List and detail have separate loading/error/empty/retry states. Capture actor/employee/active role/effective permissions/token/organization/legal entity and request generation/selection. Suppress obsolete pre-send callbacks and late responses across context, selection, retry and unmount. Explicit retry resets cached backend availability. Invalid/mismatched server scope and malformed responses fail closed; no production local/demo fallback.

The only backend exception is DATE-as-text projection of calendar effective_from/effective_to and holiday holiday_date/effective_from/effective_to in the two existing GETs. Preserve predicates, order, limits, permission/ownership and row-array shape. No schema/global DATE parser/mutation/audit change.

## Exclusions and verification

No create/edit/retire/import/export, calendar assignment, effective capacity, winning-worker-calendar resolution, legacy utilization/leave/capacity integration, grants or credentials. No historical/future explorer, readiness write or claim of full WOS-ORG-008/010. Catalog mutations remain NO-GO pending retired-lineage reactivation and reference-semantics decisions. Blocked role-removal security repair, PR30, EmailMonitor, reference repository writes, Ready/merge/deployment and programme/release acceptance remain excluded.

Require production-service GET contracts and explicit zero business mutation requests; additive twelfth hosted browser suite covering applicability/holidays/empty/cap/retry/context/selection races; actual disposable PostgreSQL route tests in UTC, Asia/Kolkata and America/Los_Angeles; locked install, all existing full gates, independent exact-tree engineering review, exact-head hosted CI and receipt/readback. Local browser socket restrictions are not bypassed and unexecuted gates are never counted as passed. Formal dependency/review/owner/UAT/release gates stay open. Rollback is a revert of this isolated viewer/service/date-transport/test/docs increment, with no migration or data conversion.
