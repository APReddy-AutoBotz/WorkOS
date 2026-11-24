import {RiskNoticePolicyFields} from '../components/RiskNoticePolicyFields';
import {useState,type FormEvent} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

type Policy = Awaited<ReturnType<typeof commercialDraftingService.riskNoticePolicy>>['latest'];

export function EngagementNoticePolicy({context,engagement,today,model='fixed_fee'}:{context:CommercialDraftingContext;engagement:string;today:string;model?:'fixed_fee'|'managed_service'}) {
  const recipients=model==='fixed_fee'?'Budget warning recipients':'Monthly margin alert recipients';
  const [policy,setPolicy]=useState<Policy|undefined>(undefined);
  const [delivery,setDelivery]=useState<Awaited<ReturnType<typeof commercialDraftingService.riskDeliveryStatus>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  async function read() {
    setBusy(true);setMessage('');setPolicy(undefined);
    try {
      const result=await commercialDraftingService.riskNoticePolicy(engagement,context,undefined,model);
      if (isCommercialDraftingContextCurrent(context)) setPolicy(result.latest);
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not load the engagement notice policy.');}
    finally {setBusy(false);}
  }
  async function inspectDelivery() {
    setBusy(true);setMessage('');setDelivery(null);
    try {
      const result=await commercialDraftingService.riskDeliveryStatus(engagement,context);
      if (isCommercialDraftingContextCurrent(context)) setDelivery(result);
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not load warning delivery status.');}
    finally {setBusy(false);}
  }
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (policy===undefined || busy) return;
    const fields=new FormData(event.currentTarget);
    const text=(name:string)=>String(fields.get(name)??'').trim();
    setBusy(true);setMessage('');
    try {
      const result=await commercialDraftingService.riskNoticePolicy(engagement,context,{
        expectedVersion:policy?.version??0,effectiveFrom:text('date'),locale:text('locale'),title:text('title'),
        body:text('body'),reason:text('reason'),manager:{userId:text('manager'),role:text('managerRole')},
        finance:{userId:text('finance'),role:text('financeRole')}
      },model);
      if (isCommercialDraftingContextCurrent(context)) {setPolicy(result.latest);setMessage('Notice policy saved.');}
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not save. Check the recipient accounts, held roles and effective date, then reload the policy.');}
    finally {setBusy(false);}
  }
  return <section aria-label={recipients}>
    <button type="button" disabled={busy} onClick={()=>void read()}>{model==='fixed_fee'?'Review budget warning recipients':'Review monthly margin alert recipients'}</button>
    {model==='fixed_fee' && <button type="button" disabled={busy} onClick={()=>void inspectDelivery()}>Check warning deliveries</button>}
    {delivery && <div aria-label="Warning delivery status">
      {delivery.scan?.scanFailure && <p>Budget evaluation needs a retry.</p>}
      {delivery.events.length===0 && <p>No recorded budget alerts.</p>}
      {delivery.events.map(row=><div key={row.metric+row.sourceAmendmentId}><p>
        {row.metric==='effort'?'Delivery hours':'Labor cost'} · {row.through} · {row.deliveredAt?'Delivered '+row.deliveredAt:
          row.failure==='RECIPIENTS_UNAVAILABLE'?'Check recipient access':row.failure==='POLICY_UNAVAILABLE'?'Configure a notice policy':
          row.failure?'Delivery needs a retry':'Pending'}{row.nextAttempt && ' · Next attempt '+row.nextAttempt}
      </p>{row.history.length>0 && <details><summary>Recent delivery attempts ({row.attempts} total)</summary>
        <ol>{row.history.map(h=><li key={h.attempt}>Attempt {h.attempt} · {h.at} · {h.failure===null?'Delivered':
          h.failure==='POLICY_UNAVAILABLE'?'Policy unavailable':h.failure==='RECIPIENTS_UNAVAILABLE'?'Recipients unavailable':'Delivery unavailable'}</li>)}</ol>
      </details>}</div>)}
    </div>}
    {policy!==undefined && <form key={policy?.id??'new'} onSubmit={save}><fieldset disabled={busy}>
      <legend>{policy?'Notice policy version '+policy.version+' · Effective '+policy.effectiveFrom:'Configure '+recipients.toLowerCase()}</legend>
      <RiskNoticePolicyFields policy={policy} today={today}/>
      <button>Save notice policy</button>
    </fieldset></form>}
    {message && <p role="status">{message}</p>}
  </section>;
}
