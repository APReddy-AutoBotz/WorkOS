# DOC-WOS-00-002 — Independent Review Resolution

**Workstream:** WOS-00  
**Issue:** #2  
**Pull request:** #1  
**First reviewed head:** `492715dc8a40de6431365b6e52378d317721f617`  
**First independent review ID:** `PRR_kwDOUAv8Lc8AAAABKhE2vA`  
**Second reviewed head:** `c2e3dbb74bc7c78a8f946222497850ac0c49ac78`  
**Second independent review ID:** `PRR_kwDOUAv8Lc8AAAABKhJrmQ`  
**Third reviewed head:** `1f36b49461b86516b5855dbf9930a75f234b58e1`  
**Third independent review ID:** `PRR_kwDOUAv8Lc8AAAABKhMTmA`  
**Fourth reviewed head:** `9fc70babdf7c4d5c72f9d18a54f8c2318c903b3b`  
**Fourth independent review ID:** `PRR_kwDOUAv8Lc8AAAABKhNcnA`  
**Fifth reviewed head:** `649db270e8d43af152076e1f99e07c7204c575fc`  
**Fifth independent review ID:** `PRR_kwDOUAv8Lc8AAAABKhROXA`  
**Sixth reviewed head:** `7124709e4f6682ded0321c58d22a6851a5e32b9d`  
**Sixth independent review IDs:** `PRR_kwDOUAv8Lc8AAAABKhU3Ng`, `PRR_kwDOUAv8Lc8AAAABKhVa0Q`  
**Status:** Six independent review rounds completed; all historical P1/P2 findings corrected; one clean final exact-head re-review remains pending

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

## Third-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| `DOMAIN_MODEL.md` retained a stale direct calculation-snapshot-to-invoice-ready-line edge despite the corrected governing architecture | P1 | Removed the stale edge and introduced explicit versioned `BILLING_ELIGIBILITY_EVENT` and `APPROVED_UNBILLED_ITEM` relationships. Calculation snapshots are valuation evidence only; all supported source families must create a source-specific eligibility-event version before entering the approved-unbilled register or an invoice-ready batch. Reversal/supersession and no-active/final-batch uniqueness are explicit. |

## Fourth-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Authoritative and derived documents still allowed a raw source or T&M calculation snapshot to satisfy invoice-line traceability without mandating the event → register → line boundary | P1 | Made the versioned approved-unbilled item the only batchable object, created one-to-one from a versioned billing-eligibility event. Requirements, architecture, specifications, tests, PR-012 backlog and traceability reject direct raw-source/snapshot line creation and require source → event → register → line → batch → export lineage. |

## Fifth-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Product-owner Gate C was still listed as PR-011 evidence before invoice-readiness PR-012 | P1 | Removed Gate C from PR-011. Gate C now occurs only after PR-010, PR-011 and PR-012 are merged and PR-012 engineering acceptance is independently proven at an exact head. Gate C is additional owner acceptance and does not replace engineering evidence. |
| Authoritative WOS-INV-006/008 lacked exact state, occupancy, cancellation, export-failure and versioned-correction semantics | P1 | Defined canonical states, occupying classes, allowed transitions, terminal behavior, failed-export handling, pre-export cancellation with atomic occupancy release, eligibility revalidation and permanent occupancy of exported/billed lineage. Corrections use versioned reversal/superseding records. |

