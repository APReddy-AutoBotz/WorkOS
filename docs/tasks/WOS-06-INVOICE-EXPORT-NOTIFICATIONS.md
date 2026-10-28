# Invoice export notification integration — bounded continuation

## Requirement and dependency

WOS-INT-002 and the canonical matrix require one `invoice_batch.exported_or_billed_confirmed` INFORMATIONAL event for an accepted CSV export, and `invoice_batch.export_failed` OPERATIONAL_CRITICAL for a recorded generation failure. WOS-INT-003/005 require stable operation identity and isolation of optional delivery failures; WOS-INV-006/007 retain exact exported artifact and occupancy. The test matrix in `docs/04-quality/TEST_STRATEGY.md` requires the owner/finance recipient relationships, integration administrator and configured alert route, preference behavior, and no duplicate event on retrieval or replay.

This local development branch starts at the unpublished CSV candidate 28559436738a0753630688aadaf5cfad1b6d2f36/tree f5e9905110208dd56a0af5340d0c885e49377764. That candidate's local gates are still in progress and PR107's hosted gate remains pending. This branch is not integration or release acceptance.

## Boundary and explicit configuration

The batch owner comes from the retained scoped batch. Finance/billing owner, integration administrator, approved versioned templates, locale and operational alert-route target must be selected explicitly in a prospective scoped configuration; do not infer that the finance preparer or caller holds any of those relationships. Configuration uses an explicit opt-in management capability with no role or user grants. Validate named users, currently held roles and scope before activation and again for delivery. No default recipients, templates, routing, external delivery, schedules, real grants or provider credentials are created.

Produce a single stable canonical event for each accepted artifact or recorded failure, with source/version, triggering operation, complete recipient reasons, selected template version, locale, policy class and sanitized variables. Replays and artifact retrieval do not make another event. INFORMATIONAL delivery honors preferences; OPERATIONAL_CRITICAL required in-app and configured alert-route work cannot be opted out. The configured route may be represented as pending outbox evidence for a separately authorized adapter; this slice makes no claim that an external alert was delivered. Never treat a user-selected arbitrary address as authority.

Core artifact acceptance and recorded failure must not be silently undone by optional delivery failure. Persist sufficient transactional event/outbox or explicit failure evidence to retry the same event without duplicating the artifact, notification, recipient or delivery attempt. Preserve immutable receipt, role/scope fences, failure evidence, permanent occupancy and all protected state transitions.

## Acceptance before publication

On a frozen combined source, exercise the real React/API/PostgreSQL configured workflow, explicit named source relationships and versioned templates, saved in-app notification/read evidence, required alert-route outbox identity and preference decisions, account/scope loss and missing relationship, atomic event/outbox persistence, optional failure isolation, generation failure, repeat and concurrent retries, no duplicate on artifact retrieval, no uncontrolled recipients, unchanged no-grant upgrade/replay and no external delivery. Verify prior CSV/approval regressions in an independent clean checkout and unchanged hosted CI. Report actual pending alert delivery and do not conflate it with a successful external dispatch. Publish only after PR107 and the precise CSV base have their own required acceptance and dependency reconciliation; no merge/deploy or review claim.
