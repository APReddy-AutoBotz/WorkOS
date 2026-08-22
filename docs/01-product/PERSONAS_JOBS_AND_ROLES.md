# WorkOS Personas, Jobs and Roles

## Principle

Personas describe jobs; canonical roles and permissions authorize actions. Buyers may rename user-facing roles, but canonical keys remain stable for API, audit and migration behavior.

## Personas and primary jobs

| Persona | Primary jobs | Sensitive access considerations |
|---|---|---|
| Organization Administrator | Configure organization, identity, roles, terminology, modules and readiness | Protected security and permission controls |
| People Operations | Maintain workers, capacity, calendars, leave and lifecycle | Personal data; normally no confidential cost rate |
| Resource Manager / Delivery Lead | Plan demand, assignments, capacity, bench, overload and roll-off | Scoped workforce and engagement visibility |
| Engagement / Project Manager | Manage engagement/project delivery, assignments, budgets, work approval and forecast | Project scope; margin may require separate permission |
| Account / Commercial Manager | Manage contracts, POs, commercial models, rate cards and billing schedules | Commercial terms and client scope |
| Finance / Billing Analyst | Review approved-unbilled work, snapshots and invoice-ready batches | Financial scope; cost/margin separate from billing access |
| Team Lead / Approver | Review scoped work/leave/changes and delegate authority | Delegation never broadens original scope |
| Employee / Contractor | View own profile/assignments and submit/correct work | Own records only unless separately authorized |
| Executive / Practice Leader | Review capacity, utilization, client exposure, revenue, margin and risk | Aggregated and scoped reporting |
| Auditor / Control Owner | Review immutable audit, access, commercial changes and exports | Read-only protected evidence |
| Integration Administrator | Configure provider mappings and inspect delivery health | Credential readiness without secret disclosure |

## Canonical role-template direction

Initial templates may include:

- `organization_admin`
- `people_ops`
- `resource_manager`
- `engagement_manager`
- `commercial_manager`
- `finance_billing`
- `approver`
- `worker`
- `executive_reader`
- `auditor`
- `integration_admin`

These are templates, not hardcoded authorization shortcuts. Effective access is:

```text
identity + active role + effective permission + organization/legal entity + entity relationship + policy state
```

## Separation-of-duty examples

- A project manager may approve work but not edit confidential worker cost rates.
- A finance analyst may prepare a batch but require a different approver to finalize/export it.
- A people administrator may manage worker records but not change protected role permissions.
- An auditor can review evidence but cannot mutate operational records.

## Acceptance cases

Positive: a user with the required active role, permission and data relationship can perform the job.

Negative: assigned-but-inactive roles, renamed user-facing titles, delegated authority or broad UI access cannot bypass server permission and row scope.