'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {
  assessContinuationFreshness,
  attemptGuardedMerge,
  authorityTimestamp,
  checksAreGreen,
  classifyLatestWorkflowRuns,
  inspectReviewGate,
  isExactCleanReview,
  isExactReviewRequest,
  latestDecisiveReviews,
  latestSubmittedReviewAt,
  maybeAutopick,
  run: runController,
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

const reviewRequest = '@codex review\n[WORKOS-INDEPENDENT-REVIEW-REQUEST head=' + HEAD + ']';
assert.equal(isExactReviewRequest(reviewRequest, HEAD), true);
assert.equal(isExactReviewRequest(reviewRequest + '\n', HEAD), true);
assert.equal(isExactReviewRequest(reviewRequest.replace(/\n/g, '\r\n'), HEAD), true);
assert.equal(isExactReviewRequest('[WORKOS-INDEPENDENT-REVIEW-REQUEST head=' + HEAD + ']', HEAD), false);
assert.equal(isExactReviewRequest('Review request follows:\n' + reviewRequest, HEAD), false);
assert.equal(isExactReviewRequest('~~~text\n' + reviewRequest + '\n~~~', HEAD), false);
assert.equal(isExactReviewRequest('~~~~markdown\n' + reviewRequest + '\n~~~~', HEAD), false);
assert.equal(isExactReviewRequest('<!-- ' + reviewRequest + ' -->', HEAD), false);
assert.equal(isExactReviewRequest('<pre>' + reviewRequest + '</pre>', HEAD), false);
assert.equal(isExactReviewRequest(reviewRequest + '\nextra prose', HEAD), false);
assert.equal(isExactReviewRequest('<!--\n' + reviewRequest + '\n-->', HEAD), false);
assert.equal(isExactReviewRequest('<blockquote>' + reviewRequest + '</blockquote>', HEAD), false);
assert.equal(isExactReviewRequest(reviewRequest.toUpperCase(), HEAD), false);
assert.equal(isExactReviewRequest(reviewRequest, OTHER_HEAD), false);
assert.equal(isExactReviewRequest(reviewRequest, HEAD.toUpperCase()), false);
assert.equal(isExactReviewRequest(reviewRequest + '\n\n', HEAD), false);
assert.equal(isExactReviewRequest(reviewRequest.replace(HEAD, HEAD.slice(0, 39)), HEAD), false);
assert.equal(isExactReviewRequest(null, HEAD), false);

