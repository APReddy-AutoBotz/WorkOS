'use strict';

const HEARTBEAT_MARKER = '<!-- workos-continuous-controller -->';
const AUTOPICK_MARKER = '[WORKOS-CONTROLLER-AUTOPICK]';
const MERGE_LEASE_PATTERN = /\[WORKOS-AUTO-MERGE\s+head=([0-9a-f]{40})\s+base=([0-9a-f]{40})\]/i;
const TRANSIENT_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'startup_failure']);
const BOT_LOGINS = new Set(['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector']);
const MINUTE = 60 * 1000;

function parseMergeLease(body = '') {
  const match = String(body).match(MERGE_LEASE_PATTERN);
  return match ? {head: match[1].toLowerCase(), base: match[2].toLowerCase()} : null;
}

function isExactCleanReview(body = '', headSha = '') {
  const text = String(body).replace(/\s+/g, ' ').trim();
  if (!headSha || !text.toLowerCase().includes(headSha.toLowerCase())) return false;
  return /no\s+(?:actionable\s+|current\s+|remaining\s+)?p0\s*\/\s*p1\s*\/\s*p2\s+(?:finding|findings|issue|issues|blocker|blockers)(?:\s+remain(?:s|ing)?)?/i.test(text)
    || /p0\s*\/\s*p1\s*\/\s*p2[^.]{0,80}\b(?:none|clean|clear)\b/i.test(text);
}

function checksAreGreen(checkRuns = [], statuses = []) {
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
  const badStatus = (statuses || []).find((status) => status.state !== 'success');
  if (badStatus) {
    return {green: false, reason: `status ${badStatus.context || 'unknown'} is ${badStatus.state}`};
  }
  return {green: true, reason: 'all exact-head check runs and statuses succeeded'};
}

function classifyLatestWorkflowRuns(runs = []) {
  const latestByWorkflow = new Map();
  for (const run of [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))) {
    if (!latestByWorkflow.has(run.workflow_id)) latestByWorkflow.set(run.workflow_id, run);
  }
  const latest = [...latestByWorkflow.values()];
  const active = latest.find((run) => run.status === 'queued' || run.status === 'in_progress');
  if (active) return {classification: 'active', run: active};
  const transient = latest.find((run) =>
    run.status === 'completed'
    && TRANSIENT_CONCLUSIONS.has(run.conclusion)
    && Number(run.run_attempt || 1) < 2
  );
  if (transient) return {classification: 'transient', run: transient};
  const failure = latest.find((run) => run.status === 'completed' && run.conclusion === 'failure');
  if (failure) return {classification: 'failure', run: failure};
  return {classification: 'none', run: null};
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

