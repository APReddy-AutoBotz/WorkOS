import assert from 'node:assert/strict';
import {getAmendmentWorkspace,previewAmendment,appendAmendment} from '../server/modules/commercial-drafting/amendment-service.mjs';
import {transitionLifecycle,createGovernedProject} from '../server/modules/commercial-drafting/lifecycle-service.mjs';
import {resolveAmendedTerms,applyAmendedSnapshot} from '../server/modules/commercial-drafting/amendment-terms.mjs';

// Execute the production domain service without opening a socket. This precise
// SQL protocol fixture complements, never replaces, the mandatory PostgreSQL
// persistence/transaction suite. Unknown queries fail instead of returning data.
const req={organizationScope:{organizationId:'org-synthetic',legalEntityId:'legal-synthetic'},user:{sub:'actor-synthetic',activeRole:'Admin'},
  correlationId:'synthetic-correlation',operationId:'synthetic-operation'};
const today='2026-10-20',future='2026-11-20',privateReason='SYNTHETIC-PROTECTED-AMENDMENT-DOMAIN';
const term=(version=1)=>({id:`version-${version}`,contract_id:'contract-synthetic',version,effective_from:version===1?'2020-01-01':today,
  name:'Synthetic immutable contract terms',model:'fixed_fee',starts_on:'2020-01-01',ends_on:version===1?'2098-12-31':'2099-12-31',currency:'GBP',
  value:version===1?'25000.0001':'30000.0002',billing_terms:'Synthetic protected terms',documents:[{name:'Synthetic evidence',url:'https://example.test/private-amendment'}]});
const life=(type,id)=>({id:`lifecycle-${type}`,sequence:1,state:'Active',effective_on:today,contract_version_id:'version-1',reason:'Synthetic activation',
  approval_reference:null,actor_id:req.user.sub,active_role:'Admin',correlation_id:req.correlationId,operation_id:req.operationId});
const event=(type,id,overrides={})=>({id:`amendment-${type}`,entity_type:type,entity_id:id,sequence:1,effective_on:today,contract_version_id:'version-2',
  starts_on:'2020-01-01',ends_on:'2099-12-31',budget:type==='Contract'?'30000.0002':type==='Engagement'?'8000.0003':'4000.0002',
  reason:privateReason,approval_reference:'SYNTHETIC-APPROVAL',actor_id:req.user.sub,active_role:req.user.activeRole,
  correlation_id:req.correlationId,operation_id:req.operationId,before_value:{synthetic:true},after_value:{synthetic:true},...overrides});
