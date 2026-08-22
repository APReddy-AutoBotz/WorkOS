# WorkOS Release Acceptance Criteria

## Two-axis acceptance

A capability has separate statuses:

1. **Engineering readiness** — code, schema, tests, documentation and product-owned evidence are complete.
2. **Environment/buyer acceptance** — buyer configuration, credentials, data reconciliation, role UAT, operations ownership and formal sign-off are complete.

Neither axis may be hidden or substituted for the other.

## Pull-request acceptance

A PR may merge only when:

- Scope and requirement IDs are clear.
- Actual diff matches the approved outcome and exclusions.
- Architecture/security/migration impacts are reviewed.
- Applicable tests pass at the exact head.
- New behavior includes positive and negative cases.
- Traceability, status, changelog and operational documentation are updated.
- No unresolved blocking review thread or failing required check remains.
- Rollback/roll-forward and known limitations are documented.

## Release-candidate acceptance

The candidate must have:

- Locked reproducible build and immutable version metadata.
- Full exact-head CI matrix.
- Fresh installation and supported upgrade evidence.
- Production-mode startup and fail-closed configuration tests.
- Multi-role production-like browser journeys.
- Authorization/data-scope negative matrix.
- Commercial golden vectors and control-total reconciliation.
- Threat/security review and finding disposition.
- Standard-profile performance evidence.
- Backup/restore rehearsal and monitoring evidence.
- No prohibited branding, data or credentials.
- Complete known-limitations and migration/rollback notes.

## Buyer/environment acceptance

The buyer or deployment owner confirms:

- Hosting, database, domain/TLS and secret ownership.
- Identity provider, named users, roles and access review.
- Imported data and report/commercial reconciliation.
- Calendars, periods, terminology and policies.
- Provider credentials and delivery tests.
- Backup frequency, retention, restore owner and recovery target.
- Monitoring, alerts, support and incident ownership.
- Security/privacy/retention decisions.
- Role UAT and final business acceptance.

## Release blockers

- Failed or not-run mandatory exact-head check.
- Unresolved high/critical security issue.
- Destructive/unreconciled migration.
- Authorization or cost/margin leakage.
- Financial golden-vector or reconciliation difference.
- Direct raw-source/snapshot-to-invoice-line bypass or incomplete event/register lineage.
- Ambiguous or untested invoice-batch occupancy/release semantics.
- Production demo fallback/shared credentials.
- Missing rollback/recovery path for high-risk change.
- Incomplete provenance or prohibited source/data.

## Approval gates

- **Gate B:** blueprint approval before source bootstrap.
- **Gate C:** complete WOS-06 commercial-engine acceptance only after PR-010, PR-011 and PR-012 are merged and exact-head evidence proves effective-dated terms, deterministic calculations, source-specific billing eligibility, approved-unbilled registration, invoice-ready batch states, export lineage, reversals/corrections, authorization and control-total reconciliation. PR-011 alone cannot satisfy Gate C.
- **Gate D:** final v1 release and buyer-handover approval.

Acceptance is recorded against a commit/tag and artifact; later changes require renewed evidence.