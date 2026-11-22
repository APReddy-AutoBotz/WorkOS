import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function ServicePeriodMargin({context,engagement,today}:{context:CommercialDraftingContext;engagement:string;today:string}) {
  const [month,setMonth]=useState(today.slice(0,7));
  const [state,setState]=useState<Awaited<ReturnType<typeof commercialDraftingService.serviceMargin>>|null>(null);
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState(false);
  const inspect=async(options:{version?:number;expectedToken?:string}={})=>{
    setPending(true);setMessage('');setState(null);
    try {
      const result=await commercialDraftingService.serviceMargin(engagement,month+'-01',context,options);
      if (isCommercialDraftingContextCurrent(context)) setState(result);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('This financial period could not be confirmed. Inspect the month again.');
    } finally {setPending(false);}
  };
  return <section aria-label="Managed-service period margin">
    <h5>Managed-service period margin</h5>
    <fieldset disabled={pending}>
      <label>Reporting month<input type="month" value={month} max={today.slice(0,7)} onChange={e=>{setMonth(e.target.value);setState(null);setMessage('');}}/></label>
      <button type="button" disabled={!month} onClick={()=>void inspect()}>Inspect month</button>
      {state && <>
        <p>{state.version?'Retained version '+state.version:'Current evidence'} · {state.currency}</p>
        <p>Registered billable value {state.billable} · Retained worker cost {state.cost}</p>
        {state.margin===null ? <p>Margin unavailable. Check accepted effort, worker costs and approved time coverage.</p> :
          <p>Gross margin {state.margin} · {state.percent===null?'Percentage unavailable':state.percent+'%'}</p>}
        <p>Approved hours {state.hours} · Verified entries {state.verified} of {state.entries} · Pending receipts {state.pending} · Missing costs {state.missing} · Unreconciled receipts {state.unresolved}</p>
        {state.version===null && context.canRetainServiceMargin && (state.entries+state.receipts+state.billingEvents)>0 &&
          <button type="button" onClick={()=>void inspect({expectedToken:state.token})}>Retain month</button>}
        {(state.version??state.latestVersion+1)>1 && <button type="button" onClick={()=>void inspect({version:(state.version??state.latestVersion+1)-1})}>Previous retained version</button>}
      </>}
    </fieldset>
    {message && <p role="status">{message}</p>}
  </section>;
}
