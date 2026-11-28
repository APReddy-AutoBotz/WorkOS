import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {INVOICE_EXPORT_EVENT_KEYS} from '../../shared/invoice-export-notification.mjs';

export async function configureFixedFeeNotices({call,ok,reviewerKey,today,engagementId,reviewer,preparer}) {
  const configure=(path,body)=>call('/api/v1/invoice-export-notice-config'+path,{...body,expectedOwnerKey:reviewerKey,requestId:randomUUID(),reason:'Synthetic installment notice policy'});
  const route=ok(await configure('/routes',{routeKey:randomUUID(),expectedLatestId:null,label:'Synthetic fixed-fee export',active:true})).route;
  ok(await configure('/policies',{expectedLatestId:null,effectiveFrom:today,definition:{entityType:'InvoiceExport',engagementId,
    financeOwner:{userId:reviewer.id,role:reviewer.role},integrationAdmin:{userId:preparer.id,role:preparer.role},alertRouteId:route.id,
    locale:'en-US',completionInApp:true,templates:INVOICE_EXPORT_EVENT_KEYS.map(key=>({key,subject:'Invoice {{sourceRef}}',body:'Status {{sourceRef}}'}))}}));
}

export async function verifyFixedFeeExport({apiRequest,pool,page,engagementId,batchId,reviewer,preparer,today,reviewerKey,registered,instance,change,grant}) {
  const csv='/api/v1/invoice-csv',schema='workos.invoice-fixed-fee-csv/2';
  const call=(path,body)=>apiRequest(path,body?{identity:reviewer,method:'POST',body}:{identity:reviewer});
  const ok=(r,status=201)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
  await configureFixedFeeNotices({call,ok,reviewerKey,today,engagementId,reviewer,preparer});
  const batch=ok(await call(csv+'/batches/'+batchId),200).batch;
  const command={expectedOwnerKey:reviewerKey,requestId:randomUUID(),batchId,approvalId:instance,finalTransitionId:batch.finalTransitionId,
    lineageHash:batch.lineageHash,schemaVersion:schema,expectedLineCount:1,expectedTotal:'12000',reason:'Verify installment export'};
  assert.equal((await call(csv+'/exports',{...command,expectedTotal:'1'})).status,409);
  assert.equal((await call(csv+'/exports',{...command,schemaVersion:'workos.invoice-tm-csv/1'})).status,409);
  const desk=page.getByRole('region',{name:'Invoice CSV export'});
  await desk.getByLabel('Invoice export engagement').selectOption(engagementId);
  await desk.getByRole('button',{name:'Load invoice export batches'}).click();
  await desk.getByLabel('Invoice export batch').selectOption(batchId);
  await desk.getByRole('button',{name:'Inspect invoice export source'}).click();
  await desk.getByLabel('Invoice CSV schema').selectOption(schema);
  await desk.getByRole('checkbox',{name:'I inspected the final approval, retained lineage and control total'}).check();
  await desk.getByLabel('Invoice CSV reason').fill(command.reason);
  await pool.query(`create function reject_installment_notice() returns trigger language plpgsql as $$
    begin raise exception 'Synthetic notice refusal' using errcode='INC02'; end $$`);
  await pool.query('create trigger reject_installment_notice before insert on invoice_export_notice_events for each row execute function reject_installment_notice()');
  let saved;
  try {
    const receipt=page.waitForResponse(r=>r.url().endsWith(csv+'/exports') && r.request().method()==='POST');
    await desk.getByRole('button',{name:'Accept invoice CSV artifact'}).click();
    saved=await receipt;
    assert.equal(saved.status(),201,await saved.text());
  } finally {
    await pool.query('drop trigger reject_installment_notice on invoice_export_notice_events');
    await pool.query('drop function reject_installment_notice()');
  }
  const a=(await saved.json()).artifact;
  await desk.getByRole('region',{name:'Verified invoice CSV'}).waitFor();
  const download=page.waitForEvent('download');
  await desk.getByText('Download verified invoice CSV',{exact:true}).click();
  const chunks=[];for await(const chunk of await (await download).createReadStream()) chunks.push(chunk);
  const bytes=Buffer.concat(chunks);
  assert.deepEqual(bytes,Buffer.from(a.payloadBase64,'base64'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);
  const parts=bytes.toString('utf8').split('\r\n');
  const row=parts[1].split(',');
  assert.equal(ok(await call(csv+'/exports',saved.request().postDataJSON()),200).artifact.id,a.id);
  const recovery=page.getByRole('region',{name:'Invoice notification recovery'});
  await recovery.getByLabel('Invoice recovery engagement').selectOption(engagementId);
  await recovery.getByRole('button',{name:'Load invoice recovery batches'}).click();
  await recovery.getByLabel('Invoice recovery batch',{exact:true}).selectOption(batchId);
  const targetsPath=csv+'/notice-recovery-sources/'+batchId;
  const targetResponse=page.waitForResponse(r=>r.url().endsWith(targetsPath));
  await recovery.getByRole('button',{name:'Load invoice recovery targets'}).click();
  const {targets}=await (await targetResponse).json();
  assert.deepEqual(targets.map(t=>t.kind),['producer']);
  await recovery.getByLabel('Invoice recovery target').selectOption(targets[0].id);
  await recovery.getByLabel('Invoice recovery reason').fill('Recover the original installment export notice');
  const recoveryResponse=page.waitForResponse(r=>r.url().endsWith(csv+'/notice-recoveries') && r.request().method()==='POST');
  await recovery.getByRole('button',{name:'Attempt invoice notice recovery'}).click();
  const recovered=await recoveryResponse;
  assert.equal(recovered.status(),201,await recovered.text());
  await recovery.getByText(/Recovery attempt recorded/).waitFor();
  assert.deepEqual(ok(await call(targetsPath),200).targets,[]);
  assert.equal((await pool.query('select id from invoice_export_notice_events where batch_id=$1 and artifact_id=$2',[batchId,a.id])).rowCount,1);
  assert.equal(ok(await call(csv+'/artifacts/'+a.id),200).artifact.sha256,a.sha256);
  const mutate=async(index,value)=>{
    const line=[...row];line[index]=value;
    const payload=Buffer.from([parts[0],line.join(','),''].join('\r\n'));
    const tampered={...a,payloadBase64:payload.toString('base64'),sha256:createHash('sha256').update(payload).digest('hex')};
    return page.evaluate(async artifact=>{
      try {await window.verifyFixedFeeInvoiceCsv(artifact);return true;} catch {return false;}
    },tampered);
  };
  assert.equal(await mutate(19,'2'),false);
  assert.equal(await mutate(8,'b64:'+Buffer.from('another-contract-version').toString('base64')),false);
  assert.equal(await mutate(15,'12001'),false);
  const decode=field=>{assert(field.startsWith('b64:'));return Buffer.from(field.slice(4),'base64').toString('utf8');};
  assert.equal(row[19],'1');
  const evidence=JSON.parse(decode(row[9]));
  assert.deepEqual([row[0],row[4],row[6],row[7],decode(row[8]),evidence.installment,evidence.dueOn,row[15]],
    [schema,registered.itemId,registered.eventId,'FIXED_FEE_INSTALLMENT',registered.contractVersionId,1,registered.dueOn,'12000']);
  await change(reviewer.role,[grant],false);
  assert.equal((await call(csv+'/artifacts/'+a.id)).status,403);
  assert.equal((await call(csv+'/confirmation-sources/'+batchId)).status,403);
  assert.equal((await call(targetsPath)).status,403);
  await change(reviewer.role,[grant],true);
  const attestation={expectedOwnerKey:reviewerKey,requestId:randomUUID(),batchId,artifactId:a.id,artifactVersion:1,artifactSha256:a.sha256,
    currency:a.currency,total:a.total,reference:'Synthetic downstream installment',reason:'Matched downstream installment receipt'};
  assert.equal((await call(csv+'/confirmations',{...attestation,artifactSha256:'0'.repeat(64)})).status,409);
  const confirmed=await attestFixedFeeInBrowser(page,engagementId,batchId,attestation.reference,attestation.reason);
  const retained=(await confirmed.json()).confirmation;
  assert.deepEqual([retained.sourceType,retained.artifactSha256,retained.total],['FIXED_FEE_INSTALLMENT',a.sha256,a.total]);
  assert.equal(ok(await call(csv+'/confirmations',confirmed.request().postDataJSON()),200).confirmation.id,retained.id);
  assert.equal(ok(await call(csv+'/batches/'+batchId),200).batch.state,'Billed/Confirmed');
  assert.equal((await pool.query('select count(*)::int n from invoice_csv_artifacts where batch_id=$1',[batchId])).rows[0].n,1);
  return {a,receipt:retained,attestationRequest:confirmed.request().postDataJSON(),exportCmd:saved.request().postDataJSON()};
}

export async function attestFixedFeeInBrowser(page,engagementId,batchId,reference,reason) {
  const confirmation=page.getByRole('region',{name:'Invoice billing confirmation'});
  await confirmation.getByLabel('Invoice confirmation engagement').selectOption(engagementId);
  await confirmation.getByRole('button',{name:'Load invoice confirmation batches'}).click();
  await confirmation.getByLabel('Invoice confirmation batch').selectOption(batchId);
  await confirmation.getByRole('button',{name:'Inspect exported invoice artifact'}).click();
  const inspect=confirmation.getByRole('region',{name:'Inspected confirmation source'});
  await inspect.getByText(/fixed-fee installment/).waitFor();
  await inspect.getByLabel('Invoice confirmation reference').fill(reference);
  await inspect.getByLabel('Invoice confirmation reason').fill(reason);
  await inspect.getByRole('checkbox').check();
  const result=page.waitForResponse(r=>r.url().endsWith('/api/v1/invoice-csv/confirmations') && r.request().method()==='POST');
  await inspect.getByRole('button',{name:'Record manual billing attestation'}).click();
  const confirmed=await result;assert.equal(confirmed.status(),201,await confirmed.text());
  return confirmed;
}
