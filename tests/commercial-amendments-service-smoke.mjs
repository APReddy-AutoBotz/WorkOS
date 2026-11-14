import assert from 'node:assert/strict';
import {syntheticHexDigest} from './support/synthetic-values.mjs';

// Pure transport/context tests: no listener, browser, database or local fallback.
process.env.APP_MODE=process.env.VITE_APP_MODE='production';
process.env.ALLOW_TEST_FALLBACK=process.env.VITE_ALLOW_TEST_FALLBACK='false';
const storage=new Map(),localAccesses=[],events=[];
globalThis.sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
const forbidden=(...args)=>{localAccesses.push(args);throw new Error('Amendments cannot use browser-local records.');};
globalThis.localStorage={getItem:forbidden,setItem:forbidden,removeItem:forbidden,clear:forbidden};
globalThis.window={localStorage,location:{pathname:'/commercial-drafting',href:'/commercial-drafting'},dispatchEvent:event=>{events.push(event.type);return true;}};
const {commercialAmendmentService:service,captureCommercialAmendmentContext:capture,isCommercialAmendmentContextCurrent:current,
  normalizeAmendmentEvent,normalizeCommercialAmendmentWorkspace:normalizeWorkspace,normalizeCommercialAmendmentPreview:normalizePreview}=await import('../src/services/commercialAmendments.ts');
const {ApiClientError}=await import('../src/services/apiClient.ts');
const {getDefaultPermissionsForRole}=await import('../src/services/permissions.ts');
const scope={organizationId:'synthetic-amendment-org',legalEntityId:'synthetic-amendment-legal'};
const otherScope={organizationId:'synthetic-other-org',legalEntityId:'synthetic-other-legal'};
const sessionToken='example-amendment-session-a';
const permissions=['commercial.contracts.view','commercial.lifecycle.manage','commercial.amendments.manage'];
const user={id:'synthetic-amendment-operator',employeeId:'SYN-AMENDMENT',role:'ProjectManager',permissionRole:'ProjectManager',permissions};
const lifecycle={id:'synthetic-lifecycle',sequence:1,state:'Active',effectiveOn:'2026-01-01',contractVersionId:'synthetic-terms-1',
  reason:'Synthetic activation',approvalReference:'SYN-ACTIVATE',actorId:user.id,activeRole:user.role,correlationId:'synthetic-correlation',operationId:'synthetic-operation'};
const version1={id:'synthetic-terms-1',version:1,name:'Synthetic immutable first terms',model:'fixed_fee',currency:'GBP',value:'100.0000',
  startsOn:'2026-01-01',endsOn:'2027-12-31',effectiveFrom:'2026-01-01',billingTerms:'Synthetic billing terms',documents:[]};
const version2={...version1,id:'synthetic-terms-2',version:2,name:'Synthetic immutable amended terms',value:'200.0000',endsOn:'2028-12-31',effectiveFrom:'2026-10-20'};
const version3={...version2,id:'synthetic-terms-3',version:3,value:'300.0000',effectiveFrom:'2026-10-22'};
const before={contractVersionId:version1.id,startsOn:version1.startsOn,endsOn:version1.endsOn,budget:version1.value};
const after={contractVersionId:version2.id,startsOn:version2.startsOn,endsOn:version2.endsOn,budget:version2.value};
const entityId='synthetic/contract ?';
const workspace={asOf:'2026-10-20',entityType:'Contract',entityId,lifecycle,sequence:0,currentTerms:before,activationTerms:before,
  identity:{name:'SYN-AMENDMENT',model:'fixed_fee',currency:'GBP',clientId:'synthetic-client'},latestContractVersion:2,versions:[version2,version1],history:[],pending:false};
const input={expectedSequence:0,expectedLifecycleSequence:1,expectedContractVersion:2,...after,effectiveOn:'2026-10-20',reason:'Synthetic governed amendment',approvalReference:'SYN-APPROVAL'};
const preview={previewToken:syntheticHexDigest(),asOf:workspace.asOf,entityType:'Contract',entityId,before,after,effectiveOn:input.effectiveOn,
  dependencies:{projects:2},warnings:['No automatic cascade or billing change.']};
