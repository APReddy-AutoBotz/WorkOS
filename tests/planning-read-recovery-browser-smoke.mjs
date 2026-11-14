import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const vite=await createServer({root,mode:'production',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
let browser;
try{
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const pending=kind=>page.waitForFunction(kind=>window.planningRecoveryHarness?.pending().includes(kind),kind);
 const settle=(kind,outcome)=>page.evaluate(([kind,outcome])=>window.planningRecoveryHarness.settle(kind,outcome),[kind,outcome]);
 const frames=()=>page.evaluate(()=>new Promise(resolve=>{let count=0;const next=()=>++count===10?resolve():requestAnimationFrame(next);requestAnimationFrame(next);}));
 await page.goto(origin+'/tests/fixtures/planning-read-recovery.html',{waitUntil:'domcontentloaded',timeout:60000});
 for(const kind of ['planning','pm']){
  if(kind==='pm')await page.getByRole('button',{name:'Open PM',exact:true}).click();
  const empty=kind==='planning'?'No capacity signals match the current filters.':'No managed projects in this scope.';
  const retry=kind==='planning'?'Retry resource planning':'Retry PM workspace';
  await pending(kind);assert.equal(await page.getByText(empty,{exact:true}).count(),0);
  await settle(kind,'failed');await page.getByRole('alert').filter({hasText:'could not be loaded'}).waitFor();assert.equal(await page.getByText(empty,{exact:true}).count(),0);assert.equal(await page.getByText('Synthetic private database diagnostic').count(),0);
  await page.getByRole('button',{name:retry,exact:true}).click();await pending(kind);await settle(kind,'denied');await page.getByRole('alert').filter({hasText:'not authorized'}).waitFor();assert.equal(await page.getByText('Synthetic private permission diagnostic').count(),0);
  await page.getByRole('button',{name:retry,exact:true}).click();await pending(kind);await settle(kind,'empty');await page.getByText(empty,{exact:true}).waitFor();await frames();
  assert.equal(await page.evaluate(kind=>window.planningRecoveryHarness.counts()[kind],kind),3,'Rendering a newly parsed session must not refetch');
  await page.getByRole('button',{name:'Hide workspace',exact:true}).click();await page.getByRole('button',{name:'Show workspace',exact:true}).click();await pending(kind);
  await page.getByRole('button',{name:'Hide workspace',exact:true}).click();await page.getByRole('button',{name:'Show workspace',exact:true}).click();
  await page.waitForFunction(kind=>window.planningRecoveryHarness.pending().filter(item=>item===kind).length===2,kind);
  await settle(kind,'failed');await frames();assert.equal(await page.getByRole('alert').count(),0);await settle(kind,'populated');
  if(kind==='pm'){await page.getByRole('link',{name:'Synthetic managed project',exact:true}).waitFor();assert.equal(await page.getByText('Synthetic other project',{exact:true}).count(),0);}
  else await page.getByText('7',{exact:true}).waitFor();
 }
 assert.deepEqual(errors,[]);console.log('PASS: planning/PM failure, denied read, retry, honest empty state, stable load count and obsolete rejection');
}finally{await browser?.close();await vite.close();}
