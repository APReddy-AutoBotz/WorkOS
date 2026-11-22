import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function FixedFeeEffort({context,engagement,today}:{context:CommercialDraftingContext;engagement:string;today:string}) {
  const [month,setMonth]=useState(today.slice(0,7));
  const [report,setReport]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeEffort>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const load=async()=>{
    setBusy(true);setReport(null);setMessage('');
    try {
      const value=await commercialDraftingService.fixedFeeEffort(engagement,month+'-01',context);
      if (isCommercialDraftingContextCurrent(context)) setReport(value);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('Approved effort could not be loaded.');
    } finally {setBusy(false);}
  };
  return <section aria-label="Fixed-fee approved effort">
    <fieldset disabled={busy}>
      <legend>Approved effort in your worker scope</legend>
      <label>Effort month <input type="month" value={month} onChange={e=>{setMonth(e.target.value);setReport(null);setMessage('');}}/></label>
      <button type="button" disabled={!month} onClick={()=>void load()}>Inspect approved effort</button>
    </fieldset>
    {report && <p>{report.billableHours} billable hours · {report.nonBillableHours} non-billable hours · {report.verifiedEntries} verified entries · {report.unresolvedEntries} unresolved entries</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