const event={id:'synthetic-amendment-1',sequence:1,...after,effectiveOn:input.effectiveOn,reason:input.reason,approvalReference:input.approvalReference,
  actorId:user.id,activeRole:user.role,correlationId:'synthetic-amendment-correlation',operationId:'synthetic-amendment-operation'};
const extra={organizationId:'forged',legalEntityId:'forged',actorId:'forged',activeRole:'Admin',model:'retainer',currency:'USD',status:'Active',unexpected:true};
const prefix='/api/v1/commercial-drafting/amendments';
const path=`${prefix}/Contract/${encodeURIComponent(entityId)}`;
const operations=[
  {name:'workspace',method:'GET',path,result:workspace,run:context=>service.getWorkspace('Contract',entityId,context)},
  {name:'preview',method:'POST',path:`${path}/preview`,body:input,result:preview,run:context=>service.preview('Contract',entityId,{...input,...extra},context)},
  {name:'apply',method:'POST',path,body:{...input,previewToken:preview.previewToken},result:event,
    run:context=>service.apply('Contract',entityId,{...input,...extra,previewToken:preview.previewToken},context)},
];
let payload,status,networkError,malformedJson,gate;
const calls=[];
const errorPayload={error:{code:'SYNTHETIC_AMENDMENT_FAILURE',message:'Synthetic protected failure',correlationId:'synthetic-error-correlation',operationId:'synthetic-error-operation'}};
const setUser=value=>storage.set('workos_session',JSON.stringify(value));
const setScope=value=>storage.set('workos_organization_scope',JSON.stringify(value));
const snapshot=()=>({storage:[...storage],href:window.location.href,events:[...events]});
const reset=()=>{storage.clear();setUser(structuredClone(user));setScope(scope);storage.set('workos_api_token',sessionToken);calls.length=events.length=0;
  window.location.href=window.location.pathname;payload=undefined;status=200;networkError=null;malformedJson=false;gate=null;};
const deferred=()=>{let resolve;const promise=new Promise(release=>{resolve=release;});return {promise,resolve};};
const denied=error=>error instanceof ApiClientError&&error.status===403;
const invalid=error=>error instanceof ApiClientError&&error.status===502;
globalThis.fetch=async(url,init={})=>{
  calls.push({url,init:{...init,headers:{...init.headers}}});assert(url.startsWith(prefix),'only the direct amendment endpoint, never health/demo/legacy');
  const captured={payload,status,networkError,malformedJson};if(gate)await gate.promise;if(captured.networkError)throw captured.networkError;
  return new Response(captured.malformedJson?'{malformed':JSON.stringify(captured.status<300?captured.payload:errorPayload),
    {status:captured.status,headers:{'Content-Type':'application/json'}});
};
const assertRequest=operation=>assert.deepEqual(calls.map(call=>({...call,init:{...call.init,...(call.init.body?{body:JSON.parse(call.init.body)}:{})}})),[{url:operation.path,init:{method:operation.method,credentials:'include',headers:{'Content-Type':'application/json',
  Authorization:`Bearer ${sessionToken}`,'X-Organization-Id':scope.organizationId,'X-Legal-Entity-Id':scope.legalEntityId},
  ...(operation.body?{body:operation.body}:{})}}],`${operation.name}: one exact owned request with strict command allowlist`);

