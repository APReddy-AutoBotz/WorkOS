from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"unexpected {label} count: {count}")
    return text.replace(old, new, 1)


def run(command: list[str], cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: publish-pr28-final-gates.py <target-root>")
    root = Path(sys.argv[1]).resolve()

    controller_path = root / ".github/scripts/workos-continuous-controller.cjs"
    controller = controller_path.read_text()

    old_pattern = "const REVIEW_RESULT_PATTERN = /\\[WORKOS-INDEPENDENT-REVIEW-RESULT\\s+head=([0-9a-f]{40})\\s+result=clean\\s+p0=0\\s+p1=0\\s+p2=0\\]/i;"
    new_pattern = "const REVIEW_RESULT_PATTERN = /^\\[WORKOS-INDEPENDENT-REVIEW-RESULT\\s+head=([0-9a-f]{40})\\s+result=clean\\s+p0=0\\s+p1=0\\s+p2=0\\]$/i;\nconst NON_AUTHORITATIVE_REVIEW_PATTERN = /\\b(?:do not accept|do not use|not authoritative|quoted example|example only|illustrative example|for example)\\b/i;"
    controller = replace_once(controller, old_pattern, new_pattern, "review result pattern")

    clean_start = controller.index("function isExactCleanReview(body = '', headSha = '') {")
    clean_end = controller.index("\n\nfunction checksAreGreen", clean_start)
    clean_replacement = r"""function findStandaloneCleanResult(body = '', headSha = '') {
  const lines = String(body).replace(/\r/g, '').split('\n');
  let inFence = false;
  let result = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    const match = trimmed.match(REVIEW_RESULT_PATTERN);
    if (!match) continue;
    if (inFence || raw !== trimmed || result) return null;
    if (!headSha || match[1].toLowerCase() !== headSha.toLowerCase()) return null;
    result = {lines, index};
  }
  return result;
}

function isExactCleanReview(body = '', headSha = '') {
  const result = findStandaloneCleanResult(body, headSha);
  if (!result) return false;
  const outsideMarker = result.lines.filter((_line, index) => index !== result.index).join('\n').trim();
  if (NON_AUTHORITATIVE_REVIEW_PATTERN.test(outsideMarker)) return false;
  if (/\bp[0-2]\b/i.test(outsideMarker)) return false;
  return !CONTRADICTORY_REVIEW_PATTERN.test(outsideMarker);
}"""
    controller = controller[:clean_start] + clean_replacement + controller[clean_end:]

    checks_start = controller.index("function checksAreGreen(")
    checks_end = controller.index("\n\nfunction workflowRunTimestamp", checks_start)
    checks_replacement = r"""function checksAreGreen(checkRuns = [], statuses = [], aggregateState = '') {
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
}"""
    controller = controller[:checks_start] + checks_replacement + controller[checks_end:]

    controller = replace_once(
        controller,
        "  return checksAreGreen(checks, combined.data.statuses || []);",
        "  return checksAreGreen(checks, combined.data.statuses || [], combined.data.state);",
        "inspectChecks call",
    )

    merge_call = "  const result = await github.rest.pulls.merge({"
    if controller.count(merge_call) != 1:
        raise SystemExit(f"unexpected merge call count: {controller.count(merge_call)}")
    final_revalidation = """  const finalChecks = await inspectChecks({github, owner, repo, sha: final.head.sha});
  if (!finalChecks.green) {
    return {performed: false, classification: 'merge-blocked', detail: `final ${finalChecks.reason}`};
  }
  const finalReview = await inspectReviewGate({github, owner, repo, pr: final});
  if (!finalReview.clean) {
    return {performed: false, classification: 'merge-blocked', detail: `final ${finalReview.reason}`};
  }

"""
    controller = controller.replace(merge_call, final_revalidation + merge_call, 1)
    controller_path.write_text(controller)

    test_path = root / ".github/scripts/test-workos-continuous-controller.cjs"
    test = test_path.read_text()
    fixture_marker = "assert.equal(isExactCleanReview(`${cleanResult}\\nThere is an actionable P0 issue.`, HEAD), false);\n"
    fixture_addition = fixture_marker + r"""assert.equal(isExactCleanReview(`DO NOT ACCEPT THIS RESULT:\n${cleanResult}`, HEAD), false);
assert.equal(isExactCleanReview(`Quoted example only:\n\`${cleanResult}\``, HEAD), false);
assert.equal(isExactCleanReview(['```text', cleanResult, '```'].join('\n'), HEAD), false);
assert.equal(isExactCleanReview(`> ${cleanResult}`, HEAD), false);
assert.equal(isExactCleanReview(`  ${cleanResult}`, HEAD), false);
"""
    test = replace_once(test, fixture_marker, fixture_addition, "review fixture marker")

    old_success = """  ], [{context: 'legacy', state: 'success'}]),
  {green: true, reason: 'all exact-head check runs and statuses succeeded'},
);"""
    new_success = """  ], [{context: 'legacy', state: 'success'}], 'success'),
  {green: true, reason: 'all exact-head check runs and statuses succeeded'},
);"""
    test = replace_once(test, old_success, new_success, "green-check fixture")

    old_negatives = """assert.equal(checksAreGreen([], []).green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'skipped'}], []).green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'in_progress', conclusion: null}], []).green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'pending'}]).green, false);
"""
    new_negatives = """assert.equal(checksAreGreen([], [], 'success').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'skipped'}], [], 'success').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'in_progress', conclusion: null}], [], 'success').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'pending'}], 'pending').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'success'}], 'pending').green, false);
assert.equal(checksAreGreen([{name: 'build', status: 'completed', conclusion: 'success'}], [{context: 'legacy', state: 'success'}], 'failure').green, false);
"""
    test = replace_once(test, old_negatives, new_negatives, "negative check fixtures")

    source_marker = "assert.match(source, /CONTRADICTORY_REVIEW_PATTERN/);\n"
    source_addition = source_marker + """assert.match(source, /NON_AUTHORITATIVE_REVIEW_PATTERN/);
assert.match(source, /findStandaloneCleanResult/);
assert.match(source, /combined\\.data\\.state/);
"""
    test = replace_once(test, source_marker, source_addition, "source assertion marker")

    merge_marker = "assert.match(source, /merge_method: 'squash'/);\n"
    merge_addition = merge_marker + """const finalValidationStart = source.indexOf('const final =');
const finalMergeStart = source.indexOf('const result = await github.rest.pulls.merge', finalValidationStart);
assert.ok(finalValidationStart >= 0 && finalMergeStart > finalValidationStart);
const finalValidation = source.slice(finalValidationStart, finalMergeStart);
assert.match(finalValidation, /finalChecks = await inspectChecks/);
assert.match(finalValidation, /finalReview = await inspectReviewGate/);
"""
    test = replace_once(test, merge_marker, merge_addition, "merge assertion marker")

    report_marker = "  structuredIndependentReview: true,"
    report_replacement = report_marker + "\n  standaloneReviewResult: true,\n  aggregateCommitStatus: true,\n  finalMutableGateRevalidation: true,"
    test = replace_once(test, report_marker, report_replacement, "report marker")
    test_path.write_text(test)

    docs_path = root / "docs/tasks/WOS-CONTINUOUS-CONTROLLER.md"
    docs = docs_path.read_text()
    old_review = """A later Codex response or submitted Codex review must contain the exact, unambiguous result marker:

```text
[WORKOS-INDEPENDENT-REVIEW-RESULT head=<40-character-head-sha> result=clean p0=0 p1=0 p2=0]
```

Natural-language self-reports, implementation completion comments, responses before the marked request, wrong-head markers, question-form claims, negated clean language or any contradictory P0/P1/P2 wording do not satisfy the review gate.
"""
    new_review = """A later Codex response or submitted Codex review must contain the exact, unambiguous result marker as one affirmative, unquoted standalone line:

```text
[WORKOS-INDEPENDENT-REVIEW-RESULT head=<40-character-head-sha> result=clean p0=0 p1=0 p2=0]
```

Inline, prefixed, backtick-quoted, blockquoted or fenced example markers do not qualify. Natural-language self-reports, implementation completion comments, responses before the marked request, wrong-head markers, question-form claims, negated clean language, non-authoritative example language or any contradictory P0/P1/P2 wording do not satisfy the review gate.
"""
    docs = replace_once(docs, old_review, new_review, "docs review section")

    old_items = """3. at least one exact-head check run exists and every check run/status is completed successfully, with no pending, neutral, skipped, cancelled or unexecuted result accepted;
4. no unresolved review thread remains;
5. neither GitHub's aggregate review decision nor any reviewer's latest decisive review is `CHANGES_REQUESTED`; a later `COMMENTED` review cannot hide an earlier change request;
6. an owner-authored exact-head independent-review request exists after the head commit;
7. a Codex structured clean result exists after that distinct request and is bound to the same exact SHA;
8. a final live re-fetch proves that Draft/state/head/base and the body lease did not move;
9. the merge API receives the exact expected head SHA.
"""
    new_items = """3. at least one exact-head check run exists, every check run/status is completed successfully, and GitHub's aggregate commit-status state is exactly `success`, with no pending, neutral, skipped, cancelled, omitted or unexecuted result accepted;
4. no unresolved review thread remains;
5. neither GitHub's aggregate review decision nor any reviewer's latest decisive review is `CHANGES_REQUESTED`; a later `COMMENTED` review cannot hide an earlier change request;
6. an owner-authored exact-head independent-review request exists after the head commit;
7. a Codex structured clean result exists after that distinct request, is bound to the same exact SHA and appears as an affirmative standalone line;
8. a final live re-fetch proves that Draft/state/head/base and the body lease did not move;
9. immediately after that final fetch, the controller reruns the complete mutable check/status and review/thread gates and fails closed if any changed;
10. the merge API receives the exact expected head SHA.
"""
    docs_path.write_text(replace_once(docs, old_items, new_items, "docs merge list"))

    run(["node", ".github/scripts/test-workos-continuous-controller.cjs"], root)
    run(["node", "--check", ".github/scripts/workos-continuous-controller.cjs"], root)
    run(["git", "diff", "--check"], root)


if __name__ == "__main__":
    main()
