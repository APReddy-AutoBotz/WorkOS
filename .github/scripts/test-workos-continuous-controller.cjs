'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {
  authorityTimestamp,
  checksAreGreen,
  classifyLatestWorkflowRuns,
  isExactCleanReview,
  isExactReviewRequest,
  latestDecisiveReviews,
  latestSubmittedReviewAt,
  occursAfterReviewRequest,
  parseMergeLease,
  selectActiveDraft,
  selectMergeCandidate,
} = require('./workos-continuous-controller.cjs');

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);

assert.deepEqual(
  parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD} base=${BASE}]`),
  {head: HEAD, base: BASE},
);
assert.equal(parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD}]`), null);
assert.equal(parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD} base=${'c'.repeat(39)}]`), null);

const reviewRequest = `@codex review\n[WORKOS-INDEPENDENT-REVIEW-REQUEST head=${HEAD}]`;
assert.equal(isExactReviewRequest(reviewRequest, HEAD), true);
assert.equal(isExactReviewRequest(`[WORKOS-INDEPENDENT-REVIEW-REQUEST head=${HEAD}]`, HEAD), false);
assert.equal(isExactReviewRequest(reviewRequest, OTHER_HEAD), false);

const cleanResult = `[WORKOS-INDEPENDENT-REVIEW-RESULT head=${HEAD} result=clean p0=0 p1=0 p2=0]`;
assert.equal(isExactCleanReview(cleanResult, HEAD), true);
assert.equal(isExactCleanReview(`Reviewed ${HEAD}. No actionable P0/P1/P2 findings remain.`, HEAD), false);
assert.equal(isExactCleanReview(`${cleanResult}\nP0/P1/P2 status is not clean.`, HEAD), false);
assert.equal(isExactCleanReview(`${cleanResult}\nP1 remains open.`, HEAD), false);
assert.equal(isExactCleanReview(`${cleanResult}\n[P1] Merge accepts an unsafe review result.`, HEAD), false);
assert.equal(isExactCleanReview(`${cleanResult}\nThere is an actionable P0 issue.`, HEAD), false);
assert.equal(isExactCleanReview(`DO NOT ACCEPT THIS RESULT:\n${cleanResult}`, HEAD), false);
assert.equal(isExactCleanReview(`Quoted example only:\n\`${cleanResult}\``, HEAD), false);
assert.equal(isExactCleanReview(['```text', cleanResult, '```'].join('\n'), HEAD), false);
assert.equal(isExactCleanReview(`> ${cleanResult}`, HEAD), false);
assert.equal(isExactCleanReview(`  ${cleanResult}`, HEAD), false);
assert.equal(isExactCleanReview(`No actionable P0/P1/P2 findings remain? Not yet. ${HEAD}`, HEAD), false);
assert.equal(isExactCleanReview(`[WORKOS-INDEPENDENT-REVIEW-RESULT head=${HEAD} result=blocked p0=0 p1=0 p2=0]`, HEAD), false);
assert.equal(isExactCleanReview(cleanResult, OTHER_HEAD), false);

assert.deepEqual(
  checksAreGreen([
    {name: 'build', status: 'completed', conclusion: 'success'},
    {name: 'acceptance', status: 'completed', conclusion: 'success'},
  ], [{context: 'legacy', state: 'success'}], 'success'),
  {green: true, reason: 'all exact-head check runs and statuses succeeded'},
);
assert.equal(checksAreGreen([], [], 'success').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'skipped'}], [], 'success').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'in_progress', conclusion: null}], [], 'success').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'pending'}], 'pending').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'success'}], 'pending').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'success'}], 'failure').green, false);

