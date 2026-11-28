import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {withCommercialDatabase, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {prepareStagedWork, stagedDefinition, adoptStagedPolicy, submitStagedWork, readApprovalOwner} from './support/work-approval-test.mjs';
import {seedDelegationFixture, delegationDefinition, adoptDelegation, revokeDelegation, delegationOk, waitForDelegationStart} from './support/canonical-delegation-test.mjs';

await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  const fixture=await seedDelegationFixture(pool);
  const {identities:ids,today}=fixture;
  await withCommercialApi({databaseUrl,identities:ids,runBackgroundWorkers:true},async ({request})=>{
    await prepareStagedWork(request,ids,today);
    await adoptStagedPolicy(request,ids,today,{
      ...stagedDefinition(ids),stageDueMinutes:1,escalationUserId:ids.requester.id,
    });
    const cases=[
      {worker:ids.first,delegate:ids.delegate},
      {worker:ids.correction,delegate:ids.requester},
      {worker:ids.optional,delegate:ids.delegate,revoked:true},
    ];
    for(const row of cases){
      const definition=delegationDefinition(fixture,{
        workerIds:[row.worker.employeeRecordId],delegateUserId:row.delegate.id,sourceKinds:['Work'],
      });
      row.grant=delegationOk(await adoptDelegation(request,ids.manager,definition),201).delegation;
    }
    await waitForDelegationStart(cases.at(-1).grant.definition);
    for(const row of cases){
      row.instance=(await submitStagedWork(request,row.worker,today)).instance;
      assert.equal(row.instance.delegations[0].delegationId,row.grant.id);
      if(row.revoked)delegationOk(await revokeDelegation(request,ids.manager,row.grant.id),201);
    }
    const deliveries=async id=>(await pool.query(
      'select id,user_id,reasons from work_approval_overdue_inbox where instance_id=$1 order by user_id',[id])).rows;
    const timeout=Date.now()+120_000;
    for(const row of cases){
      let rows=await deliveries(row.instance.id);
      while(!rows.length && Date.now()<timeout){
        await delay(1000);
        rows=await deliveries(row.instance.id);
      }
      const expected={[ids.manager.id]:['current_stage_approver'],[ids.requester.id]:['escalation_target']};
      if(!row.revoked)expected[row.delegate.id]=['current_stage_approver',...(expected[row.delegate.id]??[])];
      assert.equal(rows.length,Object.keys(expected).length);
      assert.deepEqual(Object.fromEntries(rows.map(r=>[r.user_id,r.reasons])),expected);
      if(!row.revoked){
        const receipt=rows.find(r=>r.user_id===row.delegate.id);
        delegationOk(await revokeDelegation(request,ids.manager,row.grant.id),201);
        assert.deepEqual(await deliveries(row.instance.id),rows);
        const ack=delegationOk(await request('/api/v1/work-approvals/inbox/'+receipt.id+'/read',{
          method:'POST',identity:row.delegate,body:{expectedOwnerKey:await readApprovalOwner(request,row.delegate)},
        }));
        assert.equal(ack.notification.id,receipt.id);
        assert(ack.notification.readAt);
      }
    }
  });
});
console.log('Overdue work delivery retained each current delegate, combined overlapping escalation reasons and excluded a revoked grant.');
