import assert from 'node:assert/strict';

export async function verifyFixedFeeCredit({apiRequest,postAs,pool,identities,createContext,baseUrl,csv,reviewRoot,
  batchId,lineId,artifact,confirmedReceipt,engagementId,managerKey,readerKey,policy,definition,today,exportGrants,grant}) {
  const {manager,reader}=identities;
  const get=async(path,identity=reader)=>{
    const response=await apiRequest(path,{identity});
    assert.equal(response.status,200,JSON.stringify(response.body));
    return response.body;
  };
  const post=(path,identity,body)=>apiRequest(path,{identity,method:'POST',body});
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Employee','commercial.invoice_export.view',true) on conflict(role_name,permission_key) do update set enabled=true");
  const root=csv+'/batches/'+batchId;
  const pin=(await pool.query('select contract_version_id from commercial_engagements where id=$1',[engagementId])).rows[0].contract_version_id;
  const held=await post('/lifecycle/Engagement/'+engagementId+'/transitions',manager,{
    expectedSequence:1,state:'On Hold',contractVersionId:pin,reason:'Hold new work after billing the installment',approvalReference:null});
  assert.equal(held.status,201,JSON.stringify(held.body));
  const current=(await pool.query('select fixed_fee_invoice_item_current(b,l.item_id,$2,$3) current from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id where b.id=$1',[batchId,reader.id,reader.role])).rows[0].current;
  assert.equal(current,false);
  const requestPath=root+'/lines/'+lineId+'/reversal-request';
  const request={expectedOwnerKey:readerKey,artifactId:artifact.id,sha256:artifact.sha256,inspectedState:'Billed/Confirmed',reason:'Reverse the entire invoiced installment'};
  assert.equal((await post(requestPath,reader,{...request,sha256:'0'.repeat(64)})).status,409);
  const recorded=(await postAs(requestPath,reader,request)).request;
  assert.equal(recorded.confirmationId,confirmedReceipt.id);
  assert.equal((await get(requestPath+'/review-route')).route.status,'NO_REVERSAL_POLICY');
  const enabled=(await postAs(reviewRoot+'/policies',manager,{expectedOwnerKey:managerKey,requestId:crypto.randomUUID(),engagementId,
    expectedLatestId:policy.id,effectiveFrom:today,definition:{...definition,fullLineReversals:true},reason:'Enable named installment correction reviewers'})).policy;
  const review=(await postAs(requestPath+'/review',reader,{expectedOwnerKey:readerKey,requestId:recorded.id,policyId:enabled.id,inspectedState:'Billed/Confirmed'})).review;
  const decisions='/api/v1/work-approvals/reversal-reviews/'+review.id;
  const inspected=(await get(decisions,manager)).review;
  assert.deepEqual([inspected.sourceType,inspected.sha256,inspected.confirmationId],['FIXED_FEE_INSTALLMENT',artifact.sha256,confirmedReceipt.id]);
  const decision={expectedOwnerKey:managerKey,expectedSequence:0,policyId:enabled.id,confirmationId:confirmedReceipt.id,decision:'Approved',reason:'Approve full installment credit'};
  assert.ok([403,404].includes((await post(decisions+'/decisions',reader,{...decision,expectedOwnerKey:readerKey})).status));
  await postAs(decisions+'/decisions',manager,decision);
  const eligibility=requestPath+'/eligibility';
  const credit=(await get(eligibility)).source;
  assert.equal(credit.amount,'-12000');
  const issue={expectedOwnerKey:readerKey,reviewId:review.id,decisionId:credit.decisionId,confirmationId:confirmedReceipt.id,eligibleOn:today,reason:'Issue independently approved installment credit'};
  assert.equal((await post(eligibility,reader,issue)).status,403);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Employee','commercial.reversal_eligibility.create',true) on conflict(role_name,permission_key) do update set enabled=true");
  const issued=(await postAs(eligibility,reader,issue)).receipt;
  assert.equal((await post(eligibility,reader,issue)).body.receipt.eventId,issued.eventId);
  const reservePath=root+'/correction-drafts';
  const reserved=(await postAs(reservePath,reader,{expectedOwnerKey:readerKey,requestId:crypto.randomUUID(),itemIds:[issued.itemId],reason:'Reserve the issued installment credit'})).receipt;
  const proof=await get(reservePath+'/'+reserved.batchId);
  assert.equal(proof.lines[0].artifactSha256,artifact.sha256);
  const source=(await get(reviewRoot+'/sources/'+reserved.batchId)).batch;
  const approval=(await postAs(reviewRoot+'/requests',reader,{expectedOwnerKey:readerKey,batchId:reserved.batchId,requestId:crypto.randomUUID(),
    expectedPolicyId:enabled.id,expectedLineCount:1,expectedLineageHash:source.lineageHash,reason:'Submit fixed-fee correction batch'})).approval;
  await postAs(reviewRoot+'/instances/'+approval.id+'/decisions',manager,{expectedOwnerKey:managerKey,requestId:crypto.randomUUID(),expectedSequence:0,decision:'Approved',reason:'Approve the fixed-fee correction batch'});
  const approved=(await get(csv+'/batches/'+reserved.batchId,manager)).batch;
  const exported=(await postAs(csv+'/exports',manager,{expectedOwnerKey:managerKey,requestId:crypto.randomUUID(),batchId:reserved.batchId,
    approvalId:approval.id,finalTransitionId:approved.finalTransitionId,lineageHash:approved.lineageHash,schemaVersion:'workos.invoice-credit-csv/1',
    expectedTotal:issued.amount,expectedLineCount:1,reason:'Retain the signed installment credit'})).artifact;
  const confirm=(await get(csv+'/confirmation-sources/'+reserved.batchId,manager)).source;
  const applied=(await postAs(csv+'/confirmations',manager,{expectedOwnerKey:managerKey,requestId:crypto.randomUUID(),batchId:reserved.batchId,
    artifactId:exported.id,artifactVersion:exported.version,artifactSha256:exported.sha256,currency:confirm.currency,total:confirm.total,
    reference:'SYNTHETIC-FEE-CREDIT',reason:'Checked downstream credit application'})).confirmation;
  assert.equal(applied.total,issued.amount);
  const original=(await pool.query(`select a.sha256,invoice_batch_governed_state(a.batch_id) state,o.line_id
    from invoice_csv_artifacts a join invoice_draft_occupancies o on o.batch_id=a.batch_id
    where a.id=$1 and o.line_id=$2`,[artifact.id,lineId])).rows;
  assert.deepEqual(original,[{sha256:artifact.sha256,state:'Billed/Confirmed',line_id:lineId}]);
  const browser=await createContext(manager,exportGrants);
  await browser.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
  const desk=browser.page.getByRole('region',{name:'Invoice CSV export'});
  await desk.getByLabel('Invoice export engagement').selectOption(engagementId);
  await desk.getByRole('button',{name:'Load invoice export batches'}).click();
  await desk.getByLabel('Invoice export batch',{exact:true}).selectOption(batchId);
  await desk.getByRole('button',{name:'Inspect invoice export source'}).click();
  await desk.getByRole('button',{name:'Check exported credits'}).click();
  await desk.getByText(/Downstream application attested/).waitFor();
  await browser.context.close();
  await pool.query("update role_permissions set enabled=false where role_name='Employee' and permission_key=$1",[grant]);
  assert.equal((await apiRequest(root+'/exported-credits',{identity:reader})).status,403);
  assert.equal((await apiRequest(csv+'/issued-credits?engagementId='+engagementId,{identity:reader})).status,403);
}
