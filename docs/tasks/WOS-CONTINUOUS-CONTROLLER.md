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

- Re-fetch live `main`, open pull requests, exact heads/bases, workflow runs, issue comments and submitted pull-request reviews on every run.
- Select one current Draft WorkOS/controller PR; never create duplicate implementation PRs.
- Do not post a new Codex continuation while a task, review or workflow is fresh or likely running.
- A completed exact-head workflow retains a twenty-minute freshness lease, including successful and ordinary failed runs, so the existing lifecycle can finish reporting before another writer is started.
- A submitted pull-request review retains a forty-five-minute continuation freshness lease.
- After all bounded freshness windows expire, post one exact-head continuation using the WorkOS Implementation environment and strongest appropriate Sol reasoning model.
- Rerun a workflow automatically at most once, and only when the latest attempt is classified as `cancelled`, `timed_out` or `startup_failure`. Ordinary failures remain visible and are never automatically retried as transient.

## Merge policy

The controller never marks a Draft Ready. A non-Draft PR is merge-eligible only when its body contains the exact lease:

```text
[WORKOS-AUTO-MERGE head=<40-character-head-sha> base=<40-character-base-sha>]
```

Independent review uses an explicit two-message authority pair. After the reviewed head is published, the repository owner must post a distinct review invocation containing:

```text
@codex review
[WORKOS-INDEPENDENT-REVIEW-REQUEST head=<40-character-head-sha>]
```

A later Codex response or submitted Codex review must contain the exact, unambiguous result marker:

```text
[WORKOS-INDEPENDENT-REVIEW-RESULT head=<40-character-head-sha> result=clean p0=0 p1=0 p2=0]
```

Natural-language self-reports, implementation completion comments, responses before the marked request, wrong-head markers, question-form claims, negated clean language or any contradictory P0/P1/P2 wording do not satisfy the review gate.

Before squash merge, the controller must prove all of the following against the live PR:

1. the body lease matches the live head and base;
2. GitHub reports `mergeable=true` and `mergeable_state=clean`;
3. at least one exact-head check run exists and every check run/status is completed successfully, with no pending, neutral, skipped, cancelled or unexecuted result accepted;
4. no unresolved review thread remains;
5. neither GitHub's aggregate review decision nor any reviewer's latest decisive review is `CHANGES_REQUESTED`; a later `COMMENTED` review cannot hide an earlier change request;
6. an owner-authored exact-head independent-review request exists after the head commit;
7. a Codex structured clean result exists after that distinct request and is bound to the same exact SHA;
8. a final live re-fetch proves that Draft/state/head/base and the body lease did not move;
9. the merge API receives the exact expected head SHA.

Only one eligible PR is merged per controller run so stacked dependencies re-evaluate on the next run.

## State reporting

One canonical issue #3 heartbeat is migrated from the legacy marker and updated only when its substantive state changes. It records current `main`, the active Draft, any exact auto-merge candidate, the last classified action and the open WorkOS/controller PR chain. Routine runs also write GitHub Actions job-summary evidence without adding comment spam.

## Retired legacy surface

The obsolete `.github/workflows/pr18-recovery-runner.yml` is deleted in this controller change. It is pinned to a completed historical recovery and must not continue producing stale-head runs.

## Safety boundary

The controller does not deploy, mutate hosted infrastructure, use paid actions, access real identity providers, secrets or customer data, write to `APReddy-AutoBotz/Boundaryless-WorkOS`, weaken product gates, or start a dependency-blocked later workstream.
