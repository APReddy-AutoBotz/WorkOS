# DOC-WOS-00-001 — Blueprint Controller Review

**Workstream:** WOS-00 / WOS-00F corrective closure  
**Governing issue:** #2  
**Corrective issue:** #13  
**Historical merged pull request:** #1  
**Active corrective pull request:** #14  
**Active branch:** `controller/wos-00f-approval-controls`  
**Historical merged baseline:** `main@880b3dc244bf516c4e535fb68e455e6153aec395`  
**Evidence posture:** Current consolidated controller record; detailed independent-review history is maintained in `DOC-WOS-00-002-REVIEW-RESOLUTION.md`  
**Status:** WOS-00 is under corrective hold. Gate B remains approved for the bounded correction, but accepted WOS-00 weight remains 0% until PR #14 is independently clean-reviewed with no P0/P1/P2, merged under an expected-head guard, and the corrected exact `main` SHA is recorded.

## Outcome reviewed

The WOS-00 blueprint establishes governing product requirements, programme controls, architecture overview and eight ADRs, product/feature specifications, quality/security/release controls, repository templates, Codex execution guidance, source-provenance policy, implementation roadmap, risk register and buyer-handover controls.

PR #1 has already been squash-merged. A post-merge independent review identified approval/invoice and notification-authority defects, so WOS-00F Draft PR #14 is the active corrective vehicle. The historical PR #1 workflow is no longer an active gate path.

Application source, reference Git history, credentials, real company/customer data and transaction-specific pricing/licensing/assignment strategy remain excluded from WOS-00/WOS-00F.

## Current controller checks

| Check | Result | Evidence / limitation |
|---|---|---|
| Required WOS-00/WOS-00F file inventory | PASS | Governing blueprint and corrective-evidence files are present and substantive |
| Authoritative requirement structure | PASS | 126 canonical product IDs and 81 separately namespaced NFR IDs retained |
| Derived feature-spec mapping | PASS | Feature specifications declare governing requirement ranges and planned implementation/evidence ownership |
| Architecture decision completeness | PASS | ADR-001 through ADR-008 retain status, context, decision, alternatives, consequences and verification/rollback |
| Workstream and issue mapping | PASS | Issues #2 through #11 remain mapped; #13 owns bounded WOS-00F correction; PR #12 remains dependency-blocked |
| Gate sequencing | PASS | Gate B remains approved; Gate C follows merged PR-010/011/012 plus independent PR-012 engineering acceptance; Gate D governs v1 release |
| Commercial terminology and policy | PASS | Fixed-fee controls remain non-statutory operational earned-management only, policy-gated and independent from billing eligibility |
| Commercial lineage | PASS | Source → eligibility event → approved-unbilled item → database-unique current occupancy → invoice-ready line/batch → accepted provider/CSV export |
| PR-012 occupancy evidence ownership | PASS | Same-batch/cross-batch/concurrent duplication, idempotency, route bypasses, cancellation/re-batching, final occupancy and versioned corrections remain mandatory |
| Export-state consistency | PASS | Initial delivery is `Approved`-only; `Exported`/`Billed/Confirmed` support retrieval/status only |
| Production identity consistency | PASS | Production requires configured OIDC/named accounts and fails closed without valid identity configuration |
| Notification scope and exclusivity | PASS | Four policy classes and thirteen canonical event/template/default-recipient rows remain owned by PR-013; generic approval and domain action events are mutually exclusive by trigger |
| Protected-recipient persistence | PASS | Mandatory protected event/in-app recipient records and reason mappings are all-or-nothing; external delivery is downstream and separately retriable |
| Leave/utilization semantics | PASS | Leave/absence reduces availability once and is never productive/billable work |
| Product-boundary consistency | PASS | Shared SaaS, payroll, statutory invoicing/GL, full CRM/mobile and autonomous AI remain deferred |
| Forbidden reference-company runtime wording | PASS | Reference terms remain restricted to approved provenance/control locations; runtime implementation is absent |
| Credential/personal/customer data review | PASS | No credentials, real customer data or production values introduced |
| GitHub issue-template front matter | PASS | Classic templates retain required front matter |
| Mermaid-aware validation | NOT RUN | Parser acquisition was blocked by registry HTTP 403; no fence-balancing PASS is claimed |
| Application build/runtime/API/migration/browser tests | SKIP / NOT RUN | WOS-00F is documentation/control-only and contains no runnable artifact |

## Current authority and dependency hold

The controlling sequence is now:

1. Draft PR #14 must receive a fresh independent exact-head Codex/Sol review with **no P0/P1/P2** findings.
2. Any active blocking review thread must be resolved or demonstrably outdated by the exact reviewed head.
3. PR #14 may then be marked Ready and merged only with an expected-head guard against that clean-reviewed SHA.
4. The resulting corrected exact `main` SHA must be recorded as the accepted WOS-00 baseline.
5. The controller must explicitly reauthorize WOS-01A.
6. PR #12 must be recreated or rebased from the corrected baseline before any source import resumes.

PR #1 having merged is historical fact only and **does not** authorize WOS-01A. Any earlier wording that allowed WOS-01 to start merely after PR #1 merged is superseded by the WOS-00F corrective hold.

## Independent review history and disposition

Rounds 1–13 belong to the original PR #1 blueprint review cycle. Those findings and resolutions remain historical evidence in `DOC-WOS-00-002-REVIEW-RESOLUTION.md`.

Post-merge PR #14 review rounds then identified and corrected:

- invoice-batch approval-reopen conflict;
- missing source-owner recipients for generic rejection/correction;
- stale canonical recipient matrices and issue ownership;
- stale primary implementation/traceability state;
- atomic zero-partial protected-recipient persistence;
- executable verification/rollback truth;
- residual WOS-01 authorization wording;
- forbidden-term scan contradiction;
- Mermaid validation overclaim;
- backlog baseline-recording prerequisite and A–I adversarial-evidence coverage.

The most recent independent reviews of exact head `81f58a01d980031c87415bf5ba5347ec39877eed`, reviews `PRR_kwDOUAv8Lc8AAAABKpzHEw` and `PRR_kwDOUAv8Lc8AAAABKp-K9w`, identified three P2 authority inconsistencies: this controller record remained PR #1/Round-13 centric, the correction report omitted full WOS-01A reauthorization/recreate-or-rebase prerequisites, and `DOC-WOS-00-002` retained stale primary PR #1/Round-13 authority. This bounded follow-up corrects those authority defects but does **not** claim a clean final review.

## Gate B record

`DOC-WOS-00-003-GATE-B-APPROVAL.md` records the product owner's 2026-08-23 approval. Gate B remains approved for the bounded WOS-00F correction, but it does not waive exact-head review, protected source boundaries, merge controls, corrected-baseline recording or the explicit controller reauthorization required before WOS-01A.

## Open gates

- Publish the bounded Round-19 authority correction on PR #14.
- Run a fresh independent Codex/Sol review of the exact resulting PR #14 head.
- Resolve any P0/P1/P2 finding before Ready/merge.
- Mark Ready only after a clean exact-head review and thread convergence.
- Squash-merge PR #14 with an expected-head guard.
- Record the corrected exact `main` SHA as the accepted WOS-00 baseline.
- Close issue #13 and return issue #2 to completed only after merge verification.
- Explicitly reauthorize WOS-01A and recreate or rebase PR #12 from the corrected baseline before any source import resumes.

## Deferred owner decisions

Final commercial name/trademark, transaction-specific legal/commercial terms, buyer-specific RPO/RTO/support targets and first-buyer policy choices remain external or deferred and do not block the technical blueprint.