for(const operation of operations){
  for(const success of operation.method==='POST'?[200,201]:[200]){
    reset();payload={...operation.result,ignoredServerField:'stripped'};status=success;const unchanged=snapshot();
    assert.deepEqual(await operation.run(capture()),operation.result);assertRequest(operation);assert.deepEqual(snapshot(),unchanged);
  }
  for(const failureStatus of [400,401,403,404,409,422,500,502,503,504]){
    reset();status=failureStatus;const unchanged=snapshot();
    await assert.rejects(operation.run(capture()),error=>{assert(error instanceof ApiClientError);assert.equal(error.status,failureStatus);
      for(const key of ['code','message','correlationId','operationId'])assert.equal(error[key],errorPayload.error[key]);return true;});
    assertRequest(operation);assert.deepEqual(snapshot(),unchanged,'a failure cannot clear scope/session, redirect, retry or fall back');
  }
  for(const bad of [null,[],{}, {unexpected:true}]){reset();payload=bad;await assert.rejects(operation.run(capture()),invalid);assertRequest(operation);}
  reset();malformedJson=true;await assert.rejects(operation.run(capture()),invalid);assertRequest(operation);
  reset();networkError=new TypeError('Synthetic transport unavailable');const original=networkError;
  await assert.rejects(operation.run(capture()),error=>error===original);assertRequest(operation);
  for(const invalidate of [()=>setUser(null),()=>storage.delete('workos_session'),()=>storage.set('workos_session','{malformed'),()=>setScope(null),
    ()=>setScope({}),()=>setScope({organizationId:scope.organizationId}),()=>setScope({organizationId:' ',legalEntityId:scope.legalEntityId}),
    ()=>storage.set('workos_organization_scope','{malformed'),()=>setUser({...user,permissions:[]}),()=>setUser({...user,permissions:['commercial.amendments.manage']})]){
    reset();invalidate();assert.equal(capture(),null);await assert.rejects(operation.run(null),denied);assert.equal(calls.length,0);
  }
  reset();await assert.rejects(operation.run(capture(()=>false)),denied);assert.equal(calls.length,0,'expired UI lease cannot dispatch');
  for(const permissionSet of [['commercial.contracts.view'],['commercial.contracts.view','commercial.contracts.manage'],
    ['commercial.contracts.view','commercial.lifecycle.manage'],['commercial.contracts.view','commercial.amendments.manage']]){
    reset();setUser({...user,permissions:permissionSet});payload=operation.result;const reader=capture();assert(reader);assert.equal(reader.canManage,false);
    if(operation.method==='POST'){
      await assert.rejects(operation.run(reader),denied);assert.equal(calls.length,0);
      await assert.rejects(operation.run({...reader,canManage:true}),denied);assert.equal(calls.length,0,'forged canManage cannot replace both current grants');
    }
    else{assert.deepEqual(await operation.run(reader),operation.result);assertRequest(operation);}
  }
}
const changes=[
  ['actor',()=>setUser({...user,id:'synthetic-other'})],['employee',()=>setUser({...user,employeeId:'SYN-OTHER'})],['active role',()=>setUser({...user,role:'Admin'})],
  ['permission role',()=>setUser({...user,permissionRole:'HR'})],['amendment permission revoked',()=>setUser({...user,permissions:permissions.filter(key=>key!=='commercial.amendments.manage')})],
  ['lifecycle permission revoked',()=>setUser({...user,permissions:permissions.filter(key=>key!=='commercial.lifecycle.manage')})],
  ['view permission revoked',()=>setUser({...user,permissions:permissions.filter(key=>key!=='commercial.contracts.view')})],
  ['permission set changed',()=>setUser({...user,permissions:[...permissions,'projects.view']})],['session token',()=>storage.set('workos_api_token','example-amendment-session-b')],
  ['token removed',()=>storage.delete('workos_api_token')],['organization',()=>setScope({...scope,organizationId:otherScope.organizationId})],
  ['legal entity',()=>setScope({...scope,legalEntityId:otherScope.legalEntityId})],['scope removed',()=>setScope(null)],['identity removed',()=>setUser(null)],
];
for(const operation of operations)for(const [reason,change] of changes){
  reset();const context=capture();change();assert.equal(current(context),false,reason);await assert.rejects(operation.run(context),denied);assert.equal(calls.length,0);
  for(const responseStatus of [200,201,401,409]){
    reset();payload=operation.result;status=responseStatus;gate=deferred();let owned=true;const context=capture(()=>owned);
    const completion=assert.rejects(operation.run(context),responseStatus<300?denied:error=>error instanceof ApiClientError&&error.status===responseStatus);
    assertRequest(operation);change();owned=false;const replacement=snapshot();gate.resolve();await completion;assertRequest(operation);
    assert.deepEqual(snapshot(),replacement,`${operation.name}: late ${responseStatus} preserves replacement ${reason}`);
  }
}
for(const operation of operations){reset();payload=operation.result;gate=deferred();let mounted=true;
  const completion=assert.rejects(operation.run(capture(()=>mounted)),denied);mounted=false;gate.resolve();await completion;assertRequest(operation);}
