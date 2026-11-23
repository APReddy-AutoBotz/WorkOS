# Fixed-fee budget breach notifications

## Scope and source

WOS-INT-002 and WOS-INT-005 govern delivery. WOS-COM-007 and WOS-RPT-004 supply the budget and verified usage. The first source is the approved fixed-fee effort or labor-cost warning. Existing allocation risk GET requests must stay read-only. Keep valuation, invoices and signed period statements independent of notification delivery.

## Recipient configuration

Resolve the engagement owner via commercial_engagements.owner_id and its current scoped worker identity. Require explicit engagement-specific, effective-dated commercial manager and finance/billing owner assignments. An invoice-export policy identifies owners for a different event and must not implicitly authorize receipt of engagement risk. Validate current user, held role, employment and organization/legal entity scope for each relationship. Deduplicate by user and retain every applicable reason. Reject ambiguous or unresolved relationships. A producer request must never accept recipient overrides.

## Production and recovery

Evaluate verified usage with the same decimal-safe logic as the risk report after work approval, cost retention and budget amendments, including amendments that become effective later. Record the source budget terms and metric. A repeated evaluation of the same breach must reuse its event across concurrent callers and subsequent reporting dates. An unrelated amendment carrying the warning forward must not start another warning. Preserve historical notices when the buyer disables or replaces the warning.

Deliver commercial.risk_threshold_breached as CONTROL_MANDATORY with a versioned buyer template. Commit all required in-app deliveries and relationship reasons atomically. A missing recipient or persistence failure needs sanitized, retryable evidence and must preserve the approved business transaction. Resolve current access again on inbox reads. External delivery follows buyer channel policy.

## Acceptance evidence

- Exercise actual PostgreSQL, application API and recipient inboxes for three separate recipients and one user holding multiple relationships.
- Exercise the exact threshold, zero and absent budgets, incomplete evidence and both metric types. Repeated report reads must write zero events. Replay, concurrent evaluations and unrelated amendments must create zero duplicate deliveries.
- Withdraw a recipient role and move a worker across legal entities between configuration and delivery. Confirm visible failure, no partial recipients, and one complete delivery after correction. Withdrawing current scope must also prevent retained notice disclosure.
- Verify preference opt-out cannot suppress required in-app notices. Exercise producer rollback, independent core commit, retry and safe failure diagnostics.
- Run fresh and upgrade migrations, production startup, browser journeys, authorization checks and the complete CI workflow before merge.
