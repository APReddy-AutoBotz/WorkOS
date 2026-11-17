# Scoped and sanitized notification diagnostics

Requirements: WOS-IAM-005/010, WOS-CORE-003, WOS-INT-002/004, WOS-NFR-SEC-004/008/013 and WOS-NFR-PRV-001.

## Boundary

Based on accepted PR169/main `88262c87a260529c00a680b22d2f021ff7d8cba4`. Actual API reproduction returned foreign-organization, other-entity and orphan delivery attempts to a current-entity administrator. The reader must join attempts through notification recipient ownership and apply the existing authoritative employee-scope predicate before sorting and the 300-row limit. Missing recipient ownership fails closed; no deployment-wide diagnostic permission is inferred.

Raw provider payloads also reached attempt metadata, notification integration history/health and notification audit delivery results. A shared allowlist retains typed provider mode, deterministic flag and valid HTTP status codes; failure uses NOTIFICATION_DELIVERY_FAILED. New notification writes and historical notification-specific projections must apply the same safe boundary. Unrelated integration/audit semantics and legitimate notification content remain unchanged. Historical records are projected safely without destructive rewriting.

## Acceptance plan and current evidence

Locked installation passed (338 packages, 345 audited, zero vulnerabilities). The local PostgreSQL cluster was confirmed stopped after environment resumption and restarted; connection refusal before restart is not passing evidence. Original API regression then failed with foreign, other-entity and orphan records in the response. The corrected real API passes active-entity, authorized scope switching, Employee own-worker and TeamLead direct-report scope, relationship removal, unauthenticated and permission-loss denial. More than 300 newer foreign attempts prove scope filtering precedes the limit.

Focused tests cover malformed diagnostic values, historical metadata copies, safe failure codes, unchanged historical data and unaffected unrelated integration payloads. Actual legacy/versioned integration and audit readers plus integration health reject synthetic private diagnostic sentinels. Real successful in-app and deterministic unsupported-email-provider outcomes retain Delivered/Failed status and persist safe diagnostics across attempts, integration events and audit. No live external delivery is used.

The real NotificationCenter/API/PostgreSQL browser passed selected-entity display, redacted network payload and authorized scope reload checks. Fresh candidate review found no concrete bypass or regression. The bootstrap scan identified two synthetic diagnostic sentinels as credential assignments; these now use explicit placeholder values without weakening the scanner. The migration integration test expected provider-specific activity metadata that the new allowlist intentionally excludes; its assertion now enforces the narrower contract.

Required remaining gates: immutable-head independent review; type/lint/aggregate, fresh/upgrade migrations, production build/identity/startup, configured scans and exact-head hosted acceptance. Record exact results in the PR before merge. No default grants, dependencies or migrations are changed.

## Operations and rollback

Use channel, provider, delivery status, timestamp and safe diagnostic code/status to investigate failures. Raw provider responses, recipient addresses and arbitrary nested metadata are not an API contract. Historical orphan attempts remain stored but cannot establish scoped ownership. This does not introduce deployment-wide access, external retry redesign, or full notification/release acceptance. Prefer forward fixes: older code reopens disclosure while historical raw evidence remains stored. Preserve audit and delivery history. No production deployment is included.

## PR170 acceptance blocked by upstream dependency advisory — 2026-11-17

Notification diagnostics runtime candidate `5ddb26a15970e34af1e2dbdb198ce21397d5ad9c` passed local typecheck, lint (266 modules), full aggregate, real PostgreSQL/API and NotificationCenter browser checks, 56 migration entries, production build/signed-identity/startup and bootstrap/adversarial scans. Independent immutable-head review `7484bf28-df01-47c9-bfe2-facc801e28d2` covered all 23 paths with zero findings.

[PR170 CI44132858216](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/44132858216) passed all preceding application/API/browser/production-identity/migration steps, then failed the full dependency audit. `GHSA-fc5q-39xc-vjpf` flags repeated-extglob ReDoS in picomatch through the latest published version 4.0.7, propagating through fdir/tinyglobby/Vite. The subsequent Compose/container checks were skipped, so this run is not acceptance. The full-history secret scan passed. A fresh production-only audit reported zero vulnerabilities; that does not waive the full audit gate.

The npm-suggested Vite 6.2.7 downgrade was evaluated in an isolated temporary manifest and itself reports high-severity vulnerabilities, including file-read/path-traversal and editor-command issues. It was not adopted. No dependency changes, suppression, audit threshold reduction or production deployment were made. Keep PR170 unmerged until a safe remediation passes the complete checks. The earlier zero-vulnerability installation result is historical evidence only and is superseded by the fresh audit. Continue independent security work, beginning with investigation of retained legacy approval/delegation ownership and selected-entity scope; do not import the dependent commercial stack wholesale.

