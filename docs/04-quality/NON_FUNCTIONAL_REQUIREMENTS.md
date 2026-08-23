# WorkOS Non-Functional Requirements

**Status:** Mandatory quality baseline for WorkOS v1  
**Applicability:** Product code, deployment package, integrations, documentation and release evidence

A requirement is not satisfied solely because the design intends to meet it. Acceptance requires measurable evidence in the applicable release environment.

## 1. Quality profiles

WorkOS v1 targets a buyer-owned deployment for approximately 25–500 active users. Two operating profiles may be used during acceptance:

| Profile | Purpose | Indicative scale |
|---|---|---|
| Standard | Small and mid-sized professional-services buyer | Up to 250 active users, 75 concurrent sessions |
| Expanded | Larger initial buyer or growth profile | Up to 500 active users, 150 concurrent sessions |

Profiles guide test fixtures and deployment sizing; they are not licensing limits.

## 2. Security

### WOS-NFR-SEC-001 — Fail-closed production mode

Production startup and readiness must fail when required database, session, OIDC identity or other mandatory secure configuration is missing, invalid or unsafe. Unavailable required production OIDC must keep authentication and readiness fail-closed. Production must not silently fall back to WorkOS local authentication, browser-local storage, seeded/shared demo identities or demo data.

### WOS-NFR-SEC-002 — Authentication

Every production deployment must use named accounts and configured OIDC. WorkOS local credentials and shared/demo identities may be enabled only in approved non-production/demo profiles; they must be disabled or absent in production and cannot be activated as a production fallback. Where local credentials are permitted in a non-production/demo profile, they must use modern password hashing, configurable password policy, secure reset handling and brute-force protection.

### WOS-NFR-SEC-003 — Session protection

Sessions must be time limited, revocable, securely transported, protected through appropriate cookie/token controls and invalidated for disabled users or removed roles.

### WOS-NFR-SEC-004 — Authorization depth

Every protected capability must enforce permission and row/data scope on the server. High-risk modules must include negative tests for unauthorized roles, out-of-scope entities and cross-organization/legal-entity attempts.

### WOS-NFR-SEC-005 — Least privilege

Cost, margin, security administration, audit administration, permission management and integration configuration must be separable from ordinary operational access.

### WOS-NFR-SEC-006 — Secret management

No runtime secret may be committed to source, image layers, generated documentation, test output or logs. Example configuration must contain placeholders only.

### WOS-NFR-SEC-007 — Transport security

Production deployments must use HTTPS/TLS. Secure cookies and redirect/callback URLs must reflect the configured trusted application URL.

### WOS-NFR-SEC-008 — Input and output safety

All external inputs must be schema validated. Database access must use parameterized operations. User-provided content rendered in the browser must be safely encoded or sanitized according to context.

### WOS-NFR-SEC-009 — CSRF, CORS and headers

Production must have an explicit CSRF posture appropriate to the session design, an allowlisted CORS policy and security headers including content-type protection, frame controls and a documented content-security policy.

### WOS-NFR-SEC-010 — File safety

When file upload is enabled, the product must enforce configured size/type limits, safe file naming, authorization, storage isolation and malware-scanning integration capability.

### WOS-NFR-SEC-011 — Dependency and secret scanning

CI must include dependency vulnerability and secret scanning. Critical/high findings require disposition before release according to the security policy.

### WOS-NFR-SEC-012 — Audit integrity

Normal application roles must not update or delete audit events. Emergency remediation must be separately controlled and create independent evidence.

### WOS-NFR-SEC-013 — Sensitive logging

Logs and error responses must not expose passwords, tokens, private keys, full connection strings or unrestricted confidential cost/personnel data.

### WOS-NFR-SEC-014 — Threat model

Identity, authorization, work approval, financial calculations, invoice readiness, imports/exports and integrations must be covered by a maintained threat model before v1 release.

## 3. Privacy and data governance

### WOS-NFR-PRV-001 — Data minimization