const cleanResult = '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + HEAD + ' result=clean p0=0 p1=0 p2=0]';
assert.equal(isExactCleanReview(cleanResult, HEAD), true);
assert.equal(isExactCleanReview(cleanResult + '\n', HEAD), true);
assert.equal(isExactCleanReview(cleanResult.replace(/\n/g, '\r\n'), HEAD), true);
const tick = String.fromCharCode(96);
const hiddenResultCases = [
  '~~~text\n' + cleanResult + '\n~~~',
  '~~~~markdown\n' + cleanResult + '\n~~~~',
  '~~~text\n' + cleanResult,
  tick.repeat(4) + 'javascript\n' + cleanResult + '\n' + tick.repeat(4),
  tick.repeat(3) + 'text\n' + cleanResult,
  '| claim | result |\n| --- | --- |\n| review | ' + cleanResult + ' |',
  '[review example](' + cleanResult + ')',
  tick.repeat(3) + 'text\n' + cleanResult + '\n' + tick.repeat(3),
  '<!--\n' + cleanResult + '\n-->',
  '<pre>\n' + cleanResult + '\n</pre>',
  '<code>' + cleanResult + '</code>',
  '<blockquote>' + cleanResult + '</blockquote>',
  '<details hidden><summary>example</summary>' + cleanResult + '</details>',
  '<script>' + cleanResult + '</script>',
  '<style>' + cleanResult + '</style>',
  '<template>' + cleanResult + '</template>',
  '<summary>' + cleanResult + '</summary>',
  '<div hidden>' + cleanResult + '</div>',
  '&lt;pre&gt;' + cleanResult + '&lt;/pre&gt;',
  '&#91;WORKOS-INDEPENDENT-REVIEW-RESULT head=' + HEAD + ' result=clean p0=0 p1=0 p2=0&#93;',
  'Example only: ' + cleanResult,
  '> ' + cleanResult,
  '- ' + cleanResult,
  tick + cleanResult + tick,
  '  ' + cleanResult,
  cleanResult + '\nA serious authorization flaw remains.',
  cleanResult + '\n[WORKOS-INDEPENDENT-REVIEW-RESULT head=invalid]',
  cleanResult + '\n' + cleanResult,
  '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + HEAD.toUpperCase() + ' result=clean p0=0 p1=0 p2=0]',
  cleanResult.replace('result=clean', 'result=blocked'),
  cleanResult.replace('p1=0', 'p1=1'),
  cleanResult.replace('p2=0', 'p2=0 extra=1'),
  'Not clean: ' + cleanResult,
  cleanResult + '\nP1 remains open.',
  cleanResult + '\nThere is an actionable P0 issue.',
  cleanResult.replace('head=', 'head=\u200b'),
  cleanResult.replace('result=clean', 'result=\u0000clean'),
  cleanResult + '\u2028extra',
  cleanResult + '\u2029extra',
  '\u00a0' + cleanResult,
  '\ufeff' + cleanResult,
  cleanResult.replace('[', '［').replace(']', '］'),
  cleanResult.replace('clean', 'сlean'),
];
for (const body of hiddenResultCases) {
  assert.equal(isExactCleanReview(body, HEAD), false, 'decorated/noncanonical review must not authorize: ' + body.slice(0, 80));
}
assert.equal(isExactCleanReview(cleanResult, OTHER_HEAD), false);
assert.equal(isExactCleanReview(cleanResult, HEAD.toUpperCase()), false);
assert.equal(isExactCleanReview(' ' + cleanResult), false);
assert.equal(isExactCleanReview(cleanResult + '\n\n', HEAD), false);
assert.equal(isExactCleanReview(cleanResult.repeat(4), HEAD), false);
assert.equal(isExactCleanReview(null, HEAD), false);
assert.equal(isExactCleanReview('x'.repeat(257), HEAD), false);

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
const run = (overrides) => ({
  workflow_id: 1,
  run_number: 10,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  updated_at: '2026-08-28T00:50:00Z',
  ...overrides,
});
assert.equal(classifyLatestWorkflowRuns([
  run({conclusion: 'cancelled', updated_at: '2026-08-28T00:55:00Z'}),
], now).classification, 'transient');
assert.equal(classifyLatestWorkflowRuns([run()], now).classification, 'recent');
assert.equal(classifyLatestWorkflowRuns([
  run({conclusion: 'failure'}),
], now).classification, 'recent');
assert.equal(classifyLatestWorkflowRuns([
  run({conclusion: 'failure', updated_at: '2026-08-28T00:00:00Z'}),
], now).classification, 'failure');
assert.equal(classifyLatestWorkflowRuns([
  run({conclusion: 'timed_out', run_attempt: 2, updated_at: '2026-08-28T00:00:00Z'}),
], now).classification, 'none');
assert.equal(classifyLatestWorkflowRuns([
  run({run_number: 11, status: 'in_progress', conclusion: null, updated_at: '2026-08-28T00:59:00Z'}),
  run({run_number: 10, conclusion: 'failure', updated_at: '2026-08-28T00:00:00Z'}),
], now).classification, 'active');
for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
  assert.equal(classifyLatestWorkflowRuns([
    run({status, conclusion: null, updated_at: '2026-08-28T00:59:00Z'}),
  ], now).classification, 'active', status + ' must hold the continuation lease');
}
assert.equal(classifyLatestWorkflowRuns([
  run({status: 'future-github-status', conclusion: null}),
], now).classification, 'unknown');

