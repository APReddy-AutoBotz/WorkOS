import assert from 'node:assert/strict';
import {verifyFixedFeeExport} from './fixed-fee-export-journey.mjs';
import {runMigrations} from '../../server/migrate.mjs';
import {withCommercialMigrationsThrough,migrateCommercialDatabase} from './commercial-drafting-test.mjs';
import {randomUUID} from 'node:crypto';

export async function verifyFixedFeeBatchApproval({pool,apiRequest,createContext,baseUrl,identities,engagementId,today,draftGrants,grant,createCommand,lineCommand,registered,reversalScenario}) {
  const preparer=identities.reader,reviewer=identities.manager;
  const access=[...draftGrants,grant,'commercial.contracts.manage','commercial.invoice_approval.manage','commercial.invoice_approval.decide','approvals.view'];
  access.push('commercial.invoice_batch.confirm','reports.export','commercial.invoice_export.view','commercial.invoice_export.create',
    'commercial.invoice_export.configure','integrations.invoice_alert_routes.manage');
  const roles=[preparer.role,reviewer.role];
  const saved=(await pool.query('select role_name,permission_key,enabled from role_permissions where role_name=any($1) and permission_key=any($2)',[roles,access])).rows;
  const change=async(role,keys,enabled)=>pool.query(`insert into role_permissions(role_name,permission_key,enabled) select $1,k,$3 from unnest($2::text[]) k
    on conflict(role_name,permission_key) do update set enabled=excluded.enabled`,[role,keys,enabled]);
  const act=(path,who,body)=>apiRequest('/api/v1/invoice-batch-approvals'+path,body?{identity:who,method:'POST',body}:{identity:who});
  const post=(path,body)=>apiRequest('/api/v1/invoice-drafts/'+path,{identity:preparer,method:'POST',body});
  const ok=(r,status=201)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
  try {
    for (const role of roles) await change(role,access,true);
    const batch=ok(await post('batches',{...createCommand,requestId:randomUUID()})).batch;
    const line=ok(await post('batches/'+batch.id+'/lines',{...lineCommand,requestId:randomUUID()}));
    if (reversalScenario==='approved credit') {
      const retained=async()=>(await pool.query(`select to_jsonb(b) batch,to_jsonb(l) line,to_jsonb(o) occupancy
        from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id join invoice_draft_occupancies o on o.line_id=l.id
        where b.id=$1`,[batch.id])).rows;
      const prior=await retained();assert.equal(prior.length,1);
      await withCommercialMigrationsThrough(96,async rootDir=>assert.deepEqual((await runMigrations({pool,rootDir,logger:{log(){}}})).applied,['096_wos06_fixed_fee_invoice_approval']));
      assert.deepEqual(await retained(),prior);

    }
    const source=ok(await act('/sources/'+batch.id,preparer),200);
    assert.equal(source.batch.total,'12000');
    assert.equal(source.batch.lines[0].eventId,registered.eventId);
    const configure=(who,prior)=>act('/policies',preparer,{expectedOwnerKey:source.ownerKey,engagementId,requestId:randomUUID(),
      expectedLatestId:prior,effectiveFrom:today,definition:{entityType:'InvoiceBatch',engagementId,locale:'en-US',completionInApp:true,
        stages:[{userId:who.id,role:who.role}],templates:['approval.action_required','approval.rejected_or_correction_required','approval.completed']
          .map(key=>({key,subject:'Review {{sourceRef}}',body:'Stage {{stageNumber}}'}))},reason:'Review the due installment'});
    const submit=(policy,hash=source.batch.lineageHash)=>act('/requests',preparer,{requestId:randomUUID(),expectedOwnerKey:source.ownerKey,batchId:batch.id,
      expectedPolicyId:policy,expectedLineCount:1,expectedLineageHash:hash,reason:'Submit verified installment for independent review'});
    const self=ok(await configure(preparer,null));
    assert([403,409].includes((await submit(self.policy.id)).status));
    await change(reviewer.role,[grant],false);
    assert.equal((await act('/sources/'+batch.id,reviewer)).status,403);
    assert.equal((await configure(reviewer,self.policy.id)).status,403);
    await change(reviewer.role,[grant],true);
    const policy=ok(await configure(reviewer,self.policy.id)).policy;
    assert.equal((await submit(policy.id,'0'.repeat(64))).status,409);
    const instance=ok(await submit(policy.id)).approval.id;
    const decisionPath='/instances/'+instance+'/decisions';
    const attempt=(who,key)=>act(decisionPath,who,{expectedOwnerKey:key,requestId:randomUUID(),expectedSequence:0,
      decision:'Approved',reason:'Verify the named stage and original installment identities'});
    assert([403,409].includes((await attempt(preparer,source.ownerKey)).status));
    const reviewerKey=ok(await act('/sources/'+batch.id,reviewer),200).ownerKey;
    const author=(await pool.query('select author_worker_id from fixed_fee_installment_identities where event_id=$1',[registered.eventId])).rows[0].author_worker_id;
    await pool.query("update employees set status='On Leave' where id=$1",[author]);
    try {
      assert([403,409].includes((await attempt(reviewer,reviewerKey)).status));
      assert.equal((await pool.query('select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',[instance])).rows[0].n,0);
    } finally {await pool.query("update employees set status='Active' where id=$1",[author]);}
    const browser=await createContext(reviewer,access);
    try {
      const page=browser.page;
      await page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      const desk=page.getByRole('region',{name:'Invoice batch approvals'});
      await desk.getByLabel('Invoice approval engagement').selectOption(engagementId);
      await desk.getByRole('button',{name:'Load invoice batches and reviews'}).click();
      await desk.getByLabel('Invoice batch review',{exact:true}).selectOption(instance);
      await desk.getByRole('button',{name:'Inspect invoice review'}).click();
      await desk.getByText(/installment 1 due/).first().waitFor();
      const decision=reversalScenario==='approved credit'?'Approved':'Rejected';
      await desk.getByLabel('Invoice approval decision',{exact:true}).selectOption(decision);
      await desk.getByLabel('Invoice approval decision reason').fill('Checked the installment amount, due date and original approval');
      const response=page.waitForResponse(r=>r.url().endsWith('/instances/'+instance+'/decisions') && r.request().method()==='POST');
      await desk.getByRole('button',{name:'Record invoice approval decision'}).click();
      const r=await response;assert.equal(r.status(),201,await r.text());
      assert.equal(ok(await act('/sources/'+batch.id,preparer),200).batch.state,decision==='Approved'?'Approved':'Draft');
      if (decision==='Approved') {
        const prior=ok(await act('/sources/'+batch.id,preparer),200).batch;
        await withCommercialMigrationsThrough(97,async rootDir=>assert.deepEqual((await runMigrations({pool,rootDir,logger:{log(){}}})).applied,['097_wos06_fixed_fee_invoice_export']));
        assert.deepEqual(ok(await act('/sources/'+batch.id,preparer),200).batch,prior);
        const delivery=await verifyFixedFeeExport({apiRequest,pool,page,engagementId,batchId:batch.id,reviewer,preparer,today,reviewerKey,registered,instance,change,grant});
        const evidence=async()=>(await pool.query(`select to_jsonb(a) artifact,to_jsonb(o) occupancy,to_jsonb(l) line
          from invoice_csv_artifacts a join invoice_draft_lines l on l.batch_id=a.batch_id
          join invoice_draft_occupancies o on o.line_id=l.id where a.id=$1`,[delivery.a.id])).rows;
        const before=await evidence();
        assert.equal(before.length,1);
        assert.deepEqual((await migrateCommercialDatabase(pool)).applied,['098_wos06_fixed_fee_credit_corrections','099_wos06_fixed_fee_work_costs']);
        assert.deepEqual(await evidence(),before);
        assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
        return {...delivery,batchId:batch.id,lineId:line.line.id,policyId:policy.id};
      }
      assert.equal((await pool.query('select 1 from invoice_draft_occupancies where item_id=$1 and batch_id=$2',[registered.itemId,batch.id])).rowCount,1);
    } finally {await browser.context.close();}
  } finally {
    for (const role of roles) for (const k of access) {
      const prior=saved.find(p=>p.role_name===role && p.permission_key===k);
      if(prior) await change(role,[k],prior.enabled);
      else await pool.query('delete from role_permissions where role_name=$1 and permission_key=$2',[role,k]);
    }
  }
}