const makeFixture=()=>{
  const contract={id:'contract-synthetic',number:'SYN-DOMAIN',client_id:'client-synthetic',latest_version:2,status:'Draft'};
  const engagement={id:'engagement-synthetic',contract_id:contract.id,contract_version_id:'version-1',origin:'manual',name:'Synthetic engagement',model:'fixed_fee',
    client_id:contract.client_id,attribution_id:null,currency:'GBP',owner_id:'owner-synthetic',starts_on:'2020-01-01',ends_on:'2098-12-31',budget:'10000.0001',billable:true};
  const project={project_id:'project-synthetic',engagement_id:engagement.id,contract_id:contract.id,contract_version_id:'version-1',origin:'manual',name:'Synthetic project',
    model:'fixed_fee',currency:'GBP',manager_id:'owner-synthetic',starts_on:'2020-01-01',ends_on:'2098-12-31',budget_allocation:'4000.0001',billable:true};
  const sibling={...project,project_id:'project-sibling'};
  const roots=new Map([['Contract',contract],['Engagement',engagement],['Project',project]]);
  const lifecycle=new Map([...roots].map(([type,row])=>[type,life(type,row.id||row.project_id)]));
  const history=new Map([['Contract',[]],['Engagement',[]],['Project',[]]]);
  const state={contract,engagement,project,sibling,roots,lifecycle,history,versions:[term(2),term()],children:[engagement],projects:[project],siblings:[sibling],
    ownerActive:true,clientActive:true,blocked:false,calls:[],inserts:[],audits:[]};
  const result=rows=>({rows,rowCount:rows.length});
  state.client={async query(sql,values=[]){
    state.calls.push({sql,values});
    if(sql.includes('pg_advisory_xact_lock'))return result([]);
    if(sql.includes("at time zone 'UTC'")&&sql.includes(' today'))return result([{today}]);
    if(sql.startsWith('select coalesce(sum(greatest'))return result([{allowed:state.capacityAllowed!==false}]);
    if(sql.includes('from commercial_lifecycle_events where'))return result(state.lifecycle.get(values[2])?[state.lifecycle.get(values[2])]:[]);
    if(sql.includes('from commercial_contract_versions'))return result(sql.includes('and id=$4')?state.versions.filter(row=>row.id===values[3]):state.versions);
    if(sql.includes('from commercial_contracts where'))return result(state.roots.has('Contract')?[state.contract]:[]);
    if(sql.includes('from commercial_engagements e'))return result(state.children);
    if(sql.includes('from commercial_engagements where'))return result(sql.includes('id<>$4')?[]:state.roots.has('Engagement')?[state.engagement]:[]);
    if(sql.includes('from commercial_project_bindings where')){
      if(sql.includes('project_id<>'))return result(state.siblings);
      if(sql.includes('project_id=$3'))return result(state.roots.has('Project')?[state.project]:[]);
      return result(state.projects);
    }
    if(sql.includes('from commercial_amendments')){
      if(sql.includes('entity_id=any'))return result([...state.history.values()].flat().filter(row=>values[2].includes(row.entity_id)&&row.effective_on>values[3]));
      const rows=(state.history.get(values[2])||[]).filter(row=>row.entity_id===values[3]);
      return result(sql.includes('effective_on<=coalesce')?rows.filter(row=>row.effective_on<=(values[4]||today)).slice(0,1):sql.includes('effective_on>$5')?rows.filter(row=>row.effective_on>values[4]):sql.includes('effective_on>(now()')?rows.filter(row=>row.effective_on>today):rows);
    }
    if(sql.includes('from commercial_milestones'))return result(state.milestoneBlocked?[{}]:[]);
    if(sql.includes('from employees'))return result(state.ownerActive?[{id:'owner-synthetic'}]:[]);
    if(sql.includes('from clients'))return result(state.clientActive?[{id:'client-synthetic'}]:[]);
    if(sql.includes('from project_allocations'))return result([{blocked:state.blocked}]);
    if(sql.includes('insert into commercial_lifecycle_events')){
      const row={id:values[0],sequence:values[5],state:values[6],contract_version_id:values[8],effective_on:today,reason:values[11],approval_reference:values[12],
        actor_id:values[13],active_role:values[14],correlation_id:values[15],operation_id:values[16]};
      state.lifecycle.set(values[3],row);return result([row]);
    }
    if(sql.includes('insert into commercial_amendments')){
      state.inserts.push({sql,values});const row={id:values[0],organization_id:values[1],legal_entity_id:values[2],entity_type:values[3],entity_id:values[4],
        contract_id:values[5],contract_version_id:values[6],sequence:values[7],lifecycle_sequence:values[8],contract_version:values[9],effective_on:values[10],
        starts_on:values[11],ends_on:values[12],budget:values[13],before_value:JSON.parse(values[14]),after_value:JSON.parse(values[15]),reason:values[16],
        approval_reference:values[17],actor_id:values[18],active_role:values[19],correlation_id:values[20],operation_id:values[21]};
      state.history.get(values[3]).unshift(row);return result([row]);
    }
    assert.fail(`Unexpected amendment domain SQL: ${sql}`);
  }};
  state.audit=async(client,request,value)=>{assert.equal(client,state.client);assert.equal(request,req);state.audits.push(value);};
  return state;
};
const input=(type='Contract',overrides={})=>({expectedSequence:0,expectedLifecycleSequence:1,expectedContractVersion:2,contractVersionId:'version-2',effectiveOn:today,
  startsOn:'2020-01-01',endsOn:'2099-12-31',budget:type==='Contract'?'30000.0002':type==='Engagement'?'8000.0003':'4000.0002',reason:privateReason,
  approvalReference:'SYNTHETIC-APPROVAL',...overrides});