## Sixth-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Delivery playbook still described Gate C as a calculation/margin milestone | P1 | `CODEX_EXECUTION_PLAYBOOK.md` now states that Gate C follows complete PR-010/011/012 delivery and independently proven PR-012 acceptance, including terms, calculations, billing eligibility, approved-unbilled, complete batch lifecycle, provider/CSV export lineage, corrections, authorization and reconciliation. PR-011 alone cannot satisfy Gate C. |
| Initial finance export wording allowed approved or finalized batches | P2 | Requirements, API, integration, commercial specification, backlog and tests now permit initial delivery only from `Approved`. `Exported` and `Billed/Confirmed` support only idempotent retrieval/redownload or status confirmation of the already accepted artifact, never duplicate delivery or re-transition. |
| Traceability reported only four/five review rounds | P2 | `REQUIREMENTS_TRACEABILITY.md`, this evidence record and `IMPLEMENTATION_STATUS.md` now record all six completed review rounds and the clean final review gate. |
| CSV export had no acceptance semantics without a provider | P1 | An `Approved` batch becomes `Exported` through CSV only after atomic creation and recording of an immutable versioned artifact with operation/idempotency ID, artifact ID/version, checksum, schema version, line count, control totals, timestamp, actor and complete lineage. Failure remains `Approved`; same-key retries return the same artifact. |
| WOS-INT-001/002 notification delivery lacked a concrete implementation owner | P1 | PR-013 and issue #9 own in-app notifications, email/collaboration adapters, versioned templates, preferences, mandatory recipients, scoped recipient resolution, delivery attempts/evidence, retries, idempotency, failure isolation, sanitized health and positive/negative security tests. |
| ADR-007 permitted production local-auth fallback | P1 | Production OIDC now fails closed. WorkOS local accounts remain non-production/demo only. Emergency recovery must be an external named, separately approved and audited infrastructure/IdP process that preserves WorkOS role, permission, data-scope and session controls. |

## Supplemental controller corrections

- Leave/absence is an availability reference, never productive/billable work, and cannot reduce capacity twice.
- PR-002 cannot merge a prohibited company-specific runtime; cleanup occurs within PR-002 or only the clean stacked PR-003 state merges.
- Operational earned-management revenue is non-statutory reporting/management evidence and never grants billing authority.
- Every production mutation receives an explicit common and module-specific traceability/audit owner.
- The commercial model separates valuation snapshots, billing eligibility, approved-unbilled registration, invoice-ready batching and downstream finance export.
- Raw T&M snapshots, milestones, fixed-fee schedules, retainer/managed-service events and adjustments remain read-only source evidence; none is an alternative batchable object.
- Canonical invoice-batch states and occupancy semantics are authoritative in WOS-INV-006/008 and test-owned by PR-012.
- Initial provider/CSV delivery is `Approved`-only; accepted final artifacts are immutable and final states are retrieval/status-only.
- Gate C follows complete WOS-06 delivery and cannot be satisfied by PR-011 alone or substitute for PR-012 engineering acceptance.
- Notification delivery is implemented and evidenced in PR-013; production identity fail-closed behavior is implemented and evidenced in PR-014.

## Controller verification after sixth-review correction

| Check | Result | Evidence / limitation |
|---|---|---|
| Gate C sequence | PASS | Playbook, backlog, commercial spec and release controls require complete PR-010/011/012 engineering acceptance before Gate C |
| Approved-only initial export | PASS | Requirements, API, integration, commercial spec and PR-012 reject initial delivery from non-Approved states |
| CSV acceptance and idempotency | PASS | Immutable artifact metadata, atomic transition, failure behavior and same-key retrieval are defined and test-owned |
| Final-state duplicate-delivery prevention | PASS | Exported/Billed states permit retrieval/status only and cannot initiate delivery or re-transition |
| Notification implementation ownership | PASS | PR-013/issue #9/traceability include complete notification scope and evidence |
| Production identity fail-closed | PASS | ADR-007, requirements, backlog and tests prohibit production local-auth fallback |
| Requirement/NFR counts | Pending independent rerun | Clean final review must confirm 126 product IDs and 81 NFR IDs |
| Application tests | SKIP | WOS-00 intentionally contains no application source |
| Shell/documentation-safe checks | NOT RUN by controller connector | Mandatory in the clean final Codex/Sol review against the exact moved head |

## Publication notes

Codex correction tasks produced local commits that could not be pushed because the task checkout lacked usable GitHub transport. The implementation controller independently materialized and reviewed the approved documentation changes through the connected GitHub controller interface. Unpublished local commits are not acceptance evidence; only the live GitHub PR head is used for final review and Gate B.

## Open gates

- Fresh clean independent Codex/Sol re-review at the exact final PR head after sixth-review corrections.
- Resolution of any remaining blocking finding.
- Product-owner Gate B approval.
- Exact-head squash merge and `v0.1.0` baseline.