reset();const equivalent=capture();setUser({...user,name:'Synthetic updated display',permissions:[...permissions].reverse()});setScope({...scope,organizationName:'Synthetic display'});assert.equal(current(equivalent),true);
for(const role of ['Admin','HR','CountryDirector','ProjectManager','TeamLead','Employee'])assert(!getDefaultPermissionsForRole(role).includes('commercial.amendments.manage'));

for(const operation of operations.slice(0,2))for(const delta of [{entityType:'Project'},{entityId:'synthetic-foreign'}]){
  reset();payload={...operation.result,...delta};await assert.rejects(operation.run(capture()),invalid);assertRequest(operation);
}
for(const delta of [{effectiveOn:'2026-10-21'},{after:{...after,budget:'199.0000'}},{after:{...after,contractVersionId:'synthetic-foreign'}},
  {previewToken:''},{previewToken:syntheticHexDigest().slice(1)},{previewToken:syntheticHexDigest().replace(/^./,'A').toUpperCase()},{previewToken:42}]){
  reset();payload={...preview,...delta};await assert.rejects(operations[1].run(capture()),invalid);assertRequest(operations[1]);
}
for(const delta of [{sequence:2},{effectiveOn:'2026-10-21'},{contractVersionId:version1.id},{budget:'199.0000'},
  {startsOn:'2026-01-02'},{endsOn:'2028-12-30'},{reason:'Different reason'},{approvalReference:'Different approval'}]){
  reset();payload={...event,...delta};await assert.rejects(operations[2].run(capture()),invalid);assertRequest(operations[2]);
}
reset();payload={...event,budget:'200'};assert.equal((await operations[2].run(capture())).budget,'200','decimal equivalence never uses Number');
for(const [key,values] of Object.entries({id:['',null,1],sequence:[0,201,1.5,'1'],effectiveOn:['2026-02-30','2026-10-20T00:00:00Z'],
  contractVersionId:['',null],startsOn:['2026-02-30'],endsOn:['1900-01-01'],budget:[1,'1e2','01','-1','0.00001','100000000000000'],
  reason:['','ab',null],approvalReference:['',null,'a'.repeat(201)],actorId:['',null],activeRole:['',null],correlationId:['',null],operationId:['',null]}))
  for(const value of values)assert.throws(()=>normalizeAmendmentEvent({...event,[key]:value}),invalid,`malformed event ${key}`);
const effectiveWorkspace={...workspace,sequence:1,currentTerms:after,history:[event]};
const pendingWorkspace={...effectiveWorkspace,asOf:'2026-10-19',currentTerms:before,pending:true};
assert.deepEqual(normalizeWorkspace(workspace),workspace);assert.deepEqual(normalizeWorkspace(effectiveWorkspace),effectiveWorkspace);assert.deepEqual(normalizeWorkspace(pendingWorkspace),pendingWorkspace);
for(const delta of [{pending:true},{pending:'false'},{sequence:1},{sequence:201},{latestContractVersion:3},{latestContractVersion:0},{versions:[]},
  {versions:[version2,version2]},{versions:[{...version2,id:version1.id},version1]},{versions:[{...version2,version:3},version1]},
  {versions:[{...version2,effectiveFrom:'2026-02-30'},version1]},{versions:[{...version2,effectiveFrom:version1.effectiveFrom},version1]},
  {versions:[{...version2,effectiveFrom:'2029-01-01'},version1]},{versions:[{...version2,currency:'USD'},version1]},
  {currentTerms:after},{activationTerms:{...before,budget:'99'}},{activationTerms:{...before,contractVersionId:'synthetic-foreign'}},
  {lifecycle:{...lifecycle,contractVersionId:version2.id}},{lifecycle:{...lifecycle,effectiveOn:'2026-10-21'}},
  {asOf:'2026-02-30'},{identity:{...workspace.identity,currency:'gbp'}},{history:Array(201).fill(event)}])
  assert.throws(()=>normalizeWorkspace({...workspace,...delta}),invalid,'malformed base workspace');
