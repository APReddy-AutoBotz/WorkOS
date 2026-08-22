import fs from 'node:fs';
import path from 'node:path';

const changed = new Set();

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\r\n/g, '\n'));
  changed.add(file);
}

function replaceExact(file, before, after) {
  const content = read(file);
  if (!content.includes(before)) {
    throw new Error(`Expected text not found in ${file}: ${before.slice(0, 120)}`);
  }
  write(file, content.replace(before, after));
}

function insertAfter(file, marker, insertion) {
  const content = read(file);
  if (!content.includes(marker)) {
    throw new Error(`Insertion marker not found in ${file}: ${marker.slice(0, 120)}`);
  }
  if (content.includes(insertion.trim())) return;
  write(file, content.replace(marker, `${marker}${insertion}`));
}

// 1. Explicit workforce and NFR ownership.
replaceExact(
  'docs/00-control/REQUIREMENTS_TRACEABILITY.md',
  '| WOS-WKF-001–008 | PR-002, PR-004, PR-008 | Workforce migration, capacity/availability tests and role browser journeys | Not started |',
  '| WOS-WKF-001–002, WOS-WKF-006 | PR-004 | Worker-master/type migration, relationship/lifecycle dependency tests and scoped administration journeys | Not started |\n| WOS-WKF-003–005, WOS-WKF-007–008 | PR-008 | Capacity, skills, single-count leave/holiday availability, self-service and scoped workforce browser/API evidence | Not started |',
);
replaceExact(
  'docs/00-control/REQUIREMENTS_TRACEABILITY.md',
  '| WOS-NFR-* | All affected work packages, consolidated PR-016 | Automated quality, security, performance, recovery and release evidence | Blueprint |',
  `| WOS-NFR-SEC-001–014 | PR-003, PR-005, PR-006, PR-009, PR-010, PR-012, PR-013, PR-014, PR-016 | Threat-boundary, authentication/authorization, secure-configuration, secret/dependency and negative-security evidence | Blueprint |\n| WOS-NFR-PRV-001–006 | PR-004, PR-008, PR-010, PR-012, PR-013, PR-014, PR-016 | Data-minimization, sensitive-field scope, retention/anonymization and privacy-export evidence | Blueprint |\n| WOS-NFR-REL-001–009 | PR-005, PR-006, PR-008, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Fail-closed startup, transaction/idempotency, recovery and exact-head reliability evidence | Blueprint |\n| WOS-NFR-PERF-001–008 | PR-006, PR-008, PR-011, PR-012, PR-013, PR-015, PR-016 | Pagination/query-index review, job/export bounds and Standard-profile performance evidence | Blueprint |\n| WOS-NFR-DAT-001–008 | PR-004, PR-007, PR-008, PR-009, PR-010, PR-011, PR-012, PR-013, PR-016 | Ownership, temporal integrity, precision, constraints, snapshot and reconciliation evidence | Blueprint |\n| WOS-NFR-MNT-001–008 | PR-002 through PR-016 | Module boundaries, typed contracts, complexity controls, documentation and maintainability evidence in every affected PR | Blueprint |\n| WOS-NFR-DPL-001–007 | PR-003, PR-005, PR-015, PR-016 | Container/environment portability, explicit migration and production deployment evidence | Blueprint |\n| WOS-NFR-OBS-001–006 | PR-005, PR-006, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Correlation, structured logging, job/integration health, audit-safe monitoring and alert evidence | Blueprint |\n| WOS-NFR-UX-001–006 | PR-003, PR-004, PR-008, PR-009, PR-012, PR-013, PR-016 | Accessibility, responsive role journeys, terminology/locale and understandable error evidence | Blueprint |\n| WOS-NFR-CMP-001–004 | PR-003, PR-004, PR-006, PR-008, PR-013, PR-014, PR-016 | Browser/API/version compatibility and provider-neutral integration evidence | Blueprint |\n| WOS-NFR-RELSE-001–005 | PR-002 through PR-016 | Version, changelog, migration/rollback, exact-artifact and release-evidence controls | Blueprint |`,
);
replaceExact(
  'docs/00-control/REQUIREMENTS_TRACEABILITY.md',
  '| DOC-WOS-00-002 | Independent Codex blueprint review at exact PR head | Pending |',
  '| DOC-WOS-00-002 | First independent Codex/Sol review and review-resolution mapping | First review complete; corrected-head re-review pending |',
);

