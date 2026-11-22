import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext,type ContractTerms,type Engagement,type ServicePeriodCharge} from '../services/commercialDrafting';
import {ServicePolicyEditor} from './ServiceValuation';

type Props={context:CommercialDraftingContext;version:ContractTerms;engagements:Engagement[];term?:ServicePeriodCharge;reviewId?:string;today:string};

export function ServicePeriodValuation({context,version,engagements,term,reviewId,today}:Props) {
  const [engagement,setEngagement]=useState('');
  const [result,setResult]=useState<Awaited<ReturnType<typeof commercialDraftingService.periodValue>>|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function run(policyId?:string) {
    if (busy || !engagement || !term || !reviewId) return;
    setBusy(true);setMessage('');
    try {
      const response=await commercialDraftingService.periodValue(engagement,reviewId,version,term,context,policyId);
      if (isCommercialDraftingContextCurrent(context)) setResult(response);
    } catch {setResult(null);setMessage('Inspect the approved charge, engagement policy and financial period before retrying.');}
    finally {setBusy(false);}
  }
  return <section aria-label="Fixed-period operational valuation">
    <label>Period valuation engagement <select value={engagement} disabled={busy} onChange={e=>{setEngagement(e.target.value);setResult(null);setMessage('');}}>
      <option value="">Select an engagement</option>{engagements.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
    </select></label>
    {engagement && context.canSetServicePolicy && <div key={engagement}><ServicePolicyEditor context={context} engagement={engagement} today={today}/></div>}
    {engagement && term && reviewId && context.canValuePeriods && <>
      <button type="button" disabled={busy} onClick={()=>run()}>Inspect period valuation</button>
      {result?.valuation ? <p>Operational management value · {result.valuation.currency} {result.valuation.amount}</p> :
        result?.policy?.profile==='approved_period' ? <><p>Policy effective {result.policy.effectiveFrom} · round half up to {result.policy.precision} decimal places</p>
          <button type="button" disabled={busy} onClick={()=>run(result.policy!.id)}>Record period value</button></> :
          result && <p>No approved-period policy was effective on the period end date.</p>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