async function listReviewThreads(github, owner, repo, number) {
  const nodes = [];
  let after = null;
  do {
    const data = await github.graphql(`
      query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              nodes { id isResolved }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `, {owner, repo, number, after});
    const page = data.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error(`Unable to read review threads for PR #${number}`);
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

async function inspectReviewGate({github, owner, repo, pr}) {
  const threads = await listReviewThreads(github, owner, repo, pr.number);
  const unresolved = threads.filter((thread) => !thread.isResolved);
  if (unresolved.length > 0) {
    return {clean: false, reason: `${unresolved.length} unresolved review thread(s)`};
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const latestByAuthor = new Map();
  for (const review of [...reviews].sort((a, b) => new Date(b.submitted_at || b.submittedAt || 0) - new Date(a.submitted_at || a.submittedAt || 0))) {
    const login = review.user?.login || review.author?.login;
    if (login && !latestByAuthor.has(login)) latestByAuthor.set(login, review);
  }
  const changeRequest = [...latestByAuthor.values()].find((review) => review.state === 'CHANGES_REQUESTED');
  if (changeRequest) {
    return {clean: false, reason: `changes requested by ${changeRequest.user?.login || changeRequest.author?.login}`};
  }

  const commit = await github.rest.repos.getCommit({owner, repo, ref: pr.head.sha});
  const headTime = new Date(commit.data.commit.committer?.date || commit.data.commit.author?.date || 0);
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const exactCleanComment = comments.find((comment) =>
    BOT_LOGINS.has(comment.user?.login)
    && new Date(comment.created_at) >= headTime
    && isExactCleanReview(comment.body || '', pr.head.sha)
  );
  const exactCleanReview = reviews.find((review) => {
    const login = review.user?.login || review.author?.login;
    const submitted = new Date(review.submitted_at || review.submittedAt || 0);
    return BOT_LOGINS.has(login) && submitted >= headTime && isExactCleanReview(review.body || '', pr.head.sha);
  });
  if (!exactCleanComment && !exactCleanReview) {
    return {clean: false, reason: 'no independent exact-head no-P0/P1/P2 confirmation'};
  }
  return {clean: true, reason: 'independent exact-head review is clean'};
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
  return checksAreGreen(checks, combined.data.statuses || []);
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

  const result = await github.rest.pulls.merge({
    owner,
    repo,
    pull_number: final.number,
    sha: final.head.sha,
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
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: active.number,
    per_page: 100,
  });
  const now = Date.now();
  const botResponses = comments
    .filter((comment) => BOT_LOGINS.has(comment.user?.login))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const taskComments = comments
    .filter((comment) => /@codex\b/i.test(comment.body || ''))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const autoComments = comments
    .filter((comment) => (comment.body || '').includes(AUTOPICK_MARKER))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const latestBot = botResponses[0] || null;
  const latestTask = taskComments[0] || null;
  const latestAuto = autoComments[0] || null;
  const taskAge = latestTask ? now - new Date(latestTask.created_at).getTime() : Infinity;
  const botAge = latestBot ? now - new Date(latestBot.created_at).getTime() : Infinity;
  const autoAge = latestAuto ? now - new Date(latestAuto.created_at).getTime() : Infinity;
  const botRespondedAfterTask = Boolean(latestTask && latestBot && new Date(latestBot.created_at) > new Date(latestTask.created_at));
  const bodyAllowsWork = !/(dependency[- ]blocked|not authorized to import|do not resume)/i.test(active.body || '');
  const noLikelyRunningTask = !latestTask || botRespondedAfterTask || taskAge >= 75 * MINUTE;
  const shouldPost = bodyAllowsWork && noLikelyRunningTask && botAge >= 45 * MINUTE && autoAge >= 45 * MINUTE;
  if (!shouldPost) return {posted: false, detail: 'current task/review activity is still fresh'};

  const taskMatch = (active.body || '').match(/`(docs\/tasks\/[^`]+\.md)`/i);
  const taskReference = taskMatch
    ? `Read and execute \`${taskMatch[1]}\` and the current PR body as the governing contract.`
    : 'Read the current PR body and governing WorkOS control documents before acting.';
  const body = `@codex ${AUTOPICK_MARKER}\n\nContinue the active WorkOS implementation on PR #${active.number} from exact published head \`${active.head.sha}\`. ${taskReference}\n\nUse the **WorkOS Implementation** environment and the strongest appropriate **Sol** reasoning model. Re-fetch live PR/head/base/check/review state before any write. Use one root writer/coordinator. Resolve the next coherent blocker family, run every applicable exact-head gate, publish only to the existing branch under an exact-old-head lease, request a fresh independent exact-head review, and merge only when explicitly permitted by the governing task.\n\nKeep Draft unless all Ready gates are independently proven. Never deploy, use real secrets/providers/customer data, modify the authorized reference repository, weaken a gate, create a duplicate active PR, or start a dependency-blocked later workstream.`;
  await github.rest.issues.createComment({owner, repo, issue_number: active.number, body});
  return {posted: true, detail: `posted bounded Codex continuation on PR #${active.number}`};
}

async function publishHeartbeat({github, context, owner, repo, mainSha, pulls, active, mergeCandidate, action}) {
  const issueNumber = 3;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((comment) =>
    (comment.body || '').includes(HEARTBEAT_MARKER) && comment.user?.login === 'github-actions[bot]'
  );
  const openSummary = pulls
    .filter((pr) => /^(?:WOS-|CTRL:)/i.test(pr.title || ''))
    .slice(0, 8)
    .map((pr) => `- #${pr.number} ${pr.draft ? 'Draft' : 'Ready'}: \`${pr.head.sha}\` → \`${pr.base.sha}\` — ${pr.title}`)
    .join('\n') || '- none';
  const body = `${HEARTBEAT_MARKER}\n## WorkOS continuous implementation controller\n\n- Cadence: every 10 minutes plus manual dispatch\n- Current main: \`${mainSha}\`\n- Active Draft: ${active ? `#${active.number} at \`${active.head.sha}\`` : 'none'}\n- Exact auto-merge candidate: ${mergeCandidate ? `#${mergeCandidate.number} at \`${mergeCandidate.head.sha}\`` : 'none'}\n- Last state-changing/classified action: **${action.classification}** — ${action.detail}\n\n### Open WorkOS controller/implementation PRs\n${openSummary}\n\nThe controller never marks a Draft Ready, never treats stale/pending/skipped/cancelled/unexecuted checks as green, and merges only a non-Draft PR carrying an exact head/base lease after all exact-head checks succeed, an independent exact-head review reports no actionable P0/P1/P2, no review thread or change request remains, and GitHub reports a clean merge state. It never deploys or uses real providers, secrets or customer data.`;
  if (!existing) {
    await github.rest.issues.createComment({owner, repo, issue_number: issueNumber, body});
  } else if ((existing.body || '').trim() !== body.trim()) {
    await github.rest.issues.updateComment({owner, repo, comment_id: existing.id, body});
  }
  return body;
}

async function run({github, context, core}) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const main = (await github.rest.repos.getBranch({owner, repo, branch: 'main'})).data;
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  });
  const active = selectActiveDraft(pulls);
  const mergeCandidate = selectMergeCandidate(pulls);
  let action = {classification: 'observed', detail: 'no state-changing action was eligible'};

  if (mergeCandidate) {
    action = await attemptGuardedMerge({github, owner, repo, candidate: mergeCandidate});
  }
  if (!action.performed) {
    const transient = await maybeRerunTransient({github, owner, repo, active});
    if (transient?.rerun) {
      action = {
        classification: 'transient-rerun',
        detail: `reran workflow ${transient.run.id} once after ${transient.run.conclusion}`,
      };
    } else if (transient?.classification === 'failure') {
      action = {
        classification: 'gate-failure',
        detail: `latest workflow ${transient.run.id} failed; no automatic rerun because failure is not proven transient`,
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

  const heartbeat = await publishHeartbeat({
    github,
    context,
    owner,
    repo,
    mainSha: main.commit.sha,
    pulls,
    active,
    mergeCandidate,
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
  AUTOPICK_MARKER,
  HEARTBEAT_MARKER,
  checksAreGreen,
  classifyLatestWorkflowRuns,
  isExactCleanReview,
  parseMergeLease,
  run,
  selectActiveDraft,
  selectMergeCandidate,
};
