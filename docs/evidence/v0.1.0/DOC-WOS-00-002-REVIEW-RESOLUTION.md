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
**Status:** Five independent review rounds completed; all historical P1/P2 findings corrected; one clean final exact-head re-review remains pending

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
| `DOMAIN_MODEL.md` retained a stale direct calculation-snapshot-to-invoice-ready-line edge despite the corrected governing architecture | P1 | Removed the stale edge and introduced explicit versioned `BILLING_ELIGIBILITY_EVENT` and `APPROVED_UNBILLED_ITEM` relationships. Calculation snapshots are valuation evidence only; T&M, milestone, fixed-fee, retainer, managed-service and adjustment sources must create a source-specific eligibility-event version before entering the approved-unbilled register or an invoice-ready batch. Reversal/supersession and no-active/final-batch uniqueness are explicit. Corrected in commit `310e6e226099cd317b62222c1ce9440647a77d1f`. |

## Fourth-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Authoritative and derived documents still allowed a raw source or T&M calculation snapshot to satisfy invoice-line traceability without mandating the event → register → line boundary | P1 | The only batchable object is now a versioned `APPROVED_UNBILLED_ITEM` created one-to-one from a versioned `BILLING_ELIGIBILITY_EVENT`. `WOS-INV-001`, `WOS-INV-003`, `WOS-INV-007` and `WOS-INV-008`, data/API/integration architecture, commercial/reporting specifications, test strategy, PR-012 backlog and traceability all reject direct raw-source/snapshot line creation. Every line traces through one register item to one event/source version; active/final uniqueness, idempotency, reversal/supersession and control-total reconciliation are explicit. Correction sequence: `58e71fdfee898b4319e4156ca0bfec2ad471aef6`, `f2aa104d18e29eaa6bc52bd63538e4b61cbb051d`, `9a13accdcbe66b54110bcbd38714057dd9613ac6`, `d92920946019111309ffa85960a7dfc1bcc88539`, `027a2d261988135e527c2cf079c4737bf37ebc31`, `27be988d20f5f89cbd071e27a6add80ff293a63a`, `fbf50dac67c29574c10bd440a0a7112d92db3935`, `8486da8556d61a0504bfd1ed94da06a18dbf0487` and `059959ffe0bbbfd79cc1c0a9af941962c0a1ad9c`. |

## Fifth-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Product-owner Gate C was still listed as PR-011 evidence before invoice-readiness PR-012 | P1 | Removed Gate C from PR-011 and made its boundary explicit: PR-011 establishes calculation/margin engineering readiness only. Gate C is now placed after PR-010, PR-011 and PR-012 are merged and PR-012 engineering acceptance is independently proven at an exact head. Required Gate C evidence covers effective-dated terms, deterministic calculations, source-specific eligibility, approved-unbilled registration, complete batch lifecycle, export lineage, corrections, authorization and reconciliation. Corrected in commit `64a9e9a0f834a73c90928c9f64327c0d93694c9a`. |
| Authoritative WOS-INV-006/008 lacked exact state, occupancy, cancellation, export-failure and versioned-correction semantics | P1 | Defined canonical states and allowed transitions; open/active and final occupying classes; terminal states; failed export remaining `Approved`; pre-export cancellation with protected reason/audit and atomic occupancy release; eligibility revalidation after release; permanent occupancy for exported/billed lineage; and versioned reversal/superseding correction paths. Product requirements were corrected in commit `8e13bd105731713cd7af81a7c1ec86f1bc5f05c4`; backlog and test ownership were aligned in `64a9e9a0f834a73c90928c9f64327c0d93694c9a` and `9daf6e93c80c98c4e4ace4bf0b4590a9f696d046`. |

## Supplemental controller corrections

- Leave/absence is an availability reference, never productive/billable work, and cannot reduce capacity twice.
- PR-002 cannot merge a prohibited company-specific runtime; cleanup occurs within PR-002 or only the clean stacked PR-003 state merges.
- Operational earned-management revenue is non-statutory reporting/management evidence and never grants billing authority.
- Every production mutation receives an explicit common and module-specific traceability/audit owner.
- The commercial model consistently separates valuation snapshots, billing eligibility, approved-unbilled registration, invoice-ready batching and downstream finance export.
- Raw T&M snapshots, milestones, fixed-fee schedules, retainer/managed-service events and adjustments remain read-only source evidence; none is an alternative batchable object.
- Gate C follows complete WOS-06 delivery and cannot be satisfied by PR-011 alone or substitute for PR-012 engineering acceptance.
- Canonical invoice-batch states and occupancy semantics are authoritative in WOS-INV-006/008 and test-owned by PR-012.

## Controller verification after fifth-review correction

| Check | Result | Evidence / limitation |
|---|---|---|
| Gate C sequence | PASS | PR-011 explicitly cannot satisfy Gate C; Gate C follows complete PR-010/011/012 delivery and independent PR-012 engineering acceptance |
| Authoritative batch state model | PASS | WOS-INV-006 defines exact states, occupancy classes, transitions, terminal behavior, export acceptance/failure and cancellation |
| Authoritative no-double-billing occupancy | PASS | WOS-INV-008 applies uniqueness to open/active and final occupying batches and requires versioned corrections |
| Source-specific invoice boundary | PASS | WOS-INV-001/003/007/008 require event → approved-unbilled item → line/batch lineage |
| All six source families represented | PASS | T&M, milestone, fixed fee, retainer, managed service and approved adjustment are present in requirements/specifications/backlog/tests |
| Direct-bypass rejection specified | PASS | API, commercial specification, PR-012 and mandatory negative vectors reject raw-source/snapshot line creation |
| Batch lifecycle negative vectors | PASS | Test strategy covers invalid transitions, terminal states, failed export, cancellation, eligibility revalidation and correction lineage |
| Application tests | SKIP | WOS-00 intentionally contains no application source |
| Shell/documentation-safe checks | NOT RUN by controller connector | Mandatory in the clean final Codex/Sol review against the exact moved head |

## Publication note

The bounded Codex correction task produced local commit `6f4e521d8499320ab656d29c195518ff8db082cd` but could not publish it because its task checkout lacked usable GitHub push transport. The implementation controller independently materialized and reviewed the corrections through the connected GitHub controller interface. The unpublished local commit is not acceptance evidence.

## Open gates

- Fresh clean independent Codex/Sol re-review at the exact final PR head after the fifth-review corrections.
- Resolution of any remaining blocking finding.
- Product-owner Gate B approval.
- Exact-head squash merge and `v0.1.0` baseline.