// 2. Backlog ownership, source merge boundary and commercial acceptance.
insertAfter(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '| WOS-09 | 4% | v1.0.0 | Production-like acceptance and buyer handover |\n',
  `\n### 2.1 NFR implementation ownership\n\n| NFR family | Accountable planned PRs | Minimum evidence |\n|---|---|---|\n| SEC-001–014 | PR-003, PR-005, PR-006, PR-009, PR-010, PR-012, PR-013, PR-014, PR-016 | Threat boundaries, secure defaults, negative authorization, secret/dependency and security-review evidence |\n| PRV-001–006 | PR-004, PR-008, PR-010, PR-012, PR-013, PR-014, PR-016 | Data minimization, field-level scope, retention/anonymization and privacy export evidence |\n| REL-001–009 | PR-005, PR-006, PR-008, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Fail-closed, transaction/idempotency, recovery and exact-head reliability evidence |\n| PERF-001–008 | PR-006, PR-008, PR-011, PR-012, PR-013, PR-015, PR-016 | Pagination/query review, bounded jobs/exports and Standard-profile performance evidence |\n| DAT-001–008 | PR-004, PR-007, PR-008, PR-009, PR-010, PR-011, PR-012, PR-013, PR-016 | Ownership, temporal, precision, snapshot, constraint and control-total evidence |\n| MNT-001–008 | PR-002 through PR-016 | Bounded modules/files, typed contracts, documentation and maintainability evidence in every affected PR |\n| DPL-001–007 | PR-003, PR-005, PR-015, PR-016 | Portable container/environment, explicit migration and production deployment evidence |\n| OBS-001–006 | PR-005, PR-006, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Correlation, safe structured logs, job/integration health and alert evidence |\n| UX-001–006 | PR-003, PR-004, PR-008, PR-009, PR-012, PR-013, PR-016 | Accessibility, responsive role journeys, terminology/locale and understandable errors |\n| CMP-001–004 | PR-003, PR-004, PR-006, PR-008, PR-013, PR-014, PR-016 | Supported browser/API/version compatibility and provider-neutral contracts |\n| RELSE-001–005 | PR-002 through PR-016 | Version, changelog, migration/rollback, immutable-artifact and release-evidence controls |\n`,
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- No write or PR against `Boundaryless-WorkOS`.',
  '- No write or pull request against the pinned reference repository.\n\n**Merge boundary:** PR-002 may not merge to `main` while prohibited company-specific runtime branding, data or operational references remain. The imported runtime must be neutralized inside PR-002, or PR-003 must remain stacked on PR-002 and only the combined clean, configuration-driven state may merge.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Guided setup/readiness page and API.',
  '- Guided setup/readiness page and API.\n- Worker-master ownership fields, configurable worker types and dependency-aware worker lifecycle controls.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '**Requirements:** WOS-ORG-001 through WOS-ORG-010, WOS-CORE-002, WOS-IAM-005.',
  '**Requirements:** WOS-ORG-001 through WOS-ORG-010, WOS-CORE-002, WOS-IAM-005, WOS-WKF-001, WOS-WKF-002, WOS-WKF-006.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Guided setup states are server derived.',
  '- Guided setup states are server derived.\n- Imported workers retain identity and relationships; worker-type and lifecycle dependency tests cover active assignments, approvals, work and ownership.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Compatibility migration for current timesheets.',
  '- Compatibility migration for current timesheets.\n- Effective capacity profiles, skills/certifications, single-count leave/holiday availability, workforce self-service and scoped directory/hierarchy views.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '**Requirements:** WOS-TIM-001 through WOS-TIM-012, WOS-RES-001 through WOS-RES-009.',
  '**Requirements:** WOS-TIM-001 through WOS-TIM-012, WOS-RES-001 through WOS-RES-009, WOS-WKF-003 through WOS-WKF-005, WOS-WKF-007, WOS-WKF-008.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Historical imported timesheets remain readable.',
  '- Historical imported timesheets remain readable.\n- Capacity/skills/availability calculations, leave single-count rules, worker self-service and cross-scope workforce views have positive and negative API/browser evidence.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '**Outcome:** Calculate reconciled revenue, cost and margin across supported engagement models.',
  '**Outcome:** Calculate reconciled billable value, cost, margin and explicitly configured operational earned-management revenue across supported engagement models.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Revenue/cost/margin snapshots.',
  '- Revenue/cost/margin snapshots.\n- Effective-dated operational earned-management policy profiles that fail closed for non-T&M models until an authorized policy is selected; billing eligibility remains independent.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Golden financial test vectors for every engagement type.',
  '- Golden financial test vectors for every engagement type, including policy-disabled and each enabled earned-management profile.\n- Evidence that operational earned-management metrics are non-statutory and cannot run for non-T&M models without an authorized effective-dated policy.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Approved-unbilled register.',
  '- Approved-unbilled register covering approved T&M snapshots, accepted billing-eligible milestones, approved/due fixed-fee schedule events, approved retainer base/period/overage events, approved managed-service period/unit events and approved adjustments.',
);
replaceExact(
  'docs/05-delivery/IMPLEMENTATION_BACKLOG.md',
  '- Duplicate inclusion prevention.',
  '- Duplicate inclusion prevention across every eligible source type.\n- Register-to-batch reconciliation by source version, approval/eligibility evidence, currency, eligible date and amount.',
);

