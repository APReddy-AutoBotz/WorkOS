import assert from 'node:assert/strict';
// Hosted browser CI owns execution; do not bypass local browser/socket restrictions.
const {chromium}=await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl=process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser=await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH?{executablePath:process.env.WORKOS_CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1100,height:900}});page.setDefaultTimeout(10000);
const errors=[],unexpectedApi=[],unexpectedRemote=[],allCalls=[],allUnexpected=[];let downloads=0;
page.on('pageerror',error=>errors.push(error.message));page.on('download',()=>downloads++);
page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==new URL(baseUrl).origin)unexpectedRemote.push(request.url());});
await page.route('**/api/**',route=>{unexpectedApi.push({url:route.request().url(),method:route.request().method()});return route.abort();});
const today=new Date().toISOString().slice(0,10);
const base={organization_id:'org-a',legal_entity_id:'legal-a',applicability_type:'legal_entity',country_code:null,country_authority_legal_entity_id:null,worker_group_id:null,
  timezone:'Asia/Kolkata',working_days:[1,2,3,4,5],hours_per_day:'7.5',effective_from:'2020-01-01',effective_to:null,active:true};
const calendars=[{...base,id:'calendar-a',code:'A_LEGAL',name:'Synthetic legal calendar'},
  {...base,id:'calendar-b',code:'B_COUNTRY',name:'Synthetic country calendar',legal_entity_id:null,applicability_type:'country',country_code:'IN',country_authority_legal_entity_id:'legal-c',timezone:'UTC',active:false,effective_to:'2030-10-20'},
  {...base,id:'calendar-c',code:'C_GROUP',name:'Synthetic group calendar',legal_entity_id:null,applicability_type:'worker_group',worker_group_id:'saved-version-row-17',working_days:[0,2,4],timezone:'America/Los_Angeles'}];
const holiday=(calendarId='calendar-a')=>({id:'holiday-version-a',holiday_id:'holiday-a',calendar_id:calendarId,organization_id:'org-a',holiday_date:'2026-12-25',label:'Synthetic holiday <script>not executable</script>',holiday_type:'Public',effective_from:'2020-01-01',effective_to:'2030-10-20',active:false});
const button=name=>page.getByRole('button',{name,exact:true});
const list=()=>page.getByRole('region',{name:'Returned calendars (3)',exact:true});
const detail=()=>page.getByRole('region',{name:'Calendar details and holidays',exact:true});
const calls=()=>page.evaluate(()=>window.workingCalendarHarness.calls);
const flush=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const lastId=async()=>Math.max(0,...(await calls()).map(call=>call.id));
const pending=async(kind,after=0)=>{await page.waitForFunction(({kind,after})=>window.workingCalendarHarness.pending.some(call=>call.kind===kind&&call.id>after),{kind,after});
  return page.evaluate(({kind,after})=>{const {id,url,method,headers,credentials,body}=window.workingCalendarHarness.pending.filter(call=>call.kind===kind&&call.id>after).at(-1);return {id,url,method,headers,credentials,body};},{kind,after});};
const settle=(request,result,status)=>page.evaluate(({id,result,status})=>window.workingCalendarHarness.settle(id,result,status),{id:request.id,result,status});
const health=async(after=0,connected=true)=>{const request=await pending('health',after);assert.equal(request.url,'/api/health');assert.equal(request.method,'GET');assert.equal(request.credentials,'include');assert.equal(request.body,null);await settle(request,{database:connected?'connected':'offline'});return request;};
const read=async(kind='calendars',after=0,id='calendar-a',scope={organizationId:'org-a',legalEntityId:'legal-a'},token='synthetic-calendar-token-a')=>{
  const request=await pending(kind,after);assert.equal(request.method,'GET','explicit zero business mutation assertion');assert.equal(request.body,null);assert.equal(request.credentials,'include');
  assert.equal(request.url,`/api/organization-setup/calendars${kind==='holidays'?`/${id}/holidays`:''}?asOf=${today}`);
  assert.deepEqual(request.headers,{'authorization':`Bearer ${token}`,'content-type':'application/json','x-organization-id':scope.organizationId,'x-legal-entity-id':scope.legalEntityId});return request;};
