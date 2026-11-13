# Spreadsheet-safe CSV text prefixes

## Review finding and authorized outcome

The enterprise review on 2026-11-14 found that the generic operational CSV encoder protects only an immediately leading ASCII formula marker. A worker/project/comment value beginning with a tab, carriage return, line feed or whitespace followed by a formula marker reaches the downloaded file without that protection. The reconciliation encoder handles whitespace-prefixed ASCII formulas, but the two implementations have diverged.

Address WOS-NFR-SEC-008, WOS-RPT-006 and WOS-NFR-MNT-005 in a bounded export-encoding change based on PR #122. Centralize quoted-field encoding, preserve existing apostrophe protection, and cover leading control characters, whitespace-prefixed formulas and full-width formula markers. Apply the same rule to operational export headers/values and reconciliation fields. Preserve delimiters, quotes, Unicode, empty values, ordinary numeric fields, column order, authorization and audit flow. Existing immutable invoice artifacts and their reversible base64 format are not rewritten.

The threat and character classes are documented by [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection). CSV interpretation varies by spreadsheet and import settings; this encoding is not a guarantee that files remain safe after external editing, saving or re-import. Do not enable formulas or external links in untrusted exports. Machine consumers must account for the existing literal-text apostrophe convention.

## Required evidence

- Demonstrate the original encoder misses the hostile-prefix vectors before changing it.
- Unit/negative vectors for headers and values, preserved ordinary data, separators, quotes and multiline fields.
- Existing reconciliation boundary tests and real browser CSV download with the production helper.
- Typecheck, lint, production build and unchanged security checks.
- Record exact head and hosted results in the Draft PR; no release acceptance inferred.

## Local verification, 2026-11-14

- The new negative test failed against the original encoder on a tab-prefixed formula, then passed after the shared encoder change.
- `npm run test:csv-output-safety`, reconciliation boundary tests, `npm run typecheck`, `node scripts/lint.mjs` (514 modules), and `node --check shared/csv-cell.mjs` passed.
- `node tests/billing-reconciliation-postgres-smoke.mjs` passed against disposable PostgreSQL 16 databases, including authorization denials and audit rollback.
- `node tests/actual-utilization-browser-smoke.mjs` passed with synthetic API fixtures in Chromium, covering the real CSV download, audit/history behavior and existing report states. Earlier attempts failed because the local fixture server was unavailable; the passing run used a restarted server and unchanged timeouts.
- `npm run build` passed (3,069 modules). Existing dependency annotation and main-chunk-size warnings remain; this change does not resolve them.
- No dependency versions changed. The parent work package installed the lockfile and passed the complete unit/contract suite and migration suite; the new exact-head CI run remains the acceptance gate for this package.

## Operations and rollback

No schema, migration, permission, calculation or provider change. CSV text that previously began with an unsafe prefix now receives the existing apostrophe literal marker; ordinary exports retain their bytes. Rollback would reintroduce the unsafe-prefix gap and should use a validated forward correction instead. Retained invoice artifacts remain unchanged.