// 3. Authoritative requirements: neutral branding, leave semantics, earned-management policy and approved-unbilled sources.
replaceExact(
  'docs/00-control/PRODUCT_REQUIREMENTS.md',
  'No runtime feature, seed, template, notification or document delivered with the product may require Boundaryless names, assets, domains, roles, data or operating conventions.',
  'No runtime feature, seed, template, notification or buyer-delivered document may require reference-company names, assets, domains, roles, data or operating conventions.',
);
replaceExact(
  'docs/00-control/PRODUCT_REQUIREMENTS.md',
  'Approved leave and configured holidays must reduce availability according to calendar and capacity rules.',
  'Approved leave and configured holidays must reduce availability exactly once according to calendar and capacity rules. Leave/absence is an availability reference, not productive or billable work: it must not require a client engagement/project, enter the actual-utilization numerator, create commercial value or reduce capacity a second time through a work-entry calculation.',
);
replaceExact(
  'docs/00-control/PRODUCT_REQUIREMENTS.md',
  'Work categories must distinguish billable client work, non-billable client work, internal delivery, pre-sales, training, leave/absence reference, administration and buyer-defined categories.',
  'Work categories must distinguish billable client work, non-billable client work, internal delivery, pre-sales, training, administration and buyer-defined categories. A leave/absence reference may be displayed for calendar/availability context, but it is not a productive work entry, is never billable and does not require a client engagement/project.',
);
replaceExact(
  'docs/00-control/PRODUCT_REQUIREMENTS.md',
  'The system must produce period snapshots for approved work, billable value, recognized/earned revenue where configured, cost, gross margin and margin percentage.',
  `The system must produce versioned period snapshots for approved work, billable value, cost, gross margin and margin percentage. WorkOS may additionally calculate **operational earned-management revenue** for planning and project-control purposes; this is not statutory IFRS/GAAP revenue recognition and is not a general-ledger posting.\n\nThe neutral default must fail closed: no non-T&M operational earned-management revenue snapshot may be created until an authorized, effective-dated policy is explicitly selected. Supported policy profiles must cover at least T&M approved eligible value, fixed-fee time-elapsed, fixed-fee progress/effort, milestone acceptance, retainer service-period/base/overage and managed-service accepted-unit/period-charge. Each active policy must define source evidence, timing, inputs, exclusions, effective dates, currency/FX, rounding, version, approval owner and correction behavior. Billing eligibility and invoice readiness remain independent from the earned-management policy.`,
);
replaceExact(
  'docs/00-control/PRODUCT_REQUIREMENTS.md',
  'Finance-authorized users must see approved billable work or milestones not yet included in an invoice-ready batch.',
  `Finance-authorized users must see every approved, billing-eligible source not already included in an active or finalized invoice-ready batch. Eligible source types are:\n\n- Approved T&M work calculation snapshots.\n- Accepted and billing-eligible milestone events.\n- Approved or contractually due fixed-fee billing-schedule events.\n- Approved retainer base, period and overage events.\n- Approved managed-service period-charge or accepted-unit events.\n- Approved commercial adjustments, credits, discounts, write-offs or corrections that are invoice eligible.\n\nEvery register row must preserve source type and version, organization/legal entity, client/contract/engagement, approval or eligibility evidence, currency, eligible date, amount, calculation/policy evidence where applicable, and active/final batch state. Operational earned-management revenue does not by itself make a source invoice eligible.`,
);
replaceExact(
  'docs/00-control/PRODUCT_REQUIREMENTS.md',
  'Every batch line must trace to approved work, milestone, retainer schedule or adjustment and preserve its commercial calculation evidence.',
  'Every batch line must trace to one versioned eligible source from WOS-INV-001—including T&M snapshot, milestone, fixed-fee schedule, retainer event, managed-service event or approved adjustment—and preserve approval/eligibility and commercial-calculation evidence.',
);

