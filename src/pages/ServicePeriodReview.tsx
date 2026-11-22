import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext,type ContractTerms} from '../services/commercialDrafting';

export function ServicePeriodReview({contractId,version,context,today}:{contractId:string;version:ContractTerms;context:CommercialDraftingContext;today:string}) {
  const [start,setStart]=useState(''), [reason,setReason]=useState(''), [inspected,setInspected]=useState(false);
  const [receipt,setReceipt]=useState<Awaited<ReturnType<typeof commercialDraftingService.servicePeriodReview>>>(null);
  const [busy,setBusy]=useState(false), [message,setMessage]=useState('');
  const active=useRef(false);
  const terms=version.servicePeriodCharges??[], selected=terms.find(t=>t.startsOn===start);
  async function run(decision?:'Approved'|'Rejected') {
    if (!selected || active.current || !isCommercialDraftingContextCurrent(context)) return;
    active.current=true;setBusy(true);setMessage('');
    try {
      const result=await commercialDraftingService.servicePeriodReview(contractId,version,selected,context,decision?{decision,reason}:undefined);
      if (isCommercialDraftingContextCurrent(context)) {setReceipt(result);setInspected(true);}
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {setInspected(false);setMessage('Inspect the period again to verify its status.');}
    } finally {active.current=false;setBusy(false);}
  }
  return <fieldset disabled={busy}><legend>Fixed-period charge review</legend>
    <label>Service period <select value={start} onChange={e=>{setStart(e.target.value);setInspected(false);setReceipt(null);setReason('');setMessage('');}}>
      <option value="">Select a period</option>
      {terms.map(t=><option key={t.startsOn} value={t.startsOn}>{t.startsOn} to {t.endsOn} · {version.currency} {t.amount}</option>)}
    </select></label>
    <button type="button" disabled={!selected} onClick={()=>run()}>Inspect period decision</button>
    {inspected && (receipt?<p role="status">{receipt.decision} · {receipt.id} · {receipt.reason}</p>:
      <><p>Pending review</p>{context.canReviewPeriods && selected && selected.endsOn<today &&
        <><label>Period decision reason <input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
          <button type="button" disabled={reason.trim().length<3} onClick={()=>run('Approved')}>Approve period charge</button>
          <button type="button" disabled={reason.trim().length<3} onClick={()=>run('Rejected')}>Reject period charge</button></>}</>)}
    {message && <p role="alert">{message}</p>}
  </fieldset>;
}
