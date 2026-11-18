# Scoped workforce directory and hierarchy workflow

## Approved lineage and dependency

WOS-WKF-008 (PRODUCT_REQUIREMENTS section7) requires an authorized directory and hierarchy according to active-role server scope. ORG004 permits recorded reporting-manager/operational ownership without hardcoded titles; IAM003/005/010 and CORE003 require existing role, permission and relationship authority. PR008 explicitly includes scoped hierarchy, with the Organization/Setup and Resource Planning specifications preserving recorded relationships. This is the next finite operational implementation gap after PR92, not a gap-derived new product scope, cumulative review or security repair.

Start from unchanged PR92 `0634d78b117a18bbc087cf22e7bea3b6c1fcdbf8` / tree `daeea499455f92e37e2750d892fe19627fec414d`. Direct dependent development only; no sibling composition or accepted-main integration is claimed. Earlier heads, main, alias and repository controller stay fixed; separate hourly automation stays off. Optional independent/formal reviews remain deferred, not passed.

## Coherent outcome

An existing employees.view holder explicitly loads a bounded server-scoped directory, searches recorded names/codes/structure, opens a worker's recorded reporting context, navigates only visible manager/direct reports, and inspects that worker's original governed capability and effective-capacity workspaces. Those components keep their own existing read/write permissions and commands; directory visibility grants no capacity change, report export, approval, new relationship or account authority. No manager mapping or hierarchy is inferred from designation, department or title. Missing/out-of-scope manager is not disclosed or treated as an organizational root. Visible direct-report counts are scoped counts, never total company/team counts.

Read-only modular API reuses buildEmployeeScopeWhere and existing hasActiveAssignedRole, with organization/legal ownership and current permission checks. No replacement of legacy endpoints/global identity, no migration, role registry/default grant, dependency, provider or business mutation. Minimal directory fields exclude leave reasons/balances, cost/pay, account/provider credentials and personal data not needed for this workflow. Each result is bounded to20 plus continuation; SQL filters and scopes before paging. Deterministic roster digest includes visible hierarchy/profile/context; old pagination/navigation conflicts after changed source or access. Cycles cannot cause traversal loops in the new UI: navigation is explicit one-step, existing scope semantics retained.

## Acceptance before publication

- Unit/client: strict query/response contracts, literal search, stable paging, no duplicate rows/invalid references/counts, owner/scope/role/token/selection/generation fences; no local fallback or automatic retry.
- Real PostgreSQL/API: >20 visible workers, literal Unicode and wildcard search, all existing active-role scope cases, manager outside scope suppressed, direct-report paging, stale roster/relationship continuation409, missing/removed role and permission refusals, cross-organization/legal negatives and client override refusal. GET leaves source, identity, permission, approval, evidence and audit tables unchanged; replay migration applies none.
- Actual React/API/PostgreSQL: directory -> selected worker -> recorded manager/direct reports -> original capabilities -> explicit capacity profile/period; keep unavailable legacy inputs unavailable. No broad compatibility loaders, external calls or new authority. Verify empty/error, paging/search, keyboard-labelled actions and a held accepted200 suppressed after scope/actor change.
- Full locked install, type/lint/unit/build, retained PostgreSQL/browser/production groups on frozen clean head; add tests to existing required entrypoints and only add PR92 base branch to current CI filter.
- Inspect outgoing authored code/synthetic tests/technical documentation for private material. Check exact base/head, existing remote branch/PR and protected runs; publish bounded dependent Draft against PR92, then follow exact-head hosted metadata to terminal. No signed-log download retry.

## Limits

This closes the bounded current recorded directory/hierarchy navigation workflow, not richer hierarchy configuration or every workforce/privacy requirement. No commercial rules/conversions/thresholds/defaults, financial authority, reopening, identity/source transfer, live delegation grants, external delivery, merge/deployment or denied operations. Formal review, stack integration, UAT and release remain separate unpassed gates.
