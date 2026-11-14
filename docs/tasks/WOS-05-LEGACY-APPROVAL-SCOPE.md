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
