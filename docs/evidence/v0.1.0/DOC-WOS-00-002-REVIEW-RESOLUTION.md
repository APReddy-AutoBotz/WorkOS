# DOC-WOS-00-002 — Independent Review Resolution

**Workstream:** WOS-00  
**Issue:** #2  
**Pull request:** #1  
**First reviewed head:** `492715dc8a40de6431365b6e52378d317721f617`  
**First independent review ID:** `5000738492`  
**Second reviewed head:** `c2e3dbb74bc7c78a8f946222497850ac0c49ac78`  
**Second independent review ID:** `PRR_kwDOUAv8Lc8AAAABKhJrmQ`  
**Status:** First-review five P1/two P2 findings and second-review two P1 findings corrected; final independent exact-head review pending

## First-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Workforce requirements lacked explicit implementation owners | P1 | Split WOS-WKF ownership across PR-004 and PR-008 with concrete evidence |
| NFR wildcard did not assign all quality families | P1 | Mapped all 11 NFR families to accountable PRs and evidence |
| Approved-unbilled excluded several engagement models | P1 | Defined T&M, milestone, fixed-fee, retainer, managed-service and adjustment source eligibility |
| Neutral revenue policy was undefined | P1 | Defined non-statutory operational earned-management profiles and fail-closed non-T&M default |
| Owner-only commercialization defaults leaked into product docs | P1 | Removed licence-vs-sale/pricing defaults and retained only a neutral external legal/commercial gate |
| Forbidden-term allowlist was not reproducible | P2 | Neutralized reference-company literals outside approved provenance/control files |
| Gate A was claimed but undefined | P2 | Removed Gate A as a formal gate; programme initiation is contextual and formal gates remain B, C and D |

## Second-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| WOS-CORE-004, WOS-CORE-005 and WOS-CORE-008 were not explicitly owned in planned PR requirement/evidence sections | P1 | Split the CORE traceability row, added a CORE ownership table, assigned the requirements to PR-004 and PR-006 through PR-014 as applicable, strengthened evidence gates, and aligned issues #4 through #10 |
| Architecture allowed an unconditional calculation-snapshot-to-invoice-ready-line path | P1 | Replaced the direct edge with a source-specific billing-eligibility gate and approved-unbilled register; T&M may use an approved eligible snapshot, while milestone, fixed-fee, retainer, managed-service and adjustment sources require their own approved/due eligibility event |

## Supplemental controller corrections

- Leave/absence is an availability reference, never productive/billable work, and cannot reduce capacity twice.
- PR-002 cannot merge a prohibited company-specific runtime; cleanup occurs within PR-002 or only the clean stacked PR-003 state merges.
- Operational earned-management revenue is non-statutory reporting/management evidence and never grants billing authority.
- Every production mutation receives an explicit common and module-specific traceability/audit owner.

## Open gates

- Fresh independent Codex/Sol review at the exact moved PR head.
- Resolution of any remaining blocking finding.
- Product-owner Gate B approval.
- Exact-head squash merge and v0.1.0 baseline.