const ids={Contract:'contract-synthetic',Engagement:'engagement-synthetic',Project:'project-synthetic'};
const reject=async(type,mutate,patch,code)=>{
  const state=makeFixture();mutate?.(state);
  await assert.rejects(previewAmendment(state.client,req,type,ids[type]||'missing',input(type,patch)),error=>error.code===code,code);
  assert.equal(state.inserts.length,0);assert.equal(state.audits.length,0);return state;
};
for(const patch of [{expectedSequence:1},{expectedLifecycleSequence:2},{expectedContractVersion:1}])await reject('Contract',null,patch,'COMMERCIAL_AMENDMENT_CONFLICT');
await reject('Contract',null,{effectiveOn:'2026-10-19'},'COMMERCIAL_AMENDMENT_DATE_CONFLICT');
await reject('Contract',state=>state.history.get('Contract').push(event('Contract',ids.Contract,{effective_on:future})),{expectedSequence:1,effectiveOn:'2026-12-01'},'COMMERCIAL_AMENDMENT_DATE_CONFLICT');
for(const contractVersionId of ['missing','version-1'])await reject('Contract',null,{contractVersionId},'COMMERCIAL_AMENDMENT_PIN_CONFLICT');
for(const patch of [{startsOn:'2020-01-02'},{endsOn:'2099-12-30'},{budget:'30000.0001'}])await reject('Contract',null,patch,'COMMERCIAL_TERMS_MISMATCH');
for(const field of ['model','currency'])await reject('Contract',state=>{state.versions[0][field]=field==='model'?'retainer':'USD';},null,'COMMERCIAL_TERMS_MISMATCH');
await reject('Contract',state=>{state.versions[0].effective_from=future;},null,'COMMERCIAL_TERMS_MISMATCH');
await reject('Contract',state=>state.roots.delete('Contract'),null,'COMMERCIAL_NOT_FOUND');
await reject('Contract',state=>state.lifecycle.delete('Contract'),null,'COMMERCIAL_AMENDMENT_NOT_GOVERNED');
await reject('PurchaseOrder',null,null,'COMMERCIAL_NOT_FOUND');
await reject('Engagement',state=>{state.engagement.contract_id=null;},null,'COMMERCIAL_NOT_FOUND');
await reject('Engagement',state=>{state.engagement.origin='legacy-neutral';},null,'COMMERCIAL_NOT_FOUND');
await reject('Engagement',state=>{state.engagement.client_id='different-client';},null,'COMMERCIAL_TERMS_MISMATCH');
for(const type of ['Engagement','Project']){
  await reject(type,null,{startsOn:'2020-01-02'},'COMMERCIAL_AMENDMENT_HISTORY_CONFLICT');
  await reject(type,null,null,'COMMERCIAL_AMENDMENT_PARENT_TERMS');
  await reject(type,state=>{state.lifecycle.get(type==='Engagement'?'Contract':'Engagement').state='On Hold';},null,'COMMERCIAL_PARENT_NOT_ACTIVE');
}
const adoptedContract=state=>state.history.get('Contract').push(event('Contract',ids.Contract));
const adoptedParent=state=>{adoptedContract(state);state.history.get('Engagement').push(event('Engagement',ids.Engagement));};
await reject('Engagement',state=>{adoptedContract(state);state.ownerActive=false;},null,'COMMERCIAL_OWNER_UNAVAILABLE');
await reject('Contract',state=>{state.clientActive=false;},null,'COMMERCIAL_REFERENCE_NOT_FOUND');
await reject('Contract',state=>{state.children[0].ends_on='2100-01-01';},null,'COMMERCIAL_AMENDMENT_DEPENDENCIES');
await reject('Engagement',adoptedContract,{budget:'4000.0000'},'COMMERCIAL_AMENDMENT_BUDGET_EXCEEDED');
await reject('Project',adoptedParent,{budget:'4000.0003'},'COMMERCIAL_AMENDMENT_BUDGET_EXCEEDED');
await reject('Contract',state=>{state.blocked=true;},null,'COMMERCIAL_AMENDMENT_DEPENDENCIES');
await reject('Contract',state=>{state.milestoneBlocked=true;},null,'COMMERCIAL_AMENDMENT_DEPENDENCIES');
await reject('Contract',state=>state.history.get('Engagement').push(event('Engagement',ids.Engagement,{effective_on:future})),null,'COMMERCIAL_AMENDMENT_DEPENDENCIES');
await reject('Project',state=>{adoptedParent(state);state.history.get('Project').push(event('Project','project-sibling',{effective_on:future,budget:'4000.0003'}));},null,'COMMERCIAL_AMENDMENT_BUDGET_EXCEEDED');
await reject('Project',state=>{adoptedParent(state);state.history.get('Engagement').unshift(event('Engagement',ids.Engagement,{id:'later-parent-reduction',sequence:2,effective_on:future,budget:'4000.0002'}));},null,'COMMERCIAL_AMENDMENT_PARENT_TERMS');
await reject('Contract',state=>{state.projects=Array.from({length:201},()=>state.project);},null,'COMMERCIAL_AMENDMENT_LIMIT');
await reject('Project',state=>{adoptedParent(state);state.siblings=Array.from({length:201},()=>state.sibling);},null,'COMMERCIAL_AMENDMENT_LIMIT');

