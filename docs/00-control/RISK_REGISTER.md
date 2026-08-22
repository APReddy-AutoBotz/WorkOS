# WorkOS Risk Register

**Status:** Active programme control  
**Review cadence:** Every material PR and release gate  
**Scoring:** Probability (1–5) × Impact (1–5)

## 1. Rating guide

| Score | Treatment |
|---:|---|
| 16–25 | Critical — explicit blocking control and frequent review |
| 10–15 | High — mitigation required before affected milestone |
| 5–9 | Medium — monitor and mitigate through planned work |
| 1–4 | Low — accept or handle through routine controls |

## 2. Active risks

| ID | Risk | Probability | Impact | Score | Owner | Mitigation / control | Trigger / evidence | Status |
|---|---|---:|---:|---:|---|---|---|---|
| WOS-RSK-001 | Written permission may not expressly cover commercial licensing or exclusive IP assignment | 3 | 5 | 15 | Product owner | Retain signed written permission; obtain legal review before external licensing/assignment; distinguish technical provenance from legal rights | Buyer diligence or deal negotiation begins | Open — blocks external sale, not internal product build |
| WOS-RSK-002 | Historic public source exposure may complicate unsupported claims of practical exclusivity in external diligence | 4 | 3 | 12 | Product owner | Use clean private WorkOS history, maintain accurate provenance, obtain external legal/commercial assessment and make no unsupported exclusivity claim | External licensing or assignment diligence | Open |
| WOS-RSK-003 | `WorkOS` working name may conflict with an existing commercial brand/trademark | 4 | 4 | 16 | Product owner | Treat WorkOS as temporary; centralize branding; complete trademark/domain clearance before commercial launch | Brand investment, marketing or contract naming | Open — commercial-launch blocker |
| WOS-RSK-004 | Company-specific data, screenshots, terminology or secrets could enter the commercial repository during source bootstrap | 3 | 5 | 15 | Implementation controller | Pinned allow/exclude import, no Git history, forbidden-term/secret scans, import manifest and manual diff review | WOS-01 source bootstrap | Controlled; PR-002 blocker |
| WOS-RSK-005 | The original reference repository could be changed accidentally | 2 | 5 | 10 | Implementation controller | Separate WorkOS environment/repository; explicit AGENTS rule; no PAT; no task/PR against reference; verify repo before every task | Any Codex/GitHub task | Controlled |
| WOS-RSK-006 | Productization expands into a generic ERP/HRMS/CRM and delays sellable value | 4 | 4 | 16 | Product owner + controller | Enforce v1 scope and explicit defer list; prioritize professional-services operations and commercial controls | New scope request outside requirements | Active control |
| WOS-RSK-007 | A big-bang rewrite discards working behavior and creates regression risk | 3 | 5 | 15 | Architecture owner/controller | Modular-monolith ADR; incremental extraction; compatibility tests; no rewrite without approved ADR | WOS-03 or large refactor proposal | Active control |
| WOS-RSK-008 | Hardcoded role and hierarchy assumptions remain hidden after visual rebranding | 4 | 4 | 16 | Product engineering | Terminology/config spec, organization model, role templates, code scan and buyer scenario tests | WOS-01/WOS-02 | Open |
| WOS-RSK-009 | Organization/legal-entity migration breaks current authorization or identifiers | 3 | 5 | 15 | Data/architecture owner | Default-organization migration, scoped constraints, fresh/upgrade tests, negative cross-scope tests and rollback plan | PR-004 | Open |
| WOS-RSK-010 | Financial calculations produce incorrect revenue, cost or margin | 3 | 5 | 15 | Commercial-engine owner/controller | Decimal-safe engine, golden vectors, effective-dated evidence, reconciliation, independent review, Gate C | PR-010/011/012 | Open — commercial-release blocker |
| WOS-RSK-011 | Later rate-card edits silently change historical financial results | 3 | 5 | 15 | Commercial-engine owner | Persist immutable/versioned calculation snapshots and resolved-rate evidence; test post-edit stability | PR-010/011 | Open |
| WOS-RSK-012 | Sensitive cost/margin data is exposed to operational roles | 3 | 5 | 15 | Security owner | Separate permissions/DTOs, server-side field filtering, negative tests and access-review evidence | PR-010 onward | Open |
| WOS-RSK-013 | Invoice-ready sources can be billed twice or lose traceability | 3 | 5 | 15 | Finance-module owner | Unique source-line constraints, batch state machine, reversal model, reconciliation and audit tests | PR-012 | Open |
| WOS-RSK-014 | Codex reports success while tests were skipped, weak or run against the wrong state | 4 | 4 | 16 | Implementation controller | Exact command/result classification, inspect tests/diff, exact-head CI, independent review, no self-report acceptance | Every Codex PR | Active control |
| WOS-RSK-015 | Codex task runs against wrong repository/environment or broadens scope | 2 | 5 | 10 | Implementation controller | Repository/base in every task packet; WorkOS-specific environment; Draft PR; branch and diff verification | Every task start | Active control |
| WOS-RSK-016 | Concurrent Codex tasks conflict in schema, identity, approvals or financial engine | 3 | 4 | 12 | Implementation controller | Max two tasks only when non-overlapping; serialize high-risk modules; rebase/compare before review | Parallel execution proposal | Active control |
| WOS-RSK-017 | Current smoke-test style creates false confidence without production-like database/browser evidence | 4 | 4 | 16 | Quality owner/controller | CI/migration harness, DB fixtures, role-negative tests, production-like browser UAT and release matrix | PR-005 onward | Open |
| WOS-RSK-018 | The large existing server/API/UI files become harder to maintain during feature growth | 4 | 3 | 12 | Architecture owner | Incremental bounded extraction, module seams, file-growth review and tests | PR-006 onward | Open |
| WOS-RSK-019 | Dependency licences or vulnerabilities complicate source-code sale | 3 | 4 | 12 | Security/legal owner | Dependency inventory, licence review, third-party notices, SBOM and vulnerability disposition | Source bootstrap and v1 release | Open |
| WOS-RSK-020 | Demo credentials or fallback behavior reaches production | 3 | 5 | 15 | Platform owner | Separate profiles, fail-closed production, forbidden config checks and production startup tests | PR-003/005 | Open |
| WOS-RSK-021 | Automatic startup migrations cause unsafe production deployment | 3 | 4 | 12 | Platform/data owner | Explicit release migration command, migration ledger and rollback/recovery guidance | PR-005 | Open |
| WOS-RSK-022 | Buyer cannot deploy without extensive undocumented developer support | 3 | 4 | 12 | Platform/product owner | Setup wizard, environment schema, Docker/Compose, runbooks and buyer handover rehearsal | PR-004/005/015/016 | Open |
| WOS-RSK-023 | Performance degrades with realistic audit, worklog and commercial data volumes | 3 | 3 | 9 | Engineering owner | Pagination, indexes/query review, asynchronous exports/jobs and Standard-profile load test | PR-006 onward | Open |
| WOS-RSK-024 | External provider failure blocks or duplicates core operations | 3 | 4 | 12 | Integration owner | Adapter contract, idempotency, transaction separation, retries and integration-event evidence | PR-013 | Open |
| WOS-RSK-025 | Backup exists but restore is untested or exceeds buyer expectations | 3 | 4 | 12 | Operations owner | Defined RPO/RTO profile, automated/documented restore rehearsal and evidence | PR-015/016 | Open |
| WOS-RSK-026 | Owner-only pricing/IP strategy is accidentally delivered with product source | 2 | 4 | 8 | Product owner/controller | Keep owner pack outside WorkOS; repository scan and buyer handover manifest | Every commercial handover | Controlled |
| WOS-RSK-027 | User-facing terminology configuration becomes inconsistent across pages/reports/notifications | 4 | 3 | 12 | Product/UX owner | Central terminology registry, component usage rules, snapshot/browser tests and forbidden hardcoded labels | PR-003/004 | Open |
| WOS-RSK-028 | Product relies too heavily on Microsoft-specific identity/collaboration | 3 | 3 | 9 | Architecture owner | Generic OIDC and provider-adapter interfaces; Microsoft Entra/Teams as supported implementations, not core domain | PR-013/014 | Open |
| WOS-RSK-029 | Repeated requirements/status documents drift and conflict | 3 | 4 | 12 | Implementation controller | One authoritative PRODUCT_REQUIREMENTS; status/traceability roles defined; consistency review in CI or tests | WOS-00 onward | Active control |
| WOS-RSK-030 | Commercial buyer expects full invoicing/accounting beyond v1 invoice readiness | 4 | 3 | 12 | Product/sales owner | Clear positioning, scope and contract language; versioned finance export interfaces; no general-ledger promise | Sales/due diligence | Open |

## 3. Accepted constraints

The following are known constraints rather than unresolved risks:

- WorkOS v1 uses an isolated buyer deployment rather than shared multi-tenant SaaS.
- WorkOS v1 prepares invoice-ready data but is not a statutory invoicing/general-ledger system.
- WorkOS is a temporary working name pending commercial naming clearance.
- Advanced AI is deferred until deterministic operational and financial controls are stable.

## 4. Risk review procedure

At each material PR, the controller must:

1. Identify risks introduced, reduced or retired.
2. Verify that mitigations are implemented, not merely documented.
3. Update probability/impact when evidence changes.
4. Block merge when a defined milestone control is absent.
5. Record accepted residual risk in the PR/release evidence.

## 5. Release-blocking risk conditions

WorkOS v1 cannot be released for commercial buyer acceptance while any of the following remains unresolved:

- Unknown/unsupported source provenance for included code.
- Known secret or real company/customer data in the product package.
- Material cross-scope authorization defect.
- Unreconciled financial or invoice-readiness calculation defect.
- Unsafe or untested supported migration path.
- No successful production-like restore rehearsal.
- Critical/high security finding without approved disposition.
- Material prohibited branding/runtime dependency.
- Missing buyer handover or operational ownership evidence.
