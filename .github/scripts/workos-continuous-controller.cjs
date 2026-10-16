'use strict';

const HEARTBEAT_MARKER = '<!-- workos-continuous-controller -->';
const LEGACY_HEARTBEAT_MARKER = '<!-- workos-hourly-controller -->';
const AUTOPICK_MARKER = '[WORKOS-CONTROLLER-AUTOPICK]';
const MERGE_LEASE_PATTERN = /\[WORKOS-AUTO-MERGE\s+head=([0-9a-f]{40})\s+base=([0-9a-f]{40})\]/i;
const TRANSIENT_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'startup_failure']);
const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const DECISIVE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const BOT_LOGINS = new Set(['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector']);
const PRODUCT_CONTINUATION_LANE = 'product-implementation';
const PRODUCT_CONTINUATION_LANE_LINE = 'WORKOS-CONTINUATION-LANE: product-implementation';
const MINUTE = 60 * 1000;
const WORKFLOW_ACTIVITY_FRESHNESS_MS = 20 * MINUTE;
const MAX_AUTHORITY_BODY_LENGTH = 256;
const WORKOS_CI_WORKFLOW_PATH = '.github/workflows/workos-ci.yml';
const REQUIRED_WORKOS_CI_CHECKS = [
  'Validate application, migrations, and container',
  'Scan full history for secrets',
];

function parseMergeLease(body = '') {
  const match = String(body).match(MERGE_LEASE_PATTERN);
  return match ? {head: match[1].toLowerCase(), base: match[2].toLowerCase()} : null;
}