The product must collect only fields required by configured features and must allow optional sensitive fields to remain disabled or empty.

### WOS-NFR-PRV-002 — Purpose-based access

Personal and commercial information must be exposed only to roles and scopes that require it for an approved product job.

### WOS-NFR-PRV-003 — Retention

The buyer must be able to configure or document retention for work records, audit, integration events, notifications and generated exports.

### WOS-NFR-PRV-004 — Subject lifecycle support

Worker exit, account disablement and configured anonymization/retention actions must not destroy legally or financially required operational history.

### WOS-NFR-PRV-005 — Export control

Personal and financial exports must be permission controlled, auditable and identify the exporter, filters, scope and timestamp.

### WOS-NFR-PRV-006 — Non-production data

Repository seeds and automated tests must use synthetic data. Production data must not be copied to development/demo without an approved masking process.

## 4. Availability, resilience and recovery

### WOS-NFR-REL-001 — Service target

The product and standard deployment guidance must support a monthly availability design target of at least 99.5 percent, excluding approved maintenance and dependencies outside the deployment boundary.

### WOS-NFR-REL-002 — Health distinction

The application must distinguish liveness from readiness. A process may be live while unready due to database, migration or required identity configuration state.

### WOS-NFR-REL-003 — Transaction integrity

Multi-record business operations such as approval decisions, finalization and invoice-ready inclusion must be atomic where partial completion would violate business integrity.

### WOS-NFR-REL-004 — External failure isolation

Notification or external-provider failure must be recorded and retryable without silently corrupting or duplicating the core business transaction.

### WOS-NFR-REL-005 — Idempotency

Imports, integration events, finalization jobs and invoice-ready operations must prevent duplicate processing through source identifiers, idempotency keys or deterministic constraints.

### WOS-NFR-REL-006 — Backup

The deployment package must define database backup procedures and optional object-storage backup. Backup ownership and retention must be buyer controlled.

### WOS-NFR-REL-007 — Recovery objectives

The standard deployment profile must document and be capable of a target RPO no worse than 24 hours and target RTO no worse than 8 hours. More stringent buyer targets require corresponding managed-database and operational configuration.

### WOS-NFR-REL-008 — Restore evidence

A production-like restore rehearsal must be completed before v1 acceptance and after material storage/migration changes.

### WOS-NFR-REL-009 — Graceful shutdown

The application and job runner must stop accepting new work, complete or safely release active operations and close database connections during managed shutdown.

## 5. Performance and scalability

### WOS-NFR-PERF-001 — Common interactive response

Under the Standard profile and representative data, 95 percent of common authenticated read requests should complete within 2 seconds at the API boundary, excluding external-provider latency.

### WOS-NFR-PERF-002 — Common mutations

Under the Standard profile, 95 percent of ordinary create/update/submit/approve operations should complete within 3 seconds, excluding intentionally asynchronous jobs.

### WOS-NFR-PERF-003 — Dashboard/report response

Operational dashboards and ordinary scoped reports should return initial results within 5 seconds under representative Standard-profile data. Large exports may run asynchronously.

### WOS-NFR-PERF-004 — Browser usability

Primary authenticated pages should become usable within 3 seconds on a representative business laptop and stable broadband connection after the application shell is cached, subject to deployment geography.

### WOS-NFR-PERF-005 — Pagination

Production list endpoints must paginate or otherwise bound result sizes. The UI must not require downloading entire high-growth tables for client-side filtering.

### WOS-NFR-PERF-006 — Export isolation

Large exports and recalculation jobs must not block common interactive requests and should provide progress/status when asynchronous.

### WOS-NFR-PERF-007 — Database efficiency

High-volume access paths must have reviewed indexes and query plans using representative fixtures. N+1 query patterns on primary workspaces are prohibited.

### WOS-NFR-PERF-008 — Scale evidence

Before v1 release, performance tests must cover at least the Standard profile with representative workers, clients, projects, assignments, work entries, audit events and commercial lines.

## 6. Data integrity and financial accuracy

