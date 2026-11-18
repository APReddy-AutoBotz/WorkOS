# Milestone acceptance and billing eligibility

A billing manager configures an effective-dated policy for a milestone engagement. The policy specifies the acceptance evidence and named approval stages. Internal and client evidence references retain who supplied them. Client evidence is a user attestation. The requester and the recorded owner must both be independent of every reviewer.

The final approval transaction retains the decision, source version, amount, native currency and acceptance evidence. It creates a single eligibility event and approved-unbilled item. Rejection, an incomplete stage, a superseded policy, an inactive source, or loss of required authority prevents eligibility. The register supports an engagement filter. The application shows the selected engagement’s items.

Migration `065m_wos06_milestone_billing_eligibility` adds the review ledger, source-specific event guards and three opt-in permission definitions. Administrators can assign view, manage and decide access in the existing permission system. The database rechecks the named stage, effective policy, active owner, requester, source and scope. Recipient access is rechecked when listing and acknowledging notifications.

For operational rollback, withdraw the milestone-specific permissions or stop new reviews, then revert the application. Retain the migration, historical decisions and both source types in the billing register. Verify T&M totals against their retained evidence. The next invoice package covers reservation, batch review, export and confirmation for accepted milestones. Amended milestone terms and operational earned-management valuation remain separate work.

The real React, API and PostgreSQL journey covers staged approval, concurrent submission, final-decision replay, rejection, superseded policy, self-approval, foreign scope, lost access and failed required delivery. The populated invoice upgrade verifies existing T&M eligibility events, register items, occupancies and artifacts before and after migration and replay.
