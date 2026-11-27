import { createHash } from 'node:crypto';

// A provider must deduplicate this key durably, including after a timeout.
// The URL and credential are deployment configuration, never request inputs.
export function createFinanceExportProvider({ endpoint, token, fetchImpl = fetch }) {
  if (!URL.canParse(endpoint)) throw new Error('Invalid finance provider configuration');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !token) {
    throw new Error('Invalid finance provider configuration');
  }

  async function requestReceipt({operationId,batchId,artifact},lookup) {
    const identity = {
      operationId,
      batchId,
      schemaVersion: artifact.schemaVersion,
      sha256: artifact.sha256,
      lineCount: artifact.lineCount,
      currency: artifact.currency,
      total: artifact.total,
    };
    let response;
    try {
      const target = new URL(url);
      if (lookup) target.searchParams.set('operationId', operationId);
      response = await fetchImpl(target, {
        method: lookup ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'idempotency-key': operationId,
        },
        ...(lookup ? {} : {body: JSON.stringify({ ...identity, payloadBase64: artifact.bytes.toString('base64') })}),
      });
    } catch {
      throw new Error('Finance provider delivery unconfirmed');
    }
    if (!response.ok) throw new Error('Finance provider delivery unconfirmed');
    const receipt = await response.json().catch(() => null);
    if (!['accepted','permanently_rejected'].includes(receipt?.status) ||
        !Object.entries(identity).every(([key, value]) => receipt[key] === value)) {
      throw new Error('Finance provider receipt does not match the export');
    }
    return { ...identity, status: receipt.status };
  }
  return {
    destinationHash: createHash('sha256').update(url.href).digest('hex'),
    deliver: input => requestReceipt(input,false),
    lookup: input => requestReceipt(input,true),
  };
}
