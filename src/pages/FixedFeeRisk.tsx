import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

const labels={
  no_work:'No approved work through this date.',
  incomplete:'Some approved work still needs a verified cost.',
  remaining:'Retained labor cost is below the engagement allocation.',
  exhausted:'Retained labor cost has consumed the engagement allocation.',
  exceeded:'Retained labor cost exceeds the engagement allocation.',
};
export function FixedFeeRisk({context,engagement,today}:{context:CommercialDraftingContext;engagement:string;today:string}) {
  const [through,setThrough]=useState(today.slice(0,10));
  const [report,setReport]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeRisk>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const inspect=async()=>{
    setReport(null);setBusy(true);setMessage('');
    try {
      const result=await commercialDraftingService.fixedFeeRisk(engagement,through,context);
      if (isCommercialDraftingContextCurrent(context)) setReport(result);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('The engagement allocation and worker costs could not be verified.');
    } finally {setBusy(false);}
  };
  return <section aria-label="Fixed-fee allocation risk">
    <fieldset disabled={busy}>
      <legend>Engagement allocation and labor cost</legend>
      <label>Include work through <input type="date" value={through} max={today.slice(0,10)} onChange={e=>{setThrough(e.target.value);setReport(null);setMessage('');}}/></label>
      <button type="button" disabled={!through} onClick={()=>void inspect()}>Check allocation risk</button>
    </fieldset>
    {report && <div>
      <p>{labels[report.status]}</p>
      <p>Engagement allocation {report.currency} {report.allocation} · Retained labor cost {report.retainedCost} · Allocation less retained cost {report.remainingAllocation}</p>
      {report.effortBudget && <div>
        <p>Budgeted hours {report.effortBudget.budgetHours} · Verified hours {report.effortBudget.verifiedHours} · Remaining hours {report.effortBudget.remainingHours}</p>
        {report.effortBudget.unresolvedEntries>0 && <p>Unresolved effort entries {report.effortBudget.unresolvedEntries}</p>}
        {report.effortBudget.status==='exceeded' && <p>Verified effort exceeds the approved hours budget.</p>}
      </div>}
      {report.laborCostBudget===null ? <p>No approved labor-cost budget for this date.</p> : <>
        <p>Approved labor-cost budget {report.currency} {report.laborCostBudget} · Budget less retained labor cost {report.remainingLaborBudget}</p>
        {report.laborBudgetStatus==='exceeded' && <p>Retained labor cost exceeds the approved labor-cost budget.</p>}
      </>}
      <p>{report.costedEntries} retained costs · {report.approvedEntries} approved entries · Contract version {report.contractVersionId}{report.amendmentId && ' · Amendment '+report.amendmentId}</p>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
