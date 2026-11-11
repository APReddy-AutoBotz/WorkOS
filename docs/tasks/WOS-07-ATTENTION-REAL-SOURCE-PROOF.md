# Operational attention: real-source acceptance increment

Requirements: bounded WOS-RPT-001/005, WOS-CORE-003/005 and WOS-APR-003/006/008.

Baseline tree: `62b3106e79205f1fbf3bbb6234fea34fd92c2061` (PR119). This local checkout has reconstructed ancestry only; publication must preserve the actual remote PR119 parent.

## Gap and acceptance contract

The existing attention journey uses synthetic API responses. Extend the existing real React/API/PostgreSQL operational journey, retaining all original assertions, to prove that the pending-review queue selects an exact real source and stage, hands off without automatic inspection/decision, preserves lost-ack reconciliation and named-stage denial, and removes a terminal source after an explicit snapshot refresh. Exercise both work and material approvals through the queue. Preserve original direct worker-row handoffs for actual reports and forecasts.

No production behavior, permission, state semantics, migration, buyer setting, financial calculation or deployment changes. Search is current-page only. Test source identities are synthetic. This increment does not establish every queue category against PostgreSQL, full UAT, formal review or release acceptance.

## Evidence and rollback

Run syntax, existing attention contract/decoder/render tests and the changed real journey. Record actual failures without skipping or claiming success. A real journey requires the existing disposable local PostgreSQL fixture, loopback API and Playwright browser. Reverting this test and document is sufficient rollback; no stored-state migration exists.

## Local result (2026-11-11)

- Changed journey JavaScript syntax check passed.
- Existing attention suite passed: ten model cases, production decoder/projector and React server-render checks. These do not execute the changed real-source journey.
- Changed real-source journey attempted and failed at its mandatory precondition: `WORKOS_TEST_DATABASE_URL must point to a disposable local PostgreSQL service.` No assertion in that journey executed. No test skip or configuration bypass was added.
- Fresh dependency installation, actual changed-journey browser/database acceptance, full regression gates and hosted validation remain pending. Existing baseline node_modules were reused for these local checks, not presented as a fresh install.

Publication preparation adds only PR119’s base branch to the existing pull-request CI filter. All gates, permissions and protections remain unchanged. Local syntax lint passed for all 513 JavaScript modules.
