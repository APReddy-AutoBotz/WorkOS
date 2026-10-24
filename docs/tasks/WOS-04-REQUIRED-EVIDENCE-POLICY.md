# PR-008F: Buyer-configurable required evidence URLs

**Status:** Dependent implementation candidate; acceptance plan was recorded before product edits in commit `680088e`. Exact-head engineering receipts remain required. Dependent development only; optional independent/formal code and security reviews are deferred and outstanding.
**Authority:** WOS-TIM-005 requires buyer-configurable comment/evidence requirements. WORK_CAPTURE_AND_TIMESHEET_SPEC.md defines buyer-configurable evidence policies and rejection of missing required evidence. PR-008 includes evidence policy. This is selected from those approved sources, not a security/gap review.
**Dependency:** Unchanged Draft PR59 `c8fcafd6b61c7e9407aaf623a23001ad144b6ef1`, tree `2c261f67740c702e52ad345e82c3599e92de0d18`.

## Ownership and development sequencing

Pre-implementation checks on 2026-10-24 found only the sole writer active, no active/queued/waiting/requested/pending Actions runs, PR59 Draft/unmerged at the fixed dependency, unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`, and active legacy controller workflow342036167 whose latest run40047943605 succeeded on that main. No monitoring/controller setting is changed. The owner authorized continued sequential ordinary development, required tests and deferred optional reviews; this is not prerequisite, integrated, programme, merge, release or deployment acceptance. PR30 remains never-merge. Denied cumulative review and separately denied security repairs stay stopped.

## Bounded buyer option

- Extend the existing scoped append-only capture policy with `evidenceRequired`: the buyer may explicitly require an evidence URL on every positive entry on governed work dates. This uses the existing positive-entry comment rule's scope and all-content-save behavior for Draft and Submitted work; it introduces no global/default mandate or new exception policy.
- Preserve the existing organization/legal-entity authority, prospective authoritative Weekly activation boundaries, expected-latest conflicts, shared locks, increments, comments, aggregate limits, period controls, assignment authority, mode/CAS and immutability behavior.
- A valid existing evidence URL satisfies the option. Text references/comments are not substituted for URLs. Zero-quantity entries are exempt, as with existing positive-entry comments. Evidence is never fetched/previewed and no upload is added.
- Existing policies remain semantically unchanged: an additive nullable column is absent/null in historical rows and means optional. New appends record a concrete boolean. Omission by older API or SQL writers inherits the latest choice so an evidence-unaware editor cannot silently disable an adopted requirement; explicit false disables it only in a new prospective policy version. No existing row/JSON, work or grant is rewritten.
- Keep the compatible `work-capture-rules/1` identifier: the field is additive/optional at the command boundary, while immutable row IDs/sequences identify exact rule contents. Existing capture references retain their original row/version. Submitted/Approved decisions use retained evidence and do not re-evaluate against later policy; no historical backfill or re-pinning.
- Manual saves and both existing import aliases, including versioned previews/replay, apply the same effective rule after omitted entry metadata is resolved. PostgreSQL's deferred work guard enforces it for direct SQL writers too, without replacing existing guards. Missing URL rejects atomically before successful work/audit/approval changes.
- Add one checkbox and retained-history display in the existing policy editor. The work-entry editor already supports evidence URLs; normal save errors identify the missing requirement. No category/worker-group exception, overtime, deadline/grace, reopen, duplicate/source identity or financial rule is invented.

## Required acceptance plan

1. Unit/contract/transport: optional/true/false flag, old omitted commands, effective resolution, positive/zero and valid/missing URLs, retained exact quantities/metadata, scope/session ownership and stale responses.
2. Real PostgreSQL/API: fresh install, 048 upgrade/replay preserving old policy/work/grant/immutable JSON values; explicit adoption/disable and inherited omission through API and direct SQL; immutable append/races/date guards; manual and both import alias parity, preview/replay, failed-write atomicity, legacy metadata preservation, zero exemption, existing scope/period/status denials, retained submission decisions and correction history.
3. Real React/API/PostgreSQL: configure opt-in in the existing policy editor, reload history, reject missing URLs, add URL then save current daily Draft, verify whole-header and hidden/weekend/zero preservation and existing mode behavior; prove explicit/inherited choices and scoped editor safeguards without external requests.
4. Locked install, type/lint, aggregate unit/contracts, retained PostgreSQL/migration and browser journeys, production build/identity/startup and configured CI/container gates. Publish only a separate dependent Draft after applicable local tests; follow hosted runs to terminal with exact head/tree receipts. No manual security scan/review/repair is requested.
5. Record optional formal review debt and all remaining broader work-capture requirements. Do not claim full WOS-TIM-005/PR008 or integrated acceptance.

## Operations and exclusions

Use additive migration049. Retain its column, append-only policies and work history on rollback. A pre049 binary does not perform the new application prevalidation/projection; retain database guards and use a forward-compatible binary before resuming work or policy writes. No destructive down migration or running-environment change is authorized.

No uploads, URL dereferencing, new permission/grant/default adoption, security repair, authoritative task/milestone relationship, new categories/worker exceptions, overtime, deadlines/grace, protected reopen, resource/financial calculation, integration, merge, deployment, spend, protection or monitoring change is included. If any such semantics becomes necessary, stop that expansion and identify the exact decision.
