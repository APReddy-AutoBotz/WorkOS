import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function ServiceEffortCost({context,engagement,evidenceId,reviewId}:{context:CommercialDraftingContext;engagement:string;evidenceId:string;reviewId:string}) {
  const [state,setState]=useState<Awaited<ReturnType<typeof commercialDraftingService.effortCost>>|null>(null);
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState(false);
  const busy=useRef(false);
  const inspect=async(adoptionId?:string)=>{
    if (busy.current || !isCommercialDraftingContextCurrent(context)) return;
    busy.current=true;setPending(true);setMessage('');setState(null);
    try {
      const result=await commercialDraftingService.effortCost(engagement,evidenceId,reviewId,context,adoptionId);
      if (isCommercialDraftingContextCurrent(context)) setState(result);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('Cost could not be confirmed. Inspect the effort cost again to recover its current status.');
    } finally {busy.current=false;setPending(false);}
  };
  const source=state?.snapshot??state?.preview;
  return <section aria-label="Service effort cost">
    <button type="button" disabled={pending} onClick={()=>void inspect()}>Inspect effort cost</button>
    {source && <p>{state?.snapshot?'Retained cost':'Estimated cost'} · {source.currency} {source.amount} · {source.hours} hours at {source.hourlyRate} per hour · priority {source.priority} · adopted rate {source.adoptionId} · effective {source.effectiveFrom} through {source.effectiveTo}</p>}
    {state?.preview && context.canRecordEffortCost && <button type="button" disabled={pending} onClick={()=>void inspect(state.preview?.adoptionId)}>Retain effort cost</button>}
    {state && !source && <p>No cost available for this receipt. Check the effort, review and adopted hourly worker rate.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
