import {useState} from 'react';
import {commercialDraftingService as api,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

type Props={context:CommercialDraftingContext;engagement:string};

export function ServicePolicyEditor({context,engagement,today}:Props & {today:string}) {
  const [policy,setPolicy]=useState<Awaited<ReturnType<typeof api.servicePolicy>>|null>(null);
  const [pending,setPending]=useState(false),[message,setMessage]=useState('');
  const [profile,setProfile]=useState<'disabled'|'accepted_unit'>('disabled');
  const load=async()=>{
    setPending(true);setMessage('');
    try {const result=await api.servicePolicy(engagement,context);if(isCommercialDraftingContextCurrent(context)) setPolicy(result);}
    catch {setPolicy(null);setMessage('Policy could not be loaded.');}
    finally {setPending(false);}
  };
  return <section aria-label="Operational valuation policy" className="mt-4 space-y-2">
    <button type="button" disabled={pending} onClick={()=>void load()}>Inspect valuation policy</button>
    {policy && <form aria-label="Schedule valuation policy" onSubmit={async event=>{
      event.preventDefault();if(pending || !isCommercialDraftingContextCurrent(context)) return;
      const fields=new FormData(event.currentTarget);setPending(true);
      try {
        await api.setServicePolicy(engagement,{previousId:policy.latest?.id??null,profile,effectiveFrom:String(fields.get('date')),
          precision:profile==='accepted_unit'?Number(fields.get('precision')):null,reason:String(fields.get('reason')).trim()},context);
        await load();
      } catch {setMessage('Policy save could not be confirmed. Inspect the current schedule before retrying.');}
      finally {setPending(false);}
    }}>
      <p>Current policy: {policy.effective?.profile==='accepted_unit'?'Accepted units':'Disabled'}</p>
      {policy.latest && <p>Latest scheduled policy: {policy.latest.effectiveFrom} · {policy.latest.profile==='accepted_unit'?'Accepted units':'Disabled'}</p>}
      <fieldset disabled={pending} className="grid gap-2">
        <label>Operational valuation profile<select value={profile} onChange={e=>setProfile(e.target.value as typeof profile)}>
          <option value="disabled">Disabled</option><option value="accepted_unit">Accepted units at contract price</option></select></label>
        <label>Policy effective date<input type="date" name="date" min={today} required/></label>
        {profile==='accepted_unit' && <label>Round half up to decimal places<select name="precision" defaultValue="2">{[0,1,2,3,4].map(n=><option key={n}>{n}</option>)}</select></label>}
        <label>Policy decision reason<input name="reason" minLength={3} maxLength={1000} required/></label><button>Schedule policy</button>
      </fieldset>
    </form>}
    {message && <p role="status">{message}</p>}
  </section>;
}

export function ServiceValueReceipt({context,engagement,evidenceId,reviewId}:Props & {evidenceId:string;reviewId:string}) {
  const [state,setState]=useState<Awaited<ReturnType<typeof api.inspectServiceValue>>|null>(null);
  const [pending,setPending]=useState(false),[message,setMessage]=useState('');
  async function run(save:boolean) {
    if(pending || !isCommercialDraftingContextCurrent(context)) return;
    setPending(true);setMessage('');
    try {
      if(save && state?.policy) await api.recordServiceValue(engagement,evidenceId,reviewId,state.policy.id,context);
      const view=await api.inspectServiceValue(engagement,evidenceId,context);
      if(isCommercialDraftingContextCurrent(context)) setState(view);
    } catch {setState(null);setMessage('Valuation could not be confirmed. Check the price, policy, identities and financial period.');}
    finally {setPending(false);}
  }
  return <div><button type="button" disabled={pending} onClick={()=>void run(false)}>Inspect operational valuation</button>
    {state?.valuation ? <p>Operational management value · {state.valuation.currency} {state.valuation.amount} · {state.valuation.quantity} units at {state.valuation.unitPrice}</p> :
      state?.policy?.profile==='accepted_unit' ? <div><p>Policy effective {state.policy.effectiveFrom} · round half up to {state.policy.precision} decimal places</p>
        <button type="button" disabled={pending} onClick={()=>void run(true)}>Record operational value</button></div> :
        state && <p>Valuation disabled on the service date.</p>}
    {message && <p role="status">{message}</p>}</div>;
}
