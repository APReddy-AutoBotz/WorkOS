'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {
  checksAreGreen,
  classifyLatestWorkflowRuns,
  isExactCleanReview,
  latestDecisiveReviews,
  parseMergeLease,
  selectActiveDraft,
  selectMergeCandidate,
} = require('./workos-continuous-controller.cjs');

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

assert.deepEqual(
  parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD} base=${BASE}]`),
  {head: HEAD, base: BASE},
);
assert.equal(parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD}]`), null);
assert.equal(parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD} base=${'c'.repeat(39)}]`), null);

assert.equal(
  isExactCleanReview(`Reviewed ${HEAD}. No actionable P0/P1/P2 findings remain.`, HEAD),
  true,
);
assert.equal(isExactCleanReview('No actionable P0/P1/P2 findings remain.', HEAD), false);
assert.equal(isExactCleanReview(`Reviewed ${HEAD}. P1 remains.`, HEAD), false);

assert.deepEqual(
  checksAreGreen([
    {name: 'build', status: 'completed', conclusion: 'success'},
    {name: 'acceptance', status: 'completed', conclusion: 'success'},
  ], [{context: 'legacy', state: 'success'}]),
  {green: true, reason: 'all exact-head check runs and statuses succeeded'},
);
assert.equal(checksAreGreen([], []).green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'skipped'}], []).green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'in_progress', conclusion: null}], []).green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'pending'}]).green, false);

assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'cancelled', run_attempt: 1, created_at: '2026-08-28T00:00:00Z'},
]).classification, 'transient');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'failure', run_attempt: 1, created_at: '2026-08-28T00:00:00Z'},
]).classification, 'failure');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'timed_out', run_attempt: 2, created_at: '2026-08-28T00:00:00Z'},
]).classification, 'none');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'in_progress', conclusion: null, run_attempt: 1, created_at: '2026-08-28T00:01:00Z'},
  {workflow_id: 1, status: 'completed', conclusion: 'failure', run_attempt: 1, created_at: '2026-08-28T00:00:00Z'},
]).classification, 'active');

const decisive = latestDecisiveReviews([
  {
    state: 'CHANGES_REQUESTED',
    submitted_at: '2026-08-28T00:00:00Z',
    user: {login: 'reviewer'},
  },
  {
    state: 'COMMENTED',
    submitted_at: '2026-08-28T00:05:00Z',
    user: {login: 'reviewer'},
  },
]);
assert.equal(decisive.length, 1);
assert.equal(decisive[0].state, 'CHANGES_REQUESTED');
assert.equal(latestDecisiveReviews([
  {
    state: 'CHANGES_REQUESTED',
    submitted_at: '2026-08-28T00:00:00Z',
    user: {login: 'reviewer'},
  },
  {
    state: 'APPROVED',
    submitted_at: '2026-08-28T00:05:00Z',
    user: {login: 'reviewer'},
  },
])[0].state, 'APPROVED');

const pulls = [
  {
    number: 27,
    state: 'open',
    draft: true,
    title: 'WOS-01A: product',
    updated_at: '2026-08-28T01:00:00Z',
    body: '',
    head: {sha: HEAD},
    base: {sha: BASE},
  },
  {
    number: 26,
    state: 'open',
    draft: true,
    title: 'CTRL: controller',
    updated_at: '2026-08-28T02:00:00Z',
    body: '',
    head: {sha: 'c'.repeat(40)},
    base: {sha: BASE},
  },
];
assert.equal(selectActiveDraft(pulls).number, 26);
assert.equal(selectMergeCandidate(pulls), null);

const ready = {
  ...pulls[0],
  draft: false,
  body: `[WORKOS-AUTO-MERGE head=${HEAD} base=${BASE}]`,
};
assert.equal(selectMergeCandidate([ready]).number, 27);
assert.equal(selectMergeCandidate([{...ready, body: `[WORKOS-AUTO-MERGE head=${'d'.repeat(40)} base=${BASE}]`}]), null);

const source = readFileSync(require.resolve('./workos-continuous-controller.cjs'), 'utf8');
assert.match(source, /fresh\.mergeable !== true \|\| fresh\.mergeable_state !== 'clean'/);
assert.match(source, /check\.status !== 'completed' \|\| check\.conclusion !== 'success'/);
assert.match(source, /unresolved\.length > 0/);
assert.match(source, /reviewDecision === 'CHANGES_REQUESTED'/);
assert.match(source, /DECISIVE_REVIEW_STATES/);
assert.match(source, /no independent exact-head no-P0\/P1\/P2 confirmation/);
assert.match(source, /sha: final\.head\.sha/);
assert.match(source, /merge_method: 'squash'/);
assert.match(source, /LEGACY_HEARTBEAT_MARKER/);
assert.match(source, /const finalMain =/);
assert.match(source, /const finalPulls =/);
assert.match(source, /classification: 'workflow-active'/);
assert.match(source, /classification: 'gate-failure-codex-continuation'/);
assert.doesNotMatch(source, /markPullRequestReadyForReview|mark_pull_request_ready/);
assert.doesNotMatch(source, /github\.rest\.deployments|createDeployment|createOrUpdateEnvironmentSecret|createOrUpdateRepoSecret/);

console.log(JSON.stringify({
  status: 'passed',
  policy: 'ten-minute guarded continuous controller',
  exactLease: true,
  strictChecks: true,
  decisiveReviewState: true,
  independentReview: true,
  postActionRefetch: true,
  legacyHeartbeatMigration: true,
  neverAutoReady: true,
}, null, 2));
