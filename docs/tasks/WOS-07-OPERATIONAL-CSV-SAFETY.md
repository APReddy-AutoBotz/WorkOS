# Operational CSV literal-text safety

Requirements: WOS-NFR-SEC-008; retained WOS-RPT-006 and WOS-NFR-PRV-005 export controls.

## Scope and acceptance plan

Based on accepted PR168/main `0d65ab6313d4a26bcc2d14702f7ce6d6e7ab88eb`, correct operational spreadsheet-facing cell encoding in the shared exporter and Timesheet Approval Ops Export. Current shared encoding misses control/whitespace-prefixed and full-width formula markers; Ops Export only quotes delimiters. Apply one cell encoder to headers and values while preserving original characters after the existing apostrophe literal marker, CSV escaping, field order, null/empty values, ordinary quantities and filtered/audited export behavior. Empty Ops Export must retain headers with no invented data row. Source records must remain unchanged.

This package safely precedes later commercial integration: invoice-action source authorization depends on modules absent from main. Do not import the dependent stack or alter retained invoice artifacts, permissions, financial calculations, schema or dependencies.

Required evidence: original hostile-vector failure, actual unsafe Ops download reproduction, hostile header/value and field-boundary regressions, real browser/API/PostgreSQL Ops export with filtering/empty output/audit witnesses, shared production-helper browser downloads, typecheck/lint/aggregate, migrations, production build/identity/startup, scans, independent exact-head review and hosted gates before merge. Source-backed candidate review is mandatory. Check the final diff before freezing.

## Format compatibility and limitations

The existing literal-text apostrophe convention is preserved, including negative-number handling. CSV interpretation depends on spreadsheet software and import settings; saving/reopening or subsequent transformations can remove protections. No universal spreadsheet execution guarantee is claimed. Machine consumers must account for literal markers. See [OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection) for the character classes and interoperability limits.

## Rollback

No migration or stored-data conversion is required. Prefer a forward correction because reverting reopens the unsafe-prefix paths. This package does not claim broader export authorization, retained commercial-artifact acceptance, production deployment or full-repository security clearance.

## Integration evidence

Locked installation passed: 338 packages installed, 345 audited, zero vulnerabilities. The hostile-prefix unit regression failed on a tab-prefixed formula against the original encoder. The actual browser/API/PostgreSQL Ops download independently failed the missing literal-marker assertion before the correction. The first browser fixture used an unsupported work type and was corrected to use existing governed-project/assignment commands; another attempt timed out loading unrelated fixture screens, so an isolated production-page mount was used. Neither setup failure is passing evidence.

After correction, 23 hostile header/value vectors, ordinary data and independent CSV parsing tests passed. The actual browser checks passed quoted bytes, selected-week exclusion, exact columns/quantities, empty header-only output, export audit actor/counts, unchanged stored work/evidence, and a real download through the production shared helper. Typecheck and the helper syntax check passed. Final aggregate, migration, production, independent frozen-head review and hosted results are recorded in the PR before acceptance. No dependency or migration changes.

A fresh independent candidate review found no concrete surviving bypass or regression; its additional 64 prefix/field-boundary combinations and six compatibility controls passed. The retained 56-entry fresh/concurrent/replay/upgrade/rollback suite also passed. Exact-head review and hosted acceptance remain required.
