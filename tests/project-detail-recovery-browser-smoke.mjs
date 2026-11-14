import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const vite=await createServer({root,mode:'production',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
let browser;
try {
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const waitPending=id=>page.waitForFunction(id=>window.projectDetailHarness.pending().includes(id),id);
 const settle=(id,outcome)=>page.evaluate(([id,outcome])=>window.projectDetailHarness.settle(id,outcome),[id,outcome]);
 const heading=id=>page.getByRole('heading',{name:`Synthetic ${id}`,exact:true,level:1});
 await page.goto(origin+'/tests/fixtures/project-detail-recovery.html',{waitUntil:'domcontentloaded',timeout:60000});
 await waitPending('alpha');await settle('alpha','found');await heading('alpha').waitFor();
 await page.getByRole('button',{name:'Update Project',exact:true}).click();await page.getByRole('heading',{name:'Edit Project',exact:true}).waitFor();
 // Simulate route navigation while a modal is open; normal pointer clicks are intentionally blocked by its overlay.
 await page.getByRole('button',{name:'Open beta',exact:true}).dispatchEvent('click');await waitPending('beta');
 assert.equal(await heading('alpha').count(),0);assert.equal(await page.getByRole('heading',{name:'Edit Project',exact:true}).count(),0);
 await settle('beta','failed');await page.getByRole('alert').waitFor();
 assert.equal(await page.getByText('Synthetic private database detail').count(),0);
 assert.equal(await page.getByRole('heading',{name:'Project Not Found',exact:true}).count(),0);
 await page.getByRole('button',{name:'Retry loading project',exact:true}).click();await waitPending('beta');await settle('beta','found');await heading('beta').waitFor();
 await page.getByRole('button',{name:'Open alpha',exact:true}).click();await waitPending('alpha');await settle('alpha','denied');await page.getByRole('heading',{name:'Project details are not authorized',exact:true}).waitFor();
 assert.equal(await heading('beta').count(),0);assert.equal(await page.getByText('Synthetic private authorization detail').count(),0);
 await page.getByRole('button',{name:'Retry loading project',exact:true}).click();await waitPending('alpha');await settle('alpha','found');await heading('alpha').waitFor();
 await page.getByRole('button',{name:'Open missing',exact:true}).click();await waitPending('missing');await settle('missing','missing');await page.getByRole('heading',{name:'Project Not Found',exact:true}).waitFor();assert.equal(await heading('beta').count(),0);
 await page.getByRole('button',{name:'Open alpha',exact:true}).click();await waitPending('alpha');
 await page.getByRole('button',{name:'Open gamma',exact:true}).click();await waitPending('gamma');await settle('gamma','found');await heading('gamma').waitFor();
 await settle('alpha','found');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await heading('gamma').count(),1);assert.equal(await heading('alpha').count(),0);
 await page.getByRole('button',{name:'Open beta',exact:true}).click();await waitPending('beta');await page.getByRole('button',{name:'Hide detail',exact:true}).click();await settle('beta','failed');
 await page.getByRole('button',{name:'Show detail',exact:true}).click();await waitPending('beta');await settle('beta','found');await heading('beta').waitFor();
 await page.getByRole('button',{name:'Open no identifier',exact:true}).click();await page.getByRole('heading',{name:'Project Not Found',exact:true}).waitFor();
 assert.equal(await page.getByRole('status',{name:'Loading project details'}).count(),0);assert.deepEqual(errors,[]);
 console.log('PASS: project detail route, missing, failure/retry, edit reset, obsolete response and unmount recovery');
} finally {await browser?.close();await vite.close();}
