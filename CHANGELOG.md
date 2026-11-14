# Changelog

All notable WorkOS changes will be recorded here. The project follows semantic versioning once application source is imported.

## [Unreleased]

### Fixed — project detail recovery (draft implementation)

- WOS-CORE-003, WOS-NFR-OBS-005 and WOS-NFR-UX-005: clear obsolete project/edit state on navigation, ignore late reads and provide distinct failed/denied read feedback with retry. Browser regression evidence and limits are recorded in `docs/tasks/WOS-04-PROJECT-DETAIL-READ-RECOVERY.md`. No schema migration; application rollback restores the stale-display defect. This entry does not imply merge or release acceptance.

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
