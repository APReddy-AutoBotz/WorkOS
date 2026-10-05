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
  parseMergeAuthorization,
  selectActiveDraft,
  selectMergeCandidate,
} = require('./workos-continuous-controller.cjs');

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const MAIN_SHA = BASE;
const REPOSITORY = 'APReddy-AutoBotz/WorkOS';
const WOS02_TASK_PATH = 'docs/tasks/WOS-02-ORGANIZATION-SETUP-FOUNDATION.md';
const WOS02_BRANCH = 'codex/wos-02-organization-setup-foundation';
const WOS02_TASK_DOC = readFileSync(
  `${__dirname}/../../docs/tasks/WOS-02-ORGANIZATION-SETUP-FOUNDATION.md`,
  'utf8',
);

function continuationBody({taskPath = WOS02_TASK_PATH, issue = 4} = {}) {
  return [
    'WORKOS-CONTINUATION-LANE: product-implementation',
    `WORKOS-GOVERNING-TASK: ${taskPath}`,
    `WORKOS-GOVERNING-ISSUE: ${issue}`,
    '',
    'Continue only this governing product task.',
  ].join('\n');
}

function productDraft({
  number = 27,
  title = 'WOS-02: Organization foundation',
  branch = WOS02_BRANCH,
  body = continuationBody(),
  headSha = HEAD,
  baseSha = MAIN_SHA,
  baseRef = 'main',
  headRepo = REPOSITORY,
  baseRepo = REPOSITORY,
} = {}) {
  return {
    number,
    title,
    state: 'open',
    draft: true,
    body,
    updated_at: '2026-08-28T01:00:00Z',
    head: {sha: headSha, ref: branch, repo: {full_name: headRepo}},
    base: {sha: baseSha, ref: baseRef, repo: {full_name: baseRepo}},
  };
}

function encodedTaskFile(markdown = WOS02_TASK_DOC) {
  const bytes = Buffer.from(markdown, 'utf8');
  return {data: {type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64')}};
}

function taskLookup({markdown = WOS02_TASK_DOC, error = null} = {}) {
  const calls = [];
  const github = {
    rest: {
      repos: {
        getContent: async (args) => {
          calls.push(args);
          if (error) throw error;
          return encodedTaskFile(markdown);
        },
      },
    },
  };
  return {github, calls};
}

assert.deepEqual(
  parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD} base=${BASE}]`),
  {head: HEAD, base: BASE},
);
assert.equal(parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD}]`), null);
assert.equal(parseMergeLease(`[WORKOS-AUTO-MERGE head=${HEAD} base=${'c'.repeat(39)}]`), null);
const mergeAuthorization = '@codex merge\n[WORKOS-AUTO-MERGE head=' + HEAD + ' base=' + BASE + ']';
assert.deepEqual(parseMergeAuthorization(mergeAuthorization), {head: HEAD, base: BASE});
assert.deepEqual(parseMergeAuthorization(mergeAuthorization + '\n'), {head: HEAD, base: BASE});
assert.deepEqual(parseMergeAuthorization(mergeAuthorization.replace(/\n/g, '\r\n')), {head: HEAD, base: BASE});
assert.equal(parseMergeAuthorization('I authorize merge:\n' + mergeAuthorization), null);
assert.deepEqual(parseMergeAuthorization(mergeAuthorization.replace(HEAD, OTHER_HEAD)), {head: OTHER_HEAD, base: BASE});
assert.equal(parseMergeAuthorization(mergeAuthorization.toUpperCase()), null);

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
assert.equal(selectMergeCandidate(pulls), null);

