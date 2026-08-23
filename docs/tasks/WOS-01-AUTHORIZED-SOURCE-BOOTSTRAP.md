# WOS-01 — Authorized Source Bootstrap

## Authority

- **Workstream:** WOS-01A
- **Issue:** #3
- **Target PR:** PR-002
- **Target branch:** `codex/wos-01-authorized-source-bootstrap`
- **Base:** WOS-00 merged `main@880b3dc244bf516c4e535fb68e455e6153aec395`
- **Reference repository:** `APReddy-AutoBotz/Boundaryless-WorkOS`
- **Authorized source commit:** `f2de1d85126f5d64f0e2e21b085b0303ca1d8417`
- **Reference access:** read-only
- **Source-history import:** prohibited

Product-owner Gate B authorizes this work only after WOS-00 merge. WOS-00 has merged. This task does not authorize any later workstream.

## Outcome

Produce a clean, reproducible, buildable WorkOS application-source baseline by importing only approved files from the exact pinned reference commit, without Git history, credentials, real company/customer data, production values, company-only artifacts or owner-only commercial strategy.

The result must preserve the complete WOS-00 governing documentation and must remain a Draft PR until the clean-runtime merge boundary is satisfied.

## Non-negotiable boundaries

1. Do not write to, push to, open a PR against or otherwise mutate `APReddy-AutoBotz/Boundaryless-WorkOS`.
2. Do not import `.git`, reference branches, tags, commit history, pull-request metadata or release history.
3. Do not import real customer/company data, credentials, tokens, private keys, production values, logs, database dumps or environment files containing values.
4. Do not import presentations, recordings, screenshots, generated exports, bulky transient artifacts, local caches, dependency directories or IDE state.
5. Do not import transaction-specific pricing, valuation, licensing, assignment, sale or negotiation strategy.
6. Do not implement WOS-02 or later product features.
7. Do not merge, mark ready, tag or deploy.
8. Do not weaken WOS-00 requirements, architecture, quality gates, source provenance or review controls.
9. Fail closed if the reference repository identity or exact commit cannot be independently verified.
10. All statements of success require executable evidence against the exact resulting GitHub head.

## Parallel-agent policy

The root Codex controller may use up to four parallel subagents with `max_depth=1` when their scopes are disjoint. The root owns all branch writes, final integration, checks, commit and publication.

Recommended read-only subagent split:

1. **Source inventory and provenance**
   - Verify repository identity and pinned commit.
   - Enumerate files and classify include/exclude with reason.
   - Identify source root, manifests, lockfiles, build/test entry points and generated/transient directories.
   - Produce checksum inputs for the root.

2. **Security and prohibited-content analysis**
   - Scan the pinned tree for credentials, secret-like values, real data, production values, company-only artifacts and owner-only strategy.
   - Identify runtime branding, domains, asset names, environment prefixes and demo shortcuts that would block merge.
   - Report; do not edit overlapping source files.

3. **Build and regression planning**
   - Determine package manager/runtime/toolchain versions from authoritative repository files.
   - Define locked install, type, lint, build, unit/integration/browser/smoke commands.
   - Identify tests that are inherited, environment-dependent or unsafe to run.

4. **Architecture and WOS-00 convergence**
   - Map imported modules/routes/data/configuration to WOS-00 boundaries.
   - Identify incompatibilities that require compatibility adapters or later WOS-01B neutralization.
   - Confirm no later-workstream functionality is accidentally introduced.

Subagents must not independently push, create branches/PRs or mutate the reference repository.

## Required repository artifacts

Create or update these artifacts in WorkOS as part of the bootstrap:

1. `docs/00-control/SOURCE_IMPORT_MANIFEST.md`
   - Reference repository and exact commit.
   - Import timestamp.
   - Included files/directories with SHA-256.
   - Excluded files/directories with reason.
   - Source-tree checksum or reproducible manifest checksum.
   - Explicit no-history and no-write statement.

2. `docs/evidence/v0.2.0/DOC-WOS-01-001-SOURCE-BOOTSTRAP.md`
   - Exact WorkOS base/head.
   - Source verification evidence.
   - File counts and checksums.
   - Install/build/test/scan results classified PASS/FAIL/SKIP/NOT RUN.
   - Known limitations and clean-runtime blockers.
   - Rollback strategy.

3. Appropriate repository scan configuration or scripts that are part of the imported stack and can run in CI without credentials.

4. Any neutral `.example` environment/configuration templates required to build or run locally, containing placeholders only.

Do not add helper/materializer workflows whose only purpose is moving source between repositories. The final WorkOS tree itself is the deliverable.

## Import method

1. Verify the reference repository owner/name and exact commit object.
2. Materialize the pinned tree without its Git history.
3. Create a deterministic file inventory.
4. Apply explicit include/exclude rules before copying.
5. Copy approved bytes only into the WorkOS branch.
6. Preserve existing WOS-00 files unless an additive link/index update is necessary.
7. Record source file hashes after import and compare them with the pinned source bytes.
8. Do not silently rewrite imported code during the source-provenance step. Any essential cleanup must be separately identified in the evidence and remain reviewable.

