# Invoice action source authorization

Requirement lineage: WOS-CORE-003, WOS-IAM-005/010, WOS-INV-002 and WOS-INT-002, with WOS-NFR-SEC-004/012.

## Confirmed defect

A disposable real-API reproduction created a supported empty milestone invoice draft and explicit action template. A separate scoped preparer with generic invoice permissions but without `commercial.milestone_billing.view` received 403 from the main batch reader, but 200 from the alternate action source reader and 201 from its assessment command. That command created two in-app recipient records. The disclosure is batch/engagement/state/owner/preparer/template/lineage metadata; no amount, cost, financial state change or invoice export bypass is claimed.

## Intended correction

Action source, receipt and assessment paths must apply source-specific visibility in addition to existing role, preparation and organization/legal-entity checks. Notification recipients, inbox reads and acknowledgement writes must retain access to the batch's source type. Database insert and deferred commit guards must enforce the same authority, preserving complete-recipient atomicity and exact-request behavior. Template access must be reviewed against its engagement model, rather than implicitly treating every engagement as T&M.

Use an additive ordered migration; do not modify prior migrations or retained action, invoice, occupancy, approval or financial records. No grants, defaults, recipient overrides or new external delivery. T&M behavior remains supported.

## Required evidence

Real milestone-source denial and authorized positive cases; unauthorized source/receipt/replay/assessment and inbox/read paths; actor and recipient permission loss through commit; SQL bypass refusal; unchanged protected state after refusal; generic T&M regression; fresh installation and populated upgrade/replay; production/browser compatibility; typecheck, lint, aggregate contracts and build. Review exact final diff for branding, secrets and unrelated edits before dependent Draft publication. Parent live-workforce package is still under broader acceptance and must be published first.

## Operations and limits

Apply the additive migration before the new reader code. Preserve immutable historical events; loss of current permission hides them without erasure. Older code/guards reopen the authorization gap, so prefer forward repair. This package does not introduce a new notification policy, financial decision or source model. Integration, buyer UAT and deployment remain separate release gates.

## Local evidence so far

- Targeted real API/SQL tests pass missing-source-permission denial, authorized assessment, exact replay, subsequent receipt/replay/template/inbox/read denial, direct SQL event/read bypass refusal, and atomic initiating-actor, preparer, owner and template authority loss. Fixtures preserve owner authority until the intended transaction; an earlier fixture incorrectly recorded permanent owner loss and was corrected without changing product controls.
- Populated 095-to-096 upgrade/replay preserves exact notice, recipient, invoice, identity and audit rows; retained receipts and inbox remain visible to authorized actors.
- Full 92-entry migration suite passes fresh/concurrent/replay/upgrade/rollback. Existing T&M invoice-action API acceptance, typecheck, lint (537 modules) and full aggregate unit/contract suite pass.
- Independent source review found no concrete bypass. Its historical-line and template/owner coverage gaps were addressed with passing tests. The extended milestone React/API/PostgreSQL journey proves retained notice reads after line reservation and cancellation; the existing T&M configuration/lost-response/inbox browser journey also passes.
- Production build and signed enterprise identity/startup checks pass on the migrated disposable database. Dependency audit reports zero vulnerabilities; no dependency change. The inherited large-bundle warning remains. The first milestone browser run timed out during cold Vite navigation; the passing rerun uses bounded DOM-ready navigation and retains every interaction/state assertion.
- Broader affected PostgreSQL acceptance is running. Exact-head hosted CI, integration and release acceptance remain outstanding; no completion is inferred from the targeted checks.
