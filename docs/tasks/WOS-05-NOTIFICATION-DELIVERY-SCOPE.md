# Scoped notification delivery history

Addresses WOS-IAM-005/010, WOS-INT-002 (delivery evidence visibility) and WOS-NFR-SEC-004. The delivery-attempt endpoint previously returned the latest 300 records across the deployment after checking notifications.manage only. It now joins each attempt to its event and recipient employee and applies the authoritative employee visibility predicate, including active organization/legal entity ownership. Orphaned events cannot establish ownership and are excluded. The authorized attempt shape and 300-row bound remain unchanged; ordering adds a deterministic identifier tie-breaker.

## Verification

The real PostgreSQL/API regression fails against the unchanged parent: the default-scope administrator receives foreign-organization, other-legal-entity and orphan attempts. After repair it passes administrator active-entity reads, authorized legal-entity switching, Employee own-worker reads, unrelated-worker denial, TeamLead own/direct-report reads, orphan exclusion, unauthenticated denial and permission-loss denial. The legacy endpoint remains the supported contract; no new versioned endpoint is introduced. The existing eight-route notification router suite passes. Type checking passed; syntax checking passed (521 JavaScript modules). Hosted CI remains required at the Draft head. No migration or dependency change; parent locked installation is unchanged.

## Operations and limitations

No notification is sent by the regression; all records are synthetic and isolated. No production deployment or data mutation occurs. Historical attempts with no recipient remain stored but are not exposed through a scoped workforce endpoint. This repair does not create deployment-wide support access or redesign delivery retry/provider metadata. Reverting reopens cross-scope disclosure, so prefer a verified forward correction. Broader integration and repository review remains active.
