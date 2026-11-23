import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commercialFixture} from './commercial-drafting-test.mjs';

export async function withLockedFeeDate({pool,request,post,date,check,whileCreating}) {
  const id=randomUUID(),{organizationId,legalEntityId}=commercialFixture;
  const insert=client=>client.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values($1,$2,$3,$1,'Synthetic finance close',$4,$4,'Financially Locked','Monthly')`,[id,organizationId,legalEntityId,date]);
  if (whileCreating) {
    const writer=await pool.connect();
    let pending;
    try {
      await writer.query('begin');
      await writer.query('select pg_advisory_xact_lock(hashtext($1))',['reporting-period:'+organizationId+':'+legalEntityId+':Monthly']);
      await insert(writer);
      pending=whileCreating();
      const deadline=Date.now()+10000;
      for (;;) {
        const {rows:[{waiting}]}=await writer.query('select exists(select from pg_locks where not granted and pg_backend_pid()=any(pg_blocking_pids(pid))) waiting');
        if (waiting) break;
        assert(Date.now()<deadline,'valuation writer should wait for calendar creation');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      await writer.query('commit');
      assertFeePeriodConflict(await pending);
    } finally {await writer.query('rollback');writer.release();await pending;}
  } else await insert(pool);
  await check();
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) select 'Admin',k,true from unnest($1::text[]) k on conflict(role_name,permission_key) do update set enabled=true",
    [['settings.manage','periods.financial_reopen']]);
  const path='/api/v1/organization-setup/financial-periods';
  const observed=await request(path+'?date='+date);
  assert.equal(observed.status,200);
  await post(path+'/'+id+'/transitions',{expectedOwnerKey:observed.body.ownerKey,
    expectedRevision:observed.body.periods.find(p=>p.id===id).revision,action:'reopen',reason:'Synthetic verified period reopening'},200);
}

export function assertFeePeriodConflict(response) {
  assert.equal(response.status,409,JSON.stringify(response.body));
  assert.equal(response.body.error.code,'FIXED_FEE_PERIOD_UNAVAILABLE');
}
