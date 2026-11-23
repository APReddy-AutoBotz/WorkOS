import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

function budgetComparison(delta:string|null, unit:string) {
  if (delta===null) return 'Unavailable';
  if (delta==='0') return 'On budget';
  return delta.startsWith('-') ? delta.slice(1)+' '+unit+' under budget' : delta+' '+unit+' over budget';
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
  return <section aria-label="Fixed-fee completion forecast">
    <fieldset disabled={busy}><legend>Fixed-fee estimates at completion</legend>
      <button type="button" onClick={()=>void inspect()}>Inspect completion forecast</button>
      {data && <>
        <p>Actuals through {through}: {data.baseline.actualHours} verified hours · {data.baseline.currency} {data.baseline.actualCost} retained labor cost</p>
        {!data.baseline.hoursComplete && <p>Hours at completion require verified approval evidence for every entry.</p>}
        {!data.baseline.costComplete && <p>Cost at completion requires retained cost for every approved entry.</p>}
        {saved && <div><p>Forecast version {saved.version} · {saved.reason}</p>
          <p>Budget at review: {saved.report.budgetHours??'Unset'} hours · Labor cost {saved.report.budgetCost??'Unset'} {saved.report.currency}</p>
          <p>Actuals at review: {saved.report.actualHours} hours · Labor cost {saved.report.actualCost} {saved.report.currency}</p>
          <p>Remaining forecast: {saved.report.remainingHours} hours · Labor cost {saved.report.remainingCost} {saved.report.currency}</p>
          <p>Estimate at completion: {saved.report.estimatedHours??'Unavailable'} hours · Labor cost {saved.report.estimatedCost??'Unavailable'} {saved.report.currency}</p>
          <p>Forecast hours versus budget: {budgetComparison(data.budgetVariance.hours,'hours')}</p>
          <p>Forecast labor cost versus budget: {budgetComparison(data.budgetVariance.laborCost,saved.report.currency)}</p>
          <p>Expected total revenue at completion: {saved.report.expectedTotalRevenue===undefined ? 'Unspecified' : saved.report.currency+' '+saved.report.expectedTotalRevenue}</p>
          <p>Forecast margin after labor cost: {data.laborMargin ? saved.report.currency+' '+data.laborMargin.amount : 'Unavailable'}
            {data.laborMargin && (data.laborMargin.percent===null ? ' · Percentage unavailable for zero revenue' : ' · '+data.laborMargin.percent+'%')}</p>
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
