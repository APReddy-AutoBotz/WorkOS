import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork,
  seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentPermissions,amendmentScope,amendmentMarker,amendmentSnapshot,amendmentCounts,amendmentToday,addUtcDays,
  amendmentContractInput,amendmentPost,amendmentTransition,grantAmendmentPermissions,createAmendmentHierarchy,
  seedApplicableAmendmentVersion,amendmentWorkspace} from './support/commercial-amendments-test.mjs';

// Hosted-only real React -> HTTP API -> randomized disposable PostgreSQL gate.
// No mocked fetch, request interception, offline fallback, live identity or DB.
// A missing required PostgreSQL or Chromium service is a failure, not a skip.
const {chromium}=await import(process.env.WORKOS_PLAYWRIGHT_MODULE||'playwright');
const rootDir=fileURLToPath(new URL('../',import.meta.url));
const prefix='/api/v1/commercial-drafting',amendmentPrefix=`${prefix}/amendments`;
const hostile='<script>window.syntheticAmendmentExecuted=true</script>';
const reason=`${amendmentMarker} real browser ${hostile}`,approvalReference=`${amendmentMarker}-BROWSER-APPROVAL`;
const previewFields=['expectedSequence','expectedLifecycleSequence','expectedContractVersion','contractVersionId','effectiveOn','startsOn','endsOn','budget','reason','approvalReference'];
await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);await grantAmendmentPermissions(pool);
  await withCommercialApi({databaseUrl,identities,timeZone:'America/Los_Angeles'},async({baseUrl:apiUrl,request:apiRequest,tokenFor})=>{
    const roots=await createAmendmentHierarchy(apiRequest,'SYN-AMENDMENT-BROWSER');
    const today=await amendmentToday(pool),future=addUtcDays(today,30);
    const v2=await seedApplicableAmendmentVersion(pool,identities.manager,roots.contract,today);
    const immutableBefore=await amendmentSnapshot(pool);const projectsBefore=await amendmentSnapshot(pool,['projects']);
    const vite=await createServer({root:rootDir,mode:'production',clearScreen:false,logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,
      proxy:{'/api':{target:apiUrl,changeOrigin:true}}},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
    let browser;
    try{
      await vite.listen();const address=vite.httpServer.address();assert(address&&typeof address!=='string');const baseUrl=`http://127.0.0.1:${address.port}`;
      browser=await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH?{executablePath:process.env.WORKOS_CHROMIUM_PATH}:{})});
      const errors=[],external=[],writes=[],reads=[];
      const createContext=async(identity,permissions)=>{
        const context=await browser.newContext({viewport:{width:1280,height:1100}});
        const session={id:identity.id,employeeId:f.ownerId,name:'Synthetic amendment browser operator',role:identity.role,permissionRole:identity.role,permissions};
        await context.addInitScript(({session,scope,token})=>{
          sessionStorage.setItem('workos_session',JSON.stringify(session));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token',token);
        },{session,scope:amendmentScope,token:tokenFor(identity)});
        const page=await context.newPage();page.setDefaultTimeout(20000);
        page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{
          const url=new URL(request.url());if(/^https?:/.test(request.url())&&url.origin!==baseUrl)external.push(request.url());
          if(url.pathname.startsWith('/api/')){
            const value={path:url.pathname,method:request.method(),body:request.method()==='GET'?null:request.postDataJSON(),headers:request.headers()};
            (request.method()==='GET'?reads:writes).push(value);
          }
        });return {context,page,session};
      };
      const manager=await createContext(identities.manager,amendmentPermissions);const {page}=manager;
      const button=name=>page.getByRole('button',{name,exact:true});
      const open=async()=>{await page.goto(`${baseUrl}/tests/fixtures/commercial-amendments.html`);await page.getByLabel('Record type',{exact:true}).waitFor();};
      const select=async(type,id)=>{
        await page.getByLabel('Record type',{exact:true}).selectOption(type);
        const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname===`${amendmentPrefix}/${type}/${id}`&&response.request().method()==='GET');
        await page.getByLabel('Record',{exact:true}).selectOption(id);const response=await responsePromise;assert.equal(response.status(),200);
        await page.getByRole('region',{name:'Activation and current terms',exact:true}).waitFor();return response.json();
      };
      const prepare=async(type,id,version,budget)=>{
        const workspace=await select(type,id);
        await page.getByLabel('Target contract version',{exact:true}).selectOption(version.id);
        assert.equal(await page.getByLabel('Amended starts on',{exact:true}).inputValue(),'2020-01-01');
        assert.equal(await page.getByLabel('Amended starts on',{exact:true}).getAttribute('readonly'),'');
        if(type!=='Contract'){
          await page.getByLabel('Amended ends on',{exact:true}).fill(version.endsOn);
          await page.getByLabel('Amended budget (decimal)',{exact:true}).fill(budget||workspace.currentTerms.budget);
        }else{
          assert.equal(await page.getByLabel('Amended ends on',{exact:true}).inputValue(),version.endsOn);
          assert.equal(await page.getByLabel('Amended budget (decimal)',{exact:true}).inputValue(),version.value);
          assert.equal(await page.getByLabel('Amended budget (decimal)',{exact:true}).getAttribute('readonly'),'');
        }
        await page.getByLabel('Reason for amendment',{exact:true}).fill(reason);await page.getByLabel('Approval reference',{exact:true}).fill(approvalReference);
        return workspace;
      };
      const post=async(type,id,action,status=201,preview=false)=>{
        const path=`${amendmentPrefix}/${type}/${id}${preview?'/preview':''}`;
        const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='POST');
        await action();const response=await responsePromise;assert.equal(response.status(),status,`real browser ${path}: ${await response.text()}`);
        const body=response.request().postDataJSON();assert.deepEqual(Object.keys(body).sort(),[...previewFields,...(preview?[]:['previewToken'])].sort());
        assert.equal(body.reason,reason);assert.equal(body.approvalReference,approvalReference);assert.equal(typeof body.budget,'string');
        assert.equal(response.request().headers()['x-organization-id'],amendmentScope.organizationId);assert.equal(response.request().headers()['x-legal-entity-id'],amendmentScope.legalEntityId);
        return {body,result:await response.json()};
      };
      const preview=async(type,id)=>{
        const before=await amendmentCounts(pool);const result=await post(type,id,()=>button('Preview amendment').click(),201,true);
        assert.deepEqual(await amendmentCounts(pool),before,'preview never appends material or general audit');
        await page.getByRole('region',{name:'Amendment preview',exact:true}).waitFor();assert.match(result.result.previewToken,/^[a-f0-9]{64}$/);return result;
      };
      const apply=async(type,id)=>{
        const result=await post(type,id,()=>button('Confirm and apply amendment').click());
        await page.getByRole('status').getByText('Amendment saved.',{exact:false}).waitFor();
        await page.getByRole('region',{name:'Protected amendment history',exact:true}).getByText(`Reason: ${reason}`,{exact:true}).waitFor();return result;
      };
      await open();assert.equal(writes.length,0);
      await prepare('Contract',roots.contract.id,v2);const initial=await preview('Contract',roots.contract.id);
      await page.evaluate(()=>window.commercialAmendmentHarness.capture('old-apply','Confirm and apply amendment'));
      await page.getByLabel('Reason for amendment',{exact:true}).fill(`${reason} edited`);
      assert.equal(await page.getByRole('region',{name:'Amendment preview',exact:true}).count(),0);
      const beforeOldPreview=writes.length;await page.evaluate(()=>window.commercialAmendmentHarness.invoke(['old-apply']));
      assert.equal(writes.length,beforeOldPreview,'edited preview cannot be confirmed by a captured handler');
      await page.getByLabel('Reason for amendment',{exact:true}).fill(reason);const confirmed=await preview('Contract',roots.contract.id);
      assert.equal(initial.result.previewToken,confirmed.result.previewToken,'unchanged exact material/context reproduces authoritative token');
      const contractApplied=await apply('Contract',roots.contract.id);assert.equal(contractApplied.body.previewToken,confirmed.result.previewToken);assert.equal(contractApplied.result.sequence,1);
      const current=page.getByRole('region',{name:'Activation and current terms',exact:true});assert((await current.innerText()).includes(roots.pin));assert((await current.innerText()).includes(v2.id));
      for(const [type,entity] of [['Engagement',roots.engagement],['Project',roots.project]])assert.equal((await amendmentWorkspace(apiRequest,type,entity.id)).currentTerms.contractVersionId,roots.pin,'parent adoption never cascades');
      await prepare('Engagement',roots.engagement.id,v2,'10000.0001');await preview('Engagement',roots.engagement.id);await apply('Engagement',roots.engagement.id);
      await prepare('Project',roots.project.id,v2,'4000.0001');await preview('Project',roots.project.id);
      await amendmentTransition(apiRequest,'Project',roots.project.id,1,roots.pin,'On Hold');
      const beforeStale=await amendmentCounts(pool);const stale=await post('Project',roots.project.id,()=>button('Confirm and apply amendment').click(),409);
      assert.equal(stale.result.error.code,'COMMERCIAL_AMENDMENT_CONFLICT');assert.deepEqual(await amendmentCounts(pool),beforeStale);
      await page.getByRole('status').getByText('Not applied because the preview or linked terms changed.',{exact:false}).waitFor();
      await page.getByLabel('Target contract version',{exact:true}).selectOption(v2.id);await page.getByLabel('Amended ends on',{exact:true}).fill(v2.endsOn);
      await page.getByLabel('Reason for amendment',{exact:true}).fill(reason);await page.getByLabel('Approval reference',{exact:true}).fill(approvalReference);
      await preview('Project',roots.project.id);const held=await apply('Project',roots.project.id);assert.equal(held.body.expectedLifecycleSequence,2);
      assert.equal((await amendmentWorkspace(apiRequest,'Project',roots.project.id)).lifecycle.state,'On Hold','amendment does not implicitly resume delivery');
      assert.equal(await page.evaluate(()=>window.syntheticAmendmentExecuted),undefined);assert.equal(await page.locator('script').filter({hasText:'syntheticAmendmentExecuted'}).count(),0);
      const projectedAfterHold=await amendmentSnapshot(pool,['projects']);
      const omitStatus=rows=>rows.map(({value})=>({value:Object.fromEntries(Object.entries(value).filter(([key])=>!['status','updated_at'].includes(key)))}));
      assert.deepEqual(omitStatus(projectedAfterHold.projects),omitStatus(projectsBefore.projects),'amendment adoption never rewrites project identity, dates or budget; only the separate explicit hold projects status');
      // The one explicit lifecycle hold above changes only its append-only event
      // and established status projection. Amendment-protected history is exact.
      const afterCurrent=await amendmentSnapshot(pool);
      for(const table of Object.keys(immutableBefore).filter(table=>table!=='commercial_lifecycle_events'))assert.deepEqual(afterCurrent[table],immutableBefore[table]);
      await page.reload();await page.getByLabel('Record type',{exact:true}).waitFor();const persisted=await select('Project',roots.project.id);
      assert.equal(persisted.sequence,1);assert.equal(persisted.currentTerms.contractVersionId,v2.id);assert.equal(persisted.activationTerms.contractVersionId,roots.pin);
      await page.getByRole('region',{name:'Protected amendment history',exact:true}).getByText(`Reason: ${reason}`,{exact:true}).waitFor();

      const oldTerms=amendmentContractInput('UNUSED');delete oldTerms.number;delete oldTerms.clientId;
      const revised=await amendmentPost(apiRequest,`/contracts/${roots.contract.id}/versions`,{...oldTerms,expectedVersion:2,effectiveFrom:future,endsOn:'2099-12-31',value:'31000.0003',reason:'Synthetic browser future publication'});
      const v3=revised.versions.find(version=>version.version===3);assert(v3);
      for(const boundary of ['permission','scope','token']){
        await page.reload();await page.getByLabel('Record type',{exact:true}).waitFor();await prepare('Contract',roots.contract.id,v3);await preview('Contract',roots.contract.id);
        await page.evaluate(()=>window.commercialAmendmentHarness.capture('captured-apply','Confirm and apply amendment'));const beforeBoundary=writes.length;
        if(boundary==='permission')await page.evaluate(session=>window.commercialAmendmentHarness.identity({...session,permissions:['commercial.contracts.view']},'focus',['captured-apply']),manager.session);
        if(boundary==='scope')await page.evaluate(()=>window.commercialAmendmentHarness.scope({organizationId:'synthetic-replacement-org',legalEntityId:'synthetic-replacement-legal'},'workos:organization-scope-changed',['captured-apply']));
        if(boundary==='token')await page.evaluate(()=>window.commercialAmendmentHarness.token('example-replacement-session','focus',['captured-apply']));
        await page.getByRole('alert').getByText('Scope or access changed.',{exact:false}).waitFor();assert.equal(writes.length,beforeBoundary);
        assert.equal(await page.locator('form').count(),0);assert(!((await page.locator('body').innerText()).includes(reason)));assert(!((await page.locator('body').innerText()).includes(approvalReference)));
      }
      await page.reload();await page.getByLabel('Record type',{exact:true}).waitFor();await prepare('Contract',roots.contract.id,v3);await preview('Contract',roots.contract.id);await apply('Contract',roots.contract.id);
      await page.getByRole('status').getByText('A future amendment is pending.',{exact:false}).waitFor();assert.equal(await button('Preview amendment').isDisabled(),true);
      const pending=await amendmentWorkspace(apiRequest,'Contract',roots.contract.id);assert.equal(pending.pending,true);assert.equal(pending.currentTerms.contractVersionId,v2.id);assert.equal(pending.history[0].contractVersionId,v3.id);

      const beforeReaders=writes.length;
      const reader=await createContext(identities.reader,['commercial.contracts.view']);await reader.page.goto(`${baseUrl}/tests/fixtures/commercial-amendments.html`);
      await reader.page.getByLabel('Record type',{exact:true}).waitFor();await reader.page.getByLabel('Record',{exact:true}).selectOption(roots.contract.id);
      await reader.page.getByRole('region',{name:'Protected amendment history',exact:true}).getByText(`Reason: ${reason}`,{exact:true}).first().waitFor();
      assert.equal(await reader.page.locator('form').count(),0);assert.equal(await reader.page.getByRole('button',{name:/^(Preview amendment|Confirm and apply amendment)$/}).count(),0);
      const denied=await createContext(identities.denied,[]);let deniedApiCalls=0;denied.page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))deniedApiCalls++;});
      await denied.page.goto(`${baseUrl}/tests/fixtures/commercial-amendments.html`);await denied.page.getByRole('alert').waitFor();assert.equal(deniedApiCalls,0);
      assert(!((await denied.page.locator('body').innerText()).includes(roots.contract.number)));assert.equal(writes.length,beforeReaders);
      const events=(await pool.query('select * from commercial_amendments order by entity_type,sequence')).rows;assert.equal(events.length,4);
      assert(events.every(event=>event.actor_id===identities.manager.id&&event.active_role==='Admin'&&event.correlation_id&&event.operation_id));
      const audit=(await pool.query("select to_jsonb(a) value from audit_logs a where module='Commercial Amendments'")).rows;assert.equal(audit.length,events.length);
      for(const value of [reason,approvalReference,hostile,'https://example.test/synthetic-amendment.pdf','30000.0002'])assert(!JSON.stringify(audit).includes(value));
      assert(writes.every(write=>write.method==='POST'&&write.path.startsWith(amendmentPrefix)));
      assert(reads.every(read=>read.path.startsWith(amendmentPrefix)||read.path===`${prefix}/lifecycle/workspace`));
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await reader.context.close();await denied.context.close();await manager.context.close();
      console.log('Commercial amendments real React/API/PostgreSQL journey passed: exact preview confirmation, explicit parent-to-child adoption, no cascade, lifecycle-stale conflict/reload, On Hold preservation, pending/current distinction, immutable activation/history, escaped private evidence, scope/token/permission invalidation and read-only/denied privacy.');
    }finally{try{if(browser)await browser.close();}finally{await vite.close();}}
  });
});
