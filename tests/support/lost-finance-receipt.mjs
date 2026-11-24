import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const fetchOriginal = globalThis.fetch;
let accepted;
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://finance.example.invalid/fixture') return fetchOriginal(url, options);
  const { payloadBase64, ...receipt } = JSON.parse(options.body);
  assert.equal(receipt.operationId, options.headers['idempotency-key']);
  assert.equal(receipt.sha256, createHash('sha256').update(Buffer.from(payloadBase64,'base64')).digest('hex'));
  if (!accepted) {
    accepted = options.body;
    throw new Error('Connection closed after provider acceptance');
  }
  assert.equal(options.body, accepted);
  return Response.json({ ...receipt, status: 'accepted' });
};
