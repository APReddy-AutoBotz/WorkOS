# Independent legacy leave decisions

Addresses WOS-APR-002, WOS-IAM-003/005/010 and WOS-NFR-SEC-004/012, including the approval specification's negative self-approval acceptance case. A real disposable baseline reproduced a default HR user submitting and approving their own unconfigured annual leave. Configured approval stages already prohibited that decision.

Both legacy leave decision paths now enforce requester/affected-worker independence before mutation. A shared service resolves the current user-to-worker link from PostgreSQL and checks retained server-written Submit Leave audit provenance. A stale or forged worker claim cannot authorize self-approval. The generic approval route also requires leave.approve and validates the linked worker against the selected organization/legal entity; approvals.view alone is insufficient. Configured approval instances retain their existing stage and delegation guards. Cancellation remains separate from an approval/rejection decision.

Migration 095 adds a partial index for retained submission-actor lookup. It changes no historical records, grants, financial data or approval state. Old records without retained submitter provenance still receive the authoritative affected-worker check; the change does not invent an unknown historical submitter. Existing successful decisions are not rewritten. The lookup is not a replacement for configured staged approvals or an assertion that every other legacy approval domain has been remediated.

## Evidence

The dedicated PostgreSQL/API test passes own approval/rejection denial, recorded on-behalf submitter denial, current-linkage enforcement despite stale claims, generic-route permission and alternate-selected-entity denial, unchanged source/balance/approval/audit/notification state after refusal, legitimate independent approval and owner cancellation. The actual Team Leave Calendar browser journey passes visible owner denial with retained Submitted state and a second actor's successful approval. No mocked feature backend is used.

The 91-entry migration runner passes fresh, concurrent, replay, upgrade and rollback checks. Configured leave and calendar-aware legacy acceptance pass, including canonical recipient failure/rollback and actual-capacity effects. The full 128-command unit/contract aggregate, type checking, syntax checks and production build pass. Aggregate tests use the repository's declared CI-only test fallback flags; production and connected API fixtures retain fail-closed configuration.

Older actual/forecast/capacity fixtures that submitted and approved using one manager are corrected to use the named affected employee as submitter and a distinct approver. Their domain assertions remain unchanged. Migration expectations explicitly include 095. Full affected PostgreSQL regression and exact-head hosted CI remain tracked in the draft PR before final acceptance.

## Rollout and rollback

Apply 095 using the ordered migration runner in the normal maintenance window; index creation takes the standard PostgreSQL table lock while it builds. The new check reads retained immutable audit evidence, so preserve that evidence through backup and restore. No destructive conversion or data backfill is required. Previously accepted own leave remains historical evidence; it is not silently cancelled or recalculated.

Older application code restores the self-decision and generic-route authorization gaps. Prefer forward correction. The additive index can remain during controlled code recovery; do not erase audit records to bypass independence. Production deployment, buyer UAT and final integration remain separate release gates.