// Run identity, not completion order, determines which workflow run is current.
const newerSuccessAfterOlderLateFailure = classifyLatestWorkflowRuns([
  run({run_number: 11, conclusion: 'success', updated_at: '2026-08-28T00:50:00Z'}),
  run({run_number: 10, conclusion: 'cancelled', updated_at: '2026-08-28T00:59:00Z'}),
], now);
assert.equal(newerSuccessAfterOlderLateFailure.classification, 'recent');
assert.equal(newerSuccessAfterOlderLateFailure.run.run_number, 11);
const latestAttemptWins = classifyLatestWorkflowRuns([
  run({run_number: 12, run_attempt: 2, conclusion: 'success', updated_at: '2026-08-28T00:45:00Z'}),
  run({run_number: 12, run_attempt: 1, conclusion: 'cancelled', updated_at: '2026-08-28T00:59:00Z'}),
], now);
assert.equal(latestAttemptWins.classification, 'recent');
assert.equal(latestAttemptWins.run.run_attempt, 2);
assert.equal(classifyLatestWorkflowRuns([
  run({run_number: 13, run_attempt: 2, conclusion: 'startup_failure', updated_at: '2026-08-28T00:00:00Z'}),
], now).classification, 'none');
const newerFailureBlocksOlderRetry = classifyLatestWorkflowRuns([
  run({run_number: 14, conclusion: 'failure', updated_at: '2026-08-28T00:00:00Z'}),
  run({run_number: 13, conclusion: 'timed_out', updated_at: '2026-08-28T00:59:00Z'}),
], now);
assert.equal(newerFailureBlocksOlderRetry.classification, 'failure');
assert.equal(newerFailureBlocksOlderRetry.run.run_number, 14);
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, status: 'completed', conclusion: 'cancelled', run_attempt: 1},
], now).classification, 'unknown');
assert.equal(classifyLatestWorkflowRuns([
  {workflow_id: 1, run_number: 15, status: 'completed', conclusion: 'cancelled'},
], now).classification, 'unknown');

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

const nowForFreshness = new Date('2026-08-28T04:00:00Z').getTime();
const freshness = (comments, body = '') => assessContinuationFreshness({
  comments,
  reviews: [],
  body,
  nowMs: nowForFreshness,
});
const recentEditedTask = {
  user: {login: 'APReddy-AutoBotz'},
  body: '@codex continue implementation',
  created_at: '2026-08-28T01:00:00Z',
  updated_at: '2026-08-28T03:55:00Z',
};
assert.equal(freshness([recentEditedTask]).shouldPost, false);
const recentEditedBot = {
  user: {login: 'chatgpt-codex-connector[bot]'},
  body: 'still working',
  created_at: '2026-08-28T01:10:00Z',
  updated_at: '2026-08-28T03:55:00Z',
};
assert.equal(freshness([
  {user: {login: 'APReddy-AutoBotz'}, body: '@codex task', created_at: '2026-08-28T01:00:00Z', updated_at: '2026-08-28T01:00:00Z'},
  recentEditedBot,
]).shouldPost, false);
const recentEditedAutopick = {
  user: {login: 'github-actions[bot]'},
  body: '[WORKOS-CONTROLLER-AUTOPICK]',
  created_at: '2026-08-28T01:15:00Z',
  updated_at: '2026-08-28T03:55:00Z',
};
assert.equal(freshness([
  {user: {login: 'APReddy-AutoBotz'}, body: '@codex task', created_at: '2026-08-28T01:00:00Z'},
  {user: {login: 'chatgpt-codex-connector[bot]'}, body: 'working', created_at: '2026-08-28T01:10:00Z'},
  recentEditedAutopick,
]).shouldPost, false);
assert.equal(freshness([]).shouldPost, true);
assert.equal(freshness([], 'dependency-blocked; do not resume').shouldPost, false);
assert.equal(freshness([{user: {login: 'APReddy-AutoBotz'}, body: '@codex task'}]).shouldPost, false);