const now = new Date('2026-08-28T01:00:00Z').getTime();
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'cancelled', run_attempt: 1, updated_at: '2026-08-28T00:55:00Z'},
], now).classification, 'transient');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'success', run_attempt: 1, updated_at: '2026-08-28T00:50:00Z'},
], now).classification, 'recent');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'failure', run_attempt: 1, updated_at: '2026-08-28T00:50:00Z'},
], now).classification, 'recent');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'failure', run_attempt: 1, updated_at: '2026-08-28T00:00:00Z'},
], now).classification, 'failure');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'timed_out', run_attempt: 2, updated_at: '2026-08-28T00:00:00Z'},
], now).classification, 'none');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'in_progress', conclusion: null, run_attempt: 1, updated_at: '2026-08-28T00:59:00Z'},
  {workflow_id: 1, status: 'completed', conclusion: 'failure', run_attempt: 1, updated_at: '2026-08-28T00:00:00Z'},
], now).classification, 'active');

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
assert.equal(latestSubmittedReviewAt([
  {submitted_at: '2026-08-28T00:01:00Z'},
  {submitted_at: '2026-08-28T00:05:00Z'},
]), new Date('2026-08-28T00:05:00Z').getTime());
assert.equal(latestSubmittedReviewAt([]), 0);

const editedRequest = {
  created_at: '2026-08-28T00:00:00Z',
  updated_at: '2026-08-28T00:10:00Z',
};
const preEditResult = {
  created_at: '2026-08-28T00:05:00Z',
  updated_at: '2026-08-28T00:05:00Z',
};
const postEditResult = {
  created_at: '2026-08-28T00:11:00Z',
  updated_at: '2026-08-28T00:11:00Z',
};
assert.equal(authorityTimestamp(editedRequest), new Date('2026-08-28T00:10:00Z').getTime());
assert.equal(occursAfterReviewRequest(preEditResult, editedRequest), false);
assert.equal(occursAfterReviewRequest(postEditResult, editedRequest), true);

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
    head: {sha: OTHER_HEAD},
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
assert.equal(selectMergeCandidate([{...ready, body: `[WORKOS-AUTO-MERGE head=${OTHER_HEAD} base=${BASE}]`}]), null);

const source = readFileSync(require.resolve('./workos-continuous-controller.cjs'), 'utf8');
assert.match(source, /fresh\.mergeable !== true \|\| fresh\.mergeable_state !== 'clean'/);
assert.match(source, /check\.status !== 'completed' \|\| check\.conclusion !== 'success'/);
assert.match(source, /unresolved\.length > 0/);
assert.match(source, /reviewDecision === 'CHANGES_REQUESTED'/);
assert.match(source, /DECISIVE_REVIEW_STATES/);
assert.match(source, /REVIEW_REQUEST_PATTERN/);
assert.match(source, /REVIEW_RESULT_PATTERN/);
assert.match(source, /CONTRADICTORY_REVIEW_PATTERN/);
assert.match(source, /NON_AUTHORITATIVE_REVIEW_PATTERN/);
assert.match(source, /findStandaloneCleanResult/);
assert.match(source, /combined\.data\.state/);
assert.match(source, /comment\.user\?\.login === owner/);
assert.match(source, /occursAfterReviewRequest\(comment, reviewRequest\)/);
assert.match(source, /authorityTimestamp\(comment\) >= headTime\.getTime\(\)/);
assert.match(source, /no independent structured clean result after the exact review request/);
assert.match(source, /WORKFLOW_ACTIVITY_FRESHNESS_MS/);
assert.match(source, /classification: 'workflow-recent'/);
assert.match(source, /github\.rest\.pulls\.listReviews/);
assert.match(source, /reviewAge >= 45 \* MINUTE/);
assert.match(source, /sha: final\.head\.sha/);
assert.match(source, /merge_method: 'squash'/);
const finalValidationStart = source.indexOf('const final =');
const finalMergeStart = source.indexOf('const result = await github.rest.pulls.merge', finalValidationStart);
assert.ok(finalValidationStart >= 0 && finalMergeStart > finalValidationStart);
const finalValidation = source.slice(finalValidationStart, finalMergeStart);
assert.match(finalValidation, /finalChecks = await inspectChecks/);
assert.match(finalValidation, /finalReview = await inspectReviewGate/);
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
  structuredIndependentReview: true,
  standaloneReviewResult: true,
  aggregateCommitStatus: true,
  finalMutableGateRevalidation: true,
  editedRequestOrdering: true,
  findingBearingResultRejected: true,
  negativeReviewLanguageRejected: true,
  recentWorkflowFreshness: true,
  submittedReviewFreshness: true,
  decisiveReviewState: true,
  postActionRefetch: true,
  legacyHeartbeatMigration: true,
  neverAutoReady: true,
}, null, 2));
