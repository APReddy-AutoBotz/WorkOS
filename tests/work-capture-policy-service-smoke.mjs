import assert from 'node:assert/strict';
process.env.APP_MODE='production';process.env.VITE_APP_MODE='production';process.env.ALLOW_TEST_FALLBACK='false';process.env.VITE_ALLOW_TEST_FALLBACK='false';
const values=new Map(),local=[];
globalThis.sessionStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
globalThis.localStorage=Object.fromEntries(['getItem','setItem','removeItem','clear'].map(method=>[method,()=>{local.push(method);throw Error('No local fallback');}]));
globalThis.window={localStorage,location:{pathname:'/work-capture-policy',href:'/work-capture-policy'},dispatchEvent:()=>true};
const {workCapturePolicyService:service}=await import('../src/services/workCapturePolicy.ts');
const {timesheetService}=await import('../src/services/api.ts');
const {captureOrganizationProfileContext:capture}=await import('../src/services/organizationProfileScope.ts');
const {getToken,getOrganizationScope,resetBackendCheck}=await import('../src/services/apiClient.ts');
const scope={organizationId:'org-synthetic',legalEntityId:'legal-synthetic'},other={organizationId:'org-other',legalEntityId:'legal-other'};
const user={id:'worker-synthetic',employeeId:'worker-synthetic',name:'Synthetic operator',role:'Admin',permissionRole:'Admin',permissions:['settings.manage']};
const draft={expectedLatestId:null,effectiveFrom:'2026-10-21',minimumIncrement:'0.25',dailyMaximum:'8',weeklyMaximum:'40',commentRequired:true};
const policy={id:'capture-synthetic',sequence:1,policyVersion:'work-capture-rules/1',...draft,evidenceRequired:false,overtime:null,submissionDeadline:null};delete policy.expectedLatestId;
const workspace={...scope,serverDate:'2026-10-21',latestId:null,versions:[],truncated:false,activationDates:['2026-10-21']};
const calls=[];let health='connected',status=200,gate=null,payload=null;
const response=(body,code=200)=>new Response(JSON.stringify(body),{status:code,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async(url,init={})=>{
 calls.push({url,method:init.method,headers:{...init.headers},body:init.body});
 if(url==='/api/health')return response({database:health});
 if(url==='/api/timesheets')return response({work_assurance:null});
 assert.equal(url,'/api/v1/work-capture-policy');
 const code=status,body=payload??(init.method==='POST'?policy:workspace),wait=gate;
 if(wait)await wait.promise;
 return response(code>=400?{error:'Synthetic rejection'}:body,code);
};
const reset=()=>{values.clear();values.set('workos_session',JSON.stringify(user));values.set('workos_organization_scope',JSON.stringify(scope));values.set('workos_api_token','synthetic-original-token');calls.length=0;health='connected';status=200;gate=null;payload=null;window.location.href='/work-capture-policy';resetBackendCheck();};
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};
const replace=()=>{values.set('workos_session',JSON.stringify({...user,id:'worker-replacement'}));values.set('workos_organization_scope',JSON.stringify(other));values.set('workos_api_token','synthetic-replacement-token');};
reset();assert.deepEqual(await service.get(capture()),workspace);
assert.equal(calls[1].headers.Authorization,'Bearer synthetic-original-token');assert.equal(calls[1].headers['X-Legal-Entity-Id'],scope.legalEntityId);
assert.deepEqual(await service.append({...draft,organizationId:'forged',actorId:'forged',unexpected:true},capture()),policy);
assert.deepEqual(JSON.parse(calls.at(-1).body),draft,'only command fields cross the boundary');
for(const evidenceRequired of [true,false,undefined]){
 reset();await service.append({...draft,evidenceRequired},capture());const command=JSON.parse(calls.at(-1).body);assert.equal(command.evidenceRequired,evidenceRequired);assert.equal(Object.hasOwn(command,'evidenceRequired'),evidenceRequired!==undefined);
}
for(const evidenceRequired of [undefined,null,'false',0,[],{}]){
 reset();payload={...workspace,latestId:policy.id,versions:[{...policy,evidenceRequired}]};
 await assert.rejects(service.get(capture()),{status:503},'unknown evidence policy must not become an optional checkbox');
 reset();payload={...policy,evidenceRequired};await assert.rejects(service.append(draft,capture()),{status:503},'malformed acknowledgement must require reconciliation');
 assert.equal(calls.filter(call=>call.method==='POST').length,1,'uncertain acknowledgement does not retry');
}
for(const evidenceRequired of [false,true]){
 reset();payload={...workspace,latestId:policy.id,versions:[{...policy,evidenceRequired}]};
 assert.equal((await service.get(capture())).versions[0].evidenceRequired,evidenceRequired);
}
for(const fields of [{versions:{}},{versions:[null]},{latestId:policy.id},{latestId:null,versions:[policy]}]){
 reset();payload={...workspace,...fields};await assert.rejects(service.get(capture()),{status:503},'unverifiable latest policy must not produce defaults');
}
for(const overtime of [undefined,null,{action:'warn',dailyThreshold:'8',weeklyThreshold:null}]){
 reset();await service.append({...draft,overtime},capture());const command=JSON.parse(calls.at(-1).body);assert.deepEqual(command.overtime,overtime);assert.equal(Object.hasOwn(command,'overtime'),overtime!==undefined);
}
for(const submissionDeadline of [undefined,null,{anchor:'weekly-end-date',timezone:'UTC',daysAfterPeriodEnd:1,time:'12:30',graceMinutes:0,lateTreatment:'block'}]){reset();await service.append({...draft,submissionDeadline},capture());const command=JSON.parse(calls.at(-1).body);assert.deepEqual(command.submissionDeadline,submissionDeadline);assert.equal(Object.hasOwn(command,'submissionDeadline'),submissionDeadline!==undefined);}
const deadlineRule={anchor:'weekly-end-date',timezone:'UTC',daysAfterPeriodEnd:1,time:'12:30',graceMinutes:0,lateTreatment:'block'};
for(const submissionDeadline of [undefined,false,[],{}, {...deadlineRule,anchor:['weekly-end-date']},{...deadlineRule,timezone:'Europe/London'},{...deadlineRule,daysAfterPeriodEnd:'1'},{...deadlineRule,daysAfterPeriodEnd:-1},{...deadlineRule,daysAfterPeriodEnd:367},{...deadlineRule,graceMinutes:0.5},{...deadlineRule,graceMinutes:527041},{...deadlineRule,time:'24:00'},{...deadlineRule,lateTreatment:['warn']},{...deadlineRule,unexpected:true}]){
 reset();payload={...workspace,latestId:policy.id,versions:[{...policy,submissionDeadline}]};await assert.rejects(service.get(capture()),{status:503},'unknown deadline must not become off');
 reset();payload={...policy,submissionDeadline};await assert.rejects(service.append(draft,capture()),{status:503},'uncertain deadline acknowledgement requires reconciliation');assert.equal(calls.filter(c=>c.method==='POST').length,1);
}
for(const submissionDeadline of [null,deadlineRule,{...deadlineRule,daysAfterPeriodEnd:0,time:'00:00',graceMinutes:527040,lateTreatment:'warn'},{...deadlineRule,daysAfterPeriodEnd:366,time:'23:59'}]){
 reset();payload={...workspace,latestId:policy.id,versions:[{...policy,submissionDeadline}]};assert.deepEqual((await service.get(capture())).versions[0].submissionDeadline,submissionDeadline);
 reset();payload={...policy,submissionDeadline};assert.deepEqual((await service.append(draft,capture())).submissionDeadline,submissionDeadline);
}
const invalidOvertime=[undefined,false,[],{}, {action:['warn'],dailyThreshold:'8',weeklyThreshold:null},{action:'off',dailyThreshold:null,weeklyThreshold:null},{action:'warn',dailyThreshold:null,weeklyThreshold:null},{action:'warn',dailyThreshold:'0',weeklyThreshold:null},{action:'warn',dailyThreshold:'24.0001',weeklyThreshold:null},{action:'warn',dailyThreshold:'8.00001',weeklyThreshold:null},{action:'warn',dailyThreshold:8,weeklyThreshold:null},{action:'block',dailyThreshold:null,weeklyThreshold:'168.0001'},{action:'warn',dailyThreshold:'8'}];
for(const overtime of invalidOvertime){
 reset();payload={...workspace,latestId:policy.id,versions:[{...policy,overtime}]};await assert.rejects(service.get(capture()),{status:503},'unknown overtime must not become an off editor');
 reset();payload={...policy,overtime};await assert.rejects(service.append(draft,capture()),{status:503},'malformed overtime acknowledgement requires reconciliation');assert.equal(calls.filter(c=>c.method==='POST').length,1);
}
for(const overtime of [null,{action:'warn',dailyThreshold:'8',weeklyThreshold:null},{action:'block',dailyThreshold:null,weeklyThreshold:'40'},{action:'warn',dailyThreshold:'0.0001',weeklyThreshold:'168'}]){
 reset();payload={...workspace,latestId:policy.id,versions:[{...policy,overtime}]};assert.deepEqual((await service.get(capture())).versions[0].overtime,overtime);
 reset();payload={...policy,overtime};assert.deepEqual((await service.append(draft,capture())).overtime,overtime);
}
for(const mutate of [()=>values.set('workos_session','null'),()=>values.set('workos_organization_scope',JSON.stringify(other)),()=>values.set('workos_api_token','replacement'),()=>values.set('workos_session',JSON.stringify({...user,permissions:[]}))]){
 reset();const owner=capture();mutate();await assert.rejects(service.get(owner));await assert.rejects(service.append(draft,owner));assert.equal(calls.length,0);
}
reset();health='offline';await assert.rejects(service.get(capture()));assert.equal(calls.filter(c=>c.url==='/api/v1/work-capture-policy').length,0);health='connected';resetBackendCheck();assert.deepEqual(await service.get(capture()),workspace);
reset();payload={...workspace,...other};await assert.rejects(service.get(capture()),{status:403});
for(const method of ['get','append'])for(const code of [200,401]){
 reset();status=code;gate=deferred();const wait=gate;
 const pending=method==='get'?service.get(capture()):service.append(draft,capture());const outcome=pending.then(value=>({value}),error=>({error}));
 for(let i=0;i<20&&!calls.some(c=>c.url==='/api/v1/work-capture-policy');++i)await new Promise(r=>setTimeout(r,0));
 assert(calls.some(c=>c.url==='/api/v1/work-capture-policy'));replace();wait.resolve();assert((await outcome).error,'stale outcomes must not be published');
 assert.equal(getToken(),'synthetic-replacement-token');assert.deepEqual(getOrganizationScope(),other);assert.equal(window.location.href,'/work-capture-policy');
 assert.equal(calls.at(-1).headers.Authorization,'Bearer synthetic-original-token','dispatch retains the captured token');
}
for(const code of [400,409,503]){reset();status=code;await assert.rejects(service.append(draft,capture()),{status:code});assert.equal(getToken(),'synthetic-original-token');}
reset();await timesheetService.save({employeeId:user.id,employeeName:user.name,weekEnding:'2026-10-21',status:'Draft',entries:[{id:'entry-synthetic',date:'2026-10-21',workType:'Client Misc Task',clientName:'Synthetic context',hours:'0.25000000000000001',remark:'Synthetic exact text',billable:false}]});
assert.equal(JSON.parse(calls.at(-1).body).entries[0].hours,'0.25000000000000001','manual DTO preserves exact typed text until server validation');
assert.deepEqual(local,[]);
console.log('Capture policy production service: exact scoped/captured-token commands, permission/identity/scope ownership, outage recovery, stale 401 isolation and no local fallback passed.');
