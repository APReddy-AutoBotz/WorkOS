# Settings persistence outcomes

Requirements: WOS-CORE-003/005, WOS-NFR-OBS-005 and WOS-NFR-UX-003/005. Governing behavior: ORGANIZATION_AND_SETUP_SPEC.md.

This independent package starts from accepted main 88262c87a260529c00a680b22d2f021ff7d8cba4. Historical Draft PR137 is reference material only; its previous test results do not establish acceptance here.

The current settings page ignores save promises and displays success before server acknowledgement. The alternate action also claims recalculation that the server does not perform. Initial load failure leaves an indefinite loading state. Await real outcomes, retain edits after refusal, prevent duplicate submission, distinguish newer edits from the acknowledged snapshot, suppress obsolete/unmounted completions, and offer load retry. Preserve server authorization, persistence, audit and unrelated catalog behavior.

Acceptance requires an actual mounted React/API/PostgreSQL journey covering failed load/retry, delayed save without early acknowledgement, refusal with unchanged database and retained input, confirmed persistence, alternate save with newer edits, unmount/reopen and live permission revocation. Run locked install, typecheck/lint, aggregate, browser, migration, production and configured security gates. No migration, dependency or permission change is planned. Shared unpatched picomatch audit failure is not waived; no release or deployment acceptance is claimed.

Prefer forward correction. Reverting the page restores misleading success states; preserve settings/audit history. Implementation and current executable evidence remain pending.

Baseline browser execution confirmed both issues: failed initialization never displayed an error/retry state, and an intentionally held POST displayed Settings Saved while the database remained unchanged. Both regressions failed against unchanged accepted main. The page now awaits the shared guarded save action, retains failed input and distinguishes newer edits, with load retry and unmount suppression. The corrected real browser/API/PostgreSQL journey passes load retry, held/refused/successful save, retained/newer edits, unmount/reopen and actual permission revocation. Typecheck and the 513-file bootstrap/adversarial scan pass. Full validation and independent exact-head review remain pending.