function normalizeAuthorityBody(body = '') {
  if (typeof body !== 'string' || body.length > MAX_AUTHORITY_BODY_LENGTH) return null;
  let text = body.replace(/\r\n/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

function isExactReviewRequest(body = '', headSha = '') {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) return false;
  return normalizeAuthorityBody(body)
    === '@codex review\n[WORKOS-INDEPENDENT-REVIEW-REQUEST head=' + headSha + ']';
}

function authorityTimestamp(value = {}) {
  const candidates = [
    value.created_at,
    value.createdAt,
    value.updated_at,
    value.updatedAt,
    value.submitted_at,
    value.submittedAt,
  ]
    .map((item) => new Date(item || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function occursAfterReviewRequest(candidate, request) {
  const requestTime = authorityTimestamp(request);
  const candidateTime = authorityTimestamp(candidate);
  return requestTime > 0 && candidateTime > requestTime;
}

function parseMergeAuthorization(body = '') {
  const normalized = normalizeAuthorityBody(body);
  if (normalized === null) return null;
  const match = normalized.match(
    /^@codex merge\n\[WORKOS-AUTO-MERGE head=([0-9a-f]{40}) base=([0-9a-f]{40})\]$/,
  );
  return match ? {head: match[1], base: match[2]} : null;
}

async function readOwnerMergeAuthorization({github, owner, repo, pr}) {
  const lease = parseMergeLease(pr.body || '');
  const head = pr.head?.sha?.toLowerCase();
  const base = pr.base?.sha?.toLowerCase();
  if (!lease || !head || !base || lease.head !== head || lease.base !== base) return null;

  const commit = await github.rest.repos.getCommit({owner, repo, ref: head});
  const headTime = new Date(commit.data.commit.committer?.date || commit.data.commit.author?.date || 0).getTime();
  if (!Number.isFinite(headTime) || headTime <= 0) return null;

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const authorization = comments
    .filter((comment) => {
      const login = comment.user?.login || '';
      const command = parseMergeAuthorization(comment.body || '');
      return login.toLowerCase() === owner.toLowerCase()
        && command?.head === head
        && command?.base === base
        && authorityTimestamp(comment) > headTime;
    })
    .sort((a, b) => authorityTimestamp(b) - authorityTimestamp(a))[0];
  return authorization ? {
    head,
    base,
    commentId: authorization.id,
    authorizedAt: authorityTimestamp(authorization),
  } : null;
}

async function readOwnerMergeAuthorizations({github, owner, repo, pulls = []}) {
  const authorizations = new Map();
  for (const pr of pulls) {
    if (pr.state !== 'open' || pr.draft || !parseMergeLease(pr.body || '')) continue;
    try {
      const authorization = await readOwnerMergeAuthorization({github, owner, repo, pr});
      if (authorization) authorizations.set(pr.number, authorization);
    } catch {
      // Missing, inaccessible or malformed authorization fails closed.
    }
  }
  return authorizations;
}

function isExactCleanReview(body = '', headSha = '') {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) return false;
  return normalizeAuthorityBody(body)
    === '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + headSha + ' result=clean p0=0 p1=0 p2=0]';
}


function checksAreGreen(checkRuns = [], statuses, aggregateState = '', {
  sha = '', repository = '', ciRun = null, totalCount,
} = {}) {
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    return {green: false, reason: 'no check runs exist for the exact head'};
  }
  if (!Array.isArray(statuses) || !Number.isSafeInteger(totalCount) || totalCount !== statuses.length) {
    return {green: false, reason: 'legacy status data is missing or incomplete'};
  }
  if (!/^[0-9a-f]{40}$/.test(sha) || !repository
    || ciRun?.head_sha !== sha || ciRun?.path !== WORKOS_CI_WORKFLOW_PATH
    || ciRun?.repository?.full_name !== repository || ciRun?.head_repository?.full_name !== repository
    || !['pull_request', 'push', 'workflow_dispatch'].includes(ciRun?.event)
    || !Number.isSafeInteger(ciRun?.check_suite_id) || ciRun.check_suite_id <= 0
    || ciRun?.status !== 'completed' || ciRun?.conclusion !== 'success') {
    return {green: false, reason: 'latest exact-head WorkOS CI workflow is missing, untrusted or not successful'};
  }
  const badCheckIndex = checkRuns.findIndex((check) =>
    !check || check.head_sha !== sha || check.status !== 'completed' || check.conclusion !== 'success'
  );
  if (badCheckIndex !== -1) {
    const badCheck = checkRuns[badCheckIndex];
    if (!badCheck) return {green: false, reason: 'check-run data is missing'};
    return {
      green: false,
      reason: badCheck.head_sha !== sha ? 'check run does not match the exact head'
        : `check ${badCheck.name || badCheck.id} is ${badCheck.status}/${badCheck.conclusion || 'none'}`,
    };
  }
  for (const name of REQUIRED_WORKOS_CI_CHECKS) {
    const required = checkRuns.filter((check) => check.name === name
      && check.app?.id === 15368 && check.app?.slug === 'github-actions'
      && check.check_suite?.id === ciRun.check_suite_id);
    if (required.length !== 1) {
      return {green: false, reason: `required WorkOS CI check is missing or ambiguous: ${name}`};
    }
  }
  const badStatusIndex = statuses.findIndex((status) => !status || status.state !== 'success');
  if (badStatusIndex !== -1) {
    const badStatus = statuses[badStatusIndex];
    if (!badStatus) return {green: false, reason: 'legacy status data is missing'};
    return {green: false, reason: `status ${badStatus.context || 'unknown'} is ${badStatus.state}`};
  }
  // GitHub reports pending for zero legacy contexts even when Actions checks passed.
  // This exception requires explicit, complete emptiness plus the trusted required jobs above.
  if (aggregateState !== 'success' && !(aggregateState === 'pending' && totalCount === 0)) {
    return {green: false, reason: `combined status is ${aggregateState || 'missing'}`};
  }
  return {green: true, reason: 'all exact-head check runs and statuses succeeded'};
}

function workflowRunTimestamp(run) {
  const value = run.updated_at || run.run_started_at || run.created_at;
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function classifyLatestWorkflowRuns(runs = [], nowMs = Date.now()) {
  const latestByWorkflow = new Map();
  for (const run of runs) {
    const workflowId = run.workflow_id;
    const runNumber = Number(run.run_number);
    const runAttempt = Number(run.run_attempt);
    if (
      workflowId === undefined || workflowId === null || workflowId === ''
      || !Number.isSafeInteger(runNumber) || runNumber < 1
      || !Number.isSafeInteger(runAttempt) || runAttempt < 1
    ) {
      return {
        classification: 'unknown',
        run,
        reason: 'workflow run number/attempt is missing or invalid',
      };
    }
    const key = String(workflowId);
    const current = latestByWorkflow.get(key);
    const isNewer = !current
      || runNumber > Number(current.run_number)
      || (
        runNumber === Number(current.run_number)
        && runAttempt > Number(current.run_attempt)
      );
    const sameAttemptIsMoreCurrent = current
      && runNumber === Number(current.run_number)
      && runAttempt === Number(current.run_attempt)
      && workflowRunTimestamp(run) > workflowRunTimestamp(current);
    if (isNewer || sameAttemptIsMoreCurrent) latestByWorkflow.set(key, run);
  }
  const latest = [...latestByWorkflow.values()];
  const unknownStatus = latest.find((run) =>
    run.status !== 'completed' && !ACTIVE_WORKFLOW_STATUSES.has(run.status)
  );
  if (unknownStatus) {
    return {
      classification: 'unknown',
      run: unknownStatus,
      reason: 'workflow run has an unrecognized status: ' + (unknownStatus.status || 'missing'),
    };
  }
  const active = latest.find((run) => ACTIVE_WORKFLOW_STATUSES.has(run.status));
  if (active) return {classification: 'active', run: active};
  const transient = latest.find((run) =>
    run.status === 'completed'
    && TRANSIENT_CONCLUSIONS.has(run.conclusion)
    && Number(run.run_attempt) < 2
  );
  if (transient) return {classification: 'transient', run: transient};
  const recent = latest.find((run) => {
    if (run.status !== 'completed') return false;
    const age = nowMs - workflowRunTimestamp(run);
    return age >= 0 && age < WORKFLOW_ACTIVITY_FRESHNESS_MS;
  });
  if (recent) return {classification: 'recent', run: recent};
  const failure = latest.find((run) => run.status === 'completed' && run.conclusion === 'failure');
  if (failure) return {classification: 'failure', run: failure};
  return {classification: 'none', run: null};
}

function latestDecisiveReviews(reviews = []) {
  const latestByAuthor = new Map();
  const sorted = [...reviews]
    .filter((review) => DECISIVE_REVIEW_STATES.has(review.state))
    .sort((a, b) =>
      new Date(b.submitted_at || b.submittedAt || 0) - new Date(a.submitted_at || a.submittedAt || 0)
    );
  for (const review of sorted) {
    const login = review.user?.login || review.author?.login;
    if (login && !latestByAuthor.has(login)) latestByAuthor.set(login, review);
  }
  return [...latestByAuthor.values()];
}

function latestSubmittedReviewAt(reviews = []) {
  const times = reviews
    .map((review) => new Date(review.submitted_at || review.submittedAt || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0);
  return times.length ? Math.max(...times) : 0;
}


function assessContinuationFreshness({comments = [], reviews = [], body = '', nowMs = Date.now()} = {}) {
  const relevantComments = comments.filter((comment) =>
    BOT_LOGINS.has(comment.user?.login)
    || /@codex\b/i.test(comment.body || '')
    || (comment.body || '').includes(AUTOPICK_MARKER)
  );
  if (relevantComments.some((comment) => authorityTimestamp(comment) <= 0)) {
    return {shouldPost: false, detail: 'comment freshness could not be established'};
  }

  const latestByAuthority = (items) => [...items]
    .sort((a, b) => authorityTimestamp(b) - authorityTimestamp(a));
  const latestBot = latestByAuthority(comments.filter((comment) => BOT_LOGINS.has(comment.user?.login)))[0] || null;
  const latestTask = latestByAuthority(comments.filter((comment) => /@codex\b/i.test(comment.body || '')))[0] || null;
  const latestAuto = latestByAuthority(comments.filter((comment) => (comment.body || '').includes(AUTOPICK_MARKER)))[0] || null;
  const latestReviewTime = latestSubmittedReviewAt(reviews);
  const timestamp = (comment) => comment ? authorityTimestamp(comment) : 0;
  const taskAge = latestTask ? nowMs - timestamp(latestTask) : Infinity;
  const botAge = latestBot ? nowMs - timestamp(latestBot) : Infinity;
  const autoAge = latestAuto ? nowMs - timestamp(latestAuto) : Infinity;
  const reviewAge = latestReviewTime ? nowMs - latestReviewTime : Infinity;
  const botRespondedAfterTask = Boolean(latestTask && latestBot && timestamp(latestBot) > timestamp(latestTask));
  const bodyAllowsWork = !/(dependency[- ]blocked|not authorized to import|do not resume)/i.test(body || '');
  const noLikelyRunningTask = !latestTask || botRespondedAfterTask || taskAge >= 75 * MINUTE;
  const shouldPost = bodyAllowsWork
    && noLikelyRunningTask
    && botAge >= 45 * MINUTE
    && autoAge >= 45 * MINUTE
    && reviewAge >= 45 * MINUTE;
  return {
    shouldPost,
    detail: shouldPost ? 'all workflow, task, response and review freshness leases expired' : 'current workflow/task/review activity is still fresh',
    latestBotTime: timestamp(latestBot),
    latestTaskTime: timestamp(latestTask),
    latestAutoTime: timestamp(latestAuto),
  };
}

function hasContinuationAuthorityDeclaration(body = '') {
  return /^WORKOS-(?:CONTINUATION-LANE|GOVERNING-TASK|GOVERNING-ISSUE)(?::|\b)/im.test(String(body));
}

function parseContinuationAuthority(pr = {}) {
  const body = typeof pr.body === 'string' ? pr.body.replace(/\r\n/g, '\n') : '';
  const lines = body.split('\n');
  if (lines[0] !== PRODUCT_CONTINUATION_LANE_LINE) return null;

  const laneLines = lines.filter((line) => /^WORKOS-CONTINUATION-LANE:/i.test(line));
  const taskLines = lines.filter((line) => /^WORKOS-GOVERNING-TASK:/i.test(line));
  const issueLines = lines.filter((line) => /^WORKOS-GOVERNING-ISSUE:/i.test(line));
  if (laneLines.length !== 1 || taskLines.length !== 1 || issueLines.length !== 1) return null;
  if (lines[3] !== '') return null;

  const taskMatch = lines[1]?.match(
    /^WORKOS-GOVERNING-TASK: (docs\/tasks\/(WOS-[0-9]{2}[A-Z]?)-[A-Z0-9]+(?:-[A-Z0-9]+)*\.md)$/,
  );
  const issueMatch = lines[2]?.match(/^WORKOS-GOVERNING-ISSUE: ([1-9][0-9]*)$/);
  if (!taskMatch || !issueMatch) return null;

  const issueNumber = Number(issueMatch[1]);
  if (!Number.isSafeInteger(issueNumber)) return null;
  return {
    lane: PRODUCT_CONTINUATION_LANE,
    taskPath: taskMatch[1],
    workstream: taskMatch[2],
    issueNumber,
  };
}

function taskAuthoritySection(markdown = '') {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const authorityIndexes = lines
    .map((line, index) => line === '## Authority' ? index : -1)
    .filter((index) => index >= 0);
  if (authorityIndexes.length !== 1) return null;
  const start = authorityIndexes[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

function taskField(section, field) {
  const prefix = `- **${field}:** `;
  const matches = section.filter((line) => line.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
}

function taskDocumentConfirmsProductLane(markdown, authority, targetBranch) {
  const section = taskAuthoritySection(markdown);
  if (!section) return false;
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const headingCount = lines.filter((line) => line.startsWith(`# ${authority.workstream} `)).length;
  if (headingCount !== 1) return false;

  const workstream = taskField(section, 'Workstream');
  const issue = taskField(section, 'Issue');
  const branch = taskField(section, 'Target branch');
  const lane = taskField(section, 'Controller continuation lane');
  return workstream === authority.workstream
    && issue === `#${authority.issueNumber}`
    && branch === `\`${targetBranch}\``
    && lane === `\`${PRODUCT_CONTINUATION_LANE}\``;
}

function decodeTaskFile(response) {
  const file = response?.data;
  if (
    !file || Array.isArray(file) || file.type !== 'file' || file.encoding !== 'base64'
    || typeof file.content !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1
  ) return null;
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size) return null;
  return bytes.toString('utf8');
}

async function selectActiveDraft({github, owner, repo, pulls = [], mainSha}) {
  const explicitDrafts = pulls.filter((pr) =>
    pr.state === 'open' && pr.draft === true && hasContinuationAuthorityDeclaration(pr.body || '')
  );
  if (explicitDrafts.length === 0) return null;
  if (!/^[0-9a-f]{40}$/.test(mainSha || '')) return null;

  const repositoryName = `${owner}/${repo}`;
  const eligible = [];
  for (const pr of explicitDrafts) {
    const authority = parseContinuationAuthority(pr);
    if (!authority) return null;
    if (
      pr.base?.ref !== 'main'
      || pr.base.repo?.full_name !== repositoryName
      || pr.head?.repo?.full_name !== repositoryName
      || typeof pr.head.ref !== 'string'
      || pr.head.ref.length === 0
    ) return null;

    let taskDocument;
    try {
      const response = await github.rest.repos.getContent({
        owner,
        repo,
        path: authority.taskPath,
        ref: mainSha,
      });
      taskDocument = decodeTaskFile(response);
    } catch {
      return null;
    }
    if (!taskDocument || !taskDocumentConfirmsProductLane(taskDocument, authority, pr.head.ref)) {
      return null;
    }
    eligible.push(pr);
  }

  return eligible.length === 1 ? eligible[0] : null;
}

function selectMergeCandidate(pulls = [], authorizations = new Map()) {
  return pulls
    .filter((pr) => {
      if (pr.draft || pr.state !== 'open') return false;
      const lease = parseMergeLease(pr.body || '');
      const authorization = authorizations.get(pr.number);
      return lease
        && authorization
        && lease.head === pr.head.sha.toLowerCase()
        && lease.base === pr.base.sha.toLowerCase()
        && authorization.head === lease.head
        && authorization.base === lease.base;
    })
    .sort((a, b) => a.number - b.number)[0] || null;
}

async function readReviewAuthority(github, owner, repo, number) {
  const threads = [];
  let reviewDecision = null;
  let after = null;
  do {
    const data = await github.graphql(`
      query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewDecision
            reviewThreads(first: 100, after: $after) {
              nodes { id isResolved }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `, {owner, repo, number, after});
    const pullRequest = data.repository?.pullRequest;
    const page = pullRequest?.reviewThreads;
    if (!page) throw new Error(`Unable to read review authority for PR #${number}`);
    if (reviewDecision === null) reviewDecision = pullRequest.reviewDecision || null;
    threads.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return {threads, reviewDecision};
}

async function inspectReviewGate({github, owner, repo, pr}) {
  const authority = await readReviewAuthority(github, owner, repo, pr.number);
  const unresolved = authority.threads.filter((thread) => !thread.isResolved);
  if (unresolved.length > 0) {
    return {clean: false, reason: `${unresolved.length} unresolved review thread(s)`};
  }
  if (authority.reviewDecision === 'CHANGES_REQUESTED') {
    return {clean: false, reason: 'GitHub aggregate review decision is CHANGES_REQUESTED'};
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const changeRequest = latestDecisiveReviews(reviews)
    .find((review) => review.state === 'CHANGES_REQUESTED');
  if (changeRequest) {
    return {clean: false, reason: `changes requested by ${changeRequest.user?.login || changeRequest.author?.login}`};
  }

  const commit = await github.rest.repos.getCommit({owner, repo, ref: pr.head.sha});
  const headTime = new Date(commit.data.commit.committer?.date || commit.data.commit.author?.date || 0);
  if (!Number.isFinite(headTime.getTime()) || headTime.getTime() <= 0) {
    return {clean: false, reason: 'unable to establish exact head commit time'};
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const reviewRequest = comments
  .filter((comment) =>
    comment.user?.login === owner
    && authorityTimestamp(comment) > headTime.getTime()
    && isExactReviewRequest(comment.body || '', pr.head.sha)
  )
  .sort((a, b) => authorityTimestamp(b) - authorityTimestamp(a))[0] || null;
if (!reviewRequest) {
  return {clean: false, reason: 'no owner-authored independent review request marker for the exact head'};
}
const postRequestBotResponses = [
  ...comments.filter((comment) =>
    BOT_LOGINS.has(comment.user?.login)
    && occursAfterReviewRequest(comment, reviewRequest)
  ),
  ...reviews.filter((review) => {
    const login = review.user?.login || review.author?.login;
    return BOT_LOGINS.has(login) && occursAfterReviewRequest(review, reviewRequest);
  }),
];
if (postRequestBotResponses.length === 0) {
  return {clean: false, reason: 'no independent structured clean result after the exact review request'};
}
const latestResponseTime = Math.max(...postRequestBotResponses.map((response) => authorityTimestamp(response)));
const latestResponses = postRequestBotResponses
  .filter((response) => authorityTimestamp(response) === latestResponseTime);
if (!latestResponses.every((response) => isExactCleanReview(response.body || '', pr.head.sha))) {
  return {clean: false, reason: 'latest Codex response is not an exact clean review result'};
}
  return {clean: true, reason: 'independent exact-head review request/result pair is clean'};
}

async function inspectChecks({github, owner, repo, sha}) {
  const checks = await github.paginate(github.rest.checks.listForRef, {
    owner,
    repo,
    ref: sha,
    filter: 'latest',
    per_page: 100,
  });
  const combined = await github.rest.repos.getCombinedStatusForRef({owner, repo, ref: sha, per_page: 100});
  // Do not coerce an unavailable/truncated status response into an empty set.
  const statuses = combined.data?.statuses;
  const totalCount = combined.data?.total_count;
  if (combined.data?.sha !== sha || !Array.isArray(statuses)
    || !Number.isSafeInteger(totalCount) || totalCount !== statuses.length) {
    return {green: false, reason: 'exact-head legacy status data is missing or incomplete'};
  }
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
    owner, repo, head_sha: sha, per_page: 100,
  });
  if (!Array.isArray(runs)) return {green: false, reason: 'workflow-run data is missing'};
  const ciRuns = runs.filter((run) => run?.path === WORKOS_CI_WORKFLOW_PATH);
  const workflowIds = new Set(ciRuns.map((run) => run.workflow_id));
  if (ciRuns.length === 0 || workflowIds.size !== 1) {
    return {green: false, reason: 'required WorkOS CI workflow is missing or ambiguous'};
  }
  const [workflowId] = workflowIds;
  const relatedRuns = runs.filter((run) => run?.workflow_id === workflowId);
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0 || relatedRuns.some((run) =>
    run.path !== WORKOS_CI_WORKFLOW_PATH || run.head_sha !== sha
    || !Number.isSafeInteger(run.run_number) || run.run_number < 1
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || !Number.isSafeInteger(run.id) || run.id < 1
  )) {
    return {green: false, reason: 'required WorkOS CI workflow identity is incomplete'};
  }
  relatedRuns.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const ciRun = relatedRuns[0];
  if (relatedRuns.some((run) => run !== ciRun
    && run.run_number === ciRun.run_number && run.run_attempt === ciRun.run_attempt)) {
    return {green: false, reason: 'latest WorkOS CI workflow attempt is ambiguous'};
  }
  return checksAreGreen(checks, statuses, combined.data.state, {
    sha, repository: `${owner}/${repo}`, ciRun, totalCount,
  });
}

async function classifyWorkflowRunsForHead({github, owner, repo, headSha}) {
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
    owner,
    repo,
    head_sha: headSha,
    per_page: 100,
  }, (response) => {
    const workflowRuns = response.data?.workflow_runs;
    if (!Array.isArray(workflowRuns)) {
      throw new Error('GitHub workflow-run response did not contain a workflow_runs array');
    }
    return workflowRuns;
  });
  return classifyLatestWorkflowRuns(runs || []);
}

async function attemptGuardedMerge({github, owner, repo, candidate}) {
  const fresh = (await github.rest.pulls.get({owner, repo, pull_number: candidate.number})).data;
  const lease = parseMergeLease(fresh.body || '');
  if (!lease) return {performed: false, classification: 'merge-blocked', detail: 'missing exact auto-merge lease'};
  if (fresh.draft) return {performed: false, classification: 'merge-blocked', detail: 'PR is Draft'};
  if (fresh.state !== 'open') return {performed: false, classification: 'merge-blocked', detail: `PR is ${fresh.state}`};
  if (lease.head !== fresh.head.sha.toLowerCase() || lease.base !== fresh.base.sha.toLowerCase()) {
    return {performed: false, classification: 'merge-blocked', detail: 'head/base moved beyond the body lease'};
  }
  if (fresh.mergeable !== true || fresh.mergeable_state !== 'clean') {
    return {performed: false, classification: 'merge-blocked', detail: `merge state is ${fresh.mergeable}/${fresh.mergeable_state}`};
  }
  let ownerAuthorization;
  try {
    ownerAuthorization = await readOwnerMergeAuthorization({github, owner, repo, pr: fresh});
  } catch {
    ownerAuthorization = null;
  }
  if (!ownerAuthorization) {
    return {performed: false, classification: 'merge-blocked', detail: 'missing current owner-authored exact-head/base merge authorization'};
  }

  const checks = await inspectChecks({github, owner, repo, sha: fresh.head.sha});
  if (!checks.green) return {performed: false, classification: 'merge-blocked', detail: checks.reason};
  const review = await inspectReviewGate({github, owner, repo, pr: fresh});
  if (!review.clean) return {performed: false, classification: 'merge-blocked', detail: review.reason};

  const final = (await github.rest.pulls.get({owner, repo, pull_number: candidate.number})).data;
  if (final.draft || final.state !== 'open' || final.head.sha !== fresh.head.sha || final.base.sha !== fresh.base.sha) {
    return {performed: false, classification: 'merge-blocked', detail: 'PR changed during final exact-head revalidation'};
  }
  const finalLease = parseMergeLease(final.body || '');
  if (!finalLease || finalLease.head !== final.head.sha.toLowerCase() || finalLease.base !== final.base.sha.toLowerCase()) {
    return {performed: false, classification: 'merge-blocked', detail: 'final merge lease is not exact'};
  }
  let finalOwnerAuthorization;
  try {
    finalOwnerAuthorization = await readOwnerMergeAuthorization({github, owner, repo, pr: final});
  } catch {
    finalOwnerAuthorization = null;
  }
  if (!finalOwnerAuthorization) {
    return {performed: false, classification: 'merge-blocked', detail: 'final owner-authored exact-head/base merge authorization is missing'};
  }

  const finalChecks = await inspectChecks({github, owner, repo, sha: final.head.sha});
  if (!finalChecks.green) {
    return {performed: false, classification: 'merge-blocked', detail: `final ${finalChecks.reason}`};
  }
  const finalReview = await inspectReviewGate({github, owner, repo, pr: final});
  if (!finalReview.clean) {
    return {performed: false, classification: 'merge-blocked', detail: `final ${finalReview.reason}`};
  }

  const afterGates = (await github.rest.pulls.get({owner, repo, pull_number: candidate.number})).data;
  if (
    afterGates.draft
    || afterGates.state !== 'open'
    || afterGates.head.sha !== final.head.sha
    || afterGates.base.sha !== final.base.sha
  ) {
    return {performed: false, classification: 'merge-blocked', detail: 'PR changed during final check/review revalidation'};
  }
  if (afterGates.mergeable !== true || afterGates.mergeable_state !== 'clean') {
    return {
      performed: false,
      classification: 'merge-blocked',
      detail: 'final merge state is ' + afterGates.mergeable + '/' + afterGates.mergeable_state,
    };
  }
  const afterGatesLease = parseMergeLease(afterGates.body || '');
  if (
    !afterGatesLease
    || afterGatesLease.head !== afterGates.head.sha.toLowerCase()
    || afterGatesLease.base !== afterGates.base.sha.toLowerCase()
  ) {
    return {performed: false, classification: 'merge-blocked', detail: 'final merge lease is not exact'};
  }
  let afterGatesOwnerAuthorization;
  try {
    afterGatesOwnerAuthorization = await readOwnerMergeAuthorization({github, owner, repo, pr: afterGates});
  } catch {
    afterGatesOwnerAuthorization = null;
  }
  if (!afterGatesOwnerAuthorization) {
    return {performed: false, classification: 'merge-blocked', detail: 'owner-authored exact-head/base merge authorization changed during final revalidation'};
  }

  const result = await github.rest.pulls.merge({
    owner,
    repo,
    pull_number: afterGates.number,
    sha: afterGates.head.sha,
    merge_method: 'squash',
    commit_title: `${final.title} (#${final.number})`,
  });
  if (!result.data.merged) {
    return {performed: false, classification: 'merge-blocked', detail: result.data.message || 'GitHub rejected merge'};
  }
  return {
    performed: true,
    classification: 'merged',
    detail: `Squash-merged PR #${final.number} at exact head ${final.head.sha}; merge ${result.data.sha}`,
  };
}

async function maybeRerunTransient({github, owner, repo, active}) {
  if (!active) return null;
  const classification = await classifyWorkflowRunsForHead({github, owner, repo, headSha: active.head.sha});
  if (classification.classification !== 'transient') return classification;
  await github.rest.actions.reRunWorkflow({owner, repo, run_id: classification.run.id});
  return {...classification, rerun: true};
}

async function maybeAutopick({github, owner, repo, active, validateBeforePost = null}) {
  if (!active) return null;
  const [comments, reviews] = await Promise.all([
    github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: active.number,
      per_page: 100,
    }),
    github.paginate(github.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: active.number,
      per_page: 100,
    }),
  ]);
  const freshness = assessContinuationFreshness({
    comments,
    reviews,
    nowMs: Date.now(),
    body: active.body || '',
  });
  if (!freshness.shouldPost) return {posted: false, detail: freshness.detail};

  if (validateBeforePost) {
    const current = await validateBeforePost(active);
    if (!current) {
      return {posted: false, detail: 'live product-task lane or exact head/base changed; no continuation posted'};
    }
    active = current;

    const [latestComments, latestReviews] = await Promise.all([
      github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number: active.number,
        per_page: 100,
      }),
      github.paginate(github.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: active.number,
        per_page: 100,
      }),
    ]);
    const finalFreshness = assessContinuationFreshness({
      comments: latestComments,
      reviews: latestReviews,
      nowMs: Date.now(),
      body: active.body || '',
    });
    if (!finalFreshness.shouldPost) {
      return {posted: false, detail: 'activity changed during final lane/head revalidation; ' + finalFreshness.detail};
    }

    let finalWorkflow;
    try {
      finalWorkflow = await classifyWorkflowRunsForHead({
        github,
        owner,
        repo,
        headSha: active.head.sha,
      });
    } catch {
      return {posted: false, detail: 'exact-head workflow freshness could not be revalidated; no continuation posted'};
    }
    if (['active', 'recent', 'transient', 'unknown'].includes(finalWorkflow.classification)) {
      return {
        posted: false,
        detail: `exact-head workflow became ${finalWorkflow.classification} during final lane/head revalidation; no continuation posted`,
      };
    }

    let finalCurrent;
    try {
      finalCurrent = await validateBeforePost(active);
    } catch {
      finalCurrent = null;
    }
    if (!finalCurrent) {
      return {posted: false, detail: 'product-task lane or exact head/base changed at the final posting boundary'};
    }
    active = finalCurrent;

    let postingComments;
    let postingReviews;
    try {
      [postingComments, postingReviews] = await Promise.all([
        github.paginate(github.rest.issues.listComments, {
          owner,
          repo,
          issue_number: active.number,
          per_page: 100,
        }),
        github.paginate(github.rest.pulls.listReviews, {
          owner,
          repo,
          pull_number: active.number,
          per_page: 100,
        }),
      ]);
    } catch {
      return {posted: false, detail: 'comment/review freshness could not be revalidated at the final posting boundary; no continuation posted'};
    }
    const postingFreshness = assessContinuationFreshness({
      comments: postingComments,
      reviews: postingReviews,
      nowMs: Date.now(),
      body: active.body || '',
    });
    if (!postingFreshness.shouldPost) {
      return {posted: false, detail: 'activity changed during final workflow/lane revalidation; ' + postingFreshness.detail};
    }
  }

  const taskMatch = (active.body || '').match(/`(docs\/tasks\/[^`]+\.md)`/i);
  const taskReference = taskMatch
    ? `Read and execute \`${taskMatch[1]}\` and the current PR body as the governing contract.`
    : 'Read the current PR body and governing WorkOS control documents before acting.';
  const body = '@codex ' + AUTOPICK_MARKER + '\n\n'
    + 'Continue the active WorkOS implementation on PR #' + active.number
    + ' from exact published head ' + active.head.sha + '. ' + taskReference + '\n\n'
    + 'Use the WorkOS Implementation environment and the strongest appropriate Sol reasoning model. '
    + 'Re-fetch live PR/head/base/check/review state before any write. Use one root writer/coordinator. '
    + 'Resolve the next coherent blocker family, run every applicable exact-head gate, publish only to the existing branch under an exact-old-head lease, '
    + 'and request a fresh independent exact-head review.\n\n'
    + 'Keep the PR Draft unconditionally. Do not mark Ready. Do not merge. '
    + 'A Ready transition requires a separate explicit owner action outside the autonomous controller; '
    + 'merging is handled only by the controller exact-lease gates. '
    + 'Never deploy, use real secrets/providers/customer data, modify the authorized reference repository, weaken a gate, '
    + 'create a duplicate active PR, or start a dependency-blocked later workstream.';
  await github.rest.issues.createComment({owner, repo, issue_number: active.number, body});
  return {posted: true, detail: `posted bounded Codex continuation on PR #${active.number}`};
}

