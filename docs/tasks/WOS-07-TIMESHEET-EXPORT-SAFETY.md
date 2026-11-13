# Timesheet operational export safety

Addresses WOS-NFR-SEC-008, WOS-RPT-006 and WOS-NFR-MNT-005. Timesheet Approval Ops Export previously escaped CSV delimiters but preserved spreadsheet formula/control prefixes in worker-entered remarks and other free-text fields. It now uses the existing shared quoteCsvCell function for every header and value. Current filters, columns, ordinary text, filename and export audit behavior remain intact; no retained invoice artifact serializer changes.

## Evidence

A real React/API/PostgreSQL browser regression saves a synthetic tab-prefixed formula remark and exports it through Ops Export. The unchanged parent fails the literal-prefix assertion. The repaired page passes the hostile remark check, embedded quote/comma preservation, header quoting, download filename and persisted export audit actor checks. The shared serializer regression passes its 18 hostile header/value vectors and normal field-boundary cases. Type checking and the production build passed. Syntax checks passed (520 JavaScript modules); hosted CI remains required at the Draft head. Existing bundle-size and dependency annotation build warnings remain. No dependency or migration changes; the verified parent locked installation is reused.

This follows the existing literal-text convention; spreadsheet import settings and later editing can affect interpretation, so no universal guarantee across spreadsheet transformations is claimed. The user still controls which authorized filtered records are exported. No production data or deployment is changed. Rollback restores the unsafe export path; prefer a tested forward correction. The wider repository security review remains in progress.
