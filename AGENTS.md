# WorkOS Agent Operating Contract

This file governs all AI-assisted and human implementation work in this repository.

## 1. Product and repository boundary

- This repository is the commercial **WorkOS** product.
- `APReddy-AutoBotz/Boundaryless-WorkOS` is an authorized reference source only. Never commit to, push to, open pull requests against, or alter that repository from a WorkOS task.
- The approved source baseline is commit `f2de1d85126f5d64f0e2e21b085b0303ca1d8417`.
- Do not import Git history from the reference repository.
- Do not copy company-only screenshots, presentations, real names, credentials, email domains, customer data, production URLs, or confidential operational material.
- `WorkOS` is a temporary product name. All runtime branding must be configuration-driven so a future rename does not require feature-code changes.

## 2. Document authority

Read these before changing product behavior:

1. `docs/00-control/PRODUCT_REQUIREMENTS.md` — authoritative product requirements.
2. `docs/00-control/PROGRAM_CHARTER.md` — programme goals, constraints and governance.
3. `docs/02-architecture/ARCHITECTURE_OVERVIEW.md` — target architecture and boundaries.
4. `docs/04-quality/NON_FUNCTIONAL_REQUIREMENTS.md` — mandatory quality attributes.
5. `docs/05-delivery/IMPLEMENTATION_BACKLOG.md` — work-package order and acceptance gates.
6. The relevant feature specification under `docs/03-specifications/` once present.

If documents conflict, stop and report the conflict. Do not silently choose the easier interpretation.

## 3. Change-control rules

- Never push implementation directly to `main`.
- Use one outcome-based branch and Draft pull request per work package.
- Keep the change within the approved scope. Do not add unrelated features or broad refactors.
- Preserve existing behavior unless a requirement explicitly changes it.
- Update requirements traceability, tests and operational documentation in the same pull request as the code.
- Do not claim completion without executable evidence.

## 4. Architecture rules

- Use a **modular monolith**. Do not introduce microservices without an approved ADR.
- Keep PostgreSQL as the system of record for WorkOS v1.
- Server-side rules are authoritative for permissions, financial calculations, approval state, period locks and audit.
- Frontend calculations may be previews only and must not become the financial or authorization source of truth.
- New modules must expose clear service boundaries and avoid extending a single unbounded server file.
- Prefer incremental extraction over a big-bang rewrite.
- External systems must be accessed through adapters with mock/test implementations.
- One isolated deployment and database per buyer is the v1 operating model, while data structures remain organization-ready.

## 5. Data and migration rules

- New commercial tables must include an organization/legal-entity ownership strategy where applicable.
- New uniqueness constraints must be scoped correctly for the deployment and domain model.
- Use append-only, ordered, versioned migrations.
- Every migration must pass both fresh-install and upgrade-path tests.
- Do not perform destructive migration without an explicit conversion and rollback plan.
- Effective-dated rates, costs and commercial terms must preserve historical calculations.
- Financial snapshots must not silently change when later rate cards are edited.
- Seed data must be synthetic, generic and safe to publish inside the private repository.

## 6. Security rules

- Enforce authorization at navigation, API permission and row/data-scope levels.
- Never trust a client-supplied organization, user, role, rate, cost, amount, approval status or audit identity without server validation.
- Do not add secrets, tokens, passwords, private keys or real credentials to source, test fixtures, screenshots or documentation.
- Production mode must fail closed when required infrastructure is unavailable.
- Security-sensitive changes require negative tests, not only happy-path tests.
- Audit records must identify actor, active role, source, entity, action, timestamp and material before/after values.
- Do not weaken existing controls to make a test pass.

## 7. Commercial and financial rules

- Support multiple engagement models without hardcoding T&M assumptions into shared entities.
- Separate work evidence, approval, billability, revenue recognition and invoicing readiness.
- Use deterministic decimal-safe rules for currency and rate calculations.
- Record the source and effective date of every rate or cost used in a calculation.
- Make rounding rules explicit and tested.
- AI may explain, summarize or suggest; it must not be the authoritative calculator or approval decision-maker for WorkOS v1.

## 8. Branding and terminology rules

- Do not hardcode `Boundaryless`, old logos, old domains, `RUT`, company-specific leadership titles or company-only process labels.
- Product name, organization name, logos, colours, support contact and terminology must come from centralized configuration.
- Internal canonical domain names may remain stable in code, but user-facing labels must be configurable where required by the product specification.
- Add an automated forbidden-term scan before the commercial baseline is accepted.

## 9. Test and evidence requirements

For every code pull request, run the applicable subset and report exact results:

- Dependency installation from the lockfile.
- Type checking and linting.
- Unit tests.
- API/contract tests.
- Authorization and negative-scope tests.
- Migration fresh-install and upgrade tests.
- Browser journeys for affected roles.
- Production-mode build/startup checks.
- Secret and dependency scans when configured.

A task is not complete when tests were skipped because configuration was absent unless the work package explicitly defines that skip as acceptable.

## 10. Codex task behavior

- Start by inspecting the repository and the exact task specification.
- State assumptions before implementation and minimize them.
- Work end-to-end: schema, backend, frontend, tests, documentation and evidence where the task requires them.
- Do not ask the owner routine implementation questions that are already resolved by the governing documents.
- Escalate only material business, legal, security or destructive-data decisions.
- When the Codex interface permits model selection, prefer the strongest available **Sol** reasoning model for architecture, security, migrations and commercial calculations. Use an appropriate Sol model for bounded implementation and review tasks.
- Before finishing, inspect the final diff for accidental branding, credentials, generated artifacts and unrelated changes.

## 11. Completion report

Every task report must include:

- Outcome delivered.
- Requirement IDs addressed.
- Files and migrations changed.
- Tests executed with results.
- Known limitations or deferred items.
- Security and rollback considerations.
- Exact commit/head identifier when available.