## Mandatory include classes

Include only where present and required for a reproducible application baseline:

- Application source code.
- Dependency manifests and committed lockfiles.
- Build, type-check, lint and test configuration.
- Database schema/migration source required by the application baseline, subject to secret/data scans.
- Neutral public static assets required for build/runtime.
- Existing automated tests and fixtures that contain synthetic or neutral data.
- Container/local-development definitions that contain placeholders only.
- Technical documentation required to build and operate the imported application.

## Mandatory exclude classes

Exclude at minimum:

- `.git/**`, branches, tags and history.
- `.env`, `.env.*` with values, credentials, certificates and key material.
- `node_modules`, package caches, build outputs, coverage, logs and temporary files.
- Database dumps, exports, backups and real operational datasets.
- Presentations, recordings, sales collateral and screenshots not required as runtime assets.
- Company-only branding files that are not needed to make the application buildable.
- User-specific IDE/workspace state.
- Owner-only commercial and transaction documents.
- Generated binary artifacts unless the application cannot build without an explicitly justified source-controlled artifact.

## Clean-runtime merge boundary

The imported branch may remain Draft while company-specific runtime branding is still being catalogued, but it cannot merge to `main` in that state.

Before PR-002 merge, one of these controlled paths must be complete:

1. The PR-002 branch itself removes or centralizes every prohibited runtime company dependency; or
2. A stacked WOS-01B branch/PR is merged into the PR-002 branch, after which the combined PR-002 head is independently re-reviewed and only the combined clean state merges to `main`.

The clean-runtime boundary includes:

- Product/organization name and logos.
- Favicon and visual tokens.
- Company domains, email/support identities and URLs.
- Cookie, password, service, database and deployment prefixes.
- Seed/default organization names and user identities.
- Demo credentials, shared accounts and production fallbacks.
- Notifications, templates and exports.
- Container/service names and environment-variable prefixes where buyer-facing or operationally coupled.
- Company-specific role labels, operating assumptions and hardcoded identifiers.

## Required checks

Report every check as `PASS`, `FAIL`, `SKIP` or `NOT RUN`.

### Provenance and inventory

- Reference repository identity verified.
- Exact source commit verified.
- Included/excluded manifest complete.
- Included source hashes verified.
- No reference Git history imported.
- Reference repository unchanged/no-write evidence.

### Prohibited content

- Credential/private-key/token scan.
- Real company/customer data scan.
- Production-value/environment scan.
- Company-only artifact and file-type scan.
- Owner-only transaction-strategy scan.
- Forbidden runtime term/domain/asset scan with explicit allowlist for provenance documents only.

### Engineering baseline

- Toolchain/runtime version detection.
- Locked dependency installation.
- Dependency integrity/provenance.
- Type check.
- Lint.
- Production build.
- Inherited unit/integration tests.
- Migration/schema validation where safely runnable.
- Minimal application startup/health/smoke evidence where safely runnable.
- Browser tests only when a safe local/test configuration exists; otherwise classify honestly.

### WOS-00 regression

- WOS-00 required-file inventory remains complete.
- 126 product requirement IDs remain unique.
- 81 NFR IDs remain unique.
- ADR-001 through ADR-008 remain present.
- Relative links remain valid.
- Source-provenance and exclusion wording remains intact.
- No review/evidence history is overwritten.

### Git hygiene

- `git diff --check`.
- No untracked generated artifacts.
- Exact resulting branch head reported.
- Changed-file inventory and stats reported.

## Acceptance criteria

This task is construction-complete only when:

1. The exact source repository and commit are proven.
2. The import manifest is complete and reproducible.
3. Only approved source bytes and required additive WorkOS control artifacts exist.
4. No credential, real data, production value, company-only artifact or owner-only strategy is imported.
5. Locked install, type/lint, production build and applicable inherited tests are executed and classified.
6. WOS-00 governing files and identifiers remain intact.
7. The reference repository is unchanged.
8. The exact resulting GitHub head is published to this Draft PR branch.
9. All limitations and remaining clean-runtime blockers are explicit.

Construction completion is not merge acceptance. Independent exact-head review and the clean-runtime merge boundary remain mandatory.

## Expected completion report

Report, in order:

1. Exact source repository and verified SHA.
2. Exact WorkOS base and resulting GitHub head.
3. Included/excluded counts and manifest checksum.
4. Imported stack/toolchain summary.
5. Findings by severity.
6. Complete PASS/FAIL/SKIP/NOT RUN check matrix.
7. Clean-runtime blockers and whether WOS-01B is required.
8. Security/provenance limitations.
9. Rollback instructions.
10. Confirmation that the reference repository was not modified.
