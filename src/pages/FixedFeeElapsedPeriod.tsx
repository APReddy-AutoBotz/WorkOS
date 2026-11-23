import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function FixedFeeElapsedPeriod({context,engagement,through}:{context:CommercialDraftingContext;engagement:string;through:string}) {
  const [from,setFrom]=useState(through.slice(0,7)+'-01');
  const [data,setData]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeElapsedPeriod>>|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function inspect() {
    setBusy(true);setMessage('');setData(null);
    try {
      const result=await commercialDraftingService.fixedFeeElapsedPeriod(engagement,from,through,context);
      if (isCommercialDraftingContextCurrent(context)) setData(result);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('Choose a period of up to 366 days within your financial scope.');
    } finally {setBusy(false);}
  }
  return <section aria-label="Elapsed-time period reconciliation"><fieldset disabled={busy}>
    <legend>Reconcile daily values through {through}</legend>
    <label>Period starts on <input type="date" value={from} max={through} onChange={e=>{setFrom(e.target.value);setData(null);setMessage('');}}/></label>
    <button type="button" disabled={!from || from>through} onClick={()=>void inspect()}>Reconcile period</button>
  </fieldset>{message && <p role="status">{message}</p>}
    {data && <><p>{data.matched} matched · {data.missing} missing · {data.stale} stale · {data.inapplicable} outside policy</p>
      <p>Reconciled elapsed-time value: {data.amount===null?'Unavailable':data.currency+' '+data.amount}</p>
      <details><summary>Daily reconciliation evidence</summary>
        <table><thead><tr><th>Service date</th><th>Status</th><th>Retained version</th><th>Retained value ({data.currency})</th><th>Current value ({data.currency})</th></tr></thead>
          <tbody>{data.days.map(day=><tr key={day.serviceDay}><td>{day.serviceDay}</td><td>{day.status==='inapplicable'?'Outside policy':day.status}</td>
            <td>{day.version??'—'}</td><td>{day.retainedAmount??'—'}</td><td>{day.applicableAmount??'—'}</td></tr>)}</tbody></table>
      </details></>}
  </section>;
}
