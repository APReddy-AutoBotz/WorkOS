# Changelog

All notable WorkOS changes will be recorded here. The project follows semantic versioning once application source is imported.

## [Unreleased]

- Allow prose-only progress PRs to complete CI with whitespace validation and a secret scan of all fetched Git history.

- Corrected forecast pressure and project allocation indicators for out-of-term projects and missing capacity.

- Anchored forecast charts, roll-off dates and exports to the report source date.

- Added a scoped missing-worker drilldown and corrected weekly submission coverage under status filters.

- Corrected actual utilization displays and CSVs when approval or capacity evidence is missing.

- Pinned the tested Node and PostgreSQL image indexes for reproducible container inputs.

- Managed-service engagements can adopt an effective-dated standing margin threshold through the commercial amendment workflow.

- CI retains the tested container with its source revision, image ID, checksums and runtime inventories for buyer verification.

- Finance can compare retained managed-service margins across engagements for a selected month and distinguish missing evidence from margins below an entered threshold.

### Added

- WOS-00 programme charter, authoritative requirements and architecture baseline.
- Repository governance and AI-agent operating controls.
- Product, architecture, specification, quality and delivery documentation pack.
- Source-provenance and commercial-repository separation rules.

### Not yet included

- Application source.
- Runtime branding/configuration implementation.
- Database migrations.
- Production deployment artifacts.

## [0.1.0] — Planned

The `v0.1.0` milestone will represent the accepted governing blueprint and controlled commercial repository baseline. It will not represent a runnable product.

## Unreleased — WOS-00F corrective hold

### Fixed

- Corrected invoice-batch approval finality and the protected replacement and post-export correction paths.
- Corrected rejection/correction notification ownership so mandatory source owners are resolved by the server.

### Security

- Reopen, recipient redirection and stale relationship inputs now fail closed in the governing contracts. The merged WOS-00 baseline remains under corrective hold and WOS-01A remains blocked until this correction is independently reviewed and merged.

## Changelog rules

- Use `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` and `Security` headings as applicable.
- Reference governing requirement IDs and PRs in release notes.
- Include migration and rollback implications.
- Do not claim a capability is released until its acceptance evidence is merged.