const ready = {
  ...pulls[0],
  draft: false,
  body: `[WORKOS-AUTO-MERGE head=${HEAD} base=${BASE}]`,
};
assert.equal(selectMergeCandidate([ready]), null, 'a PR body marker alone cannot authorize an automatic merge');
const authorizedReady = new Map([[27, {head: HEAD, base: BASE}]]);
assert.equal(selectMergeCandidate([ready], authorizedReady).number, 27);
assert.equal(selectMergeCandidate([{...ready, body: `[WORKOS-AUTO-MERGE head=${OTHER_HEAD} base=${BASE}]`}], authorizedReady), null);
assert.equal(selectMergeCandidate([ready], new Map([[27, {head: OTHER_HEAD, base: BASE}]])), null);

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
  mergeIntentBody = mergeAuthorization,
  mergeIntentLogin = 'APReddy-AutoBotz',
  mergeIntentCreated = '2026-08-28T00:01:00Z',
  mergeIntentUpdated = mergeIntentCreated,
  hideMergeIntentAfterRead = Infinity,
  extraComments = [],
  extraReviews = [],
  commitDate = '2026-08-28T00:00:00Z',
} = {}) {
  let pullReads = 0;
  let checkReads = 0;
  let reviewReads = 0;
  let commentReads = 0;
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
    {
      id: 2001,
      user: {login: mergeIntentLogin},
      body: mergeIntentBody,
      created_at: mergeIntentCreated,
      updated_at: mergeIntentUpdated,
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
      if (endpoint === listComments) {
        commentReads += 1;
        return commentReads > hideMergeIntentAfterRead
          ? comments.filter((comment) => comment.id !== 2001)
          : comments;
      }
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
    get counts() { return {pullReads, checkReads, reviewReads, commentReads}; },
    get mergeArgs() { return mergeArgs; },
  };
}

async function verifyProductLaneSelector() {
  const valid = productDraft({title: 'Alternative title; task authority is controlling'});
  const controller = {
    ...productDraft({number: 28, title: 'CTRL: Add guarded monitoring', branch: 'controller/workos-continuous-controller-v2'}),
    body: '## Outcome\nController-only work. No product continuation authority is declared.',
  };
  const acceptance = {
    ...productDraft({number: 38, title: 'WOS-02 CTRL: Exact-head acceptance', branch: 'controller/wos02-exact-acceptance'}),
    body: '## Purpose\nRead-only exact-head acceptance controller for product PR #37.\n\nGoverning issue/task: #4 / `docs/tasks/WOS-02-ORGANIZATION-SETUP-FOUNDATION.md`.',
  };

  const lookup = taskLookup();
  const selected = await selectActiveDraft({
    github: lookup.github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [controller, acceptance, valid],
    mainSha: MAIN_SHA,
  });
  assert.equal(selected.number, valid.number, 'only a Draft with explicit product task authority is selected');
  assert.deepEqual(lookup.calls, [{
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    path: WOS02_TASK_PATH,
    ref: MAIN_SHA,
  }], 'the governing task is read from current main, not the candidate head');

  const currentPullsOnly = taskLookup();
  const currentSelection = await selectActiveDraft({
    github: currentPullsOnly.github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [controller, acceptance],
    mainSha: MAIN_SHA,
  });
  assert.equal(currentSelection, null, 'the actual #28 and #38 controller/evidence lanes are not product candidates');
  assert.equal(currentPullsOnly.calls.length, 0, 'undeclared lanes are excluded before task lookup');

  const wrongBranch = productDraft({
    number: 38,
    title: 'WOS-02: acceptance evidence',
    branch: 'controller/wos02-exact-acceptance',
  });
  const wrongBranchLookup = taskLookup();
  assert.equal(await selectActiveDraft({
    github: wrongBranchLookup.github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [wrongBranch],
    mainSha: MAIN_SHA,
  }), null, 'a product task path cannot authorize the acceptance controller branch');

  const duplicateMetadata = productDraft({body: continuationBody() + '\nWORKOS-CONTINUATION-LANE: product-implementation'});
  assert.equal(await selectActiveDraft({
    github: taskLookup().github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [duplicateMetadata],
    mainSha: MAIN_SHA,
  }), null, 'duplicate lane declarations fail closed');

  const wrongIssue = productDraft({body: continuationBody({issue: 5})});
  assert.equal(await selectActiveDraft({
    github: taskLookup().github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [wrongIssue],
    mainSha: MAIN_SHA,
  }), null, 'the issue identifier must match the authoritative task document');

  const missingSeparator = productDraft({body: continuationBody().replace('\n\nContinue', '\nContinue')});
  assert.equal(await selectActiveDraft({
    github: taskLookup().github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [missingSeparator],
    mainSha: MAIN_SHA,
  }), null, 'the canonical authority block must be followed by a blank line');

  const wrongBase = productDraft({baseRef: 'release'});
  assert.equal(await selectActiveDraft({
    github: taskLookup().github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [wrongBase],
    mainSha: MAIN_SHA,
  }), null, 'a non-main base is ineligible');

  const crossRepositoryHead = productDraft({headRepo: 'APReddy-AutoBotz/WorkOS-fork'});
  assert.equal(await selectActiveDraft({
    github: taskLookup().github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [crossRepositoryHead],
    mainSha: MAIN_SHA,
  }), null, 'cross-repository heads are ineligible');

  const controllerLaneDoc = WOS02_TASK_DOC.replace(
    '- **Controller continuation lane:** `product-implementation`',
    '- **Controller continuation lane:** `controller-only`',
  );
  assert.equal(await selectActiveDraft({
    github: taskLookup({markdown: controllerLaneDoc}).github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [valid],
    mainSha: MAIN_SHA,
  }), null, 'non-product task lanes are ineligible');

  const twoProductsLookup = taskLookup();
  assert.equal(await selectActiveDraft({
    github: twoProductsLookup.github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [valid, productDraft({number: 29, branch: WOS02_BRANCH})],
    mainSha: MAIN_SHA,
  }), null, 'multiple eligible Drafts are ambiguous and do not produce an autopick');

  const unreadableTask = taskLookup({error: new Error('task not found on main')});
  assert.equal(await selectActiveDraft({
    github: unreadableTask.github,
    owner: 'APReddy-AutoBotz',
    repo: 'WorkOS',
    pulls: [valid],
    mainSha: MAIN_SHA,
  }), null, 'missing authoritative task data fails closed');
}

