# Scoped audit active-role revocation diagnostic

This diagnostic branch preserves the green product checkpoint `396bd955a3e4df47d91b4f4f31f49f2d9a641b0e` / tree `abfa68fc866f6bc76c140606ae544856225e687b`. It changes no application authorization, identity configuration, grants, schema, migrations or production deployment. It is not a product-acceptance or merge candidate.

## Agreed rule and question

`NON_FUNCTIONAL_REQUIREMENTS.md`, WOS-NFR-SEC-003, explicitly requires sessions to be invalidated for disabled users or removed roles. WOS-IAM-003/005 additionally combine the selected active role, permission and data scope. The question is whether a still-unexpired, originally valid session can continue reading ordinary scoped audit history after its selected active role is removed, while its account, another assigned role and exact scope membership remain active.

The minimum secure observation is HTTP 401 or 403 with no audit data. The probe does not choose a new role policy, implement a fix, or prescribe a particular error contract beyond refusal. Scope is the existing legacy `/api/audit-logs` and `/api/v1/audit-logs` aliases. Other readers and the complete authorization matrix are not presumed tested.

## Executable fixture

Run `npm run test:scoped-audit-role-revocation` with `WORKOS_TEST_DATABASE_URL` pointing to the existing disposable local PostgreSQL service. Missing infrastructure fails; there is no acceptance-producing skip.

1. Require a complete PostgreSQL URL with the established local-host allowlist, reject every query/fragment override, validate the driver's effective host/port and emit only fixed sanitized parse errors; create a cryptographically randomized database and apply the complete unchanged migrations.
2. Create one synthetic active account assigned existing HR and Employee roles, with exact default organization/legal-entity membership. Existing-model permission fixtures allow HR audit reads and deny Employee audit reads. No persistent application account or grant is created.
3. Append one synthetic audit sentinel. Start the real API with a process-local random session secret, test profile, automatic demo/reset disabled and all fallback disabled. No endpoint, database or permission middleware is stubbed.
4. Verify missing-auth denial, assigned Employee permission denial and authorized HR visibility through both aliases. Mint the HR session while HR is genuinely assigned.
5. Delete only that fixture's HR assignment. Independently verify the active account, remaining Employee assignment, live scope membership and retained HR permission template. Replay the exact original, still-unexpired HR token against both readers.
6. Emit only sanitized path/status/synthetic-sentinel-presence observations, fixture invariant booleans and unchanged-audit confirmation. Assert refusal. Do not print tokens, secrets, connection URLs, raw responses or subprocess output.
7. Always stop the exact API child, close the pool, terminate connections only to the generated fixture database, drop only that database and close its admin connection.

This exercises the real PostgreSQL and API middleware in the already-established isolated test profile. It does not contact production or exercise an external OIDC sign-in/provider.

## CI and result interpretation

The diagnostic branch alone adds an exact-name push trigger to the existing WorkOS CI workflow. Workflow/job permissions, secrets, pinned actions, PostgreSQL service and every existing test/audit/container/secret gate remain unchanged. The probe runs last, so a diagnostic assertion failure preserves the preceding complete baseline results. Main, Draft41 and controller triggers are not modified externally by this branch.

Independent exact-tree source review is required before publication. Record the actual commit/tree, workflow URL, both observed statuses and any skipped gates after execution. Until then, runtime outcome is **NOT RUN**. A failed invariant is evidence for a separately scoped corrective bug fix, not permission to weaken the test, grant access or claim matrix closure. Formal review, Draft/no-merge/no-deploy controls and the complete Auditor/WOS-03B/product acceptance remain open.

Source review first caught and closed a P1 driver host-query override and P2 raw URL parse-error disclosure before any database connection/publication. The added construction-only safety regression verifies those cases, encoded query keys, absent user/database, malformed escaping and loopback defaults without opening a connection. The older migration harness is outside this diagnostic change; its actual CI URL remains the fixed query-free loopback service URL.