// 4. Commercial/reporting specifications and tests.
replaceExact(
  'docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md',
  'WorkOS deterministically resolves commercial terms, values approved evidence across supported engagement models, preserves snapshots, reports revenue/cost/margin and prepares traceable invoice-ready exports.',
  'WorkOS deterministically resolves commercial terms, values approved evidence across supported engagement models, preserves snapshots, reports billable value/cost/margin and optional non-statutory operational earned-management revenue, and prepares traceable invoice-ready exports.',
);
replaceExact(
  'docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md',
  '- Fixed fee: contract/schedule value with consumed effort/cost and earned/recognized policy; hours are not automatically invoiceable.',
  '- Fixed fee: contract/schedule value with consumed effort/cost and an explicitly selected operational earned-management policy; hours are not automatically invoiceable.',
);
insertAfter(
  'docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md',
  '- Managed service: configured service units/tickets/shifts with optional time/cost evidence.\n',
  `\n## Operational earned-management revenue\n\nOperational earned-management revenue is a project-control metric, not statutory accounting recognition. T&M may use the approved-eligible-value profile. For fixed-fee, milestone, retainer and managed-service models the calculation is disabled until an authorized effective-dated profile is selected. Supported profiles include fixed-fee time-elapsed, fixed-fee progress/effort, milestone acceptance, retainer service-period/base/overage and managed-service accepted-unit/period-charge.\n\nEach profile defines source evidence, timing, formula inputs, exclusions, currency/FX, rounding, version, approval owner and correction/recalculation behavior. Billing eligibility is a separate decision and cannot be inferred merely because operational earned-management revenue exists.\n`,
);
replaceExact(
  'docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md',
  'Finance users review approved-unbilled sources and create batches by client, legal entity, engagement, period and currency. Lines trace to snapshots/milestones/retainer schedules or controlled adjustments. States are Draft, Under Review, Approved, Exported, Billed/Confirmed and Cancelled.',
  `Finance users review an approved-unbilled register and create batches by client, legal entity, engagement, period and currency. The register includes approved T&M snapshots, accepted billing-eligible milestones, approved/due fixed-fee schedule events, approved retainer base/period/overage events, approved managed-service period/unit events and approved invoice-eligible adjustments.\n\nEach register and batch line retains source type/version, approval or eligibility evidence, currency, eligible date, amount and commercial/policy evidence, and is excluded once it belongs to an active or finalized batch except through an authorized reversal/correction. States are Draft, Under Review, Approved, Exported, Billed/Confirmed and Cancelled.`,
);
replaceExact(
  'docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md',
  'Positive vectors cover rate precedence/effective dates, currency/rounding, T&M caps, fixed-fee consumption, milestone acceptance, retainer rollover/overage, managed-service units, budget/EAC and invoice batch totals.',
  'Positive vectors cover rate precedence/effective dates, currency/rounding, T&M caps, every enabled operational earned-management policy profile, policy-disabled fail-closed cases, fixed-fee consumption, milestone acceptance, retainer rollover/overage, managed-service units, budget/EAC, approved-unbilled by source type and invoice-batch totals.',
);
replaceExact(
  'docs/03-specifications/REPORTING_AND_ANALYTICS_SPEC.md',
  'Scoped operational and commercial read models explain workforce, utilization, delivery, revenue, margin, invoice readiness, data quality and leakage with control totals and auditable exports.',
  'Scoped operational and commercial read models explain workforce, utilization, delivery, billable value, optional non-statutory operational earned-management revenue, margin, invoice readiness, data quality and leakage with control totals and auditable exports.',
);
replaceExact(
  'docs/03-specifications/REPORTING_AND_ANALYTICS_SPEC.md',
  '- Budget versus actual, revenue, cost, gross margin, PO consumption, fixed-fee/retainer consumption and EAC.\n- Approved-unbilled and invoice-ready reconciliation.',
  '- Budget versus actual, billable value, operational earned-management revenue only where an authorized effective-dated policy is active, cost, gross margin, PO consumption, fixed-fee/retainer consumption and EAC.\n- Approved-unbilled and invoice-ready reconciliation across T&M snapshots, milestones, fixed-fee schedule events, retainer events, managed-service events and approved adjustments.',
);
replaceExact(
  'docs/03-specifications/REPORTING_AND_ANALYTICS_SPEC.md',
  'Reports query authoritative records/snapshots and publish control totals. Commercial reports reconcile to snapshot and invoice-ready line/batch totals.',
  'Reports query authoritative records/snapshots and publish control totals. Operational earned-management metrics identify the active policy/version and never claim statutory recognition. Commercial reports reconcile source eligibility to the approved-unbilled register and then to invoice-ready line/batch totals.',
);
replaceExact(
  'docs/04-quality/TEST_STRATEGY.md',
  'The commercial engine maintains versioned deterministic fixtures for rate precedence, effective dates, decimal precision, multi-currency/FX, caps, exclusions, fixed fee, milestone, retainer, managed service, budgets, POs, EAC, adjustments and no-double-billing.',
  'The commercial engine maintains versioned deterministic fixtures for rate precedence, effective dates, decimal precision, multi-currency/FX, caps, exclusions, fixed fee, milestone, retainer, managed service, budgets, POs, EAC, every operational earned-management policy profile, policy-disabled fail-closed behavior, approved-unbilled source eligibility, adjustments and no-double-billing.',
);
insertAfter(
  'docs/04-quality/TEST_STRATEGY.md',
  'Expected values are independently specified and not generated by the implementation under test.\n',
  '\nAvailability fixtures prove that approved leave/holidays reduce the denominator exactly once, never enter the productive/billable numerator and do not require a client engagement or project.\n',
);
replaceExact(
  'docs/01-product/PRODUCT_VISION_AND_POSITIONING.md',
  'WorkOS is not a payroll engine, full HRMS, CRM, task tracker, statutory invoice issuer, general ledger or autonomous AI approval/calculation system.',
  'WorkOS is not a payroll engine, full HRMS, CRM, task tracker, statutory invoice issuer, statutory revenue-recognition/accounting engine, general ledger or autonomous AI approval/calculation system.',
);