async function revalidateCurrentProductLane({github, owner, repo, active}) {
  if (!active) return null;
  try {
    const [mainResponse, pulls] = await Promise.all([
      github.rest.repos.getBranch({owner, repo, branch: 'main'}),
      listOpenPulls(github, owner, repo),
    ]);
    const mainSha = mainResponse.data.commit?.sha || '';
    const current = await selectActiveDraft({github, owner, repo, pulls, mainSha});
    if (
      !current
      || current.number !== active.number
      || current.head.sha !== active.head.sha
      || current.base.sha !== active.base.sha
    ) return null;
    return current;
  } catch {
    return null;
  }
}

async function maybeAutopickForCurrentLane({github, owner, repo, active}) {
  if (!active) return {posted: false, detail: 'no eligible product-implementation Draft'};
  return maybeAutopick({
    github,
    owner,
    repo,
    active,
    validateBeforePost: (candidate) => revalidateCurrentProductLane({github, owner, repo, active: candidate}),
  });
}

async function publishHeartbeat({github, owner, repo, mainSha, pulls, active, mergeCandidate, action}) {
  const issueNumber = 3;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((comment) => {
    const body = comment.body || '';
    return comment.user?.login === 'github-actions[bot]'
      && (body.includes(HEARTBEAT_MARKER) || body.includes(LEGACY_HEARTBEAT_MARKER));
  });
  const openSummary = pulls
    .filter((pr) => /^(?:WOS-|CTRL:)/i.test(pr.title || ''))
    .slice(0, 8)
    .map((pr) => `- #${pr.number} ${pr.draft ? 'Draft' : 'Ready'}: \`${pr.head.sha}\` → \`${pr.base.sha}\` — ${pr.title}`)
    .join('\n') || '- none';
  const body = `${HEARTBEAT_MARKER}\n## WorkOS continuous implementation controller\n\n- Cadence: every 10 minutes plus manual dispatch\n- Current main: \`${mainSha}\`\n- Active Draft: ${active ? `#${active.number} at \`${active.head.sha}\`` : 'none'}\n- Exact auto-merge candidate: ${mergeCandidate ? `#${mergeCandidate.number} at \`${mergeCandidate.head.sha}\`` : 'none'}\n- Last state-changing/classified action: **${action.classification}** — ${action.detail}\n\n### Open WorkOS controller/implementation PRs\n${openSummary}\n\nThe controller never marks a Draft Ready, never treats stale/pending/skipped/cancelled/unexecuted checks as green, and merges only a non-Draft PR with an exact head/base body marker plus a separate owner-authored exact-head/base merge command, after all exact-head checks succeed, an owner-authored exact-head independent-review request is followed by a structured independent clean result, no review thread or change request remains, and GitHub reports a clean merge state. It never deploys or uses real providers, secrets or customer data.`;
  if (!existing) {
    await github.rest.issues.createComment({owner, repo, issue_number: issueNumber, body});
  } else if ((existing.body || '').trim() !== body.trim()) {
    await github.rest.issues.updateComment({owner, repo, comment_id: existing.id, body});
  }
  return body;
}

