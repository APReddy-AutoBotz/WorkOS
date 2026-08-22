# Security, Privacy and Compliance Baseline

## Scope

This baseline defines product controls and buyer responsibilities for a buyer-owned WorkOS deployment. It does not claim certification or replace buyer legal, regulatory, infrastructure or penetration-testing obligations.

## Security objectives

- Prevent unauthorized cross-organization, cross-legal-entity and cross-relationship access.
- Protect identity, personal, contract, rate, cost, margin and billing data according to sensitivity.
- Preserve trustworthy approval, financial and audit evidence.
- Fail closed when production identity, secrets, database or required configuration is unsafe.
- Detect and investigate security-relevant activity without exposing sensitive payloads.

## Identity and authorization

Production uses named accounts and OIDC where configured. Sessions are time limited and revocable. Effective access combines identity, active role, permission, organization/legal entity, row/data scope and business state. Protected administration permissions cannot be removed from all administrators accidentally.

## Application security

- Server-side validation and parameterized data access.
- Explicit CSRF, CORS, cookie and security-header policy.
- Persistent production throttling and account lifecycle controls.
- Optimistic concurrency for high-risk changes.
- Idempotency for imports, integrations and finalization.
- Sensitive response/log filtering.
- Dependency, secret and source scans in CI.

## Data privacy

WorkOS minimizes collected data to operational need. Buyers define lawful basis, notices, retention and data-subject handling. Product controls support scoped access, export evidence, deactivation/anonymization hooks and retention configuration while preserving required audit/commercial history.

## Data classification and handling

- Personal data is available only to authorized roles and scoped operations.
- Cost rates and compensation-derived values receive the most restrictive business permissions.
- Secrets remain in buyer-owned secret stores and are never returned in normal APIs, logs or exports.
- Supporting files use optional controlled storage and access checks.
- Backups and exported files inherit the sensitivity of their contents.

## Audit and non-repudiation posture

Append-only application audit records capture actor, active role, source, entity, action, time, reason and material changes. Corrections create new evidence. High-risk exports, permission changes, commercial terms, snapshots and batch transitions are audited.

Audit is not a cryptographic legal-signature system unless a buyer adds such integration.

## Retention and deletion

Retention settings are documented and buyer-approved. Purge/anonymization must account for legal holds, audit, contract, invoice-readiness and financial evidence. Destructive maintenance requires protected authority and a recorded operation.

## Threat review themes

- Broken object-level authorization and aggregate/report leakage.
- Active-role or delegation bypass.
- Rate/cost/margin disclosure.
- Timesheet, approval, period or batch state tampering.
- Duplicate import/export/retry effects.
- Historical snapshot mutation.
- Credential/session compromise.
- Malicious files, formula injection and export leakage.
- Log/backup exposure and unsafe restore.

## Release evidence

Before v1 release: threat model, negative authorization suite, secret/dependency scan, vulnerability findings/disposition, production identity/session checks, sensitive logging review, backup/restore evidence and buyer security checklist.