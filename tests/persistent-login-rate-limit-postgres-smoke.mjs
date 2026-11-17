import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';

await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  const login=api=>api.request('/api/auth/login',{authenticated:false,method:'POST',body:{username:'synthetic-throttle-probe',password:randomUUID()}});
  await withCommercialApi({databaseUrl,identities:{}},async first=>{
    for(let i=0;i<8;i++) assert.equal((await login(first)).status,401);
    assert.equal((await login(first)).status,429,'First API enforces the default account budget');
    await withCommercialApi({databaseUrl,identities:{}},async second=>{
      assert.equal((await login(second)).status,429,'A second actual API process must share exhausted budget');
      const callback = api => fetch(`${api.baseUrl}/api/auth/entra/callback`,{redirect:'manual'});
      for (let i=0;i<8;i++) assert.equal((await callback(first)).status,302);
      assert.equal((await callback(second)).status,429,'Callback budget is independent of local input and shared across replicas');
    });
  });
  await withCommercialApi({databaseUrl,identities:{}},async restarted=>{
    assert.equal((await login(restarted)).status,429,'Restarting the actual API must preserve active budget');
    await pool.query("update authentication_rate_buckets set reset_at=clock_timestamp()-interval '1 second'");
    const results = await Promise.all(Array.from({length:12}, () => login(restarted)));
    assert.equal(results.filter(r => r.status === 401).length,8);
    assert.equal(results.filter(r => r.status === 429 && Number(r.response.headers.get('retry-after')) > 0).length,4);
    const stored = await pool.query('select bucket_key,attempts from authentication_rate_buckets order by attempts');
    assert.deepEqual(stored.rows.map(row => Number(row.attempts)),[8,12]);
    for (const row of stored.rows) assert.match(row.bucket_key,/^[a-f0-9]{64}$/);
    await pool.query('alter table authentication_rate_buckets rename to unavailable_fixture');
    const outage = await login(restarted);
    assert.equal(outage.status,503);
    assert.equal(outage.response.headers.has('set-cookie'),false);
    assert.doesNotMatch(JSON.stringify(outage.body),/relation|postgres|authentication_rate_buckets/i);
    await pool.query('alter table unavailable_fixture rename to authentication_rate_buckets');
    assert.equal((await login(restarted)).status,429,'Restoring storage preserves the budget');
  });
});
console.log('Actual API replica and restart throttle enforcement passed.');