async function verifyControllerLanesDoNotStartContinuation() {
  const listPulls = () => {};
  const listComments = () => {};
  const posted = [];
  let taskLookups = 0;
  const controller = {
    number: 28,
    title: 'CTRL: Add guarded continuous WorkOS monitoring',
    state: 'open',
    draft: true,
    updated_at: new Date().toISOString(),
    body: 'Controller-only work; no product lane declaration.',
    head: {sha: HEAD, ref: 'controller/workos-continuous-controller-v2', repo: {full_name: REPOSITORY}},
    base: {sha: MAIN_SHA, ref: 'main', repo: {full_name: REPOSITORY}},
  };
  const acceptance = {
    number: 38,
    title: 'WOS-02 CTRL: Exact-head organization/setup acceptance',
    state: 'open',
    draft: true,
    updated_at: new Date(Date.now() + 1000).toISOString(),
    body: 'Read-only exact-head acceptance controller; Governing task: `docs/tasks/WOS-02-ORGANIZATION-SETUP-FOUNDATION.md`.',
    head: {sha: OTHER_HEAD, ref: 'controller/wos02-exact-acceptance', repo: {full_name: REPOSITORY}},
    base: {sha: MAIN_SHA, ref: 'main', repo: {full_name: REPOSITORY}},
  };
  const github = {
    rest: {
      pulls: {list: listPulls},
      repos: {
        getBranch: async () => ({data: {commit: {sha: MAIN_SHA}}}),
        getContent: async () => { taskLookups += 1; return encodedTaskFile(); },
      },
      issues: {
        listComments,
        createComment: async (args) => { posted.push(args); },
        updateComment: async (args) => { posted.push(args); },
      },
    },
    paginate: async (endpoint, params, mapFunction) => {
      if (endpoint === listPulls) return [acceptance, controller];
      if (endpoint === listComments && params.issue_number === 3) return [];
      throw new Error('unexpected controller-lane endpoint');
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
  assert.equal(action.classification, 'waiting');
  assert.equal(taskLookups, 0);
  assert.equal(posted.length, 1, 'the only post is the controller heartbeat on issue #3');
  assert.equal(posted[0].issue_number, 3);
  assert.equal(posted.some((comment) => comment.issue_number === 28 || comment.issue_number === 38), false);
  assert.equal(posted.some((comment) => /@codex/i.test(comment.body || '')), false);
}

async function verifyLiveLaneRevalidationBeforeContinuation() {
  const listPulls = () => {};
  const listComments = () => {};
  const listReviews = () => {};
  const listWorkflowRuns = () => {};
  const posts = [];
  const events = [];
  let pullListCalls = 0;
  let mainReads = 0;
  let taskLookups = 0;
  const eligibleAtStart = productDraft({number: 27});
  const revokedDuringFreshnessReads = {
    ...eligibleAtStart,
    body: 'Lane authority was removed while the controller was checking workflow freshness.',
  };
  const controllerPr = {
    number: 28,
    title: 'CTRL: Add guarded continuous WorkOS monitoring',
    state: 'open',
    draft: true,
    body: 'Controller-only scope.',
    head: {sha: OTHER_HEAD, ref: 'controller/workos-continuous-controller-v2', repo: {full_name: REPOSITORY}},
    base: {sha: MAIN_SHA, ref: 'main', repo: {full_name: REPOSITORY}},
  };
  const github = {
    rest: {
      pulls: {list: listPulls, listReviews},
      actions: {listWorkflowRunsForRepo: listWorkflowRuns},
      repos: {
        getBranch: async () => {
          mainReads += 1;
          events.push(`main-read-${mainReads}`);
          return {data: {commit: {sha: MAIN_SHA}}};
        },
        getContent: async () => { taskLookups += 1; return encodedTaskFile(); },
      },
      issues: {
        listComments,
        createComment: async (args) => { posts.push(args); },
        updateComment: async (args) => { posts.push(args); },
      },
    },
    paginate: async (endpoint, params, mapFunction) => {
      if (endpoint === listPulls) {
        pullListCalls += 1;
        events.push(`pull-list-${pullListCalls}`);
        return pullListCalls === 1 ? [eligibleAtStart] : [revokedDuringFreshnessReads, controllerPr];
      }
      if (endpoint === listWorkflowRuns) return mapFunction({data: {workflow_runs: []}});
      if (endpoint === listComments && params.issue_number === 3) return [];
      if (endpoint === listComments && params.issue_number === 27) {
        events.push('freshness-comments');
        return [];
      }
      if (endpoint === listReviews && params.pull_number === 27) {
        events.push('freshness-reviews');
        return [];
      }
      throw new Error('unexpected lane-revalidation endpoint');
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
  assert.equal(action.classification, 'waiting');
  assert.equal(pullListCalls, 3, 'the candidate set is re-read before any continuation and for final reporting');
  assert.equal(taskLookups, 1, 'the now-ineligible task is not re-read from a stale selector result');
  assert.equal(posts.length, 1, 'only the issue #3 state heartbeat is posted');
  assert.equal(posts[0].issue_number, 3);
  assert.equal(posts.some((comment) => comment.issue_number === 27), false);
  assert.equal(posts.some((comment) => /@codex/i.test(comment.body || '')), false);
  const revalidationIndex = events.indexOf('main-read-2');
  assert.ok(events.indexOf('freshness-comments') < revalidationIndex);
  assert.ok(events.indexOf('freshness-reviews') < revalidationIndex);
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

async function verifyContinuationFreshnessFinalBoundary() {
  for (const activityKind of ['task-comment', 'submitted-review']) {
    const listComments = () => {};
    const listReviews = () => {};
    const events = [];
    let commentReads = 0;
    let reviewReads = 0;
    let posted = 0;
    const freshTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const taskComment = {
      user: {login: 'APReddy-AutoBotz'},
      body: '@codex continue the current task',
      created_at: freshTime,
      updated_at: freshTime,
    };
    const submittedReview = {
      user: {login: 'reviewer'},
      state: 'COMMENTED',
      submitted_at: freshTime,
    };
    const github = {
      rest: {
        issues: {
          listComments,
          createComment: async () => { posted += 1; events.push('posted'); },
        },
        pulls: {listReviews},
      },
      paginate: async (endpoint) => {
        if (endpoint === listComments) {
          commentReads += 1;
          events.push('comments-' + commentReads);
          return activityKind === 'task-comment' && commentReads > 1 ? [taskComment] : [];
        }
        if (endpoint === listReviews) {
          reviewReads += 1;
          events.push('reviews-' + reviewReads);
          return activityKind === 'submitted-review' && reviewReads > 1 ? [submittedReview] : [];
        }
        throw new Error('unexpected continuation freshness endpoint');
      },
    };
    const outcome = await maybeAutopick({
      github,
      owner: 'APReddy-AutoBotz',
      repo: 'WorkOS',
      active: {number: 27, head: {sha: HEAD}, body: ''},
      validateBeforePost: async (candidate) => {
        events.push('lane-revalidated');
        return candidate;
      },
    });
    assert.equal(outcome.posted, false, `a new ${activityKind} during lane revalidation blocks the continuation`);
    assert.equal(posted, 0);
    assert.ok(events.indexOf('lane-revalidated') < events.indexOf('comments-2'));
    assert.ok(events.indexOf('lane-revalidated') < events.indexOf('reviews-2'));
  }
}

async function verifyContinuationFreshnessAfterFinalChecks() {
  for (const arrivalPoint of ['workflow-recheck', 'final-lane-recheck']) {
    for (const activityKind of ['task-comment', 'submitted-review']) {
      const listComments = () => {};
      const listReviews = () => {};
      const listWorkflowRuns = () => {};
      const events = [];
      let commentReads = 0;
      let reviewReads = 0;
      let validationReads = 0;
      let activityVisible = false;
      let posted = 0;
      const freshTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const taskComment = {
        user: {login: 'APReddy-AutoBotz'},
        body: '@codex continue the current task',
        created_at: freshTime,
        updated_at: freshTime,
      };
      const submittedReview = {
        user: {login: 'reviewer'},
        state: 'COMMENTED',
        submitted_at: freshTime,
      };
      const github = {
        rest: {
          issues: {
            listComments,
            createComment: async () => { posted += 1; events.push('posted'); },
          },
          pulls: {listReviews},
          actions: {listWorkflowRunsForRepo: listWorkflowRuns},
        },
        paginate: async (endpoint, _params, mapFunction) => {
          if (endpoint === listComments) {
            commentReads += 1;
            events.push('comments-' + commentReads);
            return activityKind === 'task-comment' && activityVisible && commentReads >= 3
              ? [taskComment]
              : [];
          }
          if (endpoint === listReviews) {
            reviewReads += 1;
            events.push('reviews-' + reviewReads);
            return activityKind === 'submitted-review' && activityVisible && reviewReads >= 3
              ? [submittedReview]
              : [];
          }
          if (endpoint === listWorkflowRuns) {
            events.push('workflow-recheck');
            if (arrivalPoint === 'workflow-recheck') activityVisible = true;
            return mapFunction({data: {workflow_runs: []}});
          }
          throw new Error('unexpected final-posting-freshness endpoint');
        },
      };
      const outcome = await maybeAutopick({
        github,
        owner: 'APReddy-AutoBotz',
        repo: 'WorkOS',
        active: {number: 27, head: {sha: HEAD}, body: ''},
        validateBeforePost: async (candidate) => {
          validationReads += 1;
          events.push('lane-' + validationReads);
          if (arrivalPoint === 'final-lane-recheck' && validationReads === 2) activityVisible = true;
          return candidate;
        },
      });
      assert.equal(outcome.posted, false, `${activityKind} during ${arrivalPoint} blocks a duplicate continuation`);
      assert.equal(posted, 0, 'fresh task/review activity suppresses the continuation');
      assert.equal(commentReads, 3, 'comments are checked once more after the final lane/workflow reads');
      assert.equal(reviewReads, 3, 'reviews are checked once more after the final lane/workflow reads');
      assert.ok(events.indexOf('lane-2') < events.indexOf('comments-3'));
      assert.ok(events.indexOf('workflow-recheck') < events.indexOf('comments-3'));
    }
  }
}

async function verifyWorkflowFreshnessFinalBoundary() {
  const listPulls = () => {};
  const listComments = () => {};
  const listReviews = () => {};
  const listWorkflowRuns = () => {};
  const activePr = productDraft({number: 27, updated_at: new Date().toISOString()});
  const activeWorkflow = {
    workflow_id: 202,
    run_number: 2,
    run_attempt: 1,
    status: 'in_progress',
    conclusion: null,
    updated_at: new Date().toISOString(),
  };
  const posts = [];
  let workflowReads = 0;
  const github = {
    rest: {
      pulls: {list: listPulls, listReviews},
      actions: {listWorkflowRunsForRepo: listWorkflowRuns},
      repos: {
        getBranch: async () => ({data: {commit: {sha: MAIN_SHA}}}),
        getContent: async () => encodedTaskFile(),
      },
      issues: {
        listComments,
        createComment: async (args) => { posts.push(args); },
        updateComment: async (args) => { posts.push(args); },
      },
    },
    paginate: async (endpoint, params, mapFunction) => {
      if (endpoint === listPulls) return [activePr];
      if (endpoint === listWorkflowRuns) {
        workflowReads += 1;
        return mapFunction({data: {workflow_runs: workflowReads === 1 ? [] : [activeWorkflow]}});
      }
      if (endpoint === listComments && params.issue_number === 3) return [];
      if (endpoint === listComments && params.issue_number === 27) return [];
      if (endpoint === listReviews && params.pull_number === 27) return [];
      throw new Error('unexpected final-workflow-freshness endpoint');
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
  assert.equal(workflowReads, 2, 'the exact-head workflow set is reread after final lane/head validation');
  assert.equal(action.classification, 'waiting', 'a newly active exact-head workflow suppresses autopick');
  assert.equal(posts.some((comment) => /@codex/i.test(comment.body || '')), false);
}

async function verifyLaneAuthorityFinalBoundary() {
  const listPulls = () => {};
  const listComments = () => {};
  const listReviews = () => {};
  const listWorkflowRuns = () => {};
  const eligiblePr = productDraft({number: 27, updated_at: new Date().toISOString()});
  const revokedPr = {...eligiblePr, body: 'Controller-only work; product continuation authority was revoked.'};
  const posts = [];
  let pullListCalls = 0;
  let commentReads = 0;
  let activityBoundaryReached = false;
  const github = {
    rest: {
      pulls: {list: listPulls, listReviews},
      actions: {listWorkflowRunsForRepo: listWorkflowRuns},
      repos: {
        getBranch: async () => ({data: {commit: {sha: MAIN_SHA}}}),
        getContent: async () => encodedTaskFile(),
      },
      issues: {
        listComments,
        createComment: async (args) => { posts.push(args); },
        updateComment: async (args) => { posts.push(args); },
      },
    },
    paginate: async (endpoint, params, mapFunction) => {
      if (endpoint === listPulls) {
        pullListCalls += 1;
        return activityBoundaryReached && pullListCalls >= 3 ? [revokedPr] : [eligiblePr];
      }
      if (endpoint === listWorkflowRuns) return mapFunction({data: {workflow_runs: []}});
      if (endpoint === listComments && params.issue_number === 3) return [];
      if (endpoint === listComments && params.issue_number === 27) {
        commentReads += 1;
        if (commentReads > 1) activityBoundaryReached = true;
        return [];
      }
      if (endpoint === listReviews && params.pull_number === 27) return [];
      throw new Error('unexpected final-lane-authority endpoint');
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
  assert.equal(commentReads, 2, 'final comment freshness is read after the first authority validation');
  assert.ok(pullListCalls >= 4, 'lane/head authority is revalidated after final activity reads');
  assert.equal(action.classification, 'waiting', 'revoked lane authority blocks the continuation');
  assert.equal(posts.some((comment) => /@codex/i.test(comment.body || '')), false);
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

  const collaboratorLease = buildMergeHarness({mergeIntentLogin: 'untrusted-contributor'});
  const collaboratorLeaseResult = await attemptGuardedMerge({
    github: collaboratorLease.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    candidate: {number: 27},
  });
  assert.equal(collaboratorLeaseResult.performed, false, 'a collaborator-authored exact token is not owner authorization');
  assert.equal(collaboratorLease.mergeArgs, null);

  const missingOwnerCommand = buildMergeHarness({mergeIntentBody: '[WORKOS-AUTO-MERGE head=' + HEAD + ' base=' + BASE + ']'});
  const missingOwnerCommandResult = await attemptGuardedMerge({
    github: missingOwnerCommand.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    candidate: {number: 27},
  });
  assert.equal(missingOwnerCommandResult.performed, false, 'a body-like marker in a comment is not a canonical owner command');
  assert.equal(missingOwnerCommand.mergeArgs, null);

  const staleOwnerCommand = buildMergeHarness({mergeIntentCreated: '2026-08-27T23:59:00Z'});
  const staleOwnerCommandResult = await attemptGuardedMerge({
    github: staleOwnerCommand.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    candidate: {number: 27},
  });
  assert.equal(staleOwnerCommandResult.performed, false, 'owner authorization must be posted after the exact head commit');
  assert.equal(staleOwnerCommand.mergeArgs, null);

  const revokedDuringFinalRevalidation = buildMergeHarness({hideMergeIntentAfterRead: 4});
  const revokedResult = await attemptGuardedMerge({
    github: revokedDuringFinalRevalidation.github,
    owner: 'APReddy-AutoBotz',
    repo: 'repo',
    candidate: {number: 27},
  });
  assert.equal(revokedResult.performed, false, 'owner authorization is reread immediately before merge');
  assert.equal(revokedDuringFinalRevalidation.mergeArgs, null);

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
    const listWorkflowRuns = () => {};
    const postedBodies = [];
    let rerunCalls = 0;
    const activePr = {
      number: 28,
      title: 'WOS-02: active product lane',
      state: 'open',
      draft: true,
      updated_at: new Date().toISOString(),
      body: continuationBody(),
      head: {sha: HEAD, ref: WOS02_BRANCH, repo: {full_name: REPOSITORY}},
      base: {sha: MAIN_SHA, ref: 'main', repo: {full_name: REPOSITORY}},
    };
    const github = {
      rest: {
        pulls: {list: listPulls},
        actions: {
          listWorkflowRunsForRepo: listWorkflowRuns,
          reRunWorkflow: async () => { rerunCalls += 1; },
        },
        repos: {
          getBranch: async () => ({data: {commit: {sha: BASE}}}),
          getContent: async () => encodedTaskFile(),
        },
        issues: {
          listComments,
          createComment: async (args) => { postedBodies.push(args.body); },
          updateComment: async (args) => { postedBodies.push(args.body); },
        },
      },
      paginate: async (endpoint, params, mapFunction) => {
        if (endpoint === listPulls) return [activePr];
        if (endpoint === listWorkflowRuns) return mapFunction({data: {workflow_runs: [run({
          run_number: 99,
          run_attempt: 1,
          status,
          conclusion: null,
          updated_at: new Date().toISOString(),
        })]}});
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

async function verifyWorkflowRunPagination() {
  const listPulls = () => {};
  const listComments = () => {};
  const activePr = productDraft({number: 27});
  const pageOne = Array.from({length: 50}, (_, index) => ({
    workflow_id: 101,
    run_number: 100 - index,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-08-28T00:00:00Z',
  }));
  const olderActiveWorkflow = {
    workflow_id: 202,
    run_number: 1,
    run_attempt: 1,
    status: 'in_progress',
    conclusion: null,
    updated_at: new Date().toISOString(),
  };
  const allRuns = [...pageOne, olderActiveWorkflow];
  const posted = [];
  let paginationCalls = 0;
  let directCalls = 0;
  const listWorkflowRuns = async () => {
    directCalls += 1;
    return {data: {workflow_runs: pageOne}};
  };
  const github = {
    rest: {
      pulls: {list: listPulls},
      actions: {listWorkflowRunsForRepo: listWorkflowRuns},
      repos: {
        getBranch: async () => ({data: {commit: {sha: MAIN_SHA}}}),
        getContent: async () => encodedTaskFile(),
      },
      issues: {
        listComments,
        createComment: async (args) => { posted.push(args); },
        updateComment: async (args) => { posted.push(args); },
      },
    },
    paginate: async (endpoint, params, mapFunction) => {
      if (endpoint === listPulls) return [activePr];
      if (endpoint === listWorkflowRuns) {
        paginationCalls += 1;
        assert.equal(params.per_page, 100);
        assert.equal(typeof mapFunction, 'function');
        return [allRuns.slice(0, 50), allRuns.slice(50)].flatMap((page) => mapFunction({data: {workflow_runs: page}}));
      }
      if (endpoint === listComments && params.issue_number === 3) return [];
      throw new Error('unexpected paginated workflow-boundary endpoint');
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
  assert.equal(paginationCalls, 1, 'the controller reads all workflow pages for the exact head');
  assert.equal(directCalls, 0, 'the first-page REST response is not used directly');
  assert.equal(action.classification, 'workflow-active', 'an active workflow on a later page blocks continuation');
  assert.equal(posted.some((comment) => /@codex/i.test(comment.body || '')), false);
}

async function runAsyncTests() {
  await verifyProductLaneSelector();
  await verifyControllerLanesDoNotStartContinuation();
  await verifyLiveLaneRevalidationBeforeContinuation();
  await verifyReviewGateContext();
  await verifyGeneratedContinuationPrompt();
  await verifyContinuationFreshnessFinalBoundary();
  await verifyContinuationFreshnessAfterFinalChecks();
  await verifyWorkflowFreshnessFinalBoundary();
  await verifyLaneAuthorityFinalBoundary();
  await verifyFinalMergeRevalidation();
  await verifyNonterminalWorkflowDoesNotAutopick();
  await verifyWorkflowRunPagination();
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
  exactHeadWorkflowRunsFullyPaginated: true,
  ownerAuthoredMergeIntentRequired: true,
  continuationFreshnessRecheckedAtPostBoundary: true,
  continuationFreshnessRecheckedAfterFinalLaneAndWorkflow: true,
  workflowFreshnessRecheckedAtPostBoundary: true,
  laneAuthorityRecheckedAfterFreshnessReads: true,
  editedCommentFreshness: true,
  recentWorkflowFreshness: true,
  submittedReviewFreshness: true,
  decisiveReviewState: true,
  postActionRefetch: true,
  legacyHeartbeatMigration: true,
  neverAutoReady: true,
  productLaneSelectionFailClosed: true,
  controllerAndAcceptanceLanesCannotAutopick: true,
  liveLaneRevalidationBeforeAutopick: true,
}, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
