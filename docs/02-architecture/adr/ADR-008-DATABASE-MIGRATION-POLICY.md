# ADR-008 — Controlled Database Migration Policy

**Status:** Accepted  
**Date:** 2026-08-22

## Context

WorkOS will evolve an inherited schema into organization, engagement and commercial models. Buyer-owned deployments require predictable upgrades and must not depend on application startup performing opaque or destructive work.

## Decision

Use append-only, ordered, versioned migrations executed by an explicit release command/step with a migration ledger. Every release proves fresh installation and supported prior-version upgrade. Data conversions include validation, reconciliation and roll-forward/rollback guidance.

## Alternatives considered

1. Automatic startup migrations as the only mechanism — rejected because failure and recovery are hard to control.
2. Manual unversioned SQL — rejected because environments drift.
3. Recreate the database on upgrades — rejected because buyer history must be preserved.

## Consequences

- Migrations are code-reviewed and checksum/ledger controlled.
- Destructive changes use expand/migrate/contract or an approved conversion plan.
- Release artifacts declare required schema version.
- Backups and readiness gates precede production migration.

## Verification and rollback

CI runs fresh and upgrade paths with representative data and control totals. Prefer roll-forward after production migration; rollback requires an explicitly tested safe path and backup.