import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function FixedFeeEffort({context,engagement,today}:{context:CommercialDraftingContext;engagement:string;today:string}) {
  const [month,setMonth]=useState(today.slice(0,7));
  const [report,setReport]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeEffort>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [costs,setCosts]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeCosts>>|null>(null);
  const inspectCosts=async(command?:{entryId:string;decisionId:string;adoptionId:string})=>{
    setBusy(true);setMessage('');setCosts(null);
    try {
      if (command) await commercialDraftingService.fixedFeeCosts(engagement,month+'-01',context,command);
      const value=await commercialDraftingService.fixedFeeCosts(engagement,month+'-01',context);
      if (isCommercialDraftingContextCurrent(context)) setCosts(value);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('Work costs could not be confirmed. Inspect the month again.');
    } finally {setBusy(false);}
  };
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
      <label>Effort month <input type="month" value={month} onChange={e=>{setMonth(e.target.value);setCosts(null);setReport(null);setMessage('');}}/></label>
      <button type="button" disabled={!month} onClick={()=>void load()}>Inspect approved effort</button>
      {context.canViewFixedFeeCost && <button type="button" disabled={!month} onClick={()=>void inspectCosts()}>Inspect worker costs</button>}
    </fieldset>
    {costs && context.canViewFixedFeeCost && <section aria-label="Fixed-fee worker costs">
      <p>{costs.unresolvedEntries} unresolved work entries · {costs.entries.filter(e=>e.snapshotId).length} of {costs.entries.length} visible verified entries costed</p>
      {costs.retainedTotals.map(t=><p key={t.currency}>{costs.complete?'Verified monthly cost':'Retained cost subtotal'} {t.currency} {t.amount}</p>)}
      {costs.entries.length===0 && <p>No verified work in your cost scope this month.</p>}
      {costs.entries.map(row=><div key={row.entryId}>
        <p>{row.workDate} · Worker {row.workerId} · Entry {row.entryId} · {row.hours} hours</p>
        {row.amount===null ? <p>No unique adopted worker cost for this date and currency.</p> : <>
          <p>{row.snapshotId?'Retained cost':'Cost preview'} {row.currency} {row.amount} · Hourly rate {row.hourlyRate}</p>
          <p>Priority {row.priority} · Rate {row.candidateId} · Adoption {row.adoptionId} · Effective {row.effectiveFrom} through {row.effectiveTo}</p>
          {!row.snapshotId && context.canRecordFixedFeeCost && <button type="button" disabled={busy}
            onClick={()=>void inspectCosts({entryId:row.entryId,adoptionId:row.adoptionId!,decisionId:row.decisionId!})}>Retain worker cost</button>}
        </>}
      </div>)}
    </section>}
    {report && <p>{report.billableHours} billable hours · {report.nonBillableHours} non-billable hours · {report.verifiedEntries} verified entries · {report.unresolvedEntries} unresolved entries</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
