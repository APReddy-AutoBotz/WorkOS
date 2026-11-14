import {syntheticHexDigest,rejectedConfigurationValues} from './support/synthetic-values.mjs';
import assert from 'node:assert/strict';
process.env.APP_MODE='production';process.env.VITE_APP_MODE='production';process.env.ALLOW_TEST_FALLBACK='false';process.env.VITE_ALLOW_TEST_FALLBACK='false';
const values=new Map(),local=[];
globalThis.sessionStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
globalThis.localStorage=Object.fromEntries(['getItem','setItem','removeItem','clear'].map(method=>[method,()=>{local.push(method);throw Error('No local fallback');}]));
globalThis.window={localStorage,location:{pathname:'/timesheets',href:'/timesheets'},dispatchEvent:()=>true};
const {workCaptureWorkspaceService:work,workCaptureModesSettingsService:settings,captureWorkCaptureContext:capture}=await import('../src/services/workCaptureModes.ts');
const {captureOrganizationProfileContext:captureSettings}=await import('../src/services/organizationProfileScope.ts');
const {getToken,getOrganizationScope,resetBackendCheck}=await import('../src/services/apiClient.ts');
const scope={organizationId:'org-synthetic',legalEntityId:'legal-synthetic'},other={organizationId:'org-other',legalEntityId:'legal-other'};
const user={id:'worker-synthetic',employeeId:'worker-synthetic',name:'Synthetic operator',role:'Admin',permissionRole:'Admin',permissions:['settings.manage','timesheets.submit']};
const token=syntheticHexDigest(),nextToken=syntheticHexDigest(),modes={...scope,serverDate:'2026-10-22',latestId:'m1',enabledModes:['weekly','daily']};
const modeSettings={...scope,latestId:null,versions:[],truncated:false},draft={expectedLatestId:null,enabledModes:['daily']};
const input={employeeId:user.id,weekEnding:'2026-10-23',status:'Draft',entries:[{id:'entry-synthetic',date:'2026-10-22',workType:'Client Misc Task',clientName:'Synthetic context',category:'Synthetic category',hours:'0.25000000000000001',remark:'Synthetic comment',billable:false}]};
const precondition={writeToken:token,mode:'daily',modePolicyId:'m1'};
const modeVersion={id:'m1',sequence:1,policyVersion:'work-capture-modes/1',enabledModes:['daily'],createdAt:'2026-10-22T12:00:00.000Z'};
const calls=[];let status=200,health='connected',gate=null,gatePath=null,projection=modes,history=modeSettings,appended=modeVersion;
const response=(body,code=200)=>new Response(JSON.stringify(body),{status:code,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async(url,init={})=>{
 calls.push({url,method:init.method||'GET',headers:{...init.headers},body:init.body});
 if(url==='/api/health')return response({database:health});
 let body;
 if(url==='/api/v1/work-capture-modes')body=projection;
 else if(url==='/api/projects')body=[{id:'project-synthetic',name:'Synthetic project',status:'Active',start_date:'2026-01-01',end_date:'2026-12-31'}];
 else if(url==='/api/allocations')body=[{id:'allocation-synthetic',employee_id:user.id,project_id:'project-synthetic',start_date:'2026-01-01',end_date:'2026-12-31',status:'Active'}];
 else if(url==='/api/settings')body=[];
 else if(url==='/api/timesheets')body=init.method==='POST'?{write_token:nextToken,work_assurance:null}:[{id:'header-synthetic',employee_id:user.id,week_ending:input.weekEnding,status:'Draft',write_token:token,entries:[]}];
 else if(url==='/api/v1/work-capture-modes/settings')body=init.method==='POST'?appended:history;
 else throw Error(`Unexpected transport ${url}`);
 const code=status,wait=gate&&url===gatePath?gate:null;if(wait)await wait.promise;
 return response(code>=400?{error:'Synthetic rejection'}:body,code);
};
const reset=()=>{values.clear();values.set('workos_session',JSON.stringify(user));values.set('workos_organization_scope',JSON.stringify(scope));values.set('workos_api_token','synthetic-original-token');calls.length=0;status=200;health='connected';gate=null;gatePath=null;projection=modes;history=modeSettings;appended=modeVersion;resetBackendCheck();};
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};
const replace=()=>{values.set('workos_session',JSON.stringify({...user,id:'worker-replacement'}));values.set('workos_organization_scope',JSON.stringify(other));values.set('workos_api_token','synthetic-replacement-token');};
reset();const workspace=await work.get(capture());assert.equal(workspace.allocations[0].projectName,'Synthetic project');assert.equal(workspace.timesheets[0].writeToken,token);
assert.deepEqual(calls.slice(1).map(call=>call.url).sort(),['/api/allocations','/api/projects','/api/timesheets','/api/v1/work-capture-modes'].sort());
assert(calls.slice(1).every(call=>call.headers.Authorization==='Bearer synthetic-original-token'&&call.headers['X-Legal-Entity-Id']===scope.legalEntityId));
await work.save({...input,organizationId:'forged',actorId:'forged'},precondition,capture());const body=JSON.parse(calls.at(-1).body);
assert.deepEqual(Object.keys(body).sort(),['capture_mode','employee_id','entries','expected_mode_policy_id','expected_write_token','status','week_ending'].sort());
assert.equal(body.entries[0].hours,'0.25000000000000001');assert.equal(body.expected_write_token,token);assert.equal(body.capture_mode,'daily');assert.equal(body.expected_mode_policy_id,'m1');assert.equal(body.entries[0].billable,false);
assert.deepEqual(await settings.get(captureSettings()),modeSettings);
await settings.append({...draft,actorId:'forged'},captureSettings());assert.deepEqual(JSON.parse(calls.at(-1).body),draft);
for(const mutate of [()=>values.set('workos_session','null'),()=>values.set('workos_organization_scope',JSON.stringify(other)),()=>values.set('workos_api_token','replacement'),()=>values.set('workos_session',JSON.stringify({...user,permissions:[]}))]){
 reset();const owner=capture(),admin=captureSettings();mutate();await assert.rejects(work.get(owner));await assert.rejects(work.save(input,precondition,owner));await assert.rejects(settings.get(admin));await assert.rejects(settings.append(draft,admin));assert.equal(calls.length,0);
}
reset();projection={...modes,...other};await assert.rejects(work.get(capture()),{status:403});
reset();health='offline';await assert.rejects(work.get(capture()));assert.equal(calls.length,1);health='connected';resetBackendCheck();await work.get(capture());
for(const operation of ['load','save','settings'])for(const code of [200,401]){
 reset();status=code;gate=deferred();gatePath=operation==='load'?'/api/v1/work-capture-modes':operation==='save'?'/api/timesheets':'/api/v1/work-capture-modes/settings';
 const wait=gate,pending=operation==='load'?work.get(capture()):operation==='save'?work.save(input,precondition,capture()):settings.append(draft,captureSettings());
 const outcome=pending.then(value=>({value}),error=>({error}));
 for(let i=0;i<30&&!calls.some(call=>call.url===gatePath);++i)await new Promise(resolve=>setTimeout(resolve,0));
 assert(calls.some(call=>call.url===gatePath));replace();wait.resolve();assert((await outcome).error);
 assert.equal(getToken(),'synthetic-replacement-token');assert.deepEqual(getOrganizationScope(),other);assert.equal(window.location.href,'/timesheets');
 assert(calls.filter(call=>call.url!=='/api/health').every(call=>call.headers.Authorization==='Bearer synthetic-original-token'));
}
for(const code of [400,409,422,503]){reset();status=code;await assert.rejects(work.save(input,precondition,capture()),{status:code});assert.equal(getToken(),'synthetic-original-token');}
const validHistory={...scope,latestId:'m1',versions:[modeVersion],truncated:false};
reset();history=validHistory;assert.deepEqual(await settings.get(captureSettings()),validHistory);
for(const malformed of [null,[],{...validHistory,versions:{}},{...validHistory,latestId:'missing'},
 {...validHistory,truncated:'false'},{...validHistory,truncated:true},
 {...validHistory,versions:[{...modeVersion,enabledModes:'daily'}]},
 {...validHistory,versions:[{...modeVersion,enabledModes:['daily','daily']}]},
 {...validHistory,versions:[{...modeVersion,policyVersion:'unknown'}]},
 {...validHistory,versions:[{...modeVersion,sequence:2}]},
 {...validHistory,versions:[{...modeVersion,createdAt:'invalid'}]},
 {...validHistory,versions:[modeVersion,modeVersion]}]){
 reset();history=malformed;await assert.rejects(settings.get(captureSettings()),{status:503});
}
for(const malformed of [null,[],{...modeVersion,sequence:0},{...modeVersion,sequence:1.5},
 {...modeVersion,id:''},{...modeVersion,enabledModes:[]},{...modeVersion,createdAt:null}]){
 reset();appended=malformed;await assert.rejects(settings.append(draft,captureSettings()),{status:503});
 assert.equal(calls.filter(call=>call.method==='POST').length,1,'malformed success must not trigger retry');
}
for(const malformed of [null,[],{...modes,enabledModes:['weekly','weekly']},{...modes,enabledModes:['unknown']},
 {...modes,latestId:null},{...modes,enabledModes:[]},{...modes,serverDate:'2026-02-30'}]){
 reset();projection=malformed;await assert.rejects(work.get(capture()),{status:503});
}
reset();projection={...modes,latestId:null,enabledModes:[]};assert.deepEqual((await work.get(capture())).modes,projection);
reset();history={...validHistory,latestId:'v51',truncated:true,versions:Array.from({length:50},(_,i)=>({...modeVersion,id:`v${51-i}`,sequence:51-i}))};
assert.equal((await settings.get(captureSettings())).versions.length,50,'valid bounded truncated histories remain usable');
assert.deepEqual(local,[]);
console.log('Fresh capture-mode production transport: captured scope/session/grants, exact allowlisted payload, mode/CAS trio, stale results/401, outage and no local fallback passed.');