const source = readFileSync(require.resolve('./workos-continuous-controller.cjs'), 'utf8');
assert.match(source, /fresh\.mergeable !== true \|\| fresh\.mergeable_state !== 'clean'/);
assert.match(source, /check\.status !== 'completed' \|\| check\.conclusion !== 'success'/);
assert.match(source, /unresolved\.length > 0/);
assert.match(source, /reviewDecision === 'CHANGES_REQUESTED'/);
assert.match(source, /DECISIVE_REVIEW_STATES/);
assert.match(source, /function normalizeAuthorityBody/);
assert.match(source, /function isExactReviewRequest/);
assert.match(source, /function isExactCleanReview/);
assert.doesNotMatch(source, /NON_AUTHORITATIVE_REVIEW_PATTERN|CONTRADICTORY_REVIEW_PATTERN|findStandaloneCleanResult/);
assert.match(source, /combined\.data\.state/);
assert.match(source, /comment\.user\?\.login === owner/);
assert.match(source, /occursAfterReviewRequest\(comment, reviewRequest\)/);
assert.match(source, /authorityTimestamp\(comment\) > headTime\.getTime\(\)/);
assert.match(source, /no independent structured clean result after the exact review request/);
assert.match(source, /WORKFLOW_ACTIVITY_FRESHNESS_MS/);
assert.match(source, /classification: 'workflow-recent'/);
assert.match(source, /run\.run_number/);
assert.match(source, /run\.run_attempt/);
assert.match(source, /authorityTimestamp\(b\) - authorityTimestamp\(a\)/);
assert.match(source, /github\.rest\.pulls\.listReviews/);
assert.match(source, /reviewAge >= 45 \* MINUTE/);
assert.match(source, /sha: afterGates\.head\.sha/);
assert.match(source, /merge_method: 'squash'/);
const finalValidationStart = source.indexOf('const final =');
const finalMergeStart = source.indexOf('const result = await github.rest.pulls.merge', finalValidationStart);
assert.ok(finalValidationStart >= 0 && finalMergeStart > finalValidationStart);
const finalValidation = source.slice(finalValidationStart, finalMergeStart);
assert.match(finalValidation, /finalChecks = await inspectChecks/);
assert.match(finalValidation, /finalReview = await inspectReviewGate/);
assert.match(finalValidation, /const afterGates =/);
assert.match(finalValidation, /afterGates\.mergeable_state !== 'clean'/);
const finalChecksAt = finalValidation.indexOf('const finalChecks =');
const finalReviewAt = finalValidation.indexOf('const finalReview =');
const afterGatesAt = finalValidation.indexOf('const afterGates =');
assert.ok(finalChecksAt >= 0 && finalChecksAt < finalReviewAt && finalReviewAt < afterGatesAt);
assert.ok(afterGatesAt < finalValidation.indexOf('afterGatesLease'));

assert.match(source, /LEGACY_HEARTBEAT_MARKER/);
assert.match(source, /const finalMain =/);
assert.match(source, /const finalPulls =/);
assert.match(source, /classification: 'workflow-active'/);
assert.match(source, /classification: 'gate-failure-codex-continuation'/);
assert.doesNotMatch(source, /markPullRequestReadyForReview|mark_pull_request_ready/);
assert.doesNotMatch(source, /github\.rest\.deployments|createDeployment|createOrUpdateEnvironmentSecret|createOrUpdateRepoSecret/);