// 5. Workforce/work-capture consistency.
replaceExact(
  'docs/03-specifications/WORK_CAPTURE_AND_TIMESHEET_SPEC.md',
  '- Categories distinguish billable client, non-billable client, internal, pre-sales, training, administration and buyer-defined work.',
  '- Categories distinguish billable client, non-billable client, internal, pre-sales, training, administration and buyer-defined work. Leave/absence may appear as read-only availability/calendar context but is not a productive work entry, is never billable and needs no client engagement/project.',
);
replaceExact(
  'docs/03-specifications/WORK_CAPTURE_AND_TIMESHEET_SPEC.md',
  'Actual utilization uses approved work and configured inclusion rules divided by effective available capacity. Draft, rejected or otherwise excluded categories do not silently count.',
  'Actual utilization uses approved productive work and configured inclusion rules divided by effective available capacity. Approved leave/holidays reduce availability exactly once and never enter the numerator; Draft, rejected, absence-reference or otherwise excluded categories do not silently count.',
);
replaceExact(
  'docs/03-specifications/RESOURCE_PLANNING_SPEC.md',
  'Workers include type/status, organization structure, manager, dates, utilization eligibility and effective capacity profiles. Working calendars, holidays and approved leave reduce availability.',
  'Workers include type/status, organization structure, manager, dates, utilization eligibility and effective capacity profiles. Working calendars, holidays and approved leave reduce availability exactly once; absence is not productive/billable work and is excluded from the actual-utilization numerator.',
);
replaceExact(
  'docs/03-specifications/RESOURCE_PLANNING_SPEC.md',
  '- Calculate part-time/leave-adjusted capacity and overlapping assignments.',
  '- Calculate part-time/leave-adjusted capacity and overlapping assignments while proving leave is not double counted or treated as productive work.',
);

