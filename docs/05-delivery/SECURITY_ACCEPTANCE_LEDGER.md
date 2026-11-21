# Security integration evidence and remaining work

Updated 2026-11-16. This ledger records bounded accepted corrections, not blanket closure of the earlier whole-repository audit. Each original finding must still be reconciled against the eventual immutable release head. Draft-stack tests and a clean incremental review do not establish complete product security.

## Accepted corrections

| Outcome | Accepted PR and merge | Exact candidate / post-merge hosted evidence | Practical boundary |
|---|---|---|---|
| Current selected-role authority | PR162, `0ad02ab3611d9720eb226b481ae68e6cbbd68ec4` | CI43797328102 / CI43798387297: 74 steps each | Disabled accounts and removed roles fail closed; verified provider mapping alternatives retained. Live provider membership refresh and per-session logout revocation remain separate. |
| Protected identity administration | PR163, `134031bf43cf2b934759dcfec629f697bd82d203` | CI43801592175 / CI43802724124: 75 steps each | Privileged roles, reset/binding authority, username collision and durable unlink/concurrent callback corrected. No general session-revocation claim. |
| Verified PostgreSQL TLS | PR164, `a6b1cc249f5266ee41896245927cfe52f5f557cf` | CI43804406594 / CI43805538159: 76 steps each | API, migration and seed share certificate/hostname checks. Buyer CA mounts and transport configuration require deployment acceptance. |
| Setup reads and error containment | PR165, `0489b181b0f5c3fc3e4825a662cecbf3987b98d8` | CI43807321480 / CI43809000917: 77 steps each | Administrative reads require capability; worker history/dependencies enforce current row scope. Minimal history, strict dates and contained async errors. Existing lifecycle mutation policy remains separate. |

## Authentication correction accepted

PR166 merged at `06516367ec9f452032b3d1a65658a22011448147` after final candidate `b9e82f8e256d5546d974e8fadd11a57d692c63f1` passed all 77 hosted steps in CI43810482651. Post-merge CI43811695312 also passed all 77 steps. Independent runtime/test and final documentation reviews passed. Local install, type/lint/aggregate, nine limiter tests, authorization PostgreSQL negatives, TLS, 54 migration entries, both retained browser journeys and production signed-identity/startup passed. Process-local limits do not satisfy persistent/distributed throttling requirements.

## Durable sessions accepted; leave correction in verification

Durable session revocation PR167 merged at `b1822ca9f9683c5eeaf40db6db1d6450ca214fb6`. All 79 exact-head steps in CI43814919022 and all 79 post-merge steps in CI43816509128 passed with no skips or failures. Independent frozen-head review covered all 48 changed paths.

This revision adds [independent leave decisions](../tasks/WOS-05-INDEPENDENT-LEAVE-DECISIONS.md): affected-worker and submitting-account separation, current canonical identity and qualified role-specific delegator scope checks, and a Teams source-workspace boundary. Migration057b adds only a scoped submission-evidence index. Missing or conflicting historical submitter evidence requires cancellation/resubmission; historical decisions are not rewritten. Final exact-head review and hosted acceptance are recorded in the PR. PR168 also refreshes canonical worker codes, worker IDs and qualified director scope on every bearer/cookie request, including identity-only routes. Null canonical links do not fall back to legacy codes. Other legacy delegation domains, commercial source eligibility, exports/diagnostics, persistent throttling and buyer/release evidence remain open.

## Remaining priority work

1. Rehearse account-wide session revocation with the buyer’s named incident responders before production acceptance.
2. Verify independent leave decisions, current director/relationship bindings and delegation authority against accepted behavior. Retain negative self-approval and stale-authority cases.
3. Verify invoice source eligibility and alternate-source protections in the commercial integration sequence. Financial policy and immutable snapshots must remain authoritative.
4. Integrate remaining timesheet/export safety and notification diagnostic controls with actual scope, CSV and redaction tests.
5. Reconcile all earlier finding identifiers and proof artifacts against one release head; complete persistent production throttling, performance, backup/restore, buyer identity/topology and UAT evidence.

These are work priorities, not a claim that every historical candidate still reproduces after intervening changes. Investigation precedes each repair; already corrected behavior should receive evidence rather than redundant rewrites.

## Session evidence on main, November 18, 2026

The earlier logout finding concerned reuse of a signed credential after logout. The [session specification and regression evidence](../tasks/WOS-04-DURABLE-SESSION-REVOCATION.md) records the original result. At main commit `88262c87a260529c00a680b22d2f021ff7d8cba4`, the PostgreSQL session suite, actual sign-in/logout browser journey, and production identity/startup suite all passed. [Hosted results](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43857837218)

| Requirement or operation | Evidence and remaining work |
|---|---|
| WOS-IAM-008 and WOS-IAM-010, current-session logout | The API suite checks denial of bearer and cookie reuse, including refresh and role-switch siblings. An independent sign-in remains usable. A second API process enforces revocation. Failed audit writes roll back the logout transaction. |
| WOS-IAM-008, absolute lifetime | Refresh and role switch preserve the original expiry. The server reads `API_SESSION_TTL_HOURS` and derives the cookie lifetime from the expiry. Migration 082a adds the prior and new values, timestamp, authenticated database operator and active database role. CI checks access denial, transaction rollback and production replica mismatch. |
| Administrative revoke-all | An explicit database function grant authorizes account-wide revocation. Migration 082b and the session PostgreSQL suite cover denied execution, actor attribution, audit rollback, stale retries, independent account isolation, reactivation and fresh sign-in. |