const collect=async()=>{const prior=await page.evaluate(()=>window.workingCalendarHarness?{calls:window.workingCalendarHarness.calls,unexpected:window.workingCalendarHarness.unexpectedFetches}:null);if(prior){allCalls.push(...prior.calls);allUnexpected.push(...prior.unexpected);}};
const open=async(params='')=>{await collect();await page.goto(`${baseUrl}/tests/fixtures/working-calendar-inspector.html${params}`);await page.getByRole('heading',{name:'Working calendars',exact:true}).waitFor();};
const boot=async(rows=calendars)=>{await open();await health();const request=await read();await settle(request,rows);await page.getByRole('heading',{name:`Returned calendars (${rows.length})`,exact:true}).waitFor();return request;};
const select=async(code='A_LEGAL',id='calendar-a')=>{const after=await lastId();await button(`Inspect ${code}`).click();const request=await read('holidays',after,id);await detail().getByText('Loading holidays…',{exact:true}).waitFor();return request;};
const capture=(label,name)=>page.evaluate(({label,name})=>window.workingCalendarHarness.capture(label,name),{label,name});
const invoke=labels=>page.evaluate(labels=>window.workingCalendarHarness.invoke(labels),labels);
const noDispatch=async(before,why)=>{await flush();assert.deepEqual(await calls(),before,why);};
const blocked=async()=>{await page.getByRole('alert').getByText('Scope or access changed.',{exact:false}).waitFor();assert.equal(await page.getByRole('heading',{name:/Returned calendars/}).count(),0);};
const noPrivate=async()=>{const text=await page.locator('body').innerText();assert(!text.includes('synthetic-private'));assert(!text.includes('/internal/provider'));};
try {
  await boot();
  assert.equal((await calls()).filter(call=>call.url.includes('/holidays')).length,0,'holiday loading is lazy, never one read per list item');
  assert.equal(await page.getByRole('link',{name:'Governance Settings',exact:true}).getAttribute('href'),'/admin');
  assert((await list().innerText()).includes('Country: IN'));assert((await list().innerText()).includes('Worker-group version-row ID: saved-version-row-17'));
  let request=await select();await settle(request,[holiday()]);await detail().getByText('2026-12-25: Synthetic holiday <script>not executable</script>',{exact:true}).waitFor();
  for(const text of ['Asia/Kolkata','Monday, Tuesday, Wednesday, Thursday, Friday','7.5','2020-01-01 to no saved end date','Public. Status: Inactive.','Effective bounds (inclusive): 2020-01-01 to 2030-10-20.']) assert((await detail().innerText()).includes(text));
  assert.equal(await page.locator('script:not([src])').count(),0,'server label remains inert text');
  request=await select('B_COUNTRY','calendar-b');await settle(request,[]);await detail().getByText('No holidays returned for this calendar and snapshot. This is not an exhaustive absence claim.',{exact:true}).waitFor();
  assert((await detail().innerText()).includes('legal-c'));assert((await detail().innerText()).includes('Inactive'));
  request=await select('C_GROUP','calendar-c');await settle(request,[holiday('calendar-c')]);await detail().getByText('Sunday, Tuesday, Thursday',{exact:true}).waitFor();
  assert((await detail().innerText()).includes('saved-version-row-17'));
  await button('Inspect A_LEGAL').focus();await page.keyboard.press('Enter');request=await read('holidays',request.id);await settle(request,[]);
  await page.setViewportSize({width:390,height:844});await flush();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'390px has no horizontal overflow');
  await page.setViewportSize({width:1100,height:900});

  await boot([]);await page.getByText('No calendars returned for this scope and snapshot. This is not an exhaustive absence claim.',{exact:true}).waitFor();
  const capped=Array.from({length:200},(_,i)=>({...base,id:`cap-calendar-${i}`,code:`CAP_${i}`,name:`Synthetic capped ${i}`}));
  await boot(capped);await page.getByText('The 200-calendar response limit was reached.',{exact:false}).waitFor();
  request=await select('CAP_0','cap-calendar-0');await settle(request,Array.from({length:200},(_,i)=>({...holiday('cap-calendar-0'),id:`cap-holiday-${i}`})));
  await page.getByText('The 200-holiday response limit was reached.',{exact:false}).waitFor();

  for(const failure of [400,401,403,500,503,'network','malformed-json']) {
    await open();await health();request=await read();await settle(request,undefined,failure);await button('Retry calendars').waitFor();await noPrivate();
    const after=await lastId();await button('Retry calendars').click();await health(after);request=await read('calendars',after);await settle(request,calendars);await list().waitFor();
    request=await select();await settle(request,undefined,failure);await button('Retry holidays').waitFor();await noPrivate();assert((await detail().innerText()).includes('Asia/Kolkata'),'holiday failure preserves confirmed calendar details');
    const retryAfter=await lastId();await button('Retry holidays').click();await health(retryAfter);request=await read('holidays',retryAfter);await settle(request,[]);await detail().getByText('No holidays returned',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('workos_api_token')),'synthetic-calendar-token-a');
  }
  await open();await health(0,false);await button('Retry calendars').waitFor();const offlineAfter=await lastId();await button('Retry calendars').click();await health(offlineAfter);request=await read('calendars',offlineAfter);await settle(request,calendars);await list().waitFor();

  for(const rows of [{not:'an array'},[{...calendars[0],organization_id:'org-foreign'}],[{...calendars[0],legal_entity_id:'legal-b'}],[{...calendars[0],effective_from:'2026-02-30'}]]) {
    await open();await health();request=await read();await settle(request,rows);await button('Retry calendars').waitFor();assert.equal(await page.getByRole('heading',{name:/Returned calendars/}).count(),0);
  }
  for(const rows of [[{...holiday(),organization_id:'org-foreign'}],[{...holiday(),calendar_id:'calendar-b'}],[{...holiday(),holiday_date:'2026-02-30'}],[{...holiday(),holiday_type:['Public']}]]) {
    await boot();request=await select();await settle(request,rows);await button('Retry holidays').waitFor();assert.equal(await detail().getByText(/2026-12-25:/).count(),0);
  }

  // Selection races, duplicate clicks, stale selection and retry callbacks.
  await boot();await capture('old-reload','Reload calendars');await capture('old-select','Inspect C_GROUP');
  await page.evaluate(()=>window.workingCalendarHarness.clickTwice('Inspect A_LEGAL'));request=await read('holidays');assert.equal((await calls()).filter(call=>call.url.includes('/holidays')).length,1);
  const oldHoliday=request;const newHoliday=await select('B_COUNTRY','calendar-b');const before=await calls();await invoke(['old-reload','old-select']);await noDispatch(before,'selection change invalidates retained handlers');
  await settle(newHoliday,[]);await settle(oldHoliday,[holiday()]);await flush();assert((await detail().innerText()).includes('Synthetic country calendar'));assert(!(await detail().innerText()).includes('Synthetic holiday <script>'));
  request=await select('A_LEGAL');await settle(request,undefined,503);await button('Retry holidays').waitFor();await capture('stale-retry','Retry holidays');
  const afterRetry=await lastId();await button('Retry holidays').click();await health(afterRetry);const retried=await read('holidays',afterRetry);const switched=await select('C_GROUP','calendar-c');
  const beforeOldRetry=await calls();await invoke(['stale-retry']);await noDispatch(beforeOldRetry,'retry callback cannot read replacement selection');await settle(switched,[]);await settle(retried,[holiday()]);await flush();assert((await detail().innerText()).includes('Synthetic group calendar'));

  const changeCases=[
    ()=>page.evaluate(()=>window.workingCalendarHarness.scope({organizationId:'org-b',legalEntityId:'legal-b'})),
    ()=>page.evaluate(()=>window.workingCalendarHarness.scope({organizationId:'org-a',legalEntityId:'legal-b'},'storage')),
    ()=>page.evaluate(()=>window.workingCalendarHarness.identity('replacement-actor')),
    ()=>page.evaluate(()=>window.workingCalendarHarness.identity('synthetic-calendar-admin','Admin')),
    ()=>page.evaluate(()=>window.workingCalendarHarness.identity('synthetic-calendar-admin','HR',false)),
    ()=>page.evaluate(()=>window.workingCalendarHarness.token('synthetic-calendar-token-b')),
    ()=>page.evaluate(()=>window.workingCalendarHarness.event('workos:organization-scope-switch-requested')),
  ];
  for(const change of changeCases) {
    await open();const waiting=await pending('health');await change();await blocked();const before=await calls();await settle(waiting,{database:'connected'});await noDispatch(before,'changed context while health waits suppresses calendar GET');
    await boot();await capture('context-select','Inspect A_LEGAL');await capture('context-reload','Reload calendars');request=await select();await change();await blocked();const beforeLate=await calls();await invoke(['context-select','context-reload']);await settle(request,[holiday()]);await noDispatch(beforeLate,'old handlers/completion cannot restore cleared results or dispatch');await noPrivate();
  }
  // A context change without an event is still caught before dispatch.
  for(const name of ['Inspect A_LEGAL','Reload calendars']) {await boot();await capture('silent-handler',name);await page.evaluate(()=>window.workingCalendarHarness.token('synthetic-calendar-token-b',null));const beforeSilent=await calls();await invoke(['silent-handler']);await blocked();await noDispatch(beforeSilent,'pre-send ownership cannot depend solely on events');}

  // Reload/Unmount and StrictMode replay are separate request generations.
  await open();await health();const oldList=await read();await capture('generation-reload','Reload calendars');const beforeReload=await lastId();await button('Reload calendars').click();await health(beforeReload);const latestList=await read('calendars',beforeReload);await settle(latestList,calendars);await list().waitFor();const beforeStale=await calls();await invoke(['generation-reload']);await settle(oldList,[]);await noDispatch(beforeStale,'older generation cannot dispatch or replace current list');await list().waitFor();
  request=await select();await page.evaluate(()=>window.workingCalendarHarness.hide());const beforeUnmount=await calls();await settle(request,[holiday()]);await invoke(['generation-reload']);await noDispatch(beforeUnmount,'unmounted handlers and responses are inert');await page.evaluate(()=>window.workingCalendarHarness.show());await health(beforeUnmount.at(-1).id);const remount=await read('calendars',beforeUnmount.at(-1).id);await settle(remount,calendars);await list().waitFor();
  await open('?strict=1');await health();request=await read();await settle(request,calendars);await list().waitFor();assert.equal((await calls()).filter(call=>call.url.includes('calendars?')).length,1,'StrictMode replay suppresses obsolete health continuation');

  await open('?access=none');await blocked();assert.equal((await calls()).length,0,'settings-management denied before any read');
  for(const scope of [null,{}, {organizationId:'org-a'}, {organizationId:42,legalEntityId:'legal-a'}]) {
    await boot();await page.evaluate(scope=>window.workingCalendarHarness.scope(scope),scope);await blocked();const after=await calls();await button('Reload calendars').click();await flush();assert.deepEqual(await calls(),after,'malformed scope fails closed without network');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpectedApi,[]);assert.deepEqual(unexpectedRemote,[]);assert.equal(downloads,0);
  await collect();assert.deepEqual(allUnexpected,[]);
  assert(allCalls.every(call=>call.method==='GET'&&call.body===null),'explicit no business mutation requests across complete browser journey');
  console.log('Working calendar real production-page/service browser applicability/holidays/empty/cap/retry/ownership/selection/StrictMode/keyboard/390px and zero business mutations passed.');
} finally {await browser.close();}
