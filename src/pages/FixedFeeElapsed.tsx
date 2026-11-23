import {FixedFeeElapsedPeriod} from './FixedFeeElapsedPeriod';
import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

export function FixedFeeElapsed({context,engagement,serviceDay}:{context:CommercialDraftingContext;engagement:string;serviceDay:string}) {
  const [data,setData]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeElapsed>>|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function inspect(version?:number,retain=false) {
    setBusy(true);
    setMessage('');
    try {
      const command=retain && data?.report ? {policyVersion:data.report.policyVersion,lifecycleId:data.report.lifecycleId,parentLifecycleId:data.report.parentLifecycleId,expectedVersion:data.latestVersion}:undefined;
      const result=await commercialDraftingService.fixedFeeElapsed(engagement,serviceDay,context,{version,command});
      if (isCommercialDraftingContextCurrent(context)) setData(result);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {setData(null);setMessage('The elapsed-time valuation could not be verified. Inspect the service day again.');}
    } finally {setBusy(false);}
  }
  return <section aria-label="Fixed-fee operational earned-management value"><fieldset disabled={busy}>
    <legend>Operational earned-management value for {serviceDay}</legend>
    <button type="button" onClick={()=>void inspect()}>Inspect elapsed service day</button>
    {data && <>
      {data.report ? <><p>Daily management value {data.report.currency} {data.report.amount} · Service day {data.report.dayNumber} of {data.report.serviceDays}</p>
        <p>Approved allocation {data.report.currency} {data.report.allocation} · {data.report.startsOn} to {data.report.endsOn} · Approval {data.report.approvalReference}</p>
        {context.canRecordFixedFeeElapsed && <button type="button" onClick={()=>void inspect(undefined,true)}>Retain daily value</button>}</> :
        <p>No effective approved elapsed-time policy for this service day.</p>}
      {data.saved && <><p>Retained version {data.saved.version} · {data.saved.report.currency} {data.saved.report.amount} · Policy {data.saved.report.policyVersion}</p>
        {data.saved.version>1 && <button type="button" onClick={()=>void inspect(data.saved!.version-1)}>Previous daily value</button>}</>}
    </>}
  </fieldset>{message && <p role="status">{message}</p>}
    <div key={data?.saved?.id??engagement}><FixedFeeElapsedPeriod context={context} engagement={engagement} through={serviceDay}/></div></section>;
}