for(const delta of [{currentTerms:before},{pending:true},{sequence:0},{history:[event,event]},
  {history:[{...event,contractVersionId:version1.id}]},{history:[{...event,effectiveOn:'2026-10-19'}]},
  {history:[{...event,startsOn:'2026-10-21'}]},{history:[{...event,budget:'199.0000'}]},
  {history:[{...event,endsOn:'2029-01-01'}]}])assert.throws(()=>normalizeWorkspace({...effectiveWorkspace,...delta}),invalid,'malformed effective history');
for(const delta of [{pending:false},{currentTerms:after}])assert.throws(()=>normalizeWorkspace({...pendingWorkspace,...delta}),invalid,'pending does not replace current terms');
const event2={...event,id:'synthetic-amendment-2',sequence:2,contractVersionId:version3.id,budget:version3.value,effectiveOn:version3.effectiveFrom};
const twoEvents={...effectiveWorkspace,latestContractVersion:3,versions:[version3,version2,version1],sequence:2,history:[event2,event],pending:true};
assert.deepEqual(normalizeWorkspace(twoEvents),twoEvents);
for(const history of [[event,event2],[{...event2,effectiveOn:event.effectiveOn},event],[{...event2,sequence:3},event],
  [{...event2,contractVersionId:version2.id},event]])assert.throws(()=>normalizeWorkspace({...twoEvents,history}),invalid,'ordered contiguous strictly newer history');
assert.throws(()=>normalizeWorkspace({...twoEvents,asOf:'2026-10-19',currentTerms:before}),invalid,'only one future amendment');
const childWorkspace={...effectiveWorkspace,entityType:'Engagement',activationTerms:{...before,budget:'70.0000'},
  currentTerms:{...after,budget:'80.0000'},history:[{...event,budget:'80.0000'}]};
assert.deepEqual(normalizeWorkspace(childWorkspace),childWorkspace);
assert.throws(()=>normalizeWorkspace({...childWorkspace,currentTerms:{...childWorkspace.currentTerms,startsOn:'2026-01-02'},
  history:[{...childWorkspace.history[0],startsOn:'2026-01-02'}]}),invalid,'child historical start is immutable');
for(const delta of [{dependencies:{projects:-1}},{dependencies:{projects:1.5}},{dependencies:{projects:'1'}},{warnings:[null]},
  {asOf:'2026-10-21'},{effectiveOn:'2026-02-30'},{after:{...after,startsOn:'2026-10-21'}},{after:{...after,contractVersionId:before.contractVersionId}}])
  assert.throws(()=>normalizePreview({...preview,...delta}),invalid,'malformed preview');
// SSR verifies the public component loads safely without mounting an effect or
// exposing confidential fixtures. It is not a claim of browser acceptance.
const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
const {CommercialAmendmentWorkspace}=await import('../src/components/CommercialAmendmentWorkspace.tsx');
reset();const markup=renderToStaticMarkup(React.createElement(CommercialAmendmentWorkspace));
assert(markup.includes('aria-label="Governed commercial amendments"'));assert(markup.includes('Loading amendment record choices'));
assert(!markup.includes('synthetic-terms'));assert.equal(calls.length,0,'unmounted SSR does not dispatch requests');
assert.deepEqual(localAccesses,[],'success, denial, stale completion and malformed data never use browser-local fallback');
console.log('Commercial amendment production service passed: strict transport/allowlists, exact decimals and preview/commit echoes, independent opt-in permissions, role/identity/scope/token/unmount races, preserved replacement sessions, malformed pending/current/history/version negatives and no implicit retry or local fallback.');
