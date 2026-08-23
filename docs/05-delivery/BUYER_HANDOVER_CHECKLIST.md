# WorkOS Buyer Handover Checklist

A handover is complete only when product evidence and buyer-owned environment decisions are both accepted.

## 1. Commercial and source package

- [ ] Exact release tag, source commit and artifact checksums recorded.
- [ ] Licence/assignment scope and excluded third-party components documented separately from technical evidence.
- [ ] Provenance, dependency inventory, third-party notices and SBOM supplied.
- [ ] Changelog, release notes, known limitations and deferred scope supplied.

## 2. Deployment and credentials

- [ ] Buyer-owned hosting, database, domain/TLS and optional object storage identified.
- [ ] Environment variables and secret inventory assigned to owners.
- [ ] Database, session/OIDC, email/collaboration and integration credentials configured without sharing in source.
- [ ] Rotation, revocation and break-glass procedures agreed.
- [ ] Production demo data, shortcuts, fallback and shared accounts disabled.

## 3. Organization, identity and access

- [ ] Organization/legal entities, currencies, locale, terminology and brand approved.
- [ ] Calendars, periods and feature release settings approved.
- [ ] OIDC/Entra configuration and named production users tested.
- [ ] Role templates, exceptions, protected permissions and effective access reviewed.
- [ ] Joiner/mover/leaver and session-revocation ownership agreed.

## 4. Data and reconciliation

- [ ] Workforce, clients, contracts, engagements/projects and assignments imported through controlled batches.
- [ ] Rejected/duplicate rows resolved and source/batch evidence retained.
- [ ] Record counts, relationships, utilization and data-quality reports reconciled.
- [ ] Commercial terms, rates, costs, budgets and POs approved by authorized owners.
- [ ] Golden vectors and representative revenue/margin/invoice-ready totals reconciled.

## 5. Role UAT

- [ ] Organization administrator.
- [ ] People operations.
- [ ] Resource/delivery manager.
- [ ] Engagement/project manager.
- [ ] Commercial manager.
- [ ] Finance/billing analyst.
- [ ] Approver/team lead.
- [ ] Worker/contractor.
- [ ] Executive reader and auditor.
- [ ] Protected deep links and negative cross-scope cases.

## 6. Security and privacy

- [ ] Security architecture and threat model reviewed.
- [ ] Findings are resolved, accepted or tracked with owner/date.
- [ ] Retention, anonymization, audit export and legal-hold decisions approved.
- [ ] Logging and exports reviewed for personal, cost, margin and secret exposure.
- [ ] Buyer-specific penetration/infrastructure testing completed where required.

## 7. Operations and recovery

- [ ] Monitoring, dashboards, alert routes and operational owner configured.
- [ ] Backup schedule, retention, encryption, restore owner and RPO/RTO approved.
- [ ] Restore rehearsal completed against the accepted release.
- [ ] Migration, rollback/roll-forward and incident procedures rehearsed.
- [ ] Provider/integration health, retries and failure ownership verified.

## 8. Support and acceptance

- [ ] Support contacts, hours, severity model and warranty/maintenance boundaries documented.
- [ ] Administrator and operations knowledge transfer completed.
- [ ] Final engineering evidence references the exact release head/artifact.
- [ ] Buyer acceptance, residual risks and open environment gates signed off.
- [ ] Product-owner Gate D approval recorded before `v1.0.0` release declaration.