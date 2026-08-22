# ADR-005 — Server-Authoritative Policy and Calculations

**Status:** Accepted  
**Date:** 2026-08-22

## Context

Client-side permission checks and financial previews are useful for UX but can be manipulated. Approval, period-lock and commercial results affect audit, invoicing and buyer trust.

## Decision

The server is authoritative for authentication/session context, active role, permission/data scope, state transitions, period locks, rate resolution, currency/rounding, revenue/cost/margin and audit identity. Frontend calculations are labelled previews and are never accepted as final amounts or authority.

## Alternatives considered

1. Client-authoritative calculations — rejected as insecure and difficult to reconcile.
2. Duplicate independent client/server engines — rejected because drift is likely.
3. Database-only business logic — rejected as the sole design because it obscures application policy, although constraints remain important.

## Consequences

- Calculation services expose explicit inputs, versions and snapshots.
- API tests and golden vectors become release gates.
- UI can explain server results without recreating hidden policy.
- AI may summarize or suggest but cannot finalize finance or approvals.

## Verification and rollback

Negative API tests prove client-supplied scope, role, rate, amount and status are ignored/rejected. Rollback restores prior service version and preserves immutable snapshots.