async function listOpenPulls(github, owner, repo) {
  return github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  });
}

async function run({github, context, core}) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const initialMain = (await github.rest.repos.getBranch({owner, repo, branch: 'main'})).data;
  const initialMainSha = initialMain.commit?.sha || '';
  const initialPulls = await listOpenPulls(github, owner, repo);
  const active = await selectActiveDraft({
    github,
    owner,
    repo,
    pulls: initialPulls,
    mainSha: initialMainSha,
  });
  const initialMergeAuthorizations = await readOwnerMergeAuthorizations({
    github,
    owner,
    repo,
    pulls: initialPulls,
  });
  const mergeCandidate = selectMergeCandidate(initialPulls, initialMergeAuthorizations);
  let action = {classification: 'observed', detail: 'no state-changing action was eligible'};

  if (mergeCandidate) {
    action = await attemptGuardedMerge({github, owner, repo, candidate: mergeCandidate});
  }
  if (!action.performed) {
    const workflow = await maybeRerunTransient({github, owner, repo, active});
    if (workflow?.rerun) {
      action = {
        classification: 'transient-rerun',
        detail: `reran workflow ${workflow.run.id} once after ${workflow.run.conclusion}`,
      };
    } else if (workflow?.classification === 'active') {
      action = {
        classification: 'workflow-active',
        detail: `workflow ${workflow.run.id} is ${workflow.run.status}; no duplicate continuation was started`,
      };
    } else if (workflow?.classification === 'recent') {
      action = {
        classification: 'workflow-recent',
        detail: `workflow ${workflow.run.id} recently completed as ${workflow.run.conclusion}; the bounded freshness lease prevents a duplicate continuation`,
      };
    } else if (workflow?.classification === 'unknown') {
      action = {
        classification: 'workflow-unknown',
        detail: workflow.reason || 'latest workflow attempt could not be determined; no continuation or retry was started',
      };
    } else if (workflow?.classification === 'failure') {
      const autopick = await maybeAutopickForCurrentLane({github, owner, repo, active});
      action = autopick?.posted
        ? {
            classification: 'gate-failure-codex-continuation',
            detail: `workflow ${workflow.run.id} failed without automatic rerun; ${autopick.detail}`,
          }
        : {
            classification: 'gate-failure',
            detail: `workflow ${workflow.run.id} failed and is not proven transient; ${autopick?.detail || 'no continuation eligible'}`,
          };
    } else {
      const autopick = await maybeAutopickForCurrentLane({github, owner, repo, active});
      if (autopick?.posted) action = {classification: 'codex-continuation', detail: autopick.detail};
      else if (mergeCandidate && action.classification === 'merge-blocked') {
        // Preserve the exact merge blocker classification.
      } else {
        action = {classification: 'waiting', detail: autopick?.detail || 'no active Draft WorkOS PR'};
      }
    }
  }

  const finalMain = (await github.rest.repos.getBranch({owner, repo, branch: 'main'})).data;
  const finalPulls = await listOpenPulls(github, owner, repo);
  const finalActive = await selectActiveDraft({
    github,
    owner,
    repo,
    pulls: finalPulls,
    mainSha: finalMain.commit?.sha || '',
  });
  const finalMergeAuthorizations = await readOwnerMergeAuthorizations({
    github,
    owner,
    repo,
    pulls: finalPulls,
  });
  const finalMergeCandidate = selectMergeCandidate(finalPulls, finalMergeAuthorizations);
  const heartbeat = await publishHeartbeat({
    github,
    owner,
    repo,
    mainSha: finalMain.commit.sha,
    pulls: finalPulls,
    active: finalActive,
    mergeCandidate: finalMergeCandidate,
    action,
  });
  core.summary
    .addHeading('WorkOS continuous controller')
    .addRaw(`Run: ${new Date().toISOString()}\n\n`)
    .addRaw(heartbeat.replace(HEARTBEAT_MARKER, '').trim())
    .write();
  return action;
}

module.exports = {
  ACTIVE_WORKFLOW_STATUSES,
  AUTOPICK_MARKER,
  HEARTBEAT_MARKER,
  LEGACY_HEARTBEAT_MARKER,
  assessContinuationFreshness,
  attemptGuardedMerge,
  authorityTimestamp,
  checksAreGreen,
  classifyWorkflowRunsForHead,
  classifyLatestWorkflowRuns,
  inspectReviewGate,
  inspectChecks,
  isExactCleanReview,
  maybeAutopick,
  normalizeAuthorityBody,
  isExactReviewRequest,
  latestDecisiveReviews,
  latestSubmittedReviewAt,
  occursAfterReviewRequest,
  parseMergeLease,
  parseMergeAuthorization,
  readOwnerMergeAuthorization,
  readOwnerMergeAuthorizations,
  run,
  selectActiveDraft,
  selectMergeCandidate,
};
