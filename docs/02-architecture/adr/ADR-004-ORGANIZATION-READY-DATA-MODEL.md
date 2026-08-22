# ADR-004 — Organization-Ready Data Model

**Status:** Accepted  
**Date:** 2026-08-22

## Context

One buyer may contain several legal entities, business units and operating structures. Global identifiers and hardcoded regional ownership would prevent reuse and create unsafe future migrations.

## Decision

Add an organization root and legal-entity boundaries. Primary domain roots carry `organization_id` where applicable; contracting/currency/reporting records carry `legal_entity_id` when required. Business uniqueness and data scope are owner-scoped, and imported existing data migrates to one controlled default organization.

## Alternatives considered

1. Rely only on deployment isolation — rejected because it cannot represent multiple legal entities/structures safely.
2. Full shared-tenant schema/control plane — deferred and unnecessary for v1.
3. Add ownership later — rejected because retrofitting after commercial data exists is high risk.

## Consequences

- Every new query and command must establish ownership from authenticated context and relationships.
- Migration/backfill and negative cross-scope tests are mandatory.
- User-facing hierarchy labels remain configurable while canonical keys remain stable.

## Verification and rollback

WOS-02 proves fresh installation, default-organization migration and cross-organization denial. Rollback is permitted only before buyer data uses new ownership; otherwise use a forward migration.