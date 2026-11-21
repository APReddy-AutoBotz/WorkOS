import {useState} from 'react';
import {commercialDraftingService, isCommercialDraftingContextCurrent, type ContractTerms, type CommercialDraftingContext} from '../services/commercialDrafting';

export function RetainerConsumption({contractId,version,context}: {
  contractId:string; version:ContractTerms; context:CommercialDraftingContext;
}) {
  const [periods,setPeriods]=useState<Awaited<ReturnType<typeof commercialDraftingService.retainerConsumption>>>();
  const [status,setStatus]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  async function inspect() {
    setPeriods(undefined);
    setStatus('loading');
    try {
      const result=await commercialDraftingService.retainerConsumption(contractId,version,context);
      if (isCommercialDraftingContextCurrent(context)) {setPeriods(result); setStatus('ready');}
    } catch {setStatus('error');}
  }
  if (!isCommercialDraftingContextCurrent(context)) return null;
  return <div>
    <button type="button" disabled={status==='loading'} className="mt-2 underline" onClick={inspect}>Inspect approved retainer hours</button>
    {status==='loading' && <p role="status">Loading approved hours…</p>}
    {status==='error' && <p role="alert">Approved hours could not be loaded.</p>}
    {periods && <><h5>Approved hours in your worker scope</h5><ul>{periods.map(p=>
      <li key={p.startsOn}>{p.startsOn} through {p.endsOn} · {p.billableHours} billable hours · {p.nonBillableHours} non-billable hours</li>)}</ul></>}
  </div>;
}
