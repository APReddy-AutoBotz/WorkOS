# WOS Continuous Implementation Controller

**Status:** proposed controller policy  
**Scope:** GitHub-native monitoring, bounded continuation and exact-head merge control

## Objective

Replace the legacy hourly heartbeat with one guarded controller that checks WorkOS at least every ten minutes, avoids duplicate writers, continues a stalled active workstream, and merges only an explicitly authorized exact PR head after all executable and independent-review gates are clean.

## Cadence and concurrency

- Schedule: every ten minutes.
- Manual `workflow_dispatch` is retained.
- Push-to-main execution proves the merged controller immediately.
- One main controller run at a time; pull-request validation is isolated by PR number.

## Continuation policy

- Re-fetch live `main`, open pull requests, exact heads/bases, workflow runs and recent Codex activity on every run.
- Select one current Draft WorkOS/controller PR; never create duplicate implementation PRs.
- Do not post a new Codex continuation while a task/review is fresh or likely running.
- After the bounded freshness window, post one exact-head continuation using the WorkOS Implementation environment and strongest appropriate Sol reasoning model.
- Rerun a workflow automatically at most once, and only when the latest attempt is classified as `cancelled`, `timed_out` or `startup_failure`. Ordinary failures remain visible and are never automatically retried as transient.

## Merge policy

The controller never marks a Draft Ready. A non-Draft PR is merge-eligible only when its body contains the exact lease:

```text
[WORKOS-AUTO-MERGE head=<40-character-head-sha> base=<40-character-base-sha>]
```

Before squash merge, the controller must prove all of the following against the live PR:

1. the body lease matches the live head and base;
2. GitHub reports `mergeable=true` and `mergeable_state=clean`;
3. at least one exact-head check run exists and every check run/status is completed successfully, with no pending, neutral, skipped, cancelled or unexecuted result accepted;
4. no unresolved review thread remains;
5. no reviewer’s latest review state is `CHANGES_REQUESTED`;
6. an independent Codex exact-head comment/review, created after the head commit, contains the exact SHA and explicitly states that no actionable P0/P1/P2 findings remain;
7. a final live re-fetch proves that Draft/state/head/base and the body lease did not move;
8. the merge API receives the exact expected head SHA.

Only one eligible PR is merged per controller run so stacked dependencies re-evaluate on the next run.

## State reporting

One canonical issue #3 heartbeat is updated only when its substantive state changes. It records current `main`, the active Draft, any exact auto-merge candidate, the last classified action and the open WorkOS/controller PR chain. Routine runs also write GitHub Actions job-summary evidence without adding comment spam.

## Retired legacy surface

The obsolete `.github/workflows/pr18-recovery-runner.yml` is deleted in this controller change. It is pinned to a completed historical recovery and must not continue producing stale-head runs.

## Safety boundary

The controller does not deploy, mutate hosted infrastructure, use paid actions, access real identity providers, secrets or customer data, write to `APReddy-AutoBotz/Boundaryless-WorkOS`, weaken product gates, or start a dependency-blocked later workstream.
