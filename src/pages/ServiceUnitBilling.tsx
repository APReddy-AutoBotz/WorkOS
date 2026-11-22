import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function ServiceUnitBilling({context,engagement,evidenceId,reviewId}:{context:CommercialDraftingContext;engagement:string;evidenceId:string;reviewId:string}) {
  const busy=useRef(false),[pending,setPending]=useState(false),[reason,setReason]=useState(''),[message,setMessage]=useState('');
  const [state,setState]=useState<Awaited<ReturnType<typeof commercialDraftingService.serviceRegister>>|null>(null);
  async function inspect(issue:boolean) {
    if (busy.current || !isCommercialDraftingContextCurrent(context)) return;
    busy.current=true;setPending(true);setMessage('');
    try {
      const result=await commercialDraftingService.serviceRegister(engagement,evidenceId,reviewId,context,issue?{reason:reason.trim()}:undefined);
      if(isCommercialDraftingContextCurrent(context)) setState(result);
    } catch {
      setState(null);setMessage('Registration could not be confirmed. Inspect billing eligibility again before retrying.');
    } finally {busy.current=false;setPending(false);}
  }
  return <section aria-label="Accepted-unit billing">
    <button type="button" disabled={pending} onClick={()=>void inspect(false)}>Inspect billing eligibility</button>
    {state?.receipt ? <p>Approved unbilled · {state.receipt.currency} {state.receipt.amount} · {state.receipt.eligibleOn} · {state.receipt.itemId}</p> :
      state?.charge ? <fieldset disabled={pending}><p>Contractual charge · {state.charge.currency} {state.charge.amount}</p>
        <label>Billing decision reason<textarea value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
        <button type="button" disabled={reason.trim().length<3} onClick={()=>void inspect(true)}>Register accepted-unit charge</button></fieldset> :
        state && <p>No eligible contractual charge.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
