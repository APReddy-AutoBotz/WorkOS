import { hasRatePermission } from '../services/rateCandidates';
import { useState } from 'react';
import { invoiceCsv, type SubmittedReversalReview, type InvoiceReversalRoute, type ReversalCredit, type InvoiceCsvArtifact, type InvoiceCsvSource, type InvoiceLineReversalRequest } from '../services/invoiceCsv';
import type { RateContext } from '../services/rateCandidates';

export function InvoiceLineReversal({ source, state, artifact, run, disabled }: {
  key?: string; source: InvoiceCsvSource; state: 'Exported' | 'Billed/Confirmed'; artifact: InvoiceCsvArtifact;
  run: (fn: (context: RateContext) => Promise<void>) => Promise<void>; disabled: boolean;
}) {
  const [line, select] = useState(''), [reason, setReason] = useState('');
  const [receipt, setReceipt] = useState<InvoiceLineReversalRequest | null | undefined>();
  const [route, setRoute] = useState<InvoiceReversalRoute | null>(null);
  const [review, setReview] = useState<SubmittedReversalReview | null>(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const inspectRoute = () => receipt && void run(async c => {
    setRoute(null);
    setReview(null);
    setCanSubmit(false);
    const saved = await invoiceCsv.submittedReversal(source.id, receipt, c);
    setReview(saved.review);
    if (!saved.review) {
      setRoute(await invoiceCsv.reversalReviewRoute(source.id, receipt, c));
      setCanSubmit(saved.canSubmit);
    }
  });
  const submitReview = () => receipt && route?.status === 'AVAILABLE' && canSubmit && void run(async c => {
    setCanSubmit(false);
    setRoute(null);
    const saved = await invoiceCsv.submittedReversal(source.id, receipt, c, {
      policyId: route.policyId, firstReviewer: route.stages[0], inspectedState: state,
    });
    setReview(saved.review);
  });
  const inspect = () => void run(async c => {
    setRoute(null);
    setReview(null);
    setCanSubmit(false);
    setReceipt(undefined);
    setReceipt(await invoiceCsv.lineReversal(source.id, line, artifact.id, c));
  });
  const submit = () => void run(async c => {
    setRoute(null);
    setReview(null);
    setCanSubmit(false);
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
      <select value={line} onChange={e => {select(e.target.value); setReview(null); setCanSubmit(false); setRoute(null); setReceipt(undefined); setReason('');}}>
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
    {receipt && <button type="button" onClick={inspectRoute}>Check reversal reviewers</button>}
    {receipt && review && <p role="status">Submitted reversal review {review.id} · {review.state ?? 'Pending'} · policy {review.policyId} · first reviewer {review.reviewerRole} {review.reviewerId}</p>}
    {review?.state === 'Approved' && receipt && <CorrectiveEligibility key={review.id} batch={source} lineId={line} requestId={receipt.id} reviewId={review.id} run={run}/>}
    {route?.status === 'NO_REVERSAL_POLICY' && <p>No effective policy enables full-line reversal review.</p>}
    {route?.status === 'REVIEWERS_UNAVAILABLE' && <p>The named reviewers do not meet current access or independence requirements.</p>}
    {route?.status === 'AVAILABLE' && <div>
      <p>Review policy {route.policyId} · effective {route.effectiveFrom}</p>
      {canSubmit && <button type="button" onClick={submitReview}>Submit reversal for independent review</button>}
      <ol>{route.stages.map(stage => <li key={stage.userId}>{stage.role} · {stage.userId}</li>)}</ol>
    </div>}
  </fieldset>;
}


function CorrectiveEligibility({batch,lineId,requestId,reviewId,run}:{
  key?:string;batch:InvoiceCsvSource;lineId:string;requestId:string;reviewId:string;
  run:(fn:(context:RateContext)=>Promise<void>)=>Promise<void>;
}){
  const [credit,setCredit]=useState<ReversalCredit|null>(null);
  const [reason,setReason]=useState('');
  const inspect=()=>void run(async c=>{
    setCredit(null);setReason('');
    setCredit(await invoiceCsv.reversalCredit(batch,lineId,requestId,reviewId,c));
  });
  const issue=()=>credit && void run(async c=>{
    const write={credit,reason:reason.trim()};
    setCredit(null);
    setCredit(await invoiceCsv.reversalCredit(batch,lineId,requestId,reviewId,c,write));
    setReason('');
  });
  return <section aria-label="Corrective billing eligibility">
    <button type="button" onClick={inspect}>Inspect corrective billing eligibility</button>
    {credit && <div>
      <p>Full reversal · {credit.source.currency} {credit.source.amount} · original event {credit.source.originalEventId}</p>
      {credit.receipt ? <p role="status">Approved-unbilled credit {credit.receipt.itemId} · eligibility date {credit.receipt.eligibleOn} · {credit.receipt.reason}</p>
        : <><p>UTC eligibility date {credit.eligibleOn}</p>
          {hasRatePermission('commercial.reversal_eligibility.create') && <>
            <label>Credit issuance reason <input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
            <button type="button" disabled={reason.trim().length<3} onClick={issue}>Issue approved-unbilled credit</button>
          </>}
        </>}
    </div>}
  </section>;
}
