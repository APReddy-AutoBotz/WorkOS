# Security integration evidence and remaining work

Updated 2026-11-16. This ledger records bounded accepted corrections, not blanket closure of the earlier whole-repository audit. Each original finding must still be reconciled against the eventual immutable release head. Draft-stack tests and a clean incremental review do not establish complete product security.

## Accepted corrections

| Outcome | Accepted PR and merge | Exact candidate / post-merge hosted evidence | Practical boundary |
|---|---|---|---|
| Current selected-role authority | PR162, `0ad02ab3611d9720eb226b481ae68e6cbbd68ec4` | CI43797328102 / CI43798387297: 74 steps each | Disabled accounts and removed roles fail closed; verified provider mapping alternatives retained. Live provider membership refresh and per-session logout revocation remain separate. |
| Protected identity administration | PR163, `134031bf43cf2b934759dcfec629f697bd82d203` | CI43801592175 / CI43802724124: 75 steps each | Privileged roles, reset/binding authority, username collision and durable unlink/concurrent callback corrected. No general session-revocation claim. |
| Verified PostgreSQL TLS | PR164, `a6b1cc249f5266ee41896245927cfe52f5f557cf` | CI43804406594 / CI43805538159: 76 steps each | API, migration and seed share certificate/hostname checks. Buyer CA mounts and transport configuration require deployment acceptance. |
| Setup reads and error containment | PR165, `0489b181b0f5c3fc3e4825a662cecbf3987b98d8` | CI43807321480 / CI43809000917: 77 steps each | Administrative reads require capability; worker history/dependencies enforce current row scope. Minimal history, strict dates and contained async errors. Existing lifecycle mutation policy remains separate. |

## Authentication correction in this revision

PR166 candidate `4d103df312a3a6bda92c2359d6ce0f9e9cd073fc` bounds authentication map retention, validates rate limits and makes proxy trust explicit. It shares authoritative client IP with audit. Local locked install, type/lint/full aggregate, nine limiter tests, authorization PostgreSQL negatives, TLS, 54 migration entries, both retained browser journeys and production signed-identity/startup passed. Independent exact-head review passed all 23 changed paths with no introduced findings. The final documentation-only revision preserves these runtime/test bytes; its exact-head hosted acceptance is recorded in PR166. Process-local limits do not satisfy persistent/distributed throttling requirements.

## Remaining priority work

1. Reproduce remaining session-lifecycle findings on accepted main; implement durable logout/revocation with correctly ordered additive migrations and fresh/upgrade evidence. Do not transplant later-stack migration094 ahead of its prerequisites.
2. Verify independent leave decisions, current director/relationship bindings and delegation authority against accepted behavior. Retain negative self-approval and stale-authority cases.
3. Verify invoice source eligibility and alternate-source protections in the commercial integration sequence. Financial policy and immutable snapshots must remain authoritative.
4. Integrate remaining timesheet/export safety and notification diagnostic controls with actual scope, CSV and redaction tests.
5. Reconcile all earlier finding identifiers and proof artifacts against one release head; complete persistent production throttling, performance, backup/restore, buyer identity/topology and UAT evidence.

These are work priorities, not a claim that every historical candidate still reproduces after intervening changes. Investigation precedes each repair; already corrected behavior should receive evidence rather than redundant rewrites.

## Rollback and release boundary

Prefer tested forward corrections. Reverting these security changes can restore access, spoofing, trust or availability defects. Preserve identity tombstones and all existing migration/history ledgers. No package here authorizes production deployment, new default grants, destructive data conversion or a claim of zero remaining defects.
