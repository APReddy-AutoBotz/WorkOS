# PR-008 finite acceptance checklist through PR62

> Historical engineering snapshot: the matrix, counts and decision questions below describe the original 2026-10-24 Draft baseline. They are preserved for traceability, not a current completion or approval register. The owner's later authorization permits independent review and eligible integration; current requirements, feature specifications and implementation status govern. Later accepted decisions/packages must be reconciled against their own evidence rather than inferred from this snapshot.

**Snapshot:** Draft PR62 `0eaf501b4988af107d1a503fe93ccab96b2eb96f`, tree `2ae3aaff3729c699c4bf6c8e3d5c6397a87a2ba3`, on2026-10-24. This is an ordinary product-completeness map of the approved backlog/specifications and delivered receipts, not cumulative code/security review, new findings or authorization to expand scope.

**Authority:** [Implementation backlog PR-008](../05-delivery/IMPLEMENTATION_BACKLOG.md#pr-008--wos-04-flexible-work-capture-and-resource-planning), [product requirements](../00-control/PRODUCT_REQUIREMENTS.md), [work-capture specification](../03-specifications/WORK_CAPTURE_AND_TIMESHEET_SPEC.md), [resource-planning specification](../03-specifications/RESOURCE_PLANNING_SPEC.md). These remain authoritative; this checklist neither changes business policy nor accepts a milestone.

## Status meaning and delivered evidence

Implemented means the stated required ordinary behavior exists in the dependent source and has engineering receipts, **not** merged/formally reviewed/product accepted. Partial means delivered foundations or legacy behavior cover only part of the requirement; Missing means no delivered authoritative capability/acceptance receipt for the stated remainder. Optional extensions do not become mandatory by appearing here. All requirements still need the applicable final integration/owner gates.

A–H delivered: PR55 assignment/work-date authority and immutable submission/decision history (migration044); PR56 scoped capture increments/aggregate limits/comments and lossless grid (045); PR57 explicit daily/weekly presentation and full-header optimistic saves (046); PR58 optional evidence URLs (047); PR59 optional descriptive task/ticket/milestone references (048); PR60 opt-in required positive-entry evidence (049); PR61 within-header exact-content advisories (050); PR62 read-only retained history. Their exact heads/test receipts belong to their Drafts; later results do not retroactively accept earlier stacks. PR62's exact-head CI40087049444 passed53 steps, with no skips. Prior report-read recovery and calendar inspection improved read behavior only, and expressly did not establish new capacity/report calculation semantics.

## Complete requirement matrix (28 rows)

| Requirement | Engineering status through PR62 | Delivered boundary / finite remainder |
|---|---|---|
| WOS-CORE-004 | Partial | Dated commercial/work/assignment checks and immutable work snapshots exist; complete effective capacity/assignment/report reconciliation remains R6/R7/R9. |
| WOS-CORE-005 | Partial | Delivered work/assignment/policy commands retain scoped audit and submission sources; remaining resource/policy commands need the same traceability in R1–R10. |
| WOS-TIM-001 | Implemented | Explicit scoped weekly/daily modes share one header, preserve all entries and use CAS. Optional timer is excluded from finish requirements. |
| WOS-TIM-002 | Partial | Legacy category text/context and server billability are retained. Governed seven-category/buyer-defined classification and nonclient contexts remain R1; optional absence display is not a finish blocker. |
| WOS-TIM-003 | Partial | Existing project/client contexts support worker/date/category/exact hours/billability/comment, evidence URL, descriptive reference and command/submission source. Governed nonclient category contexts and provider-neutral per-entry source identity remain R1/R5; reference text does not bind an actual milestone. |
| WOS-TIM-004 | Partial | Standard worker, assignment, parent/adopted dates and period checks span manual/import. A selected controlled exception policy, if needed, must use R4/R7; none is inferred from missing policy. |
| WOS-TIM-005 | Partial | Buyer-selected increments, daily/weekly aggregate maxima, positive comments/evidence are implemented. Overtime rules remain R2; no payroll/rate behavior is authorized. |
| WOS-TIM-006 | Partial | Draft/Submitted/Approved/Rejected and immutable rejected correction exist; reporting-period locks deny edits. Explicit applicable Reopened/Correction Required/Locked state policy remains R4. |
| WOS-TIM-007 | Missing | Configurable deadline/grace policy, its precedence and late behavior remain R3. |
| WOS-TIM-008 | Implemented | Required rejection reason, rejected correction, prior snapshots/decisions and read-only inspection exist; Approved work cannot be overwritten. Approved reopen is R4, not an implicit correction bypass. Named-role composite evidence E1 is next. |
| WOS-TIM-009 | Implemented | Ordinary future and locked-period content is denied through manual/import paths. No exception is enabled by default; a later explicitly selected exception belongs to R4. |
| WOS-TIM-010 | Partial | Legacy approved-work reports/read recovery exist. Governed inclusion and effective available-capacity/single-count absence reconciliation remain R6/R9. |
| WOS-TIM-011 | Partial | CSV compatibility/versioned schema, preview, apply, batch provenance, row errors and idempotency exist. Provider-neutral source identity/replay contract remains R5; live Jira/ADO/ServiceNow connections are not required for v1. |
| WOS-TIM-012 | Partial | Import natural-key row flags plus exact saved-content manual advisories exist. Upstream identity/cross-header duplicate semantics remain R5; intentional splits must not be silently deleted. |
| WOS-RES-001 | Partial | Percentage assignments retain worker/project/role/dates/billability/status/comments and dated checks. Planned-hours/demand linkage, treatment and version semantics remain R7. |
| WOS-RES-002 | Implemented | Ordinary assignment intervals remain inside active/adopted parent dates, including interior holds/gaps. No unapproved exception is allowed; chosen exceptions are R4/R7. |
| WOS-RES-003 | Partial | Legacy overlap calculation/settings exist. Separate warning/block policy against authoritative effective capacity remains R7/R6. |
| WOS-RES-004 | Partial | Legacy planned-utilization views exist; effective assignment/capacity denominator and parity remain R6/R9. |
| WOS-RES-005 | Partial | Existing 1/2/3-month forecast presentation exists; governed as-of/horizon/status/capacity semantics and parity remain R9. |
| WOS-RES-006 | Partial | Existing bench/underload/overload/roll-off presentation exists; authoritative threshold/as-of results and unstaffed demand remain R8/R9. |
| WOS-RES-007 | Missing | Structured unfilled demand with dates/skill/role/capacity/status remains R8. |
| WOS-RES-008 | Missing | Buyer-selected assignment/material-change approval policy and retained versions remain R7, with PR-009 dependency; generic approval records alone are not this capability. |
| WOS-RES-009 | Partial | Assignment changes cannot rewrite retained approved work. Complete assignment versions and future financial/utilization snapshot reconciliation remain R7/R9; no finance completion is claimed. |
| WOS-WKF-003 | Partial | Worker weekly-hours/eligibility/capacity fields and calendar catalogs exist. Effective part-time/capacity profiles and winning-calendar resolution remain R6. |
| WOS-WKF-004 | Missing | Structured skills/proficiency/certification/availability and deterministic matching/filtering remain R8; AI suggestions are optional and excluded. |
| WOS-WKF-005 | Partial | Existing leave/availability behavior exists, but effective calendar/capacity single-count proof and exclusion from productive work remain R6/R9, with R1 category semantics. |
| WOS-WKF-007 | Partial | Existing own profile/work/assignment/leave/utilization views plus A–H capture/history exist. Integrated authoritative capacity/availability/action-item role evidence remains R10 after its underlying capabilities. |
| WOS-WKF-008 | Partial | Existing directory/hierarchy/scoped readers exist; complete planner/hierarchy role evidence for the new resource projections remains R10. This is not permission to resume denied security repairs. |

There are4 implemented ordinary requirement boundaries,20 partial and4 missing in this engineering map. These are classification counts, not percentages of programme progress or acceptance credit.

## Finite functional remainder: R1–R10

| ID | Required remaining outcome | Requirement IDs | Decision / dependency |
|---|---|---|---|
| R1 | Governed category catalog and work-context adoption across manual/import, with historical preservation | TIM002/003, WKF005, CORE004/005 | D1; depends on R6/R9 for authoritative inclusion rather than invented financial treatment. |
| R2 | Configurable overtime policy and manual/import parity | TIM005, CORE004/005 | D2; payroll processing/automatic financial effects excluded. |
| R3 | Scoped deadline/grace policy, visible late result and specified overdue-event handoff | TIM007, WKF007, CORE004/005 | D3; canonical notification/approval delivery remains its approved later work package. |
| R4 | Protected applicable work states/reopen/correction and explicit exceptions | TIM004/006/009, CORE004/005 | D4 and PR-009 approval/period dependencies; no generic Approved overwrite. |
| R5 | Provider-neutral work-entry source identifiers, deterministic cross-header/source duplicate and replay contract | TIM003/011/012, CORE005 | D5; no live external connector, fetching, automatic deduplication or new integration spend. |
| R6 | Effective capacity/calendar/part-time/eligibility and single-count leave/holiday authority | WKF003/005, RES003/004/005, TIM010, CORE004 | D6 and existing WOS-02 calendar-lineage/reference decisions; read-only calendar inspection is insufficient. |
| R7 | Complete assignment planning/version/treatment, overlap warning/block and selected material-change approval | RES001/003/008/009, CORE004/005 | D7; uses R6 and PR-009; preserve accepted work/financial history. |
| R8 | Structured demand, skills/certifications and deterministic planner filtering/matching | RES006/007, WKF004, CORE005 | D8 and R7 quantity/status contract. |
| R9 | Planned/actual/forecast and bench/overload/roll-off/demand-gap reconciliation against authoritative inputs | TIM010, RES004/005/006/009, WKF005, CORE004 | D1/D6/D7/D8; follows R1/R6/R7/R8, not a read-recovery cosmetic change. |
| R10 | Integrated own-worker and scoped planner/hierarchy views for those results and action items | WKF007/008 | Follows R3/R6–R9; uses existing approved access contracts. Any overlap with denied work stays stopped. |

## Specific missing business decisions: D1–D8

These ask for policy shape/precedence and permitted choices, not arbitrary default values. Ordinary engineering choices already in the specifications do not need owner confirmation.

- **D1 — Category meaning/adoption:** Which required category kinds permit/require project/client context? How may a buyer-defined kind select those meanings, billability constraints and productive-utilization inclusion? Choose prospective scope/effective adoption and treatment of unmapped legacy categories. Existing project/assignment billability must not be overridden by a label.
- **D2 — Overtime:** Define the measured day/week and included quantities, threshold versus capture maximum, warning/block/authorized-exception behavior, and who approves an exception. No assumption about wages, premium rates or statutory payroll rules.
- **D3 — Deadlines:** Define the deadline anchor relative to the authoritative period, organization time zone/DST behavior, worker-group/legal-entity/period precedence, grace duration and late-save/submission behavior. Specify when an overdue event is considered resolved after correction/rejection.
- **D4 — Protected reopen/states/exceptions:** Specify applicable states, authorized actor/policy and reason/approval evidence; whether and how a locked period is reopened; allowed future/assignment-date exceptions; and which downstream accepted work/valuation/billing dependencies forbid correction. Until selected, existing denials stand.
- **D5 — Source identity/replay:** Define source namespace plus external worklog ID scope, same-key changed-content/update versus conflict behavior, manual/import linkage and intentional split treatment. Preserve historical IDs/versions and distinguish original source from last writer; text ticket references are not source authority.
- **D6 — Capacity/calendar/leave:** Set effective part-time/weekly-hours semantics and precedence, winning calendar/worker-group rules (including retired-lineage reference behavior), partial-day leave/holiday overlap and single-count rules, noneligible-worker denominator treatment and reproducible as-of behavior.
- **D7 — Assignment planning/approval:** Define percentage versus planned-hours authority/conversion across capacity changes, warning/block thresholds and overrides, cost/revenue treatment links (without exposing unauthorized values), material-change version adoption and whether approval is off or which changes/roles/stages require it.
- **D8 — Skills/demand/forecast:** Define skill/proficiency/certification vocabulary and expiry/matching semantics, demand states/fulfilment/cancellation and quantity units, forecast as-of/horizon/status inclusion and bench/roll-off thresholds. AI matching remains optional/non-authoritative.

## Finite evidence and release gates

- **E1 (next, no new business policy):** Genuine named Employee and distinct authorized approver execute the specification's own assigned-project Draft → Submitted → Rejected/reason → corrected Submitted → Approved cycle in real React/API/PostgreSQL, in both existing presentations, with full-entry references/history preserved. Existing Admin operator journeys are retained and are not renamed as Employee proof.
- **E2:** Each R outcome adds its applicable unit/API/scope/history/migration/browser evidence and preserves the retained suite. After R1–R10, run one defined composite resource/capture acceptance matrix and historical-utilization/migration reconciliation. Do not claim older isolated tests are new integrated acceptance.
- **E3:** Deferred independent/formal reviews, branch/protection/dependency/integration gates, owner role UAT and release acceptance remain separate. No merge/deployment is authorized by this checklist. Denied cumulative review/repairs remain stopped; monitoring is not paused. PR30 never-merge.

The finish line is R1–R10 with applicable E1–E3, subject only to explicit owner-approved scope decisions. No automatic new follow-on scope is created by this map. Optional timer, AI suggestions, live provider connections, payroll and unrelated finance work are excluded; required PR-009/financial dependency gates are not silently waived.
