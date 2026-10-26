import assert from 'node:assert/strict';
import {commercialFixture as f} from './commercial-drafting-test.mjs';
import {workApprovalWorkers,readApprovalOwner,WORK_APPROVAL_BASE as base} from './work-approval-test.mjs';
import {importedOk as ok,importedRow,importedSnapshot,importedTables,importedInbox} from './import-approval-export-test.mjs';
import {delegationDefinition,adoptDelegation,revokeDelegation,waitForDelegationStart,readDelegationInstance,delegationCommand} from './canonical-delegation-test.mjs';

const retainedTables=[...importedTables,'canonical_delegations','canonical_delegation_bindings','canonical_delegation_decisions','canonical_delegation_revocations'];
const accountTables=['users','user_roles','role_permissions','user_permission_grants','user_organization_scopes','approval_delegations'];

// These controls use the real legacy intake contract on separate workers. They
// cannot affect the selected worker's exact four-hour report denominator/numerator.
const controlImport=async(pool,request,fx,employeeId,externalId)=>{
  const row={...importedRow(fx,false),employeeId,hours:'1',sourceNamespace:'synthetic.delegated-import-controls',externalWorklogId:externalId};
  const result=ok(await request('/api/imports/timesheets/apply',{method:'POST',identity:fx.identities.requester,body:{fileName:'synthetic-delegated-control.csv',rows:[row],totalRows:1,clientErrors:[]}}));
  assert.equal(result.status,'Success');
  const found=(await pool.query('select i.id from work_approval_instances i join timesheets t on t.id=i.timesheet_id where t.employee_id=$1 and t.week_ending=$2',[employeeId,fx.today])).rows;
  assert.equal(found.length,1);
  return readDelegationInstance(request,'Work',found[0].id);
};

export const createDelegatedImportHooks=async({pool,request,fx,ui,readInbox})=>{
  const ids=fx.identities,accounts=await importedSnapshot(pool,accountTables);
  const old=await controlImport(pool,request,fx,workApprovalWorkers.legacyImport,'SYN-OLD-UNBOUND');
  const definition=delegationDefinition(fx,{sourceKinds:['Work']});
  const adopted=ui?await ui.adopt(definition):ok(await adoptDelegation(request,ids.manager,definition),201).delegation;
  await waitForDelegationStart(adopted.definition);
  const oldNow=await readDelegationInstance(request,'Work',old.id);
  assert.equal(oldNow.delegations,undefined,'Earlier imported approval is never adopted retrospectively');
  const oldCommand=await delegationCommand(request,ids.delegate,oldNow);
  const oldSnapshot=await importedSnapshot(pool,retainedTables);
  assert.equal((await request(base+'/instances/'+old.id+'/decisions',{method:'POST',identity:ids.delegate,body:oldCommand})).status,403);
  assert.deepEqual(await importedSnapshot(pool,retainedTables),oldSnapshot);
  // Keep the retained duplicate-key target worker untouched: its existing
  // natural-key/source refusal is a distinct regression, not this pending control.
  const pending=await controlImport(pool,request,fx,workApprovalWorkers.optional,'SYN-PENDING-REVOKE');
  assert.equal(pending.delegations.length,1);assert(pending.delegations[0].eligible);
  const pendingCommand=await delegationCommand(request,ids.delegate,pending);
  const state={adopted,old,pending,accounts,definition,oldSnapshot,revoked:null,first:null};fx.delegatedImportState=state;
  return {
    decisionActors:[ids.delegate,ids.second],
    beforeDecisions:async instance=>{
      assert.equal(instance.delegations.length,1);
      const binding=instance.delegations[0];
      assert.equal(binding.delegatorUserId,ids.manager.id);assert.equal(binding.delegateUserId,ids.delegate.id);assert(binding.eligible);
      for(const identity of [ids.manager,ids.delegate]){
        const note=(await importedInbox(request,identity)).find(n=>n.instanceId===instance.id&&n.eventKey==='approval.action_required');assert(note);
        if(readInbox)await readInbox(identity,note);
        else ok(await request(base+'/inbox/'+note.id+'/read',{method:'POST',identity,body:{expectedOwnerKey:await readApprovalOwner(request,identity)}}));
        assert((await importedInbox(request,identity)).find(n=>n.id===note.id).readAt);
      }
      const before=await importedSnapshot(pool,retainedTables);
      for(const identity of [ids.requester,ids.reader])assert.equal((await request(base+'/instances/'+instance.id+'/decisions',{method:'POST',identity,body:await delegationCommand(request,identity,instance)})).status,403);
      assert.deepEqual(await importedSnapshot(pool,retainedTables),before,'Importer and affected worker cannot borrow delegated approval');
    },
    afterDecision:async(identity,instance,result,index)=>{
      if(index!==0)return;
      assert.equal(result.receipt.actorId,ids.delegate.id);assert.notEqual(result.receipt.actorId,ids.manager.id);
      assert.equal(result.receipt.delegationBindingId,instance.delegations[0].id);state.first=result.receipt;
      const command=await delegationCommand(request,ids.delegate,instance,'Approved',result.receipt.requestId,result.receipt.reason);
      state.revoked=ui?await ui.revoke(adopted):ok(await revokeDelegation(request,ids.manager,adopted.id),201).delegation;
      assert(state.revoked.revokedAt);
      const before=await importedSnapshot(pool,retainedTables);
      // The already accepted operation remains an immutable historical receipt.
      const replay=ok(await request(base+'/instances/'+instance.id+'/decisions',{method:'POST',identity,body:command}));
      assert(replay.replayed);assert.deepEqual(replay.receipt,result.receipt);
      assert.deepEqual(await importedSnapshot(pool,retainedTables),before);
      if(ui)await ui.refused(pending);
      const refused=await request(base+'/instances/'+pending.id+'/decisions',{method:'POST',identity,body:pendingCommand});
      assert.equal(refused.status,403,JSON.stringify(refused.body));
      assert.deepEqual(await importedSnapshot(pool,retainedTables),before,'Revoked pending imported stage cannot gain a new decision or partial source effects');
      const current=await readDelegationInstance(request,'Work',pending.id);assert.equal(current.transitions.length,0);assert.equal(current.state.status,'Pending');assert.equal(current.delegations[0].eligible,false);
      const main=await readDelegationInstance(request,'Work',instance.id);assert.equal(main.transitions.length,1);assert.equal(main.transitions[0].actorId,ids.delegate.id);assert.equal(main.delegations[0].eligible,false);
    }
  };
};

