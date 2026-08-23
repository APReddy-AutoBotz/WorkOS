# ADR-006 — Feature Flags and Evidence-Based Release Gates

**Status:** Accepted  
**Date:** 2026-08-22

## Context

Modules may be engineering-ready before a buyer supplies identity, data, provider credentials or policy sign-off. Treating code completion as production acceptance either hides blockers or unnecessarily labels completed work unfinished.

## Decision

Use environment-aware feature configuration plus separate release-gate status. Enabling a module records owner, evidence, activation time and environment. Engineering readiness and buyer/environment acceptance are tracked independently.

## Alternatives considered

1. Ship every merged module enabled — rejected because dependencies may be unsafe or absent.
2. Hide incomplete modules only in navigation — rejected because APIs and jobs would remain exposed.
3. Long-lived code branches per buyer — rejected because it fragments the product.

## Consequences

- Flags guard UI, API and jobs consistently.
- Gates require tests, migrations, role UAT and operations evidence.
- Configuration cannot bypass protected security or migration requirements.
- Removal of a flag occurs only after broad acceptance and migration planning.

## Verification and rollback

Tests prove disabled modules fail closed and enabled modules require authority. Rollback disables the module or redeploys the prior release without deleting accepted data.