## Rollback and release boundary

Prefer tested forward corrections. Reverting these security changes can restore access, spoofing, trust or availability defects. Preserve identity tombstones and all existing migration/history ledgers. No package here authorizes production deployment, new default grants, destructive data conversion or a claim of zero remaining defects.


## Independent leave/current identity accepted; operational CSV safety next — 2026-11-16

[PR168](https://github.com/APReddy-AutoBotz/WorkOS/pull/168) merged at `0d65ab6313d4a26bcc2d14702f7ce6d6e7ab88eb`. Final candidate `0e544a7623d5f349d71f8db1d4aab0570a3d66c9` passed all 82 steps in [CI43830710558](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43830710558); [main CI43832282956](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43832282956) also passed all 82, without skips or failures. Independent runtime and final cleanup reviews passed. Leave decisions now enforce submitting-account/affected-worker independence and qualified role-specific delegation; Teams cannot bypass the source transition. Authenticated requests refresh canonical workforce bindings, including null links and changed employee codes.

The next bounded package is [operational CSV literal-text safety](../tasks/WOS-07-OPERATIONAL-CSV-SAFETY.md), covering the shared exporter and Timesheet Approval Ops Export. This safely precedes the invoice-action source correction, whose commercial modules are absent from current main. Preserve existing scope, filters, audit and source records; no dependency or migration changes. Fresh local acceptance, independent exact-head review and hosted gates are required before merge. Other delegation domains, commercial source authorization, diagnostic disclosure, persistent throttling and buyer/release evidence remain open.


## Operational CSV safety accepted; notification diagnostics next — 2026-11-17

[PR169](https://github.com/APReddy-AutoBotz/WorkOS/pull/169) merged at `88262c87a260529c00a680b22d2f021ff7d8cba4`. Candidate `907f02bb897adb4ad962d62d09647b4c67b776c7` passed all 83 steps in [CI43856156210](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43856156210); [main CI43857837218](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43857837218) also passed all 83 with no skips or failures. Independent exact-head review covered all 18 paths with no findings. Shared and Timesheet Approval exports now use consistent literal-text cell encoding; spreadsheet interoperability limitations remain documented.

The next bounded security package is [scoped and sanitized notification diagnostics](../tasks/WOS-05-NOTIFICATION-DIAGNOSTIC-BOUNDARY.md). It restricts delivery attempts to current recipient organization/entity and worker visibility before the result limit, excludes orphan ownership, and sanitizes provider metadata in new writes and historical attempt/integration/audit readers. Preserve delivery outcome, legitimate operational fields and immutable history. Fresh local, browser, independent exact-head and hosted checks remain mandatory before merge. Commercial-source authorization prerequisites, other delegation domains, persistent throttling and buyer/release evidence remain open.

## PR170 acceptance blocked by upstream dependency advisory — 2026-11-17

Notification diagnostics runtime candidate `5ddb26a15970e34af1e2dbdb198ce21397d5ad9c` passed local typecheck, lint (266 modules), full aggregate, real PostgreSQL/API and NotificationCenter browser checks, 56 migration entries, production build/signed-identity/startup and bootstrap/adversarial scans. Independent immutable-head review `7484bf28-df01-47c9-bfe2-facc801e28d2` covered all 23 paths with zero findings.

[PR170 CI44132858216](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/44132858216) passed all preceding application/API/browser/production-identity/migration steps, then failed the full dependency audit. `GHSA-fc5q-39xc-vjpf` flags repeated-extglob ReDoS in picomatch through the latest published version 4.0.7, propagating through fdir/tinyglobby/Vite. The subsequent Compose/container checks were skipped, so this run is not acceptance. The full-history secret scan passed. A fresh production-only audit reported zero vulnerabilities; that does not waive the full audit gate.

The frontend toolchain correction merged in PR #176. The notification diagnostics journey now runs on the same compiled fixture server as the other database-backed browser checks.

## Legacy approval/delegation security integration - 2026-11-17

Accepted baseline: PR169 CSV safety merged at `88262c87a260529c00a680b22d2f021ff7d8cba4`; candidate CI43856156210 and main CI43857837218 passed all 83 steps. Earlier next-package references above are historical.

[PR170](https://github.com/APReddy-AutoBotz/WorkOS/pull/170) remains unmerged at documentation head `471234b12ee700657aec80a658195f887ccb3a06`: runtime candidate `5ddb26a15970e34af1e2dbdb198ce21397d5ad9c` passed local checks and a 23-path independent review, but CI44132858216 failed the full dependency audit on unpatched picomatch. Eighty steps passed, one failed and four were skipped. The suggested Vite downgrade was evaluated and rejected because it introduces other high-severity vulnerabilities. No audit waiver or production deployment occurred.

This independent revision implements [legacy approval/delegation ownership and selected-entity scope](../tasks/WOS-05-LEGACY-APPROVAL-SCOPE.md) on accepted main. Actual baseline API execution reproduced recipient ownership takeover and cross-entity approval disclosure; the corrected API and real browser regressions pass. New bounded modules preserve original-owner/scoped-administrator editing, revocation after lifecycle changes, On Leave compatibility and immutable audit evidence. Complete local/hosted gates and exact-head independent review remain required. The shared dependency audit blocker remains open; commercial source integration, remaining security reconciliation, persistent throttling and buyer/release evidence are separate work.
