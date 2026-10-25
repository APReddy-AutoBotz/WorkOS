import { withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { seedWorkApproval } from './support/work-approval-test.mjs';
import { configureStagedLeave, proveStagedLeave } from './support/staged-leave-test.mjs';
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool); const fx = await seedWorkApproval(pool);
  // Reuse the existing calendar-leave synthetic self-service fixture capability;
  // this is not a runtime permission definition, buyer grant or seed change.
  await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Employee','leave.self_service',true)on conflict(role_name,permission_key)do update set enabled=true");
  await withCommercialApi({ databaseUrl, identities: fx.identities, timeZone: 'Pacific/Kiritimati' }, async ({ request }) => { await configureStagedLeave(request, fx); await proveStagedLeave({ pool, request, fx }); });
});
