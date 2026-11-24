import assert from 'node:assert/strict';
import {commercialFixture} from './commercial-drafting-test.mjs';

export async function verifyRiskNoticePolicy({pool,request,identities,engagement,today,model='fixed_fee'}) {
  const path='/engagements/'+engagement.id+(model==='fixed_fee'?'/fixed-fee-risk-notice-policy':'/service-margin-risk-notice-policy');
  const grant=model==='fixed_fee'?'commercial.fixed_fee_risk.configure':'commercial.service_margin_risk.configure';
  const named={userId:identities.reader.id,role:'Employee'};
  const command={expectedVersion:0,effectiveFrom:today,manager:named,finance:named,locale:'en',
    title:'Review the engagement warning',body:'A budget threshold needs review.',reason:'Synthetic buyer routing decision'};
  const post=body=>request(path,{method:'POST',body});
  assert.equal((await request(path)).status,403);
  assert.equal((await post(command)).status,403);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true)",[grant]);
  assert.deepEqual((await request(path)).body,{engagementId:engagement.id,latest:null});
  assert.equal((await post({...command,recipients:[named]})).status,400);
  assert.equal((await post({...command,finance:{...named,role:'Admin'}})).status,409);
  const [first,retry]=await Promise.all([post(command),post(command)]);
  assert.equal(first.status,201,JSON.stringify(first.body));
  assert.equal(retry.status,201,JSON.stringify(retry.body));
  const policy=first.body.latest;
  assert.equal(policy.id,retry.body.latest.id);
  assert.equal(policy.version,1);
  assert.equal((await post({...command,body:'A different instruction.'})).status,409);
  assert.equal((await request(path,{identity:identities.reader})).status,403);
  const recipients=async()=> (await pool.query(
    'select * from engagement_risk_recipients($6,$1,$2,$3,$4,$5,$4,$5) order by reason',
    [commercialFixture.organizationId,commercialFixture.legalEntityId,engagement.id,named.userId,named.role,model])).rows;
  assert.deepEqual(await recipients(),['commercial_manager','engagement_owner','finance_billing_owner'].map(reason=>({user_id:named.userId,reason})));
  await pool.query('update user_organization_scopes set active=false where user_id=$1 and legal_entity_id=$2',[named.userId,commercialFixture.legalEntityId]);
  assert.deepEqual(await recipients(),[]);
  assert.equal((await post({...command,expectedVersion:1})).status,409);
  await pool.query('update user_organization_scopes set active=true where user_id=$1 and legal_entity_id=$2',[named.userId,commercialFixture.legalEntityId]);
  await assert.rejects(pool.query('update fixed_fee_risk_notice_policies set title=$1 where id=$2',['Replaced',policy.id]));
  assert.equal((await request(path)).body.latest.id,policy.id);
}
