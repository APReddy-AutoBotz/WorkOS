import {hasRatePermission} from '../services/rateCandidates';
import {useState} from 'react';
import {commercialDraftingService, isCommercialDraftingContextCurrent, type ContractTerms, type CommercialDraftingContext} from '../services/commercialDrafting';

export function RetainerConsumption({contractId,version,context}: {
  contractId:string; version:ContractTerms; context:CommercialDraftingContext;
}) {
  const [periods,setPeriods]=useState<Awaited<ReturnType<typeof commercialDraftingService.retainerConsumption>>>();
  const [status,setStatus]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const [preview,setPreview]=useState<Awaited<ReturnType<typeof commercialDraftingService.retainerOveragePreview>>>();
  const [previewStatus,setPreviewStatus]=useState<'idle'|'loading'|'error'>('idle');
  async function inspectPricing() {
    setPreview(undefined);setPreviewStatus('loading');
    try {
      const result=await commercialDraftingService.retainerOveragePreview(contractId,version,context);
      if (isCommercialDraftingContextCurrent(context)) {setPreview(result);setPreviewStatus('idle');}
    } catch {setPreviewStatus('error');}
  }
  async function inspect() {
    setPeriods(undefined);setPreview(undefined);setPreviewStatus('idle');
    setStatus('loading');
    try {
      const result=await commercialDraftingService.retainerConsumption(contractId,version,context);
      if (isCommercialDraftingContextCurrent(context)) {setPeriods(result); setStatus('ready');}
    } catch {setStatus('error');}
  }
  if (!isCommercialDraftingContextCurrent(context)) return null;
  return <div>
    <button type="button" disabled={status==='loading' || previewStatus==='loading'} className="mt-2 underline" onClick={inspect}>Inspect approved retainer hours</button>
    {status==='loading' && <p role="status">Loading approved hours…</p>}
    {status==='error' && <p role="alert">Approved hours could not be loaded.</p>}
    {periods && <><h5>Approved hours in your worker scope</h5><ul>{periods.map(p=>
      <li key={p.startsOn}><span>{p.startsOn} through {p.endsOn} · {p.billableHours} billable hours · {p.nonBillableHours} non-billable hours</span>
        {p.capacity && <p>Contract capacity in hours · {p.capacity.carriedIn} brought forward · {p.capacity.consumed} consumed · {p.capacity.remaining} remaining · {p.capacity.overage} over capacity · {p.capacity.carriedOut} carried forward · {p.capacity.expired} expired</p>}</li>)}</ul></>}
    {version.retainerOveragePolicy && periods?.some(p=>p.capacity) && hasRatePermission('commercial.rate_candidates.view') && <>
      <button type="button" className="mt-2 underline" disabled={previewStatus==='loading'} onClick={inspectPricing}>Preview excess-hour pricing</button>
      {previewStatus==='loading' && <p role="status">Loading pricing…</p>}
      {previewStatus==='error' && <p role="alert">Excess-hour pricing could not be loaded.</p>}
      {preview && <><h5>Excess-hour pricing preview</h5><ul>{preview.map(p=><li key={p.startsOn}>
        {p.startsOn} through {p.endsOn} · {p.hours} excess hours · {p.status==='missing' ? 'No adopted hourly rate covers the period end' :
          p.status==='conflict' ? 'Highest-priority adopted rates conflict' : p.status==='no_charge' ? 'No charge under this contract' :
          p.status==='no_excess' ? 'No excess hours to price' : `Unrounded amount ${version.currency} ${p.amount}`}
        {p.source && <p>Hourly rate {version.currency} {p.source.hourlyRate} · effective {p.source.effectiveFrom} through {p.source.effectiveTo} · candidate {p.source.candidateId} · adoption {p.source.adoptionId} · approval {p.source.approvalId}</p>}
      </li>)}</ul></>}
    </>}
  </div>;
}
