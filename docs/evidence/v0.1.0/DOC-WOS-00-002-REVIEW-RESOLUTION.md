# DOC-WOS-00-002 — Independent Review Resolution

**Workstream:** WOS-00  
**Issue:** #2  
**Pull request:** #1  
**Reviewed head:** `492715dc8a40de6431365b6e52378d317721f617`  
**Independent review ID:** `5000738492`  
**Status:** Five P1 and two P2 findings corrected; fresh independent review of the moved head pending

## Resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Workforce requirements lacked explicit implementation owners | P1 | Split WOS-WKF ownership across PR-004 and PR-008 with concrete evidence |
| NFR wildcard did not assign all quality families | P1 | Mapped all 11 NFR families to accountable PRs and evidence |
| Approved-unbilled excluded several engagement models | P1 | Defined T&M, milestone, fixed-fee, retainer, managed-service and adjustment source eligibility |
| Neutral revenue policy was undefined | P1 | Defined non-statutory operational earned-management profiles and fail-closed non-T&M default |
| Owner-only commercialization defaults leaked into product docs | P1 | Removed licence-vs-sale/pricing defaults and retained only a neutral external legal/commercial gate |
| Forbidden-term allowlist was not reproducible | P2 | Neutralized reference-company literals outside approved provenance/control files |
| Gate A was claimed but undefined | P2 | Removed Gate A as a formal gate; programme initiation is contextual and formal gates remain B, C and D |

## Supplemental controller corrections

- Leave/absence is an availability reference, never productive/billable work, and cannot reduce capacity twice.
- PR-002 cannot merge a prohibited company-specific runtime; cleanup occurs within PR-002 or only the clean stacked PR-003 state merges.

## Open gates

- Fresh independent Codex/Sol review at the exact moved PR head.
- Resolution of any remaining blocking finding.
- Product-owner Gate B approval.
- Exact-head squash merge and v0.1.0 baseline.
