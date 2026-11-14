# Retained requirements authority

The frozen audit found that WOS01A_RETAINED_REQUIREMENTS.md claimed single-source/superseding authority, excluded billing and allowed release with known P1 defects. Those historical statements conflict with the current authoritative WorkOS requirements and blocking-review policy.

On 2026-11-14, the owner explicitly selected **Mark retained file historical**, authorizing a clarification while preserving its original contents. A prominent notice now identifies the retained text as historical, links current product and review authority, and prevents historical completion claims being used as present acceptance evidence. No original retained paragraph was changed or deleted.

Requirement traceability: WOS-GOV-005 release traceability. This resolves a document-authority ambiguity; it does not accept any runtime requirement, waive defects or change commercial policy. No source code, dependencies, migrations, configuration, permissions or financial records changed.

Validation passed: original retained text matches the parent Git blob line-for-line after removing the inserted notice; both relative Markdown authority links resolve; whitespace diff check passes. Application, browser, database and production tests are not applicable to this documentation-only change. No hosted CI result is claimed.

Security: historical relaxed release language cannot authorize bypassing current blocking controls. Rollback removes the added notice and this task record, reintroducing the documented ambiguity but changing no stored business data. The dependent project-contribution implementation remains unfinished and separately scoped.
