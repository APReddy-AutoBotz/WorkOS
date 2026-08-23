# ADR-002 — Isolated Buyer Deployment

**Status:** Accepted  
**Date:** 2026-08-22

## Context

Target buyers prefer ownership, strong data isolation and deployability without dependence on a shared vendor control plane. Building shared multi-tenant SaaS operations would add billing, tenant lifecycle and cross-tenant risk not required for v1.

## Decision

WorkOS v1 runs as one isolated application and PostgreSQL database per buyer. Buyer-owned secrets, identity and operational services are configured per environment. The data model still carries organization/legal-entity ownership where domain-correct.

## Alternatives considered

1. Shared multi-tenant SaaS — deferred due to higher security and operational complexity.
2. One deployment per legal entity — rejected as unnecessarily fragmented for buyers with multiple legal entities.
3. Desktop/local-only product — rejected because enterprise identity, operations and shared access require managed deployment.

## Consequences

- Strong isolation and simpler backup, export and IP handover.
- Upgrades must be reproducible across independent installations.
- A future SaaS control plane remains possible but is not assumed.
- Cross-organization negative tests remain required because a buyer may contain multiple organizations/legal entities.

## Verification and rollback

Deployment and migration tests prove one isolated environment. A later shared-tenancy proposal requires a new ADR, threat model and migration plan.