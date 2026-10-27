# Explicit worker types and configurable labels

## Authority and dependency

WOS-WKF-002 requires employee, contractor, fixed-term worker, intern and external resource as distinct canonical types with configurable user-facing labels. WKF001 requires worker type in the workforce master; CORE004/005, IAM003/005/010 and the Organization and Setup and Resource Planning specifications require scoped authority, retained effective history and audit. WOS-02 issue #4 includes configurable worker types and worker lifecycle preservation.

Develop as a dependent Draft from PR98 ef6219ff79d30b65f836024ca9e70c18e1bc2ac3. The existing worker_type catalog supports arbitrary buyer codes but contains no canonical-kind mapping; worker_profiles.worker_type_id is a nullable current native reference without a supported authoring/history path. Existing legacy contract_type is separate. Do not infer mappings or rewrite existing rows.

## Acceptance boundary

Provide explicitly configured, prospective, dated labels for the five fixed canonical kinds, and an explicitly selected, dated worker type for an existing scoped worker. Record exact actor/role/reason and prior versions; current and as-of reads resolve deterministic retained history. Buyer labels and worker choices are explicit: no seeded selection, guessed legacy conversion, automatic calendar/capacity/billability projection, employee status change, ownership transfer or new grant. Existing manual/import omission must preserve the new ledger and existing native fields. Existing permissions and relationship scope apply independently to configuration and worker adoption. Unavailable existing native references remain visible as legacy, not silently adopted.

Use additive migration(s), no rewrite of earlier migrations. Preserve native source and retained history, concurrent version conflicts, exact-request replay/reconciliation, current permission/scope checks and actor/session fences. Avoid same-day amendments, future cancellation and identity transfer unless existing contracts specify them. Guard retirement or version closure so retained historical references cannot be silently orphaned or rebound.

Required proof: real React/API/PostgreSQL configuration for all five kinds; explicit scoped worker selection, save/reload/current/as-of history and future-date behavior; configurable Unicode labels, legacy omission and native-reference preservation; foreign/unauthorized/stale/retired source negatives; concurrent replay/conflict, atomic audit and original owned receipt recovery; session/worker switch isolation; fresh/upgrade/replay migration and unchanged work/capacity/approval/financial history. Run applicable independent fresh-source local gates and exact-head hosted validation, retaining any failures. Formal reviews, integration, UAT and release remain unpassed; no merge/deploy.
