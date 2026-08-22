# ADR-003 — Modular Monolith

**Status:** Accepted  
**Date:** 2026-08-22

## Context

The inherited application is compact enough for one deployable system but contains large shared files. Commercial expansion needs explicit boundaries without introducing distributed transactions, service discovery and independent operations for a small buyer team.

## Decision

Use a modular monolith with domain modules for identity/access, organization, workforce, clients/contracts, engagements, planning, work capture, approvals, commercial finance, invoice readiness, reporting, integrations, audit and platform operations. A job process may share the codebase/image while using a separate command.

## Alternatives considered

1. Preserve page/table-oriented structure — rejected because it increases coupling.
2. Microservices — rejected for v1 because operational complexity exceeds demonstrated need.
3. Big-bang rewrite — rejected because it raises regression and migration risk.

## Consequences

- Module boundaries are enforced through services/contracts and tests.
- Extraction is incremental and tied to real outcomes.
- One release artifact simplifies buyer deployment.
- Internal coupling is reviewed as part of each PR.

## Verification and rollback

WOS-03 establishes module conventions, compatibility adapters and architecture tests. A module extraction can roll back without changing external behavior; microservices require a separate accepted ADR.