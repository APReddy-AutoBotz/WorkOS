import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

type Register=Awaited<ReturnType<typeof commercialDraftingService.purchaseOrderRisks>>;

export function PurchaseOrderRiskRegister({context,today}:{context:CommercialDraftingContext;today:string}) {
  const [expiresBy,setExpiresBy]=useState(today);
  const [result,setResult]=useState<Register|null>(null);
  const [routing,setRouting]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const pending=useRef(false);

  async function load(after:string|null) {
    if (pending.current || !isCommercialDraftingContextCurrent(context)) return;
    pending.current=true;
    setBusy(true);setError('');
    if (!after) setResult(null);
    try {
      const page=await commercialDraftingService.purchaseOrderRisks(routing?today:expiresBy,after,context,routing);
      if (!isCommercialDraftingContextCurrent(context)) return;
      if (after && result?.asOf!==page.asOf) {
        setResult(null);
        setError('The UTC date changed. Check purchase-order risks again to refresh the register.');
      } else {
        setResult(previous=>after && previous ? {...page,orders:[...previous.orders,...page.orders]} : page);
      }
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setError('Could not load purchase-order risks. Check the date and your current access.');
    } finally {pending.current=false;setBusy(false);}
  }
  return <fieldset disabled={busy}>
    <legend>Released purchase-order risks</legend>
    <label><input type="checkbox" checked={routing} onChange={e=>{setRouting(e.target.checked);setResult(null);setError('');}}/> Show orders missing alert assignments or owners</label>
    <label>Include orders expiring through <input type="date" disabled={routing} min={today} value={expiresBy} onChange={e=>{
      setExpiresBy(e.target.value);setResult(null);setError('');
    }}/></label>
    <button type="button" disabled={!routing && (!expiresBy || expiresBy<today)} onClick={()=>void load(null)}>Check purchase-order risks</button>
    {error && <p role="alert">{error}</p>}
    {result && <div>
      <p>Balances as of {result.asOf} UTC</p>
      {!result.orders.length && <p>{routing?'Every released order has assigned engagements with available owners.':'No released orders meet the expiry or balance warning criteria.'}</p>}
      <ul>{result.orders.map(order=><li key={order.id}><strong>{order.number}</strong>
        <p>{[order.expired?'Expired':order.expiresInWindow?'Expires in selected window':null,
          order.exhausted?'Exhausted':null,order.warning?'Warning threshold reached':null].filter(Boolean).join(' · ')}</p>
        {order.assignedCount===0 && <p>No engagements assigned for alerts</p>}
        {Boolean(order.unavailableOwners) && <p>Assigned engagements with an unavailable owner: {order.unavailableOwners}</p>}
        <p>Ends {order.endsOn} · {order.currency} · Committed {order.committed} · Gross consumed {order.consumed} · Available {order.remaining}</p>
      </li>)}</ul>
      {result.nextAfter && <button type="button" onClick={()=>void load(result.nextAfter)}>Load more at-risk orders</button>}
    </div>}
  </fieldset>;
}
