# Contributing to WorkOS

## 1. Start with authority

Before changing behavior, read:

- `AGENTS.md`
- `docs/00-control/PRODUCT_REQUIREMENTS.md`
- `docs/02-architecture/ARCHITECTURE_OVERVIEW.md`
- `docs/04-quality/NON_FUNCTIONAL_REQUIREMENTS.md`
- The relevant specification under `docs/03-specifications/`

Derived documents explain requirements but do not override `PRODUCT_REQUIREMENTS.md`.

## 2. Branch and pull-request rules

- Never implement directly on `main`.
- Use one outcome-based branch and Draft PR per work package.
- Reference requirement IDs and the governing GitHub issue.
- Include schema, backend, frontend, tests, migration evidence and documentation together when applicable.
- Keep unrelated cleanup out of feature PRs.
- Prefer squash merge after exact-head acceptance.

Recommended branch forms:

```text
controller/wos-00-blueprint
codex/wos-01-source-bootstrap
codex/wos-06-commercial-engine
fix/wos-<issue>-<brief-name>
```

## 3. Design and implementation expectations

- Preserve modular-monolith boundaries.
- Keep permissions, scope, approval, financial calculations and audit server authoritative.
- Use effective dates and immutable/versioned snapshots where historical truth matters.
- Use decimal-safe money and explicit rounding.
- Add negative authorization cases, not only happy paths.
- Do not hardcode buyer names, visual identity, organization titles or deployment values.
- Do not introduce microservices or destructive migrations without an accepted ADR.

## 4. Evidence

Every implementation PR must report applicable checks as `PASS`, `FAIL`, `SKIP` or `NOT RUN`, including:

- Locked dependency installation.
- Type/lint and build.
- Unit/domain and API tests.
- Authorization and out-of-scope tests.
- Fresh-install and upgrade migration tests.
- Browser journeys for affected roles.
- Financial reconciliation when applicable.
- Production startup, security and operational checks.

A skipped mandatory check blocks acceptance unless the work package explicitly authorizes the skip.

## 5. Data and security

Use synthetic data only. Never commit credentials, customer data, personal data, private keys, production URLs or unrestricted financial information. Follow `SECURITY.md` for vulnerability reporting.

## 6. Documentation

Update requirement traceability, implementation status, release notes and operational guidance in the same PR as the behavior change. Mermaid diagrams should remain editable and syntactically valid.