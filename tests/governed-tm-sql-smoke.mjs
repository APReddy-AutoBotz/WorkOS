import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialFixture as f,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import { seedCapacity } from './support/worker-capacity-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
import { calculateTmEntry, validTmValuationPolicy } from '../shared/governed-tm-valuation.mjs';
const ok = (r, n = 200) => {
  assert.equal(r.status, n, JSON.stringify(r.body));
  return r.body;
};
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedCapacity(pool),
    manager = fx.identities.manager,
    keys = ['commercial.tm_valuation.view', 'commercial.tm_valuation.create'];
  assert.equal(
    (
      await pool.query(
        'select count(*)::int n from permission_definitions where permission_key=any($1::text[])',
        [keys],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await pool.query('select count(*)::int n from role_permissions where permission_key=any($1::text[])', [
        keys,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int n from user_permission_grants where permission_key=any($1::text[])',
        [keys],
      )
    ).rows[0].n,
    0,
  );
  for (const k of [...keys, 'commercial.rate_candidates.view', 'commercial.cost_candidates.view'])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  const policy = {
    version: 'governed-tm/1',
    currency: 'USD',
    precision: 2,
    rounding: 'HALF_UP',
    aggregation: 'PER_ENTRY',
    capTreatment: 'NONE',
    exclusions: 'NONE',
    unit: 'HOUR',
    approvalTreatment: 'NONE',
  };
  for (const v of [
    policy,
    { ...policy, precision: null },
    { ...policy, rounding: 'UNKNOWN' },
    { ...policy, extra: true },
  ])
    assert.equal(
      (await pool.query('select valid_governed_tm_policy($1::jsonb) valid', [JSON.stringify(v)])).rows[0]
        .valid,
      validTmValuationPolicy(v),
    );
  for (const mode of ['HALF_UP', 'HALF_EVEN', 'DOWN'])
    for (const rate of ['1.0050', '1.0150', '1.0199', '99999999999999.9999']) {
      const expected = calculateTmEntry({
        hours: '1',
        billingRate: rate,
        costRate: '2.0000',
        currency: 'USD',
        unit: 'HOUR',
        policy: { ...policy, rounding: mode },
      });
      const got = (await pool.query('select commercial_tm_fixed($1::numeric,2,$2) v', [rate, mode])).rows[0]
        .v;
      assert.equal(got, expected.billableValue);
    }
  await withCommercialApi({ databaseUrl, identities: fx.identities }, async ({ request }) => {
    const contract = ok(
        await request('/contracts', {
          method: 'POST',
          body: {
            number: 'SYN-TM-SQL',
            clientId: f.clientId,
            name: 'Synthetic contract',
            model: 'time_and_materials',
            startsOn: fx.today,
            endsOn: shift(fx.today, 30),
            effectiveFrom: fx.today,
            currency: 'USD',
            value: '100.0000',
            billingTerms: 'Synthetic terms',
            documents: [],
            reason: 'Synthetic fixture',
          },
        }),
        201,
      ),
      engagement = ok(
        await request('/engagements', {
          method: 'POST',
          body: {
            code: 'SYN-TM-SQL',
            name: 'Synthetic engagement',
            model: 'time_and_materials',
            ownerId: f.ownerId,
            startsOn: fx.today,
            endsOn: shift(fx.today, 30),
            currency: 'USD',
            budget: '100.0000',
            clientId: f.clientId,
            contractId: contract.id,
            contractVersionId: contract.versions[0].id,
            attributionId: null,
            reason: 'Synthetic fixture',
          },
        }),
        201,
      );
    const event = randomUUID(),
      requestId = randomUUID(),
      sql =
        'insert into commercial_tm_policy_versions(id,organization_id,legal_entity_id,engagement_id,sequence,previous_id,effective_from,definition,actor_id,active_role,request_id,reason,operation_id)values($1,$2,$3,$4,1,null,$5,$6::jsonb,$7,$8,$9,$10,$11)',
      args = [
        event,
        f.organizationId,
        f.legalEntityId,
        engagement.id,
        fx.today,
        JSON.stringify(policy),
        manager.id,
        'Admin',
        requestId,
        'Synthetic policy',
        'synthetic-operation',
      ];
    await assert.rejects(pool.query(sql, args), (e) => e.code === 'CTM01');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('workos.commercial_tm_context',$1,true)", [
        JSON.stringify({
          eventId: event,
          organizationId: f.organizationId,
          legalEntityId: f.legalEntityId,
          actorId: manager.id,
          activeRole: 'Admin',
          operationId: 'synthetic-operation',
        }),
      ]);
      await client.query(sql, args);
      await assert.rejects(client.query('commit'), (e) => e.code === 'CTM03');
      assert.equal(
        (await pool.query('select count(*)::int n from commercial_tm_policy_versions')).rows[0].n,
        0,
      );
      await client.query('begin');
      await client.query("select set_config('workos.commercial_tm_context',$1,true)", [
        JSON.stringify({
          eventId: event,
          organizationId: f.organizationId,
          legalEntityId: f.legalEntityId,
          actorId: manager.id,
          activeRole: 'Admin',
          operationId: 'synthetic-operation',
        }),
      ]);
      await client.query(sql, args);
      await client.query(
        "insert into audit_logs(user_id,user_name,user_role,active_role,module,action,entity_type,entity_id,new_value,details,organization_id,legal_entity_id,operation_id)values($1,'synthetic','Admin','Admin','T&M Valuation','Configure Policy','TMPolicy',$2,$3::jsonb,'Synthetic redacted',$4,$5,'synthetic-operation')",
        [
          manager.id,
          event,
          JSON.stringify({ policyId: event, engagementId: engagement.id }),
          f.organizationId,
          f.legalEntityId,
        ],
      );
      await client.query('commit');
      assert.equal(
        (await pool.query('select count(*)::int n from commercial_tm_policy_versions')).rows[0].n,
        1,
      );
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  });
  console.log('T&M policy default deny, decimal SQL parity, direct writer guard and audit rollback passed.');
});
