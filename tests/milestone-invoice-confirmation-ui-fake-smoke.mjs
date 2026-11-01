import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';

// All requests are fulfilled with synthetic in-memory responses.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,actor=id(1),scope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};
const user={id:actor,employeeId:actor,userName:'synthetic',role:'Admin',permissionRole:'Admin',permissions:['commercial.contracts.view','commercial.tm_billing.view','commercial.milestone_billing.view','commercial.invoice_drafts.view','commercial.invoice_export.view','commercial.invoice_batch.confirm','employees.view','notifications.view']};
const ownerKey=createHash('sha256').update(JSON.stringify([user.userName,user.id,user.role,scope.organizationId,scope.legalEntityId])).digest('hex'),envelope={...scope,ownerKey,actorUserId:actor,activeRole:'Admin',serverDate:'2026-10-29'},createdAt='2026-10-29T01:00:00Z';
const batch={id:id(2),sourceType:'MILESTONE_ACCEPTANCE',clientId:'synthetic-client',contractId:'synthetic-contract',engagementId:'synthetic-engagement',currency:'USD',periodStart:'2026-10-01',periodEnd:'2026-10-31',periodBasis:'ELIGIBLE_DATE',ownerUserId:id(3),ownerRole:'Admin',preparerUserId:actor,preparerRole:'Admin',requestId:id(4),reason:'Synthetic draft',createdAt,ownerCurrent:true,state:'Exported'};
const source={sourceType:'MILESTONE_ACCEPTANCE',batchId:batch.id,state:'Exported',artifactId:id(5),artifactVersion:1,artifactSha256:'a'.repeat(64),currency:'USD',total:'125.15'};
let calls=0;const vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),mode:'production',clearScreen:false,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});let browser,ctx;
try{
 await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;browser=await chromium.launch({headless:true});ctx=await browser.newContext();await ctx.addInitScript(({user,scope})=>{sessionStorage.setItem('workos_session',JSON.stringify(user));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token','synthetic-token');},{user,scope});const page=await ctx.newPage();page.setDefaultTimeout(20000);
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let payload;
  if(req.method()==='GET'&&path==='/api/v1/invoice-drafts/batches')payload={...envelope,batches:[batch],nextAfter:null};
  else if(req.method()==='GET'&&path===`/api/v1/invoice-csv/confirmation-sources/${batch.id}`)payload={...envelope,source,confirmation:null};
  else if(req.method()==='POST'&&path==='/api/v1/invoice-csv/confirmations'){const d=req.postDataJSON();calls++;assert.equal(d.artifactId,source.artifactId);assert.equal(d.artifactVersion,1);assert.equal(d.artifactSha256,source.artifactSha256);assert.equal(d.currency,'USD');assert.equal(d.total,'125.15');assert(!('sourceType'in d));payload={...envelope,confirmation:{id:id(6),sourceType:'MILESTONE_ACCEPTANCE',batchId:batch.id,artifactId:source.artifactId,artifactVersion:1,artifactSha256:source.artifactSha256,currency:'USD',total:'125.15',method:'MANUAL_ATTESTATION',reference:d.reference,actorId:actor,activeRole:'Admin',requestId:d.requestId,reason:d.reason,operationId:'synthetic',confirmedAt:createdAt},replayed:false};}
  else throw Error(`Unexpected synthetic request ${req.method()} ${path}`);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});
 });
 await page.goto(origin+'/tests/fixtures/milestone-invoice-confirmation.html');const ui=page.getByRole('region',{name:'Invoice billing confirmation'});await ui.getByLabel('Invoice confirmation engagement').selectOption(batch.engagementId);await ui.getByRole('button',{name:'Load invoice confirmation batches'}).click();await ui.getByLabel('Invoice confirmation batch').selectOption(batch.id);await ui.getByRole('button',{name:'Inspect exported invoice artifact'}).click();await ui.getByText(/milestone source/).waitFor();await ui.getByLabel('Invoice confirmation reference').fill('Synthetic downstream reference');await ui.getByLabel('Invoice confirmation reason').fill('Synthetic attestation');await ui.getByLabel('I attest the referenced downstream confirmation matches this exact artifact and total').check();await ui.getByRole('button',{name:'Record manual billing attestation'}).click();await ui.getByText('Manual downstream attestation recorded. No provider verification or payment is implied.').waitFor();assert.equal(calls,1);
 console.log('Synthetic React milestone manual attestation retains exact artifact binding with mocked API only.');
}finally{await ctx?.close();await browser?.close();await vite.close();}