### WOS-NFR-DAT-001 — Referential integrity

Primary domain relationships must be enforced through database constraints where practical. Lifecycle actions must be dependency aware.

### WOS-NFR-DAT-002 — Decimal safety

Money, rates, quantities requiring financial precision and exchange rates must use explicit decimal/numeric representation. Binary floating point must not be the authoritative persisted amount type.

### WOS-NFR-DAT-003 — Rounding

Currency precision and rounding stage/mode must be centrally defined and covered by test vectors.

### WOS-NFR-DAT-004 — Historical truth

Approved work and commercial snapshots must retain the exact terms and calculation version used. Later rate or cost changes must not mutate historical results.

### WOS-NFR-DAT-005 — Concurrency

High-risk master and commercial updates must detect lost-update/concurrent-edit conditions through record versions, timestamps or equivalent controls.

### WOS-NFR-DAT-006 — Period integrity

Locked periods must reject unauthorized changes from all write paths, including imports and integrations.

### WOS-NFR-DAT-007 — Reconciliation

Revenue, cost, margin and invoice-ready reports must reconcile to authoritative snapshots and source-line control totals.

### WOS-NFR-DAT-008 — Time zones and dates

Business dates must be stored and interpreted consistently. Instants must use UTC storage. User-facing dates/times must use the configured organization/user time zone as appropriate.

## 7. Maintainability and architecture

### WOS-NFR-MNT-001 — Modular boundaries

New implementation must follow approved domain modules. Cross-module access must use documented services/contracts rather than uncontrolled table/UI coupling.

### WOS-NFR-MNT-002 — No unbounded central files

No new feature should materially expand an already oversized central server, API client or UI file without an extraction plan. Work packages must improve seams as they touch affected areas.

### WOS-NFR-MNT-003 — Type and schema safety

Public module and API boundaries must use explicit types and runtime validation where data enters the trust boundary.

### WOS-NFR-MNT-004 — Documentation with change

Material behavior, configuration, migration, operational or integration changes must update the relevant governing and user/operations documentation in the same PR.

### WOS-NFR-MNT-005 — Automated tests

New business rules require automated tests. Bug fixes require a regression test unless technically impossible and explicitly approved.

### WOS-NFR-MNT-006 — Code reviewability

A PR must be bounded to one outcome, identify migration/rollback implications and avoid generated or formatting noise unrelated to the objective.

### WOS-NFR-MNT-007 — Dependency discipline

New dependencies require justification, active maintenance assessment, compatible licensing and security consideration. Duplicative libraries should not be added for convenience.

### WOS-NFR-MNT-008 — Versioned contracts

External and downstream API/export contracts must be versioned and changed compatibly or with explicit migration notes.

## 8. Deployability and portability

### WOS-NFR-DPL-001 — Container build

The product must provide a production container build with pinned runtime major version and reproducible dependency installation from the lockfile.

### WOS-NFR-DPL-002 — Local production-like profile

A documented local/CI profile must run the application and PostgreSQL in production-like API mode without relying on browser-local fallback data.

### WOS-NFR-DPL-003 — Environment schema

Environment configuration must be validated at startup and documented by purpose, sensitivity, required/optional status and allowed values. Production OIDC configuration must be marked mandatory.

### WOS-NFR-DPL-004 — Controlled migrations

Migration execution must be an explicit release step/command. Fresh install and upgrade from the previous supported release must be automated.

### WOS-NFR-DPL-005 — Provider portability

Core operation must depend on standard PostgreSQL and documented external interfaces. Provider-specific conveniences must not prevent deployment on another compatible platform without product-code rewrite.

### WOS-NFR-DPL-006 — Build metadata

The running product must expose safe version, build and migration-level metadata for operations and support.

### WOS-NFR-DPL-007 — Rollback guidance

Every release with schema or configuration changes must document rollback limitations and safe recovery procedure.

## 9. Observability and supportability

### WOS-NFR-OBS-001 — Structured logging

The API and job runner must emit structured logs with timestamp, level, service, operation, correlation identifier and safe contextual identifiers.