const state=makeFixture();const body=input();
const preview=await previewAmendment(state.client,req,'Contract',ids.Contract,body);
assert.match(preview.previewToken,/^[a-f0-9]{64}$/);assert.equal(preview.asOf,today);assert.equal(preview.dependencies.projects,1);
assert.equal(preview.before.contractVersionId,'version-1');assert.equal(preview.after.contractVersionId,'version-2');assert.equal(state.inserts.length,0);
assert.match(state.calls[0].sql,/pg_advisory_xact_lock/);assert.deepEqual(state.calls[0].values,['commercial-lifecycle:org-synthetic:legal-synthetic']);
for(const patch of [{reason:'Synthetic changed material'},{approvalReference:'Synthetic changed approval'}])
  await assert.rejects(appendAmendment(state.client,req,'Contract',ids.Contract,{...body,...patch,previewToken:preview.previewToken},state.audit),error=>error.code==='COMMERCIAL_AMENDMENT_PREVIEW_CONFLICT');
state.children[0].budget='10000.0002';
await assert.rejects(appendAmendment(state.client,req,'Contract',ids.Contract,{...body,previewToken:preview.previewToken},state.audit),error=>error.code==='COMMERCIAL_AMENDMENT_PREVIEW_CONFLICT','dependency changes invalidate the exact preview');
state.children[0].budget='10000.0001';
const actorPreview=await previewAmendment(state.client,{...req,user:{...req.user,sub:'other-actor'}},'Contract',ids.Contract,body);assert.notEqual(actorPreview.previewToken,preview.previewToken);
const rolePreview=await previewAmendment(state.client,{...req,user:{...req.user,activeRole:'Manager'}},'Contract',ids.Contract,body);assert.notEqual(rolePreview.previewToken,preview.previewToken);
const applied=await appendAmendment(state.client,req,'Contract',ids.Contract,{...body,previewToken:preview.previewToken},state.audit);
assert.equal(applied.sequence,1);assert.equal(applied.actorId,req.user.sub);assert.equal(applied.activeRole,req.user.activeRole);assert.equal(state.inserts.length,1);assert.equal(state.audits.length,1);
assert.deepEqual(state.audits[0].oldValue,{commercialEventId:applied.id,snapshot:'before'});assert.deepEqual(state.audits[0].newValue,{commercialEventId:applied.id,snapshot:'after'});
assert.doesNotMatch(JSON.stringify(state.audits),/SYNTHETIC-PROTECTED|30000\.0002|private-amendment|Synthetic immutable contract terms/);
const workspace=await getAmendmentWorkspace(state.client,req,'Contract',ids.Contract);assert.equal(workspace.currentTerms.contractVersionId,'version-2');assert.equal(workspace.activationTerms.contractVersionId,'version-1');
assert.equal(workspace.lifecycle.contractVersionId,'version-1');assert.equal(workspace.sequence,1);assert.equal(workspace.pending,false);
assert.equal((await getAmendmentWorkspace(state.client,req,'Engagement',ids.Engagement)).currentTerms.contractVersionId,'version-1','contract adoption is not a child cascade');