function buildMergeHarness({
  afterGatesChanges = {},
  finalCheckFails = false,
  finalReviewFails = false,
  requestBody = reviewRequest,
  requestLogin = 'APReddy-AutoBotz',
  requestCreated = '2026-08-28T00:05:00Z',
  requestUpdated = requestCreated,
  resultBody = cleanResult,
  resultLogin = 'chatgpt-codex-connector[bot]',
  resultCreated = '2026-08-28T00:06:00Z',
  resultUpdated = '2026-08-28T00:06:00Z',
  extraComments = [],
  extraReviews = [],
  commitDate = '2026-08-28T00:00:00Z',
} = {}) {
  let pullReads = 0;
  let checkReads = 0;
  let reviewReads = 0;
  let mergeArgs = null;
  const basePr = {
    number: 27,
    title: 'CTRL: guarded merge test',
    state: 'open',
    draft: false,
    head: {sha: HEAD},
    base: {sha: BASE},
    body: '[WORKOS-AUTO-MERGE head=' + HEAD + ' base=' + BASE + ']',
    mergeable: true,
    mergeable_state: 'clean',
  };
  const listForRef = () => {};
  const listReviews = () => {};
  const listComments = () => {};
  const comments = [
    {
      user: {login: requestLogin},
      body: requestBody,
      created_at: requestCreated,
      updated_at: requestUpdated,
    },
    {
      user: {login: resultLogin},
      body: resultBody,
      created_at: resultCreated,
      updated_at: resultUpdated,
    },
    ...extraComments,
  ];
  const github = {
    rest: {
      pulls: {
        get: async () => {
          pullReads += 1;
          const data = pullReads < 3
            ? JSON.parse(JSON.stringify(basePr))
            : {...JSON.parse(JSON.stringify(basePr)), ...afterGatesChanges};
          return {data};
        },
        listReviews,
        merge: async (args) => {
          mergeArgs = args;
          return {data: {merged: true, sha: 'd'.repeat(40)}};
        },
      },
      checks: {listForRef},
      repos: {
        getCombinedStatusForRef: async () => ({data: {statuses: [], state: 'success'}}),
        getCommit: async () => ({data: {commit: {committer: {date: commitDate}}}}),
      },
      issues: {listComments},
    },
    paginate: async (endpoint) => {
      if (endpoint === listForRef) {
        checkReads += 1;
        if (finalCheckFails && checkReads === 2) {
          return [{name: 'final', status: 'completed', conclusion: 'failure'}];
        }
        return [{name: 'all', status: 'completed', conclusion: 'success'}];
      }
      if (endpoint === listReviews) return extraReviews;
      if (endpoint === listComments) return comments;
      throw new Error('unexpected paginated endpoint');
    },
    graphql: async () => {
      reviewReads += 1;
      const unresolved = finalReviewFails && reviewReads === 2;
      return {
        repository: {
          pullRequest: {
            reviewDecision: unresolved ? 'CHANGES_REQUESTED' : null,
            reviewThreads: {
              nodes: unresolved ? [{isResolved: false}] : [],
              pageInfo: {hasNextPage: false},
            },
          },
        },
      };
    },
  };
  return {
    github,
    get counts() { return {pullReads, checkReads, reviewReads}; },
    get mergeArgs() { return mergeArgs; },
  };
}

