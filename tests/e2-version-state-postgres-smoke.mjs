import { withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { seedAssignmentApproval } from './support/assignment-approval-test.mjs';
import { configureE2, proveE2 } from './support/e2-version-state-test.mjs';

await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedAssignmentApproval(pool);
  await withCommercialApi({ databaseUrl, identities: fx.identities, timeZone: 'Pacific/Kiritimati' }, async ({ request }) => {
    const assignment = await configureE2(request, fx);
    await proveE2({ pool, request, fx, assignment });
  });
});
console.log('Bounded E2 real API/PostgreSQL: nonempty project work pins V1, named final work stages feed exact actual/capacity, rejected/pending material proposals retain V1, approved V2 refreshes native projection/stale token, immutable V1 work and CSV bytes passed. No UAT/review/full milestone acceptance claim.');
