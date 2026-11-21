import assert from 'node:assert/strict';
import {verifyRestoredArchive} from './support/postgres-archive-recovery.mjs';
import {commercialFixture, migrateCommercialDatabase, seedCommercialIdentities, seedCommercialReferences,
  withCommercialApi, withCommercialDatabase, withCommercialMigrationsThrough} from './support/commercial-drafting-test.mjs';

import {runMigrations} from '../server/migration-runner.mjs';
import {randomUUID} from 'node:crypto';

for (const historical082p of [false,true]) await withCommercialDatabase(async source => {
  if (historical082p) {
    await withCommercialMigrationsThrough('082p_wos06_retainer_credit',rootDir=>runMigrations({pool:source.pool,rootDir,logger:{log(){}}}));
  } else {
    await migrateCommercialDatabase(source.pool);
  }
  await seedCommercialReferences(source.pool);
  const identities = await seedCommercialIdentities(source.pool);
  const input = {
    number: 'SYN-RESTORE', name: 'Restore rehearsal', clientId: commercialFixture.clientId,
    model: 'time_and_materials', currency: 'GBP', value: '23456.7891',
    startsOn: '2020-01-01', effectiveFrom: '2020-01-01', endsOn: '2099-12-31',
    billingTerms: 'Synthetic terms', documents: [], reason: 'Exercise commercial backup recovery',
  };
  let contractId;
  await withCommercialApi({...source, identities}, async ({request}) => {
    const saved = await request('/contracts', {method:'POST', body:input});
    assert.equal(saved.status,201);
    contractId = saved.body.id;
  });
  const profile = {skills:[{skill:'Synthetic recovery skill',proficiency:'Experienced'}],certifications:[],availabilityNote:null};
  if (historical082p) {
    await source.pool.query(`insert into workforce_capability_versions(id,organization_id,legal_entity_id,employee_id,sequence,contract_version,
      profile,actor_id,active_role,source,reason) values($1,$2,$3,$4,1,'workforce-capabilities/1',$5,$6,'Admin','Web','Synthetic historical archive')`,
      [randomUUID(),commercialFixture.organizationId,commercialFixture.legalEntityId,commercialFixture.ownerId,profile,identities.manager.id]);
  }
  await verifyRestoredArchive(source,historical082p ? '082p archive recovery' : 'Commercial contract recovery',async (target,expected) => {
    await withCommercialApi({...target, identities}, async ({request}) => {
      if (historical082p) assert.deepEqual((await target.pool.query('select profile from workforce_capability_versions')).rows,[{profile}]);
      const read = await request('/contracts/'+contractId,{identity:identities.reader});
      assert.equal(read.status,200);
      assert.equal(read.body.versions[0].value,input.value);
      assert.equal((await request('/workspace',{identity:identities.denied})).status,403);
      assert.equal((await request('/workspace',{identity:identities.reader,scope:{
        organizationId:commercialFixture.organizationId,legalEntityId:commercialFixture.otherLegalEntityId,
      }})).status,403);
      const created = await request('/contracts', {
        method: 'POST', body: {...input, number: 'SYN-RECOVERED', name: 'After recovery'},
      });
      assert.equal(created.status, 201);
      assert.notEqual(created.body.id, contractId);
      const audit = await target.pool.query('select count(*)::int count from public.audit_logs');
      assert.ok(audit.rows[0].count > expected.audit_logs.count);
    });
  },{historical082p,checkHistoricalMismatch:!historical082p});
});
