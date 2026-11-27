import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const fetchOriginal = globalThis.fetch;
let accepted;
let lookupCount=0;
globalThis.fetch = async (url, options) => {
  if (new URL(url).origin==='https://finance.example.invalid' && options.method==='GET') {
    if (!accepted || new URL(url).searchParams.get('operationId')!==JSON.parse(accepted).operationId)return new Response(null,{status:404});
    assert.equal(options.body,undefined);
    const {payloadBase64,...identity}=JSON.parse(accepted);
    lookupCount++;
    return Response.json({...identity,sha256:lookupCount===1?'0'.repeat(64):identity.sha256,status:'accepted'});
  }
  if (String(url) !== 'https://finance.example.invalid/fixture') return fetchOriginal(url, options);
  const { payloadBase64, ...receipt } = JSON.parse(options.body);
  assert.equal(receipt.operationId, options.headers['idempotency-key']);
  assert.equal(receipt.sha256, createHash('sha256').update(Buffer.from(payloadBase64,'base64')).digest('hex'));
  if (process.env.WORKOS_FIXTURE_REJECT_INVOICE === 'true') {
    assert.equal(accepted,undefined);
    accepted = options.body;
    return Response.json({...receipt,status:'permanently_rejected'});
  }
  if (!accepted) {
    accepted = options.body;
    throw new Error('Connection closed after provider acceptance');
  }
  assert.equal(options.body,accepted);
  return Response.json({...receipt,status:'accepted'});
};
