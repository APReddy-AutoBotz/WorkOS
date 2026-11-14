# PR-007C — Scoped client master and customer billing profiles

## Baseline and bounded continuation

Continue the owner's 2026-10-20 product implementation direction without a formal-review development hold. This isolated snapshot starts from unchanged Draft PR52 head `55ffd1685f8c034cc769158ff0a4ac10eca53795`, tree `df3bf8288a9d07684afe9e3b03feab5d36a1f515`. Remote PR52 remained Draft/unmerged, main remained `b9a57f8a462d8585bb3f73129080d6fae5173343`, exact-head CI39408514016 succeeded, and all five active Actions queues were empty before writes at 10:48 UTC. One WorkOS writer owns this slice, with disjoint UI/test helpers. This is development sequencing, not prerequisite, release, merge or production acceptance.

## Outcome and assumptions

WOS-CLI-001–002: preserve `clients.id` as operational/contract identity. Add protected, scoped customer master profiles and multiple billing entities or business units under an existing client, plus an optional effective-dated acyclic parent-account relationship. The buyer `legal_entity_id` remains ownership and never denotes customer billing identity. Existing operational industry, status and account owner remain canonical and visible separately. New legal/display names are explicit commercial profile values, not guessed from legacy labels. Missing legacy code/legal/display/currency/profile fields are disclosed as incomplete.

Use stable profile and billing-unit identities with append-only effective-dated snapshots, expected versions, scoped references, reason and protected material audit. A default currency is a future explicit selection aid only. No contract, engagement, version pin, neutral mapping or historical work is rewritten. No automatic currency/name inference, cross-legal consolidation, tax/payment identifiers, invoice routing, retirement/delete or new terminal lifecycle is included.

## Compatibility, confidentiality and evidence

Do not add confidential fields to clients or broaden GET /api/clients. New protected projections/routes and separate opt-in client-profile view/manage permissions have no default/live grants; lifecycle authority is insufficient. Shared audit receives opaque pointers only. Profile commands do not change operational client/project labels and do not bypass legacy governed-cascade conflicts. Existing CRUD, client-master/1 omitted fields/dry-run/idempotency/provenance, seed and local/demo behavior stay unchanged.

Required acceptance is fresh/upgrade/replay preservation, legacy CRUD/import/seed behavior, all governed cascade conflicts/rollback, omitted fields, self/cycle/concurrent-cycle and cross-scope rejection, dates/stale versions, confidential projection/audit isolation and actual PostgreSQL/API/React journeys. Retain all thirteen fixture/browser and real import/commercial/lifecycle suites; run full exact-head CI. The historical local Chromium boundary is retained without a workaround; hosted browser evidence is mandatory. Retain all evidence on rollback and disable this additive UI/routes only in a forward-compatible binary. No live credentials/grants/customer data, denied role-removal repair/diagnostic, PR30/reference repository writes, Ready/merge/deploy or unrelated schema changes.

## Integration receipt — 2026-11-14

The owner's current direction authorizes eligible reviewed merges. Historical development-only/no-merge and unavailable-local-browser statements above describe the original package; they do not describe current authorization or the now-available synthetic local tooling. PR52 is accepted at `e1d0fe67c5c8e2ada03b2b15688c4f9c0f186954`, after exact-head CI43615708220 passed every step and independent correction review passed. Its post-merge CI43616198883 remains running at this receipt. This dependent package retains accepted dependency/security repairs, all aggregate and hosted gates, commercial recovery behavior and the corrected historical-promotion rule. Integration conflicts in package scripts, CI and traceability were resolved by preserving accepted content and adding client-profile coverage. The lockfile is unchanged relative to accepted main.

Local evidence at integration checkpoint `65753de9a986b178a414efc44634a665c7641672` and its tree-identical accepted-parent merge `8111179eb2b43edeb2e6454e33ddad5554a569bd`:

- Locked installation passed: 338 packages installed, 345 audited, zero vulnerabilities reported.
- Typecheck passed; lint syntax-checked 149 modules. The complete aggregate unit/contract suite passed, including the required PostgreSQL date checks. Bootstrap scan passed across 317 files and adversarial fixtures passed.
- Actual client-profile PostgreSQL acceptance passed fresh install, populated041 upgrade, replay, immutable legacy/commercial history, opt-in permissions, protected projections/audit, scoped references, effective timelines, concurrent hierarchy safety, version limits, atomic audit failure and legacy CRUD/import rollback.
- Production build with fallback disabled passed in 17.93 seconds.
- The first fixture browser attempt failed because its required localhost4177 fixture server was absent; the subsequent real journey was not run by that failed command. After starting the required Vite server, the unchanged fixture suite and complete real React/API/disposable PostgreSQL journey both passed sequentially. The fixture server was then stopped. Coverage includes uncertain-save lock after Cancel, scope/identity/generation races, keyboard/mobile layout, effective-dated profiles and both customer-unit kinds, stale rollback, reload persistence, protected audit and unchanged pins/work history.

Independent exact-candidate review and fresh hosted integration checks remain pending. This is engineering evidence for bounded WOS-CLI-001–002, not full WOS-04, release, production OIDC/UAT or deployment acceptance. Existing full-audit findings remain open. Rollback must retain migration042 and all profile/version evidence in a separately validated forward-compatible binary; a pre042 binary is unsupported and deleting evidence is not a rollback strategy.
