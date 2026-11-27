import {ProjectCosts} from './ProjectCosts';
import {useState} from 'react';
import {fixedFeeWriteMessage,commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

function budgetComparison(delta:string|null, unit:string) {
  if (delta===null) return 'Unavailable';
  if (delta==='0') return 'On budget';
  return delta.startsWith('-') ? delta.slice(1)+' '+unit+' under budget' : delta+' '+unit+' over budget';
}

function marginText(margin:{amount:string;percent:string|null}|null,currency:string) {
  if (!margin) return 'Unavailable';
  return currency+' '+margin.amount+(margin.percent===null?' · Percentage unavailable': ' · '+margin.percent+'%');
}

export function FixedFeeForecast({context,engagement,through}:{context:CommercialDraftingContext;engagement:string;through:string}) {
  const [data,setData]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeForecast>>|null>(null);
  const [hours,setHours]=useState(''),[cost,setCost]=useState(''),[revenue,setRevenue]=useState(''),[reason,setReason]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const inspect=async(version?:number,save=false)=>{
    setBusy(true);setMessage('');
    try {
      const command=save && data?{remainingHours:hours,remainingCost:cost,expectedTotalRevenue:revenue||undefined,reason,expectedVersion:data.latestVersion,
        expectedToken:data.token,requestId:crypto.randomUUID()}:undefined;
      const value=await commercialDraftingService.fixedFeeForecast(engagement,through,context,{version,command});
      if (isCommercialDraftingContextCurrent(context)) {setData(value);if(save) setReason('');}
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {setData(null);setMessage('Inspect the current forecast and actuals before recording a version.');}
    } finally {setBusy(false);}
  };
  const saved=data?.saved;
  const transition=data?.revenue.profile==='effort'?data.revenue.scheduled:data?.revenue.profile==='transition'?data.revenue.preview:undefined;
  const [approvalReason,setApprovalReason]=useState('');
  async function approveTransition() {
    if (!transition) return;
    setBusy(true);
    try {
      await commercialDraftingService.approveFixedFeeTransition(engagement,context,{policyId:transition.policyId,snapshotId:transition.snapshotId,reason:approvalReason});
      if (isCommercialDraftingContextCurrent(context)) {setApprovalReason('');await inspect();}
    } catch (error) {
      if (isCommercialDraftingContextCurrent(context)) {setData(null);setMessage(fixedFeeWriteMessage(error,'Inspect the transition again before approving.'));}
    } finally {setBusy(false);}
  }
  return <section aria-label="Fixed-fee completion forecast">
    <fieldset disabled={busy}><legend>Fixed-fee estimates at completion</legend>
      <button type="button" onClick={()=>void inspect()}>Inspect completion forecast</button>
      {data && <>
        <p>Actuals through {through}: {data.baseline.actualHours} verified hours · {data.baseline.currency} {data.baseline.actualCost} retained labor cost</p>
        {!data.baseline.hoursComplete && <p>Hours at completion require verified approval evidence for every entry.</p>}
        {!data.baseline.costComplete && <p>Cost at completion requires retained cost for every approved entry.</p>}
        <p>Reconciled {data.revenue.profile==='elapsed'?'elapsed-time':data.revenue.profile==='effort'?'delivery-effort':'management'} revenue through {through}: {data.revenue.earnedAmount===null?'Unavailable':data.baseline.currency+' '+data.revenue.earnedAmount}</p>
        {
          data.revenue.profile==='elapsed'?<p>{data.revenue.applicableDays} applicable days · {data.revenue.missingDays} missing · {data.revenue.staleDays} stale</p>:
          data.revenue.profile==='effort'?<p>Delivery-effort evidence: {data.revenue.status}{data.revenue.version!==null?' · Retained version '+data.revenue.version:''}</p>:
          data.revenue.preview?<div>
            <p>Verified effort value through {data.revenue.preview.closingDate}: {data.baseline.currency} {data.revenue.preview.closingAmount}</p>
            <p>Allocation to spread from {data.revenue.preview.startsOn} through {data.revenue.preview.endsOn}: {data.baseline.currency} {data.revenue.preview.residual}</p>
            <p>Cumulative schedule value through {through}: {data.baseline.currency} {data.revenue.preview.amount}.</p>
          </div>:<p>Transition review unavailable{data.revenue.closingStatus?' · '+data.revenue.closingStatus:''}.</p>
        }
        {data.revenue.profile==='effort' && data.revenue.scheduled && <p>Scheduled switch on {data.revenue.scheduled.startsOn}: carry forward {data.baseline.currency} {data.revenue.scheduled.closingAmount} and spread {data.baseline.currency} {data.revenue.scheduled.residual} through {data.revenue.scheduled.endsOn}. Proposed first-day cumulative value: {data.baseline.currency} {data.revenue.scheduled.amount}.</p>}
        {transition && (transition.approvalId?<p>Finance approval {transition.approvalId}</p>:
          <><p>Finance approval pending.</p>{context.canApproveFixedFeeTransition && <>
            <label>Transition approval reason <input value={approvalReason} maxLength={1000} onChange={e=>setApprovalReason(e.target.value)}/></label>
            <button type="button" disabled={approvalReason.trim().length<3} onClick={()=>void approveTransition()}>Approve residual schedule</button>
          </>}</>)}
        {data.retainedProjectCosts && <p>Forecast version {saved?.version} retained {data.baseline.currency} {data.retainedProjectCosts.amount} in approved non-labor costs. Retained gross margin: {marginText(data.retainedProjectCosts.grossMargin,data.baseline.currency)}</p>}
        {data.projectCosts && <p>Finance-approved non-labor cost through {through}: {data.baseline.currency} {data.projectCosts.amount} ({data.projectCosts.entries} approved). Actual gross margin after labor and non-labor costs: {marginText(data.projectCosts.grossMargin,data.baseline.currency)}</p>}
        {context.canViewFixedFeeMargin && <ProjectCosts context={context} engagement={engagement} day={through} onDecision={()=>inspect()}/>}
        {data.marginComparison && <p>Actual margin after labor cost: {marginText(data.marginComparison.actual,data.baseline.currency)}</p>}
        {saved && <div><p>Forecast version {saved.version} · {saved.reason}</p>
          <p>Budget at review: {saved.report.budgetHours??'Unset'} hours · Labor cost {saved.report.budgetCost??'Unset'} {saved.report.currency}</p>
          <p>Actuals at review: {saved.report.actualHours} hours · Labor cost {saved.report.actualCost} {saved.report.currency}</p>
          <p>Remaining forecast: {saved.report.remainingHours} hours · Labor cost {saved.report.remainingCost} {saved.report.currency}</p>
          <p>Estimate at completion: {saved.report.estimatedHours??'Unavailable'} hours · Labor cost {saved.report.estimatedCost??'Unavailable'} {saved.report.currency}</p>
          <p>Forecast hours versus budget: {budgetComparison(data.budgetVariance.hours,'hours')}</p>
          <p>Forecast labor cost versus budget: {budgetComparison(data.budgetVariance.laborCost,saved.report.currency)}</p>
          <p>Expected total revenue at completion: {saved.report.expectedTotalRevenue===undefined ? 'Unspecified' : saved.report.currency+' '+saved.report.expectedTotalRevenue}</p>
          <p>Remaining forecast revenue after reconciled {data.revenue.profile==='effort'?'delivery-effort':data.revenue.profile==='elapsed'?'elapsed-time':'management'} value: {data.revenue.remainingRevenue===null?'Unavailable':saved.report.currency+' '+data.revenue.remainingRevenue}</p>
          {data.revenue.profile==='effort' && data.revenue.scheduled && <p>Scheduled switch on {data.revenue.scheduled.startsOn}: carry forward {data.baseline.currency} {data.revenue.scheduled.closingAmount} and spread {data.baseline.currency} {data.revenue.scheduled.residual} through {data.revenue.scheduled.endsOn}. Proposed first-day cumulative value: {data.baseline.currency} {data.revenue.scheduled.amount}.</p>}
        {data.marginComparison && <>
            <p>Remaining margin after labor cost: {marginText(data.marginComparison.remaining,saved.report.currency)}</p>
            {!data.marginComparison.forecastCurrent && <p>Record a forecast against current evidence to compare remaining margin.</p>}
            <p>Forecast margin after labor cost: {marginText(data.laborMargin,saved.report.currency)}</p>
          </>}
          {saved.version>1 && <button type="button" onClick={()=>void inspect(saved.version-1)}>Previous forecast version</button>}
        </div>}
        {context.canRecordFixedFeeForecast && (!saved || saved.version===data.latestVersion) &&
          <form onSubmit={e=>{e.preventDefault();void inspect(undefined,true);}}>
            <label>Remaining forecast hours <input required pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" inputMode="decimal" value={hours} onChange={e=>setHours(e.target.value)}/></label>
            <label>Remaining labor cost ({data.baseline.currency}) <input required pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" inputMode="decimal" value={cost} onChange={e=>setCost(e.target.value)}/></label>
            <label>Expected total revenue at completion ({data.baseline.currency}, optional) <input pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" inputMode="decimal" value={revenue} onChange={e=>setRevenue(e.target.value)}/></label>
            <label>Forecast assumptions <input required minLength={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
            <button>Record completion forecast</button>
          </form>}
      </>}
    </fieldset>{message && <p role="status">{message}</p>}
  </section>;
}
