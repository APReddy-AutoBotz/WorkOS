# WorkOS Feature Catalog

This catalog groups product behavior without replacing the authoritative definitions in `docs/00-control/PRODUCT_REQUIREMENTS.md`.

| Feature domain | Primary requirements | v1 outcome |
|---|---|---|
| Platform principles | WOS-CORE-001 through WOS-CORE-008 | Configuration-driven, isolated, server-authoritative and deterministic foundation |
| Organization and setup | WOS-ORG-001 through WOS-ORG-010 | Legal entities, structure, brand, terminology, calendars, periods and guided setup |
| Identity and access | WOS-IAM-001 through WOS-IAM-010 | Named identities, active roles, permissions, scope, sessions and negative evidence |
| Workforce and availability | WOS-WKF-001 through WOS-WKF-008 | Worker master, capacity, skills, availability, lifecycle and self-service |
| Clients and contracts | WOS-CLI-001 through WOS-CLI-002; WOS-CTR-001 through WOS-CTR-003 | Client hierarchy, contracts/SOWs, POs and versioned terms |
| Engagements | WOS-ENG-001 through WOS-ENG-005 | T&M, fixed fee, milestone, retainer, managed service and internal work |
| Resource planning | WOS-RES-001 through WOS-RES-009 | Demand, assignments, utilization, bench, overload and history |
| Work capture | WOS-TIM-001 through WOS-TIM-012 | Daily/weekly evidence, categories, limits, states, correction and imports |
| Approval and period policy | WOS-APR-001 through WOS-APR-008 | Routing, stages, delegation, SLA, bulk decisions and locks |
| Commercial controls | WOS-COM-001 through WOS-COM-015 | Rates, costs, budgets, POs, multi-model calculations, snapshots and EAC |
| Invoice readiness | WOS-INV-001 through WOS-INV-008 | Approved-unbilled, traceable batches, adjustments, evidence and no double billing |
| Reporting and controls | WOS-RPT-001 through WOS-RPT-007 | Operational/commercial reports, leakage, data quality, exports and reconciliation |
| Integrations and notifications | WOS-INT-001 through WOS-INT-006 | Provider adapters, notifications, idempotency, health and finance export contracts |
| Governance and audit | WOS-GOV-001 through WOS-GOV-005 | Append-only audit, coverage, retention, provenance and release traceability |
| Operations and deployment | WOS-OPS-001 through WOS-OPS-010 | Reproducible deployment, validation, migration, health, recovery and handover |

## Cross-feature controls

Every feature must define organization ownership, permission/data scope, audit, effective dates where applicable, positive and negative tests, migration behavior and rollback/roll-forward considerations.

## Product boundary

Invoice readiness prepares controlled data and evidence for downstream billing/accounting. It does not make WorkOS a statutory invoice issuer or general ledger.