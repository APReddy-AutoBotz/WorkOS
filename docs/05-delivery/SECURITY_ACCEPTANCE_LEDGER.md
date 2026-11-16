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

This revision adds [independent leave decisions](../tasks/WOS-05-INDEPENDENT-LEAVE-DECISIONS.md): affected-worker and submitting-account separation, current identity and scoped delegation checks, and a Teams source-workspace boundary. Migration057b adds only a scoped submission-evidence index. Missing or conflicting historical submitter evidence requires cancellation/resubmission; historical decisions are not rewritten. Final exact-head review and hosted acceptance are recorded in the PR. Current relationship bindings, other legacy delegation domains, commercial source eligibility, exports/diagnostics, persistent throttling and buyer/release evidence remain open.

## Remaining priority work

1. Reconcile original session findings against accepted PR167. Administrative revoke-all and audited duration configuration remain separate.
2. Verify independent leave decisions, current director/relationship bindings and delegation authority against accepted behavior. Retain negative self-approval and stale-authority cases.
3. Verify invoice source eligibility and alternate-source protections in the commercial integration sequence. Financial policy and immutable snapshots must remain authoritative.
4. Integrate remaining timesheet/export safety and notification diagnostic controls with actual scope, CSV and redaction tests.
5. Reconcile all earlier finding identifiers and proof artifacts against one release head; complete persistent production throttling, performance, backup/restore, buyer identity/topology and UAT evidence.

These are work priorities, not a claim that every historical candidate still reproduces after intervening changes. Investigation precedes each repair; already corrected behavior should receive evidence rather than redundant rewrites.

## Rollback and release boundary

Prefer tested forward corrections. Reverting these security changes can restore access, spoofing, trust or availability defects. Preserve identity tombstones and all existing migration/history ledgers. No package here authorizes production deployment, new default grants, destructive data conversion or a claim of zero remaining defects.
