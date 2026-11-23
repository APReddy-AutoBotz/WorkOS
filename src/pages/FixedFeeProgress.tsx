import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function FixedFeeProgress({context,engagement,through}:{context:CommercialDraftingContext;engagement:string;through:string}) {
  const [data,setData]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeProgress>>|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function inspect(version?:number,retain=false) {
    setBusy(true);setMessage('');
    try {
      const command=retain && data?.token?{expectedToken:data.token,expectedVersion:data.latestVersion}:undefined;
      const result=await commercialDraftingService.fixedFeeProgress(engagement,through,context,{version,command});
      if (isCommercialDraftingContextCurrent(context)) setData(result);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {setData(null);setMessage('Inspect the current policy and approved delivery evidence again.');}
    } finally {setBusy(false);}
  }
  const r=data?.report;
  return <section aria-label="Fixed-fee delivery progress"><fieldset disabled={busy}>
    <legend>Cumulative earned-management value through {through}</legend>
    <button type="button" onClick={()=>void inspect()}>Inspect approved delivery progress</button>
    {data && (r?<><p>{r.billableHours} billable hours + {r.nonBillableHours} non-billable hours = {r.verifiedHours} verified hours against {r.budgetHours} budgeted hours</p>
      <p>Approved allocation {r.currency} {r.allocation} · Approval {r.approvalReference}</p>
      <p>Cumulative effort value: {r.amount===null?'Unavailable':r.currency+' '+r.amount}</p>
      {r.unresolved>0 && <p>{r.unresolved} approved entries require evidence reconciliation.</p>}
      {r.amount!==null && context.canRecordFixedFeeProgress && <button type="button" onClick={()=>void inspect(undefined,true)}>Retain progress value</button>}</>:
      <p>No effective approved delivery-effort policy for this date.</p>)}
    {data?.saved && <><p>Retained progress version {data.saved.version} · {data.saved.report.currency} {data.saved.report.amount} · {data.saved.report.verifiedHours} verified hours</p>
      {data.saved.version>1 && <button type="button" onClick={()=>void inspect(data.saved!.version-1)}>Previous progress version</button>}</>}
  </fieldset>{message && <p role="status">{message}</p>}</section>;
}
