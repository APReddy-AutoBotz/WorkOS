# Current workforce authority for authenticated sessions

Addresses WOS-CORE-003, WOS-IAM-005/009/010, WOS-WKF-008 and WOS-NFR-SEC-004.

A real local login followed by an authorized employee update reproduced obsolete director access: the retained token still listed the previous director's workers while a fresh login did not. A signature establishes issuance, not continuing workforce relationships.

The shared authentication boundary will reload worker record, worker code and qualified director binding alongside the existing active-account/role check. Signed historical bindings must not override current database values, including null values. Existing organization/legal-entity scope and permission checks remain authoritative. Missing storage fails closed. No new grants, buyer defaults, schema or financial behavior are introduced.

Acceptance requires a real issued-token reassignment regression, null/unlinked/changed-designation and signed stale-binding negatives, current positive scope, cookie and bearer checks, middleware contracts, production identity checks and affected domain regressions. Fixtures that only signed worker claims must establish actual database ownership; tests must not weaken runtime authority to retain old assumptions.

Already admitted requests may finish under their request-start authority. No retrospective data alteration or session-wide administrative revocation is included. Older code restores stale-token scope, so prefer forward correction; any controlled rollback must invalidate outstanding sessions. Production rollout and final integration remain separate gates.
