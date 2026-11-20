import {useRef, useState} from 'react';
import {commercialDraftingService, isCommercialDraftingContextCurrent,
  type CommercialDraftingContext, type PurchaseOrder, type PurchaseOrderRelease} from '../services/commercialDrafting';

export function PurchaseOrderReleasePanel({order, context}:{order:PurchaseOrder; context:CommercialDraftingContext}) {
  const [release,setRelease]=useState<PurchaseOrderRelease | null | undefined>(undefined);
  const [balance,setBalance]=useState<Awaited<ReturnType<typeof commercialDraftingService.purchaseOrderBalance>> | null>(null);
  const [reference,setReference]=useState('');
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const inspect = async (write:boolean) => {
    if (pending.current || !isCommercialDraftingContextCurrent(context)) return;
    pending.current=true;
    setBusy(true);
    setError('');
    setBalance(null);
    try {
      const result=await commercialDraftingService.purchaseOrderRelease(order,context,
        write?{approvalReference:reference.trim(),reason:reason.trim()}:undefined);
      if (isCommercialDraftingContextCurrent(context)) setRelease(result);
      if (result && context.canManage && context.canReleasePurchaseOrder) {
        try {
          const amounts=await commercialDraftingService.purchaseOrderBalance(order,context);
          if (isCommercialDraftingContextCurrent(context)) setBalance(amounts);
        } catch {
          if (isCommercialDraftingContextCurrent(context)) setError('Order balance could not be loaded. Inspect release to retry.');
        }
      }
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {
        setRelease(undefined);
        setError('Release status could not be confirmed. Inspect the release before retrying.');
      }
    } finally {
      pending.current=false;
      setBusy(false);
    }
  };
  return <fieldset disabled={busy}>
    <legend>Purchase order release</legend>
    <button type="button" onClick={()=>void inspect(false)}>Inspect release</button>
    {error && <p role="alert">{error}</p>}
    {release && <p>Released {release.releasedAt} · {release.activeRole} · {release.approvalReference}</p>}
    {balance && <p>{order.currency} · Committed {balance.committed} · Gross consumed {balance.consumed} · Available {balance.remaining}
      {balance.warning && <> · Warning threshold reached ({order.warningThresholdPercent}%)</>}</p>}
    {release === null && <p>Awaiting release</p>}
    {release === null && context.canManage && context.canReleasePurchaseOrder && <>
      <label>Approval reference <input value={reference} maxLength={200} onChange={e=>setReference(e.target.value)}/></label>
      <label>Release reason <input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
      <button type="button" disabled={reference.trim().length<3 || reason.trim().length<3}
        onClick={()=>void inspect(true)}>Release purchase order</button>
    </>}
  </fieldset>;
}