### WOS-NFR-OBS-002 — Correlation

User requests, asynchronous jobs, integrations and commercial finalization must be traceable through correlation or operation IDs.

### WOS-NFR-OBS-003 — Operational metrics

The deployment must expose or derive health, error rate, latency, job backlog/failure and integration-failure signals.

### WOS-NFR-OBS-004 — Audit versus log distinction

Operational logs may be rotated; business audit records follow the configured audit-retention policy. One must not be treated as a substitute for the other.

### WOS-NFR-OBS-005 — Actionable errors

User-facing errors must identify the corrective action without exposing sensitive internals. Server logs must retain sufficient safe diagnostic context.

### WOS-NFR-OBS-006 — Runbooks

Release handover must include startup, migration, backup, restore, incident, credential rotation, monitoring and common-support runbooks.

## 10. Accessibility and usability

### WOS-NFR-UX-001 — Accessibility target

Primary WorkOS v1 user journeys should meet WCAG 2.1 AA intent, including keyboard access, focus visibility, labels, contrast and meaningful status/error announcements.

### WOS-NFR-UX-002 — Responsive business use

Primary workspaces must support common desktop and tablet widths. Mobile-native optimization is not a v1 requirement, but critical approvals and self-service pages must remain usable on a modern mobile browser.

### WOS-NFR-UX-003 — Configuration clarity

Administrative configuration must explain scope, dependencies, effective dates and consequences. Destructive or history-affecting operations require confirmation and reason where appropriate.

### WOS-NFR-UX-004 — Terminology consistency

Configured terminology must be applied consistently in navigation, forms, errors, reports and notifications. Mixed canonical/user-facing terms must not confuse the buyer.

### WOS-NFR-UX-005 — Empty and loading states

Primary pages must distinguish loading, empty, unavailable, unauthorized and error conditions.

### WOS-NFR-UX-006 — Bulk-operation safety

Bulk operations must preview scope/count, validate each selected record and provide a result summary with partial-failure detail when supported.

## 11. Compatibility and localization

### WOS-NFR-CMP-001 — Browser support

The product must support current stable versions of Chromium-based browsers and Microsoft Edge used by enterprise buyers. Additional browsers may be qualified later.

### WOS-NFR-CMP-002 — Locale-ready formatting

Dates, times, numbers and currencies must use configured locale/currency formatting and must not rely on hardcoded regional formats.

### WOS-NFR-CMP-003 — Time-zone behavior

Period cutoffs, deadlines and audit instants must have explicit organization/user time-zone behavior and tests around daylight-saving changes where applicable.

### WOS-NFR-CMP-004 — Character support

Names, labels and descriptive fields must support Unicode. Identifiers with stricter character rules must document and validate those rules.

## 12. Release and evidence

### WOS-NFR-RELSE-001 — CI gates

Required CI gates must run on every implementation PR and release candidate: locked install, build, type/lint, tests, migration validation and configured security scans.

### WOS-NFR-RELSE-002 — Exact-head evidence

Release and merge decisions must identify the exact commit tested and reviewed.

### WOS-NFR-RELSE-003 — Traceability

Accepted requirements must link to issue/work package, PR, tests and release evidence.

### WOS-NFR-RELSE-004 — Known limitations

Every release must state known limitations, deferred features and operational prerequisites.

### WOS-NFR-RELSE-005 — Buyer acceptance

WorkOS v1 acceptance requires production-like role UAT, migration evidence, backup/restore evidence, security review, commercial reconciliation and buyer-handover completeness.

## 13. Definition of NFR acceptance

An NFR is accepted only when the relevant release provides one or more of:

- Automated test output.
- Performance/load report.
- Security scan and disposition.
- Browser/accessibility evidence.
- Migration/restore rehearsal evidence.
- Configuration or operational verification.
- Reviewed architecture/code evidence where runtime proof is not yet applicable.

Unmeasured aspirations must remain marked as targets, not completed requirements.
