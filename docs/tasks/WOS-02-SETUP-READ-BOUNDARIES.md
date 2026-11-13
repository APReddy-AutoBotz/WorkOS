# Setup request and workforce read boundaries

Addresses WOS-IAM-005/010, WOS-WKF-006 and WOS-NFR-SEC-004/008. Setup endpoints must reject malformed dates without disrupting the shared API and must enforce worker visibility before returning lifecycle history or dependency identifiers.

The setup router validates a single real ISO asOf date before database access. All route handlers forward rejected promises through a small shared async-handler adapter to a sanitized router error boundary, including failures before mutation transaction setup. Existing transaction handlers retain rollback behavior. Unexpected failures expose a stable generic error rather than database details.

Worker history and dependency reads now require employees.view and use the existing authoritative employee visibility predicate. Own-worker and authorized direct-report/admin reads remain supported; organization membership alone does not grant access to another worker. Authorized response shapes remain unchanged. No migration, dependency, financial calculation or UI change is introduced.

## Executable evidence

The unchanged parent API reproduced a failed connection (ECONNRESET) on context?asOf=not-a-date. The new real PostgreSQL/API regression passes 50 malformed date requests across five reads and both API prefixes: invalid date text, impossible date, repeated values, object-shaped input and empty input. Valid reads still succeed. A synthetic unavailable terminology table produces a controlled 500 without SQL details, and the same process continues serving context reads.

The same regression verifies own-worker and administrator access, TeamLead direct-report access, unrelated-worker and cross-scope denial, and denial after the required permission is removed. Organization setup compatibility/unit tests passed. Actual PostgreSQL profile, terminology and calendar route/date/audit regressions passed in UTC, Asia/Kolkata and America/Los_Angeles (nine timezone suites). Type checking passed; lint syntax-checked 519 modules. Initial date-suite runs without the database environment were not counted as database acceptance; all were rerun with the disposable database configured. Hosted CI is required and remains tracked in the Draft PR.

## Operations and limitations

No production data or deployment is changed. Existing valid date queries and authorized response schemas remain compatible; malformed query values now return 400. Dependencies reuse the verified unchanged parent lockfile installation. The new error boundary covers this setup module; other legacy async modules still require separate review. Worker history remains available only within established permission and row scope; this package does not redesign its authorized payload. Reverting restores the availability and visibility gaps, so prefer a verified forward correction.