// 6. Decision and risk hygiene.
replaceExact(
  'docs/00-control/DECISION_LOG.md',
  '| WOS-DEC-022 | 2026-08-22 | Keep owner-only pricing, negotiation and IP-sale strategy outside the product repository | Accepted | Provenance/risk controls |',
  '| WOS-DEC-022 | 2026-08-22 | Keep transaction-specific pricing, valuation, licensing, assignment and negotiation strategy outside the product repository | Accepted | Provenance/risk controls |\n| WOS-DEC-023 | 2026-08-22 | Treat operational earned-management revenue as a non-statutory management metric; non-T&M calculation fails closed until an authorized effective-dated policy is selected, independently of billing eligibility | Accepted | WOS-COM-011 and commercial specification |',
);
replaceExact(
  'docs/00-control/DECISION_LOG.md',
  '| WOS-DEC-P02 | Exclusive IP sale versus perpetual non-exclusive source licence for a specific buyer | Before proposal/contract | Retain reusable core IP; do not assume exclusivity |',
  '| WOS-DEC-P02 | Transaction-specific licensing, assignment, ownership and commercialization terms | Before proposal/contract | No product-repository default; decide through external legal/commercial approval |',
);
replaceExact(
  'docs/00-control/DECISION_LOG.md',
  '| WOS-DEC-P06 | First buyer\'s exact approval and revenue-recognition policies | Commercial-engine UAT | Implement configurable policies and documented neutral defaults |',
  '| WOS-DEC-P06 | First buyer\'s approval and operational earned-management policy choices | Commercial-engine UAT | Billing eligibility remains independent; non-T&M earned-management calculation stays disabled until an authorized effective-dated policy is configured |',
);
replaceExact(
  'docs/00-control/RISK_REGISTER.md',
  '| WOS-RSK-002 | Old public repository history may contain branding or artifacts that reduce practical exclusivity | 4 | 3 | 12 | Product owner | Use clean private WorkOS history; do not claim the old public history never existed; price exclusivity based on current practical position | Exclusive IP discussion | Open |',
  '| WOS-RSK-002 | Historic public source exposure may complicate unsupported claims of practical exclusivity in external diligence | 4 | 3 | 12 | Product owner | Use clean private WorkOS history, maintain accurate provenance, obtain external legal/commercial assessment and make no unsupported exclusivity claim | External licensing or assignment diligence | Open |',
);

// 7. Gate/status and clean-source controls.
replaceExact(
  'docs/00-control/PROGRAM_CHARTER.md',
  '**Document status:** Gate A programme execution baseline; full blueprint acceptance pending Gate B  ',
  '**Document status:** Programme initiation approved on 2026-08-22; governing blueprint acceptance pending Gate B  ',
);
insertAfter(
  'docs/00-control/PROGRAM_CHARTER.md',
  '- Production credentials, customer data or deployment approval.\n',
  `\n### 9.4 Controlled approval gates\n\nThe owner\'s 2026-08-22 programme-initiation approval authorized the private repository strategy, controller operation and WOS-00 blueprint creation. It is contextual authority, not a product acceptance gate and does not authorize source import.\n\n- **Gate B — Blueprint acceptance:** required before importing the application source or starting WOS-01 implementation.\n- **Gate C — Commercial-engine acceptance:** required after deterministic revenue/margin/invoice-readiness evidence and before treating the commercial engine as accepted.\n- **Gate D — v1 release acceptance:** required before declaring/tagging the sellable WorkOS v1.0 release.\n`,
);
insertAfter(
  'docs/00-control/IMPLEMENTATION_STATUS.md',
  '- Import only the pinned authorized source commit after Gate B.\n',
  '- Do not merge an imported runtime to `main` while prohibited company-specific branding/data remains; neutralize it in PR-002 or merge only the combined clean stacked PR-003 state.\n',
);
replaceExact(
  'docs/00-control/IMPLEMENTATION_STATUS.md',
  '1. Run/review the WOS-00 documentation inventory, references, prohibited-term, credential-like and ID consistency checks.\n2. Request a fresh independent Codex review against the exact PR #1 head using the strongest appropriate Sol review model.\n3. Resolve blocking findings and recheck the moved head.\n4. Present the completed blueprint and unresolved owner decisions for Gate B approval.\n5. Merge and tag v0.1.0 only after approval and accepted evidence.\n6. Start WOS-01 issue #3 only after the Gate B record exists.',
  '1. Materialize and inspect all findings from independent review `5000738492`.\n2. Run a fresh independent Codex/Sol review against the moved correction head.\n3. Resolve any remaining blocking findings and recheck the exact head.\n4. Present the completed blueprint and unresolved external decisions for Gate B approval.\n5. Merge and tag v0.1.0 only after approval and accepted evidence.\n6. Start WOS-01 issue #3 only after the Gate B record exists.',
);

