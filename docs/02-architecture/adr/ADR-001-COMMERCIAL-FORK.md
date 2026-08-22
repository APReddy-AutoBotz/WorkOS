# ADR-001 — Clean Commercial Fork

**Status:** Accepted  
**Date:** 2026-08-22

## Context

The source application was created for one organization and contains organization-specific branding, terminology, artifacts and delivery history. A commercial product must have a controlled, independently reviewable repository and provenance boundary.

## Decision

Maintain `APReddy-AutoBotz/WorkOS` as a new private commercial repository. Import only approved files from the pinned source commit, without importing Git history. Keep the source repository unchanged and record imported/excluded files and checks in `PROVENANCE.md`.

## Alternatives considered

1. Continue in the source repository — rejected because commercial and organization-specific histories would remain mixed.
2. Use a permanent fork — rejected because fork lineage and full old history complicate confidentiality and buyer diligence.
3. Rebuild from zero — rejected because it discards proven behavior and tests without reducing product risk.

## Consequences

- The import requires an explicit allow/exclude manifest and regression restoration.
- Provenance and third-party licensing remain visible.
- Future WorkOS issues, PRs, releases and deployments are independent.
- Generic improvements are developed only in WorkOS unless separately authorized.

## Verification and rollback

WOS-01 verifies the source SHA, manifest, scans, build and tests. Before merge, the commercial repository can be reset to its pre-import commit. No task may push to or open a PR against the source repository.