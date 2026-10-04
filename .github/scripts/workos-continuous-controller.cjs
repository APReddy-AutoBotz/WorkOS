'use strict';

const HEARTBEAT_MARKER = '<!-- workos-continuous-controller -->';
const LEGACY_HEARTBEAT_MARKER = '<!-- workos-hourly-controller -->';
const AUTOPICK_MARKER = '[WORKOS-CONTROLLER-AUTOPICK]';
const MERGE_LEASE_PATTERN = /\[WORKOS-AUTO-MERGE\s+head=([0-9a-f]{40})\s+base=([0-9a-f]{40})\]/i;
const TRANSIENT_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'startup_failure']);
const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const DECISIVE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const BOT_LOGINS = new Set(['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector']);
const MINUTE = 60 * 1000;
const WORKFLOW_ACTIVITY_FRESHNESS_MS = 20 * MINUTE;
const MAX_AUTHORITY_BODY_LENGTH = 256;

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

function isExactCleanReview(body = '', headSha = '') {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) return false;
  return normalizeAuthorityBody(body)
    === '[WORKOS-INDEPENDENT-REVIEW-RESULT head=' + headSha + ' result=clean p0=0 p1=0 p2=0]';
}


function checksAreGreen(checkRuns = [], statuses = [], aggregateState = '') {
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    return {green: false, reason: 'no check runs exist for the exact head'};
  }
  const badCheck = checkRuns.find((check) =>
    check.status !== 'completed' || check.conclusion !== 'success'
  );
  if (badCheck) {
    return {
      green: false,
      reason: `check ${badCheck.name || badCheck.id} is ${badCheck.status}/${badCheck.conclusion || 'none'}`,
    };
  }
  if (aggregateState !== 'success') {
    return {green: false, reason: `combined status is ${aggregateState || 'missing'}`};
  }
  const badStatus = (statuses || []).find((status) => status.state !== 'success');
  if (badStatus) {
    return {green: false, reason: `status ${badStatus.context || 'unknown'} is ${badStatus.state}`};
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

function selectActiveDraft(pulls = []) {
  return pulls
    .filter((pr) => pr.draft && /^(?:WOS-|CTRL:)/i.test(pr.title || '') && !/transport/i.test(pr.title || ''))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0] || null;
}

function selectMergeCandidate(pulls = []) {
  return pulls
    .filter((pr) => {
      if (pr.draft || pr.state !== 'open') return false;
      const lease = parseMergeLease(pr.body || '');
      return lease && lease.head === pr.head.sha.toLowerCase() && lease.base === pr.base.sha.toLowerCase();
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
  return checksAreGreen(checks, combined.data.statuses || [], combined.data.state);
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
  const response = await github.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: active.head.sha,
    per_page: 50,
  });
  const classification = classifyLatestWorkflowRuns(response.data.workflow_runs || []);
  if (classification.classification !== 'transient') return classification;
  await github.rest.actions.reRunWorkflow({owner, repo, run_id: classification.run.id});
  return {...classification, rerun: true};
}

async function maybeAutopick({github, owner, repo, active}) {
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
  const body = `${HEARTBEAT_MARKER}\n## WorkOS continuous implementation controller\n\n- Cadence: every 10 minutes plus manual dispatch\n- Current main: \`${mainSha}\`\n- Active Draft: ${active ? `#${active.number} at \`${active.head.sha}\`` : 'none'}\n- Exact auto-merge candidate: ${mergeCandidate ? `#${mergeCandidate.number} at \`${mergeCandidate.head.sha}\`` : 'none'}\n- Last state-changing/classified action: **${action.classification}** — ${action.detail}\n\n### Open WorkOS controller/implementation PRs\n${openSummary}\n\nThe controller never marks a Draft Ready, never treats stale/pending/skipped/cancelled/unexecuted checks as green, and merges only a non-Draft PR carrying an exact head/base lease after all exact-head checks succeed, an owner-authored exact-head independent-review request is followed by a structured independent clean result, no review thread or change request remains, and GitHub reports a clean merge state. It never deploys or uses real providers, secrets or customer data.`;
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
  const initialPulls = await listOpenPulls(github, owner, repo);
  const active = selectActiveDraft(initialPulls);
  const mergeCandidate = selectMergeCandidate(initialPulls);
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
      const autopick = await maybeAutopick({github, owner, repo, active});
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
      const autopick = await maybeAutopick({github, owner, repo, active});
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
  const finalActive = selectActiveDraft(finalPulls);
  const finalMergeCandidate = selectMergeCandidate(finalPulls);
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
  classifyLatestWorkflowRuns,
  inspectReviewGate,
  isExactCleanReview,
  maybeAutopick,
  normalizeAuthorityBody,
  isExactReviewRequest,
  latestDecisiveReviews,
  latestSubmittedReviewAt,
  occursAfterReviewRequest,
  parseMergeLease,
  run,
  selectActiveDraft,
  selectMergeCandidate,
};