// 8. Controller evidence and review-resolution record.
replaceExact(
  'docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md',
  '**Status:** Controller document-pack review complete; independent Codex review and owner Gate B pending',
  '**Status:** Controller document-pack review and first independent Codex/Sol review complete; findings corrected, moved-head re-review and owner Gate B pending',
);
replaceExact(
  'docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md',
  'Application source, reference Git history, credentials, real company/customer data and owner-only pricing/IP-sale strategy remain excluded.',
  'Application source, reference Git history, credentials, real company/customer data and transaction-specific pricing/licensing/assignment strategy remain excluded.',
);
insertAfter(
  'docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md',
  '5. Added explicit Markdown/LF repository attributes.\n',
  `\n## Independent review findings and controller disposition\n\nIndependent Codex/Sol review `5000738492` at head `492715dc8a40de6431365b6e52378d317721f617` identified five P1 and two P2 findings. The correction pass assigned workforce and all NFR families, defined cross-model approved-unbilled eligibility, introduced fail-closed non-statutory operational earned-management policy semantics, removed owner-only commercialization defaults, made the forbidden-term boundary reproducible, removed the undefined Gate A claim, clarified leave single-count semantics and added the clean-source merge boundary.\n\nThese corrections require a fresh independent review at the moved head before Gate B.\n`,
);
replaceExact(
  'docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md',
  'Final commercial name/trademark, external licensing or exclusive assignment terms, buyer-specific RPO/RTO/support targets and first-buyer financial policies remain correctly deferred and do not block the technical blueprint.',
  'Final commercial name/trademark, transaction-specific legal/commercial terms, buyer-specific RPO/RTO/support targets and first-buyer approval/operational earned-management policy choices remain external or deferred and do not block the technical blueprint.',
);
write(
  'docs/evidence/v0.1.0/DOC-WOS-00-002-REVIEW-RESOLUTION.md',
  `# DOC-WOS-00-002 — Independent Review Resolution\n\n**Workstream:** WOS-00  \n**Issue:** #2  \n**Pull request:** #1  \n**Reviewed head:** \`492715dc8a40de6431365b6e52378d317721f617\`  \n**Independent review ID:** \`5000738492\`  \n**Status:** Five P1 and two P2 findings corrected; fresh independent review of the moved head pending\n\n## Resolution map\n\n| Finding | Severity | Resolution |\n|---|---|---|\n| Workforce requirements lacked explicit implementation owners | P1 | Split WOS-WKF ownership across PR-004 and PR-008 with concrete evidence |\n| NFR wildcard did not assign all quality families | P1 | Mapped all 11 NFR families to accountable PRs and evidence |\n| Approved-unbilled excluded several engagement models | P1 | Defined T&M, milestone, fixed-fee, retainer, managed-service and adjustment source eligibility |\n| Neutral revenue policy was undefined | P1 | Defined non-statutory operational earned-management profiles and fail-closed non-T&M default |\n| Owner-only commercialization defaults leaked into product docs | P1 | Removed licence-vs-sale/pricing defaults and retained only a neutral external legal/commercial gate |\n| Forbidden-term allowlist was not reproducible | P2 | Neutralized reference-company literals outside approved provenance/control files |\n| Gate A was claimed but undefined | P2 | Removed Gate A as a formal gate; programme initiation is contextual and formal gates remain B, C and D |\n\n## Supplemental controller corrections\n\n- Leave/absence is an availability reference, never productive/billable work, and cannot reduce capacity twice.\n- PR-002 cannot merge a prohibited company-specific runtime; cleanup occurs within PR-002 or only the clean stacked PR-003 state merges.\n\n## Open gates\n\n- Fresh independent Codex/Sol review at the exact moved PR head.\n- Resolution of any remaining blocking finding.\n- Product-owner Gate B approval.\n- Exact-head squash merge and v0.1.0 baseline.\n`,
);

