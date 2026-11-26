import {EngagementNoticePolicy} from './FixedFeeNoticePolicy';
import {ServicePeriodMargin} from './ServicePeriodMargin';
import {ServiceEffortCost} from './ServiceEffortCost';
import {ServiceUnitBilling} from './ServiceUnitBilling';
import {ServicePolicyEditor,ServiceValueReceipt} from './ServiceValuation';
import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext,type ContractTerms,type Engagement} from '../services/commercialDrafting';

function EffortReconciliation({context,engagement,id}:{context:CommercialDraftingContext;engagement:string;id:string}) {
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState(false);
  const inspect=async()=>{
    setPending(true);
    try {
      const result=await commercialDraftingService.reconcileEffort(engagement,id,context);
      if (isCommercialDraftingContextCurrent(context)) setMessage(result.label+(result.approvedHours===null?'':` Approved hours: ${result.approvedHours} across ${result.entryCount} entries.`));
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('Reconciliation is unavailable for this receipt.');
    } finally {setPending(false);}
  };
  return <div><button type="button" disabled={pending} onClick={()=>void inspect()}>Compare approved effort</button>{message && <p role="status">{message}</p>}</div>;
}

export function ServiceUnitCapture({engagements,context,version,today}:{engagements:Engagement[];context:CommercialDraftingContext;version:ContractTerms & {id:string};today:string}) {
  const busy=useRef(false);
  const [pending,setPending]=useState(false);
  const [message,setMessage]=useState('');
  const [engagementId,setEngagementId]=useState('');
  const [selected,setSelected]=useState('');
  const [reason,setReason]=useState('');
  const sequence=useRef(0);
  const [history,setHistory]=useState<Awaited<ReturnType<typeof commercialDraftingService.serviceUnitHistory>>|null>(null);
  const loadHistory=async (id:string,before:string|null=null)=>{
    const ticket=++sequence.current;
    setHistory(null);setSelected('');setReason('');
    if (!id || !isCommercialDraftingContextCurrent(context)) return;
    try {
      const page=await commercialDraftingService.serviceUnitHistory(id,version.id,before,context);
      if (ticket===sequence.current && isCommercialDraftingContextCurrent(context)) setHistory(page);
    } catch {
      if (ticket===sequence.current && isCommercialDraftingContextCurrent(context)) setMessage('Evidence history could not be loaded.');
    }
  };
  const decide=async (id:string,decision:'Accepted'|'Rejected')=>{
    if (busy.current || selected!==id || reason.trim().length<3 || !isCommercialDraftingContextCurrent(context)) return;
    busy.current=true;setPending(true);setMessage('');
    try {
      await commercialDraftingService.reviewUnits(engagementId,id,decision,reason.trim(),context);
      if (isCommercialDraftingContextCurrent(context)) {
        setMessage('Service evidence '+decision.toLowerCase()+'.');
        await loadHistory(engagementId);
      }
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('Decision could not be confirmed. Reload the evidence history and check independent review authority.');
    } finally {busy.current=false;setPending(false);}
  };
  if (!engagements.length) return null;
  return <><form aria-label="Record delivered units" className="mt-3 space-y-2" onSubmit={async event=>{
    event.preventDefault();
    if (busy.current || selected || !context.canCaptureUnits || !isCommercialDraftingContextCurrent(context)) return;
    const form=event.currentTarget;
    const fields=new FormData(form);
    const field=(key:string)=>String(fields.get(key)??'').trim();
    busy.current=true;setPending(true);setMessage('');
    try {
      const id=await commercialDraftingService.captureUnits(field('engagement'),{versionId:version.id,serviceDate:field('date'),
        dimensionCode:field('code'),quantity:field('quantity'),sourceReference:field('reference'),...(field('effort')?{effortHours:field('effort')}:{})},context);
      if (isCommercialDraftingContextCurrent(context)) {
        for (const name of ['quantity','reference','effort']) {
          const control=form.elements.namedItem(name);
          if (control instanceof HTMLInputElement) control.value='';
        }
        setMessage('Service evidence recorded · '+id);void loadHistory(engagementId);
      }
    } catch {
      if (isCommercialDraftingContextCurrent(context)) setMessage('Save could not be confirmed. Check access, effective terms and quantity. Retrying identical evidence uses the same reference.');
    } finally {busy.current=false;setPending(false);}
  }}>
    <fieldset disabled={pending} className="grid gap-2 sm:grid-cols-2">
      <legend className="font-semibold">Record delivered units</legend>
      <label>Service engagement<select required name="engagement" value={engagementId} onChange={event=>{const id=event.target.value;setEngagementId(id);setMessage('');void loadHistory(id);}}><option value="">Select engagement</option>{engagements.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      {context.canCaptureUnits && <>
      <label>Service date<input name="date" type="date" required min={version.effectiveFrom} max={today<version.endsOn?today:version.endsOn}/></label>
      <label>Delivered unit<select name="code" required>{version.serviceDimensions?.map(u=><option key={u.code} value={u.code}>{u.label}</option>)}</select></label>
      <label>Delivered quantity<input name="quantity" required inputMode="decimal"/></label>
      <label>Your effort in hours (optional)<input name="effort" type="number" inputMode="decimal" min="0.0001" max="24" step="0.0001"/></label>
      <label>Service evidence reference<input name="reference" required maxLength={120}/></label>
      <button type="submit">Record service evidence</button></>}
    </fieldset>
    {history && <section aria-label="Recorded service evidence">
      <h5>Recorded service evidence</h5>
      {history.records.length ? <ul>{history.records.map(row=><li key={row.id}>
        <span>{row.serviceDate} · {row.quantity} {row.dimensionCode} · {row.sourceReference}</span>
        {row.effortHours!==null && <p>Recorded effort · {row.effortHours} hours</p>}
        {context.canReconcileEffort && <EffortReconciliation context={context} engagement={engagementId} id={row.id}/>}
        {context.canViewEffortCost && row.review?.decision==='Accepted' && <ServiceEffortCost context={context} engagement={engagementId} evidenceId={row.id} reviewId={row.review.id}/>}
        {context.canIssueServiceUnits && row.review?.decision==='Accepted' && <ServiceUnitBilling context={context} engagement={engagementId} evidenceId={row.id} reviewId={row.review.id}/>}
        {context.canValueUnits && row.review?.decision==='Accepted' && <ServiceValueReceipt context={context} engagement={engagementId} evidenceId={row.id} reviewId={row.review.id}/>}
        {row.review ? <p>{row.review.decision} · {row.review.reason}</p> : <>
          <p>Pending acceptance</p>
          {context.canReviewUnits && (selected===row.id ? <fieldset disabled={pending}>
            <label>Decision reason<textarea maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
            <button type="button" disabled={reason.trim().length<3} onClick={()=>void decide(row.id,'Accepted')}>Accept units</button>
            <button type="button" disabled={reason.trim().length<3} onClick={()=>void decide(row.id,'Rejected')}>Reject units</button>
            <button type="button" onClick={()=>{setSelected('');setReason('');}}>Cancel review</button>
          </fieldset> : <button type="button" disabled={pending} onClick={()=>{setSelected(row.id);setReason('');}}>Review {row.sourceReference}</button>)}
        </>}
      </li>)}</ul> : <p>No recorded units on this version.</p>}
      {history.before && <button type="button" disabled={pending} onClick={()=>void loadHistory(engagementId,history.before)}>Older evidence</button>}
    </section>}
    {message && <p role="status">{message}</p>}
  </form>{engagementId && context.canConfigureMarginRiskNotices && <div key={context.identityKey+engagementId}><EngagementNoticePolicy context={context} engagement={engagementId} today={today} model="managed_service"/></div>}{engagementId && context.canViewServiceMargin && <div key={context.identityKey+engagementId}><ServicePeriodMargin context={context} engagement={engagementId} today={today}/></div>}{engagementId && context.canSetServicePolicy && <div key={engagementId}><ServicePolicyEditor context={context} engagement={engagementId} today={today}/></div>}</>;
}
