import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
let browser;
try {
 await vite.listen();const base=`http://127.0.0.1:${vite.httpServer.address().port}`;
 browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.clock.setFixedTime(new Date('2026-11-13T12:00:00Z'));
 await page.goto(`${base}/tests/fixtures/timesheet-ownership.html`,{timeout:60000});
 const count=async(kind,n)=>page.waitForFunction(({kind,n})=>window.ownership[kind].length===n,{kind,n});
 const release=async(kind,index,sequence)=>page.evaluate(({kind,index,sequence})=>window.ownership[kind](index,sequence),{kind,index,sequence});
 const shown=async sequence=>page.getByText(`Submission ${sequence}: 1 work entries retained, including 1 governed entries.`,{exact:true}).waitFor();
 const previous=()=>page.locator('button:has(svg.lucide-chevron-left)').click();
 const next=()=>page.locator('button:has(svg.lucide-chevron-right)').click();
 await count('reads',1);await previous();await count('reads',2);
 assert.equal(await page.getByRole('region',{name:'Work submission assurance',exact:true}).count(),0,'hide evidence until current read completes');
 assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
 await release('releaseRead',1,22);await shown(22);
 await release('releaseRead',0,11);await page.waitForTimeout(100);
 assert.equal(await page.getByText('Submission 22: 1 work entries retained, including 1 governed entries.',{exact:true}).count(),1,'late A read must not replace current B assurance');
 // A -> B -> A must not revive the first A request.
 await next();await count('reads',3);await previous();await count('reads',4);await next();await count('reads',5);
 await release('releaseRead',4,55);await shown(55);await release('releaseRead',2,33);await release('releaseRead',3,44);await page.waitForTimeout(100);await shown(55);
 // A dispatched save may finish, but cannot publish into another week.
 await page.getByRole('button',{name:'Submit for Approval',exact:true}).click();await count('saves',1);
 await previous();await count('reads',6);await release('releaseRead',5,66);await shown(66);
 await release('releaseSave',0,99);await page.waitForTimeout(100);await shown(66);
 assert.equal(await page.getByText('Awaiting Review',{exact:true}).count(),0);
 // Identity replacement also invalidates a pending save and pending read.
 await page.getByRole('button',{name:'Save Draft',exact:true}).click();await count('saves',2);
 await page.getByRole('button',{name:'Replace identity',exact:true}).click();await count('reads',7);
 await page.getByRole('button',{name:'Replace identity',exact:true}).click();await count('reads',8);
 await release('releaseRead',7,88);await shown(88);await release('releaseRead',6,77);await release('releaseSave',1,101);await page.waitForTimeout(100);await shown(88);
 // Do not even dispatch a save if ownership changed during its settings preflight.
 await page.evaluate(()=>window.ownership.holdSettings());
 await page.getByRole('button',{name:'Save Draft',exact:true}).click();await count('settings',1);
 await previous();await count('reads',9);await release('releaseRead',8,89);await shown(89);
 await page.evaluate(()=>window.ownership.releaseSettings(0));await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.ownership.saves.length),2);
 // Current-owner completion still works, with duplicate clicks suppressed.
 await page.getByRole('button',{name:'Submit for Approval',exact:true}).click();await count('saves',3);
 assert.equal(await page.getByRole('button',{name:'Submit for Approval',exact:true}).isDisabled(),true);
 await release('releaseSave',2,123);await shown(123);await page.getByText('Awaiting Review',{exact:true}).waitFor();
 // Failed scope switches clear work immediately and never reload before command settlement.
 await previous();await count('reads',10);await release('releaseRead',9,130);await shown(130);
 const reload=page.getByRole('button',{name:'Reload work',exact:true});
 const readyToReload=()=>page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Reload work'&&!b.disabled));
 await page.getByRole('button',{name:'Save Draft',exact:true}).click();await count('saves',4);
 await page.evaluate(()=>window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
 assert.equal(await reload.isDisabled(),true,'wait for dispatched command before reconciling');
 assert.equal(await page.getByRole('region',{name:'Work submission assurance',exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>window.ownership.reads.length),10,'scope invalidation must not start a pre-commit read');
 await release('releaseSave',3,199);await readyToReload();
 assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
 assert.equal(await page.getByText('Draft timesheet saved.',{exact:true}).count(),0);
 await reload.click();await count('reads',11);await release('releaseRead',10,132);await shown(132);
 // Invalidated settings preflight must send no POST, then permit explicit reload.
 await page.evaluate(()=>window.ownership.holdSettings());
 await page.getByRole('button',{name:'Save Draft',exact:true}).click();await count('settings',2);
 await page.evaluate(()=>window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
 assert.equal(await reload.isDisabled(),true);
 await page.evaluate(()=>window.ownership.releaseSettings(1));await readyToReload();
 assert.equal(await page.evaluate(()=>window.ownership.saves.length),4);
 assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
 await reload.click();await count('reads',12);await release('releaseRead',11,134);await shown(134);
 await page.getByRole('button',{name:'Save Draft',exact:true}).click();await count('saves',5);
 await release('releaseSave',4,135);await shown(135);
 // Scope-invalidated reads cannot restore metadata or readiness, in either timing order.
 for (const before of [true,false]) {
   await reload.click();const pending=await page.evaluate(()=>window.ownership.reads.length);
   if(before)await release('releaseRead',pending-1,137);
   await page.evaluate(()=>window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
   if(!before)await release('releaseRead',pending-1,137);
   await page.waitForTimeout(100);
   assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
   assert.equal(await page.getByRole('region',{name:'Work submission assurance',exact:true}).count(),0);
   await reload.click();const fresh=await page.evaluate(()=>window.ownership.reads.length);
   await release('releaseRead',fresh-1,138);await shown(138);
 }
 assert.deepEqual(errors,[]);
 console.log('MyTimesheet ownership browser passed: held reads/saves, A-B-A navigation and identity replacement; synthetic timing, no database acceptance claim.');
} finally {await browser?.close();await vite.close();}