async function verifyReviewGateContext() {
  const valid = buildMergeHarness();
  const validGate = await inspectReviewGate({
    github: valid.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(validGate.clean, true);

  const invalidContexts = [
    {requestBody: '~~~text\n' + reviewRequest + '\n~~~'},
    {requestBody: '<!--\n' + reviewRequest + '\n-->'},
    {requestBody: reviewRequest, requestLogin: 'other-owner'},
    {resultBody: '<!--\n' + cleanResult + '\n-->'},
    {resultBody: cleanResult + '\nA serious authorization flaw remains.'},
    {resultBody: cleanResult + '\n[WORKOS-INDEPENDENT-REVIEW-RESULT head=invalid]'},
    {resultBody: cleanResult, resultLogin: 'APReddy-AutoBotz'},
    {resultBody: 'Implementation complete; I reviewed this and it looks clean.', resultLogin: 'chatgpt-codex-connector[bot]'},
    {
      extraReviews: [{
        user: {login: 'chatgpt-codex-connector[bot]'},
        state: 'COMMENTED',
        body: 'A P1 authorization finding remains in the latest review.',
        submitted_at: '2026-08-28T00:07:00Z',
      }],
    },
    {
      extraComments: [{
        user: {login: 'chatgpt-codex-connector[bot]'},
        body: 'A P1 authorization finding remains open in the latest review.',
        created_at: '2026-08-28T00:07:00Z',
        updated_at: '2026-08-28T00:07:00Z',
      }],
    },
    {
      extraComments: [{
        user: {login: 'chatgpt-codex-connector[bot]'},
        body: 'Implementation complete; I changed source files.',
        created_at: '2026-08-28T00:07:00Z',
        updated_at: '2026-08-28T00:07:00Z',
      }],
    },
    {resultCreated: '2026-08-28T00:04:00Z', resultUpdated: '2026-08-28T00:04:00Z'},
    {requestBody: reviewRequest.replace(HEAD, OTHER_HEAD)},
  ];
  for (const options of invalidContexts) {
    const harness = buildMergeHarness(options);
    const gate = await inspectReviewGate({
      github: harness.github,
      owner: 'APReddy-AutoBotz',
      repo: 'repo',
      pr: {number: 27, head: {sha: HEAD}},
    });
    assert.equal(gate.clean, false, 'non-authoritative request/result context must fail closed');
  }

  const laterBlockedComment = buildMergeHarness({
    extraComments: [{
      user: {login: 'chatgpt-codex-connector[bot]'},
      body: '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + HEAD + ' result=blocked p0=0 p1=1 p2=0]',
      created_at: '2026-08-28T00:07:00Z',
      updated_at: '2026-08-28T00:07:00Z',
    }],
  });
  const laterBlockedCommentGate = await inspectReviewGate({
    github: laterBlockedComment.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(laterBlockedCommentGate.clean, false, 'a later blocked result invalidates an earlier clean result');

  const laterBlockedReview = buildMergeHarness({
    extraReviews: [{
      user: {login: 'chatgpt-codex-connector[bot]'},
      state: 'COMMENTED',
      body: '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + HEAD + ' result=blocked p0=0 p1=1 p2=0]',
      submitted_at: '2026-08-28T00:07:00Z',
    }],
  });
  const laterBlockedReviewGate = await inspectReviewGate({
    github: laterBlockedReview.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(laterBlockedReviewGate.clean, false, 'a later blocked submitted review invalidates an earlier clean result');

  const laterCleanSupersedesBlocked = buildMergeHarness({
    extraComments: [
      {
        user: {login: 'chatgpt-codex-connector[bot]'},
        body: '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + HEAD + ' result=blocked p0=0 p1=1 p2=0]',
        created_at: '2026-08-28T00:07:00Z',
        updated_at: '2026-08-28T00:07:00Z',
      },
      {
        user: {login: 'chatgpt-codex-connector[bot]'},
        body: cleanResult,
        created_at: '2026-08-28T00:08:00Z',
        updated_at: '2026-08-28T00:08:00Z',
      },
    ],
  });
  const laterCleanGate = await inspectReviewGate({
    github: laterCleanSupersedesBlocked.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(laterCleanGate.clean, true, 'a later clean result may supersede an earlier blocked result');

  const tiedCleanAndBlocked = buildMergeHarness({
    extraComments: [{
      user: {login: 'chatgpt-codex-connector[bot]'},
      body: '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + HEAD + ' result=blocked p0=0 p1=1 p2=0]',
      created_at: '2026-08-28T00:06:00Z',
      updated_at: '2026-08-28T00:06:00Z',
    }],
  });
  const tiedGate = await inspectReviewGate({
    github: tiedCleanAndBlocked.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(tiedGate.clean, false, 'a same-time conflicting result fails closed');

  const unparseableHeadTime = buildMergeHarness({commitDate: 'not-a-date'});
  const unparseableHeadGate = await inspectReviewGate({
    github: unparseableHeadTime.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(unparseableHeadGate.clean, false, 'missing exact commit time fails closed');

  const sameTimeRequestAsCommit = buildMergeHarness({
    requestCreated: '2026-08-28T00:00:00Z',
    requestUpdated: '2026-08-28T00:00:00Z',
  });
  const sameTimeRequestGate = await inspectReviewGate({
    github: sameTimeRequestAsCommit.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(sameTimeRequestGate.clean, false, 'request timestamp must be strictly later than the head commit');

  const editedAfterCommitRequest = buildMergeHarness({
    requestCreated: '2026-08-27T23:00:00Z',
    requestUpdated: '2026-08-28T00:05:00Z',
  });
  const editedGate = await inspectReviewGate({
    github: editedAfterCommitRequest.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    pr: {number: 27, head: {sha: HEAD}},
  });
  assert.equal(editedGate.clean, true, 'a post-commit edit is a fresh owner request');
}

async function verifyGeneratedContinuationPrompt() {
  let posted = null;
  const listComments = () => {};
  const listReviews = () => {};
  const github = {
    rest: {
      issues: {
        listComments,
        createComment: async (args) => { posted = args.body; },
      },
      pulls: {listReviews},
    },
    paginate: async (endpoint) => {
      if (endpoint === listComments || endpoint === listReviews) return [];
      throw new Error('unexpected continuation endpoint');
    },
  };
  const outcome = await maybeAutopick({
    github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    active: {number: 27, head: {sha: HEAD}, body: ''},
  });
  assert.equal(outcome.posted, true);
  assert.match(posted, /Keep the PR Draft unconditionally/);
  assert.match(posted, /Do not mark Ready/);
  assert.match(posted, /Do not merge/);
  assert.match(posted, /separate explicit owner action outside the autonomous controller/);
  assert.doesNotMatch(posted, /Keep Draft unless|merge only when explicitly permitted/);

  let freshPostCount = 0;
  const freshListComments = () => {};
  const freshListReviews = () => {};
  const recentEditTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const oldCreateTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const editedTask = {
    user: {login: 'APReddy-AutoBotz'},
    body: '@codex active task',
    created_at: oldCreateTime,
    updated_at: recentEditTime,
  };
  const freshGithub = {
    rest: {
      issues: {
        listComments: freshListComments,
        createComment: async () => { freshPostCount += 1; },
      },
      pulls: {listReviews: freshListReviews},
    },
    paginate: async (endpoint) => {
      if (endpoint === freshListComments) return [editedTask];
      if (endpoint === freshListReviews) return [];
      throw new Error('unexpected fresh-continuation endpoint');
    },
  };
  const freshOutcome = await maybeAutopick({
    github: freshGithub,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    active: {number: 27, head: {sha: HEAD}, body: ''},
  });
  assert.equal(freshOutcome.posted, false);
  assert.equal(freshPostCount, 0);
}

async function verifyFinalMergeRevalidation() {
  const passing = buildMergeHarness();
  const passed = await attemptGuardedMerge({
    github: passing.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    candidate: {number: 27},
  });
  assert.equal(passed.performed, true);
  assert.equal(passing.counts.pullReads, 3);
  assert.equal(passing.counts.checkReads, 2);
  assert.equal(passing.counts.reviewReads, 2);
  assert.equal(passing.mergeArgs.sha, HEAD);

  const mutations = [
    {draft: true},
    {state: 'closed'},
    {head: {sha: OTHER_HEAD}},
    {base: {sha: OTHER_HEAD}},
    {body: 'owner lease was removed'},
    {mergeable: false},
    {mergeable_state: 'dirty'},
  ];
  for (const afterGatesChanges of mutations) {
    const harness = buildMergeHarness({afterGatesChanges});
    const result = await attemptGuardedMerge({
      github: harness.github,
      owner: 'APReddy-AutoBotz',
      repo: 'repo',
      candidate: {number: 27},
    });
    assert.equal(result.performed, false, 'post-gate PR metadata changes must block merge');
    assert.equal(harness.mergeArgs, null);
  }

  const failedFinalCheck = buildMergeHarness({finalCheckFails: true});
  const checkBlocked = await attemptGuardedMerge({
    github: failedFinalCheck.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    candidate: {number: 27},
  });
  assert.equal(checkBlocked.performed, false);
  assert.equal(failedFinalCheck.mergeArgs, null);

  const changedFinalReview = buildMergeHarness({finalReviewFails: true});
  const reviewBlocked = await attemptGuardedMerge({
    github: changedFinalReview.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    candidate: {number: 27},
  });
  assert.equal(reviewBlocked.performed, false);
  assert.equal(changedFinalReview.mergeArgs, null);
}

async function verifyNonterminalWorkflowDoesNotAutopick() {
  for (const status of ['waiting', 'requested', 'pending', 'future-github-status']) {
    const listPulls = () => {};
    const listComments = () => {};
    const postedBodies = [];
    let rerunCalls = 0;
    const activePr = {
      number: 28,
      title: 'WOS-02: active test',
      state: 'open',
      draft: true,
      updated_at: new Date().toISOString(),
      body: '',
      head: {sha: HEAD},
      base: {sha: BASE},
    };
    const github = {
      rest: {
        pulls: {list: listPulls},
        actions: {
          listWorkflowRunsForRepo: async () => ({
            data: {
              workflow_runs: [run({
                run_number: 99,
                run_attempt: 1,
                status,
                conclusion: null,
                updated_at: new Date().toISOString(),
              })],
            },
          }),
          reRunWorkflow: async () => { rerunCalls += 1; },
        },
        repos: {
          getBranch: async () => ({data: {commit: {sha: BASE}}}),
        },
        issues: {
          listComments,
          createComment: async (args) => { postedBodies.push(args.body); },
          updateComment: async (args) => { postedBodies.push(args.body); },
        },
      },
      paginate: async (endpoint, params) => {
        if (endpoint === listPulls) return [activePr];
        if (endpoint === listComments && params.issue_number === 3) return [];
        if (endpoint === listComments && params.issue_number === 28) return [];
        throw new Error('unexpected controller-run endpoint');
      },
    };
    const summary = {
      addHeading() { return this; },
      addRaw() { return this; },
      addEOL() { return this; },
      write() { return this; },
    };
    const action = await runController({
      github,
      context: {repo: {owner: 'APReddy-AutoBotz', repo: 'WorkOS'}},
      core: {summary},
    });
    assert.equal(
      action.classification,
      status === 'future-github-status' ? 'workflow-unknown' : 'workflow-active',
    );
    assert.equal(rerunCalls, 0);
    assert.equal(postedBodies.some((body) => body.includes('[WORKOS-CONTROLLER-AUTOPICK]')), false);
  }
}

async function runAsyncTests() {
  await verifyReviewGateContext();
  await verifyGeneratedContinuationPrompt();
  await verifyFinalMergeRevalidation();
  await verifyNonterminalWorkflowDoesNotAutopick();
}

runAsyncTests().then(() => console.log(JSON.stringify({
  status: 'passed',
  policy: 'ten-minute guarded continuous controller',
  exactLease: true,
  strictChecks: true,
  structuredIndependentReview: true,
  latestReviewResultWins: true,
  requestStrictlyAfterCommit: true,
  wholeResponseReviewResult: true,
  aggregateCommitStatus: true,
  finalMutableGateRevalidation: true,
  postGateMetadataRevalidation: true,
  editedRequestOrdering: true,
  findingBearingResultRejected: true,
  negativeReviewLanguageRejected: true,
  latestWorkflowAttemptSelection: true,
  nonterminalWorkflowNoAutopick: true,
  editedCommentFreshness: true,
  recentWorkflowFreshness: true,
  submittedReviewFreshness: true,
  decisiveReviewState: true,
  postActionRefetch: true,
  legacyHeartbeatMigration: true,
  neverAutoReady: true,
}, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
