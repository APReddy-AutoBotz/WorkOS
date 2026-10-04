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

- Re-fetch live main, open pull requests, exact heads/bases, workflow runs, issue comments and submitted pull-request reviews on every run.
- Select only one unambiguous Draft product-implementation PR whose explicit PR authority metadata matches a product task document on the current main. Never continue controller, acceptance, evidence or other non-product lanes.
- A candidate PR body must begin with exactly one each of `WORKOS-CONTINUATION-LANE: product-implementation`, `WORKOS-GOVERNING-TASK: docs/tasks/WOS-<workstream>-<task>.md` and `WORKOS-GOVERNING-ISSUE: <issue-number>`, followed by a blank line. The referenced task document is read from live `main`, never from the candidate head, and must have exactly one `Authority` section with matching Workstream and Issue, the same target branch as the PR head branch, and `Controller continuation lane: product-implementation`. Missing, malformed, duplicated or mismatched metadata, task-document lookup failure, cross-repository heads/bases, or a non-main base makes the candidate ineligible.
- If more than one Draft passes the complete product-task authority check, select none and do not post a continuation. Missing or ambiguous authority fails closed instead of falling back to PR title, update time or free-form prose.
- Order runs for each workflow by run_number, then run_attempt; use updated_at only to select the freshest representation of the same run attempt and to calculate activity freshness. If run identity is missing or invalid, fail closed without rerunning or posting a continuation.
- Treat queued, in_progress, waiting, requested and pending workflow statuses as active leases. If the latest run has an unrecognized or missing status, fail closed without rerunning or posting a continuation.
- Do not post a new Codex continuation while a task, review or workflow is fresh or likely running.
- A completed exact-head workflow retains a twenty-minute freshness lease, including successful and ordinary failed runs, so the existing lifecycle can finish reporting before another writer is started.
- A submitted pull-request review retains a forty-five-minute continuation freshness lease.
- Comment freshness and ordering use the maximum valid created_at/updated_at timestamp, so edits refresh the lease and an edited request cannot be treated as older than an earlier response.
- After revalidating the live product-task lane and exact PR head/base, re-read issue comments, submitted reviews and every exact-head workflow-run page immediately before posting a continuation. If a new task, bot response, autopick, review or active/recent/unknown workflow makes a freshness lease current, do not post. If the exact-head workflow list cannot be read, fail closed.
- After those final activity reads, fetch main, the open PR set and governing task authority once more; post only if the same exact eligible product PR/head/base remains current. If lane/head/base authority changed or cannot be read, fail closed.
- After all bounded freshness windows expire, post one exact-head continuation using the WorkOS Implementation environment and strongest appropriate Sol reasoning model.
- Every generated continuation must say to keep the PR Draft unconditionally, not mark Ready, and not merge. A Ready transition requires a separate explicit owner action outside the autonomous controller; merge decisions remain inside the controller's exact-lease gates.
- Rerun a workflow automatically at most once, and only when the latest attempt is classified as cancelled, timed_out or startup_failure. Ordinary failures remain visible and are never automatically retried as transient.

## Merge policy

The controller never marks a Draft Ready. A body marker is only a candidate hint; it is not merge authorization. A non-Draft PR is merge-eligible only when its body contains the exact current head/base marker:

```text
[WORKOS-AUTO-MERGE head=<40-character-head-sha> base=<40-character-base-sha>]
```

The repository owner must also post a separate authenticated issue comment whose entire body is exactly:

```text
@codex merge
[WORKOS-AUTO-MERGE head=<40-character-head-sha> base=<40-character-base-sha>]
```

GitHub's comment author login must match the repository owner, and the command must be posted strictly after the exact head commit. The command is bound to that exact head and base; a PR author or collaborator cannot authorize automatic merge by adding or editing the PR-body marker. The controller re-reads the owner-authored command during final merge-gate revalidation and fails closed if it is missing, edited, stale or mismatched.

Independent review uses an explicit two-message authority pair. After the reviewed head is published, the repository owner must post a distinct review invocation whose entire body is exactly:

```text
@codex review
[WORKOS-INDEPENDENT-REVIEW-REQUEST head=<40-character-head-sha>]
```

A later Codex response or submitted Codex review qualifies only when its entire body is exactly this single line for the same canonical lower-case SHA:

```text
[WORKOS-INDEPENDENT-REVIEW-RESULT head=<40-character-head-sha> result=clean p0=0 p1=0 p2=0]
```

For both request and result bodies, parsing normalizes CRLF to LF and accepts at most one final newline. It does not trim other whitespace or search within the body. Any prefix, suffix, duplicate record, malformed or noncanonical field, non-ASCII character, control character, Markdown/HTML container, hidden or encoded text, wrong SHA, nonzero priority, negation, question, contradiction or finding-bearing text makes the body non-authoritative. Natural-language self-reports, implementation completion comments and results before the distinct post-commit owner request do not satisfy the review gate.

Before squash merge, the controller must prove all of the following against the live PR:

1. the body marker matches the live head and base, and a separate exact owner-authored merge command is present strictly after the head commit;
2. GitHub reports mergeable=true and mergeable_state=clean;
3. at least one exact-head check run exists, every check run/status is completed successfully, and GitHub's aggregate commit-status state is exactly success, with no pending, neutral, skipped, cancelled, omitted or unexecuted result accepted;
4. no unresolved review thread remains;
5. neither GitHub's aggregate review decision nor any reviewer's latest decisive review is CHANGES_REQUESTED; a later COMMENTED review cannot hide an earlier change request;
6. an exact whole-body owner-authored independent-review request exists strictly after the head commit;
7. the newest Codex response or submitted review after that request, ordered by the maximum created/updated/submitted timestamp, is an exact whole-body clean result for the same SHA and an allowed Codex reviewer identity; any later unstructured, blocked, malformed or contradictory response invalidates an earlier clean result, and timestamp ties fail closed unless every tied response is exact clean;
8. a final live re-fetch proves that Draft/state/head/base/body marker and mergeability did not move during check/review revalidation;
9. immediately before the exact-SHA merge call, the controller re-reads owner merge authorization, all mutable checks, aggregate status, review/thread and PR metadata gates and fails closed if any changed;
10. the merge API receives the exact expected head SHA.

Only one eligible PR is merged per controller run so stacked dependencies re-evaluate on the next run.

## State reporting

One canonical issue #3 heartbeat is migrated from the legacy marker and updated only when its substantive state changes. It records current `main`, the active Draft, any exact auto-merge candidate, the last classified action and the open WorkOS/controller PR chain. Routine runs also write GitHub Actions job-summary evidence without adding comment spam.

## Retired legacy surface

The obsolete `.github/workflows/pr18-recovery-runner.yml` is deleted in this controller change. It is pinned to a completed historical recovery and must not continue producing stale-head runs.

## Safety boundary

The controller does not deploy, mutate hosted infrastructure, use paid actions, access real identity providers, secrets or customer data, write to `APReddy-AutoBotz/Boundaryless-WorkOS`, weaken product gates, or start a dependency-blocked later workstream.
