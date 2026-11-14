# WorkOS Source Provenance

**Status:** Source bootstrap is present on main; original permission and reuse controls remain applicable. Git history records bootstrap commit `3070c80a71640fa4275477d0d2f1538cc8d2a819` (PR16). This technical observation does not establish legal commercialization rights or certify every import exclusion.  
**Commercial repository:** `APReddy-AutoBotz/WorkOS`  
**Reference repository:** `APReddy-AutoBotz/Boundaryless-WorkOS`  
**Approved technical baseline:** `f2de1d85126f5d64f0e2e21b085b0303ca1d8417`

## 1. Declared permission basis

The repository owner has represented that permission exists to use the application code as the basis for a separately branded product and has authorized creation of this clean commercial WorkOS repository.

This file records technical provenance and repository-handling rules. It is not a substitute for a signed legal licence, assignment or commercialization permission. Before external licensing or IP assignment, the owner must retain written evidence covering the applicable rights, scope, territory, duration, derivative works and transfer/licensing authority.

## 2. Repository separation

- The reference repository remains unchanged.
- WorkOS does not import the reference Git history.
- The commercial bootstrap copies only approved files from the pinned commit.
- WorkOS development, branches, pull requests, releases and deployment artifacts remain entirely within this repository.
- No WorkOS task may push to or open a pull request against the reference repository.

## 3. Approved reuse categories

Subject to the declared permission and import review, WorkOS may reuse or adapt:

- React/TypeScript application structure and reusable UI components.
- Node.js/Express server behavior.
- PostgreSQL schema/migration foundations.
- Authentication, permission and row-scope foundations.
- Employee/resource, client, project, allocation and timesheet capabilities.
- Leave, approval, notification and integration-adapter foundations.
- Utilization, planning, data-quality, import/export and audit capabilities.
- Automated test techniques and operational runbook patterns.

All reused content must be reviewed for company-specific assumptions, confidential data, prohibited branding and third-party obligations.

## 4. Mandatory exclusions

The commercial source import must exclude:

- The reference `.git` directory and commit history.
- Company logos, marks and branded image assets.
- Leadership-demo presentations, screenshots and generated slide artifacts.
- Company-only requirements/status/handover wording unless rewritten as neutral product guidance.
- Real employee, leader, customer or vendor names.
- Real email domains, phone numbers, addresses, IDs or credentials.
- Production URLs, database identifiers, tenant identifiers or secrets.
- Company confidential processes, pricing, policies or operational evidence not required for generic product behavior.
- Owner-only pricing, negotiation and IP-sale strategy.

## 5. Import method

The WOS-01 bootstrap task must:

1. Fetch exactly the approved commit.
2. Verify the fetched SHA.
3. Copy through an explicit allow/exclude process.
4. Generate an import manifest containing source path, destination path, source blob/checksum where practical and disposition.
5. Run forbidden-term, secret and sensitive-file scans.
6. Restore build and regression evidence in WorkOS.
7. Record the WorkOS import commit and PR below.

## 6. Import evidence

To be completed by WOS-01:

```text
Reference commit: f2de1d85126f5d64f0e2e21b085b0303ca1d8417
Import branch: pending
Import PR: pending
WorkOS import head: pending
Files included: pending
Files excluded: pending
Forbidden-term scan: pending
Secret scan: pending
Build/test evidence: pending
Controller acceptance: pending
```

## 7. Third-party components

The commercial product must preserve and comply with third-party/open-source licences. Before v1 release, the repository must include:

- Dependency inventory.
- Third-party notices.
- Licence compatibility review for production and source-code delivery.
- Software bill of materials or equivalent machine-readable inventory.

Third-party components are not represented as exclusively owned WorkOS IP.

## 8. Buyer-specific work

Future buyer-specific configurations or customizations must distinguish:

- WorkOS core product IP.
- Generic reusable enhancements.
- Buyer-specific configuration/data.
- Buyer-specific commissioned code.
- Third-party and integration components.

The applicable contract or assignment must state ownership and reuse rights for each category.

## 9. Change control

Any proposal to change the reference baseline or import additional reference content requires:

- A written reason.
- An updated provenance record.
- A confidentiality/branding review.
- A separate controlled PR.
- Controller approval before merge.
