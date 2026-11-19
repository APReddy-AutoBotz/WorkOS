import { useState } from 'react';
import { invoiceCsv, type InvoiceCsvArtifact, type InvoiceCsvSource, type InvoiceLineReversalRequest } from '../services/invoiceCsv';
import type { RateContext } from '../services/rateCandidates';

export function InvoiceLineReversal({ source, state, artifact, run, disabled }: {
  key?: string; source: InvoiceCsvSource; state: 'Exported' | 'Billed/Confirmed'; artifact: InvoiceCsvArtifact;
  run: (fn: (context: RateContext) => Promise<void>) => Promise<void>; disabled: boolean;
}) {
  const [line, select] = useState(''), [reason, setReason] = useState('');
  const [receipt, setReceipt] = useState<InvoiceLineReversalRequest | null | undefined>();
  const inspect = () => void run(async c => {
    setReceipt(undefined);
    setReceipt(await invoiceCsv.lineReversal(source.id, line, artifact.id, c));
  });
  const submit = () => void run(async c => {
    setReceipt(undefined);
    const result = await invoiceCsv.lineReversal(source.id, line, artifact.id, c, {
      sha256: artifact.sha256, inspectedState: state, reason: reason.trim(),
    });
    setReceipt(result);
    setReason('');
  });
  return <fieldset disabled={disabled} className="space-y-2">
    <legend>Full line reversal request</legend>
    <p>A request records the reason for finance review. The exported amount and line reservation stay in place.</p>
    <label>Exported line to review
      <select value={line} onChange={e => {select(e.target.value); setReceipt(undefined); setReason('');}}>
        <option value="">Choose an exported line</option>
        {source.lines.map(l => <option key={l.lineId} value={l.lineId}>Line {l.sequence} · {l.currency} {l.amount} · {l.lineId}</option>)}
      </select>
    </label>
    <button type="button" disabled={!line} onClick={inspect}>Check reversal request</button>
    {receipt === null && <>
      <label>Full reversal reason <input value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} /></label>
      <button type="button" disabled={reason.trim().length < 3} onClick={submit}>Request full line reversal</button>
    </>}
    {receipt && <p role="status">Reversal requested · {receipt.id} · {receipt.createdAt} · {receipt.reason}</p>}
  </fieldset>;
}