export const finishDelegatedImport=async({pool,request,fx,proof})=>{
  const s=fx.delegatedImportState,ids=fx.identities,current=await readDelegationInstance(request,'Work',proof.instance.id);
  assert.equal(current.state.status,'Approved');assert.deepEqual(current.transitions.map(t=>t.actorId),[ids.delegate.id,ids.second.id]);
  assert.deepEqual(current.transitions[0],s.first);assert.equal(current.delegations[0].eligible,false);assert(current.delegations[0].revokedAt);
  const evidence=(await pool.query('select e.* from work_submission_evidence e where e.id=$1',[current.submissionId])).rows[0];
  assert.equal(evidence.actor_id,ids.requester.id);assert(evidence.entries[0].sourceIdentity.externalId);assert(evidence.entries[0].assignmentSnapshots.some(x=>x.assignmentVersionId));
  assert.deepEqual(await importedSnapshot(pool,accountTables),s.accounts,'No operational role, grant, account or general visibility changes');
  const pending=await readDelegationInstance(request,'Work',s.pending.id);assert.equal(pending.transitions.length,0);
  const old=await readDelegationInstance(request,'Work',s.old.id);assert.equal(old.transitions.length,0);assert.equal(old.delegations,undefined);
  console.log('Delegated imported-work connected receipt:',JSON.stringify({alias:proof.batch.schema_version==='timesheet-import/1'?'v1':'legacy',today:fx.today,instanceId:current.id,delegationId:s.adopted.id,delegator:ids.manager.id,actualActor:ids.delegate.id,importer:ids.requester.id,affectedWorker:ids.reader.id,sourceIdentity:evidence.entries[0].sourceIdentity,batchId:proof.batch.id,priorImportedInstanceUnbound:true,revokedPendingImportedDecisionDenied:true,acceptedDecisionReplayAfterRevocation:true,pendingHours:'0',intermediateHours:'0',approvedHours:'4',availableHours:'8',percent:'50',csvSha256:proof.retained.evidence.artifact.sha256,historyRetainedAfterRevocation:true,permissionAndAccountRowsUnchanged:true}));
};