const child=makeFixture();adoptedParent(child);child.lifecycle.get('Project').state='On Hold';
const childPreview=await previewAmendment(child.client,req,'Project',ids.Project,input('Project'));
const childApplied=await appendAmendment(child.client,req,'Project',ids.Project,{...input('Project'),previewToken:childPreview.previewToken},child.audit);
assert.equal(childApplied.budget,'4000.0002');assert.equal(child.lifecycle.get('Project').state,'On Hold','adopting terms cannot resume a held project');
const baseline={contractVersionId:'version-1',startsOn:'2020-01-01',endsOn:'2098-12-31',budget:'25000.0001'};
const pendingState=makeFixture();pendingState.history.get('Contract').push(event('Contract',ids.Contract,{effective_on:future}));
assert.deepEqual(await resolveAmendedTerms(pendingState.client,req,'Contract',ids.Contract,baseline,today),baseline);
assert.equal((await resolveAmendedTerms(pendingState.client,req,'Contract',ids.Contract,baseline,future)).contractVersionId,'version-2');
const pendingWorkspace=await getAmendmentWorkspace(pendingState.client,req,'Contract',ids.Contract);assert.equal(pendingWorkspace.pending,true);assert.deepEqual(pendingWorkspace.currentTerms,baseline);
const snapshot=await applyAmendedSnapshot(child.client,req,'Project',ids.Project,child.project,today);assert.equal(snapshot.budget_allocation,'4000.0002');assert.equal(child.project.budget_allocation,'4000.0001','resolution does not mutate its immutable input');

// An immutable retained activation pin remains valid for existing state-only
// resume. It must not be confused with permission to create a new dependency.
for(const type of ['Engagement','Project']){
 const retained=makeFixture();adoptedContract(retained);if(type==='Project')retained.history.get('Engagement').push(event('Engagement',ids.Engagement));
 retained.lifecycle.get(type).state='On Hold';retained.lifecycle.get(type).sequence=2;
 const resumed=await transitionLifecycle(retained.client,req,type,ids[type],{expectedSequence:2,state:'Active',contractVersionId:'version-1',reason:'Synthetic retained-pin resume',approvalReference:null},retained.audit);
 assert.equal(resumed.sequence,3);assert.equal(resumed.contractVersionId,'version-1');assert.equal(resumed.state,'Active');
}
const frozen=makeFixture();adoptedParent(frozen);frozen.history.get('Contract').unshift(event('Contract',ids.Contract,{id:'pending-parent',sequence:2,effective_on:future}));
await assert.rejects(createGovernedProject(frozen.client,req,{engagementId:ids.Engagement},frozen.audit),error=>error.code==='COMMERCIAL_AMENDMENT_PENDING');
const capacity=makeFixture();adoptedParent(capacity);capacity.capacityAllowed=false;
capacity.history.get('Project').push(event('Project','project-sibling',{effective_on:future,budget:'4000.0003'}));
await assert.rejects(createGovernedProject(capacity.client,req,{engagementId:ids.Engagement,startsOn:'2020-01-01',endsOn:'2099-12-31',billable:true,managerId:'owner-synthetic',budgetAllocation:'0.0001'},capacity.audit),error=>error.code==='COMMERCIAL_PROJECT_BUDGET_EXCEEDED');
const capacityQuery=capacity.calls.find(call=>call.sql.startsWith('select coalesce(sum(greatest'));
assert(capacityQuery);assert.match(capacityQuery.sql,/max\(a\.budget\)/,'new child allocation reserves pending sibling maxima');
assert.deepEqual(capacityQuery.values,['org-synthetic','legal-synthetic',ids.Engagement,'0.0001','8000.0003']);

console.log('Commercial amendment production domain validation, exact decimal boundaries, separate parent adoption, immutable starts, date/pending/identity/dependency guards, bound stale previews, opaque audit and historical term resolution passed without sockets.');

const internalBaseline={contractVersionId:null,startsOn:'2020-01-01',endsOn:'2099-12-31',budget:'0.0000'};
assert.equal(await resolveAmendedTerms({query:async()=>assert.fail('Non-contract terms must never enter amendment lookup')},req,'Engagement','synthetic-internal',internalBaseline),internalBaseline);
