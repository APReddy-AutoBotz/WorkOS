import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createFinanceExportProvider} from '../server/modules/invoice-export/finance-provider.mjs';

const limit = 64 * 1024;
const operation = {
  operationId: 'synthetic-operation',
  batchId: 'synthetic-batch',
  artifact: {schemaVersion: 1, sha256: 'a'.repeat(64), lineCount: 1, currency: 'USD', total: '1', bytes: Buffer.from('1')},
};
const {bytes, ...metadata} = operation.artifact;
const receipt = JSON.stringify({...metadata, operationId: operation.operationId, batchId: operation.batchId, status: 'accepted'});
for (const method of ['deliver', 'lookup']) {
  let response;
  const provider = createFinanceExportProvider({
    endpoint: 'https://finance.example.invalid/export',
    token: randomUUID(),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['idempotency-key'], operation.operationId);
      return response;
    },
  });
  for (const declared of [true, false]) {
    let cancelled = false;
    let chunks = 0;
    const payload = new TextEncoder().encode(receipt.padEnd(limit + 1));
    const stream = new ReadableStream({
      pull(controller) {
        const start = chunks * 32768;
        if (start >= payload.length) {
          controller.close();
          return;
        }
        controller.enqueue(payload.subarray(start, start + 32768));
        chunks++;
      },
      cancel() { cancelled = true; },
    }, {highWaterMark: 0});
    response = new Response(stream, {headers: declared ? {'content-length': String(limit + 1)} : {}});
    await assert.rejects(provider[method](operation), /delivery unconfirmed/);
    assert.equal(cancelled, true);
    assert.equal(chunks, declared ? 0 : 3);
  }
  response = new Response(receipt.padEnd(limit));
  assert.equal((await provider[method](operation)).status, 'accepted');
}
console.log('Finance delivery and lookup receipt limits, cancellation and same-operation recovery passed.');
