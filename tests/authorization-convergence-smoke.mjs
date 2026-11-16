import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../server/migrations/021_entra_auth_transactions.sql', import.meta.url), 'utf8');
const identityFixture = readFileSync(new URL('./production-identity-smoke.mjs', import.meta.url), 'utf8');

const contracts = [
  ['configured deny-all remains empty', /select permission_key, enabled from role_permissions[\s\S]*filter\(row => row\.enabled\)/],
  ['Employee scope is separate from TeamLead hierarchy', /activeRole === 'Employee'[\s\S]*activeRole === 'TeamLead'/],
  ['OAuth state is browser bound', /workos_entra_state[\s\S]*browser_binding_hash/],
  ['OAuth state is atomically consumed once', /delete from entra_auth_transactions[\s\S]*returning id/],
  ['timesheet writes use active-role scope', /Timesheet is outside active-role data scope/],
  ['timesheet saves accept only draft and submitted', /status: z\.enum\(\['Draft', 'Submitted'\]\)/],
  ['project work is date-effectively assigned', /Project work requires an active assignment covering the work date/],
  ['TeamLead decisions are direct-report scoped', /Team Leads can approve only direct-report timesheets/],
  ['generic self-decisions are denied', /Users cannot decide their own approval requests/],
  ['over-allocation checks are serialized', /pg_advisory_xact_lock\(hashtextextended/],
];

for (const [name, pattern] of contracts) assert.match(source + readFileSync(new URL('../server/modules/work-capture/assignment-work-policy.mjs', import.meta.url),'utf8'), pattern, name);
assert.match(migration, /state_hash text not null unique/);
assert.match(migration, /expires_at timestamptz not null/);
assert.match(source, /process\.env\.LOGIN_RATE_LIMIT \|\| 8/, 'production login rate limiting must retain its default of eight attempts');
assert.match(identityFixture, /LOGIN_RATE_LIMIT: '13'/, 'the thirteen-callback identity fixture must use an explicit bounded allowance');
console.log(`Authorization convergence smoke passed (${contracts.length} controls).`);
