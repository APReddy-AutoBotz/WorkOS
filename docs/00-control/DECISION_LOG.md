# WorkOS Decision Log

**Purpose:** Record material product, architecture, delivery and commercial-scope decisions.  
**Decision statuses:** Proposed, Accepted, Superseded, Rejected, Deferred

## 1. Accepted blueprint decisions

| ID | Date | Decision | Status | Authority / follow-up |
|---|---|---|---|---|
| WOS-DEC-001 | 2026-08-22 | Create a new private `WorkOS` repository and leave `Boundaryless-WorkOS` unchanged | Accepted | ADR-001 |
| WOS-DEC-002 | 2026-08-22 | Reuse an authorized clean snapshot of the existing code rather than rebuild from scratch | Accepted | `PROVENANCE.md`, PR-002 |
| WOS-DEC-003 | 2026-08-22 | Pin the reference source baseline to commit `f2de1d85126f5d64f0e2e21b085b0303ca1d8417` | Accepted | `PROVENANCE.md` |
| WOS-DEC-004 | 2026-08-22 | Do not import the reference Git history into the commercial repository | Accepted | ADR-001 |
| WOS-DEC-005 | 2026-08-22 | Use `WorkOS` only as a temporary working name and make runtime branding configurable | Accepted | Product owner; final commercial name deferred |
| WOS-DEC-006 | 2026-08-22 | Target project-based professional-service organizations, initially about 25–500 users | Accepted | Programme charter |
| WOS-DEC-007 | 2026-08-22 | Position the product around workforce, engagements, work evidence, utilization, revenue and margin | Accepted | Product requirements |
| WOS-DEC-008 | 2026-08-22 | Deliver one isolated application and database per buyer for v1 | Accepted | ADR-002 |
| WOS-DEC-009 | 2026-08-22 | Add organization/legal-entity-ready ownership boundaries even though v1 is isolated | Accepted | ADR-004 |
| WOS-DEC-010 | 2026-08-22 | Use a modular monolith and incremental extraction, not a big-bang microservice rewrite | Accepted | ADR-003 |
| WOS-DEC-011 | 2026-08-22 | Keep PostgreSQL as the v1 system of record | Accepted | Architecture overview |
| WOS-DEC-012 | 2026-08-22 | Make authorization, approval policy, period locks and commercial calculations server authoritative | Accepted | ADR-005 |
| WOS-DEC-013 | 2026-08-22 | Preserve historical financial truth through effective-dated terms and immutable/versioned snapshots | Accepted | Product requirements and architecture |
| WOS-DEC-014 | 2026-08-22 | Support T&M, fixed fee, milestone, retainer, managed service, internal and pre-sales engagement models | Accepted | WOS-ENG requirements |
| WOS-DEC-015 | 2026-08-22 | Build invoice readiness and exports, but not statutory invoicing or general-ledger posting in v1 | Accepted | V1 scope; sales positioning constraint |
| WOS-DEC-016 | 2026-08-22 | Defer payroll, full CRM, native mobile, client portal, expense management, shared SaaS and advanced AI from v1 | Accepted | Programme charter |
| WOS-DEC-017 | 2026-08-22 | Use versioned feature flags plus evidence-based release gates | Accepted | ADR-006 |
| WOS-DEC-018 | 2026-08-22 | Require configured OIDC, named production accounts and revocable sessions for every production deployment; missing, invalid or unavailable required OIDC fails closed, and WorkOS local credentials/shared demo identities are restricted to approved non-production/demo profiles with no production fallback | Accepted | ADR-007; WOS-IAM-001–002; WOS-NFR-SEC-001–003 |
| WOS-DEC-019 | 2026-08-22 | Use controlled versioned migrations with fresh-install and upgrade evidence | Accepted | ADR-008 |
| WOS-DEC-020 | 2026-08-22 | Use GitHub as the authoritative implementation/release record and Codex as a bounded implementation agent | Accepted | Codex execution playbook |
| WOS-DEC-021 | 2026-08-22 | Prefer appropriate Sol models in Codex, using the strongest reasoning option for architecture/security/migrations/financial work | Accepted execution policy | AGENTS and execution playbook |
| WOS-DEC-022 | 2026-08-22 | Keep transaction-specific pricing, valuation, licensing, assignment and negotiation strategy outside the product repository | Accepted | Provenance/risk controls |
| WOS-DEC-023 | 2026-08-22 | Treat operational earned-management revenue as a non-statutory management metric; non-T&M calculation fails closed until an authorized effective-dated policy is selected, independently of billing eligibility | Accepted | WOS-COM-011 and commercial specification |

## 2. Deferred owner decisions

| ID | Decision required | Required by | Default until decided |
|---|---|---|---|
| WOS-DEC-P01 | Final commercial product name, trademark and domain | Before commercial launch/material branding investment | Continue using configurable temporary name `WorkOS` |
| WOS-DEC-P02 | Transaction-specific licensing, assignment, ownership and commercialization terms | Before proposal/contract | No product-repository default; decide through external legal/commercial approval |
| WOS-DEC-P03 | Exact legal form and wording of commercialization permission | Before external licensing/assignment | Product build may proceed; external sale remains gated |
| WOS-DEC-P04 | Buyer-specific availability, RPO/RTO and support SLA | Buyer contract/deployment | Use Standard-profile targets in NFRs |
| WOS-DEC-P05 | Final production hosting reference architectures to support commercially | Before v0.9.0 | Provide portable container/PostgreSQL baseline and at least one tested cloud path |
| WOS-DEC-P06 | First buyer's approval and operational earned-management policy choices | Commercial-engine UAT | Billing eligibility remains independent; non-T&M earned-management calculation stays disabled until an authorized effective-dated policy is configured |

## 3. Decision procedure

A new material decision must record:

- Context and problem.
- Options considered.
- Decision and rationale.
- Consequences and risks.
- Requirements/work packages affected.
- Owner/controller approval where required.
- ADR link for architecture decisions.

Routine code-level choices that do not alter product behavior, risk or architecture need not be added to this log.

## 4. Superseding decisions

A decision is never silently overwritten. When changed:

1. Mark the earlier decision `Superseded`.
2. Add the new decision and date.
3. Link the relevant ADR/PR.
4. Identify migration, compatibility and buyer impact.
