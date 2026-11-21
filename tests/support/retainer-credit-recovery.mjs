import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {withCommercialApi} from './commercial-drafting-test.mjs';
import {verifyRestoredArchive} from './postgres-archive-recovery.mjs';

export async function verifyRecoveredCredit(source, evidence) {
  assert.ok(evidence?.original && evidence?.credit, 'A billed retainer and an applied credit are required');
  await verifyRestoredArchive(source, 'Billed retainer and applied credit recovery', async target => {
    const {original,credit,finance} = evidence;
    const prefix = '/api/v1/invoice-csv';
    await withCommercialApi({...target, identities:source.identities}, async ({request}) => {
      for (const {artifact,confirmation,itemId} of [original,credit]) {
        const path = prefix + '/artifacts/' + artifact.id;
        const denied = await request(path,{identity:source.identities.reader});
        assert.equal(denied.status,artifact.schemaVersion==='workos.invoice-credit-csv/1' ? 404 : 403);
        assert.equal(denied.body.artifact,undefined);
        const recovered = await request(path,{identity:finance});
        assert.equal(recovered.status,200);
        assert.deepEqual(recovered.body.artifact,artifact);
        const bytes = Buffer.from(recovered.body.artifact.payloadBase64,'base64');
        assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);
        const inspected = await request(prefix+'/confirmation-sources/'+artifact.batchId,{identity:finance});
        assert.equal(inspected.status,200);
        assert.equal(inspected.body.source.state,'Billed/Confirmed');
        assert.deepEqual(inspected.body.confirmation,confirmation);
        const {rows} = await target.pool.query(
          'select item_id from invoice_draft_occupancies where batch_id=$1',[artifact.batchId]);
        assert.deepEqual(rows,[{item_id:itemId}]);
        const replay = await request(prefix+'/confirmations',{method:'POST',identity:finance,body:{
          expectedOwnerKey:inspected.body.ownerKey,requestId:confirmation.requestId,batchId:artifact.batchId,
          artifactId:artifact.id,artifactVersion:artifact.version,artifactSha256:artifact.sha256,
          currency:artifact.currency,total:artifact.total,reference:confirmation.reference,reason:confirmation.reason,
        }});
        assert.equal(replay.status,200);
        assert.equal(replay.body.replayed,true);
        assert.deepEqual(replay.body.confirmation,confirmation);
      }
    });
    const verifier=await target.pool.connect();
    try {
      await verifier.query('begin');
      await verifier.query("set local search_path = ''");
      const policies=await verifier.query(
        `select public.valid_invoice_batch_approval_policy(definition) as valid,
           public.valid_invoice_batch_approval_policy(definition || '{"fullLineReversals":false}'::jsonb) as malformed
         from public.invoice_batch_approval_policies`);
      assert.ok(policies.rowCount>0);
      assert.ok(policies.rows.every(row=>row.valid===true && row.malformed===false));
    } finally {
      await verifier.query('rollback');
      verifier.release();
    }
    const totals = await target.pool.query(
      `select credit.currency, trim_scale(credit.amount + original.amount)::text as balance,
        credit.billing_evidence->>'artifactSha256' as original_hash
       from approved_unbilled_items ci join billing_eligibility_events credit on credit.id=ci.event_id
       join billing_eligibility_events original on original.id=credit.reverses_event_id and original.currency=credit.currency
       join approved_unbilled_items oi on oi.event_id=original.id
       where ci.id=$1 and oi.id=$2 and credit.source_type='FULL_LINE_REVERSAL' and original.source_type='RETAINER_PERIOD'`,
      [credit.itemId,original.itemId]);
    assert.deepEqual(totals.rows,[{currency:original.artifact.currency,balance:'0',original_hash:original.artifact.sha256}]);
  });
}
