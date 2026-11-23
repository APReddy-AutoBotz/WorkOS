import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {commercialFixture} from './commercial-drafting-test.mjs';

export async function verifyFeeStatement({pool,request,post,today,engagement,identities,exposure,profile,snapshotId,amount}) {
  const path='/engagements/'+engagement.id+'/fixed-fee-statement';
  const get=async(version)=>{const r=await request(path+'?through='+today+'&frequency=Weekly'+(version?'&version='+version:''));assert.equal(r.status,200);return r.body;};
  const selection={through:today,frequency:'Weekly'};
  const reason='Verified retained balances for the synthetic reporting period';
  assert.equal((await get()).status,'period_open');
  assert.equal((await request(path+'?through='+today+'&frequency=Weekly',{identity:identities.reader})).status,403);
  await pool.query("update reporting_periods set status='Financially Locked' where id='synthetic-category-current'");
  const view=await get();
  assert.equal(view.status,'ready',JSON.stringify(view));
  assert.deepEqual([view.report.opening.amount,view.report.opening.profile,view.report.closing.amount,view.report.closing.profile,
    view.report.closing.sources,view.report.movement],['0','before_service',amount,profile,[snapshotId],amount]);
  const cmd={...selection,expectedToken:view.token,reason};
  assert.equal((await request(path,{method:'POST',body:cmd})).status,403);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.fixed_fee_statement.sign',true)");
  assert.equal((await request(path,{method:'POST',body:{...cmd,movement:'100'}})).status,400);
  assert.equal((await request(path,{method:'POST',body:{...cmd,expectedToken:createHash('sha256').update(today).digest('hex')}})).status,409);
  await pool.query(`create function reject_test_statement_audit() returns trigger language plpgsql as $$begin raise exception 'Synthetic statement audit failure';end $$;
    create trigger reject_test_statement before insert on audit_logs for each row when(new.entity_type='Fixed Fee Period Statement') execute function reject_test_statement_audit()`);
  assert.equal((await request(path,{method:'POST',body:cmd})).status,503);
  assert.equal((await get()).saved,null);
  await pool.query('drop trigger reject_test_statement on audit_logs');
  if (exposure) {
    const desk=exposure.getByRole('region',{name:'Fixed-fee period statement'});
    await desk.getByRole('button',{name:'Inspect period statement'}).click();
    await desk.getByText('GBP · Opening 0 · Closing '+amount+' · Period movement '+amount).waitFor();
    await desk.getByLabel('Statement sign-off reason').fill(reason);
    const signing=desk.page().waitForResponse(r=>r.url().endsWith('/fixed-fee-statement') && r.request().method()==='POST');
    await desk.getByRole('button',{name:'Sign period statement'}).click();
    const response=await signing;
    assert.equal(response.status(),201,await response.text());
    await desk.getByText('Signed version 1 · GBP '+amount+' · '+reason).waitFor();
  }
  const [one,two]=await Promise.all([post(path,cmd),post(path,cmd)]);
  assert.deepEqual(one.saved,two.saved);
  assert.equal(one.saved.version,1);
  assert.equal((await request(path,{method:'POST',body:{...cmd,reason:'Another sign-off'}})).status,409);
  assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_type='Fixed Fee Period Statement'")).rows[0].n,1);
  await assert.rejects(pool.query("update commercial_fixed_fee_statements set reason='Changed' where id=$1",[one.saved.id]));
  const {organizationId,legalEntityId}=commercialFixture;
  const periodPath='/api/v1/organization-setup/financial-periods';
  async function reopen() {
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) select 'Admin',k,true from unnest($1::text[]) k on conflict(role_name,permission_key) do update set enabled=true",
      [['settings.manage','periods.financial_reopen']]);
    const observed=(await request(periodPath+'?date='+today)).body;
    await post(periodPath+'/synthetic-category-current/transitions',{expectedOwnerKey:observed.ownerKey,
      expectedRevision:observed.periods.find(p=>p.id==='synthetic-category-current').revision,action:'reopen',reason:'Synthetic statement review'},200);
  }
  await reopen();
  const reopened=await get();
  assert.deepEqual([reopened.status,reopened.saved.id],['period_open',one.saved.id]);
  await pool.query("update reporting_periods set status='Financially Locked' where organization_id=$1 and legal_entity_id=$2 and id='synthetic-category-current'",[organizationId,legalEntityId]);
  const next=await get();
  assert.notEqual(next.token,view.token);
  const signed=await post(path,{...cmd,expectedToken:next.token,reason:'Reverified balances after formal reopening'});
  assert.equal(signed.saved.version,2);
  assert.deepEqual((await get(1)).saved,one.saved);
  await reopen();
}