// Validation: document inventory, IDs, terms and lightweight reference safety.
const allMarkdown = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && p !== '.git') walk(p);
    else if (entry.isFile() && p.endsWith('.md')) allMarkdown.push(p.replaceAll('\\', '/'));
  }
}
walk('.');

const gateA = allMarkdown.filter((file) => read(file).includes('Gate A'));
if (gateA.length) throw new Error(`Undefined Gate A remains in: ${gateA.join(', ')}`);

const allowedReferenceNameFiles = new Set([
  'AGENTS.md',
  'PROVENANCE.md',
  'docs/00-control/PROGRAM_CHARTER.md',
  'docs/00-control/DECISION_LOG.md',
  'docs/00-control/RISK_REGISTER.md',
  'docs/00-control/IMPLEMENTATION_STATUS.md',
  'docs/tasks/WOS-00-BLUEPRINT-COMPLETION.md',
  'docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md',
  'docs/evidence/v0.1.0/DOC-WOS-00-002-REVIEW-RESOLUTION.md',
]);
const forbiddenReferenceFiles = allMarkdown.filter((file) => /boundaryless|\bRUT\b|@boundaryless|old logo|old domain/i.test(read(file)) && !allowedReferenceNameFiles.has(file));
if (forbiddenReferenceFiles.length) throw new Error(`Reference-company terms outside allowlist: ${forbiddenReferenceFiles.join(', ')}`);

const ownerOnlyPatterns = [
  /price exclusivity/i,
  /retain reusable core IP/i,
  /perpetual non-exclusive source licence/i,
  /negotiation floor/i,
];
for (const file of allMarkdown) {
  const text = read(file);
  for (const pattern of ownerOnlyPatterns) {
    if (pattern.test(text)) throw new Error(`Owner-only strategy pattern ${pattern} remains in ${file}`);
  }
}

const trace = read('docs/00-control/REQUIREMENTS_TRACEABILITY.md');
for (const family of ['SEC', 'PRV', 'REL', 'PERF', 'DAT', 'MNT', 'DPL', 'OBS', 'UX', 'CMP', 'RELSE']) {
  if (!trace.includes(`WOS-NFR-${family}-`)) throw new Error(`NFR family ${family} is not explicitly mapped`);
}
for (const token of ['WOS-WKF-001–002', 'WOS-WKF-003–005', 'WOS-WKF-007–008']) {
  if (!trace.includes(token)) throw new Error(`Workforce ownership token missing: ${token}`);
}

const product = read('docs/00-control/PRODUCT_REQUIREMENTS.md');
for (const token of ['fixed-fee billing-schedule events', 'retainer base, period and overage events', 'managed-service period-charge or accepted-unit events', 'operational earned-management revenue', 'not statutory IFRS/GAAP revenue recognition']) {
  if (!product.includes(token)) throw new Error(`Commercial requirement token missing: ${token}`);
}

const credentialPattern = /(AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*[A-Za-z0-9_./+%-]{20,})/i;
for (const file of allMarkdown) {
  if (credentialPattern.test(read(file))) throw new Error(`Credential-like value found in ${file}`);
}

for (const file of allMarkdown) {
  const text = read(file);
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 !== 0) throw new Error(`Unbalanced fenced block in ${file}`);
  for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) throw new Error(`Broken relative link in ${file}: ${target}`);
  }
}

console.log('WOS-00 review materialization complete.');
console.log(`Changed files: ${[...changed].sort().join(', ')}`);

// Remove the temporary materializer and workflow so the final PR diff contains only product/control changes.
for (const temp of ['scripts/materialize-wos00-review.mjs', '.github/workflows/wos00-materialize.yml']) {
  if (fs.existsSync(temp)) fs.rmSync(temp);
}
