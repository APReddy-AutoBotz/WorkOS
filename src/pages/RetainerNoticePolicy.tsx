import {RiskNoticePolicyFields} from '../components/RiskNoticePolicyFields';
import {useState,type FormEvent} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

type Policy = Awaited<ReturnType<typeof commercialDraftingService.retainerNoticePolicy>>['latest'];

export function RetainerNoticePolicy({context,versionId,today}:{context:CommercialDraftingContext;versionId:string;today:string}) {
  const [policy,setPolicy]=useState<Policy|undefined>(undefined);
  const [delivery,setDelivery]=useState<Awaited<ReturnType<typeof commercialDraftingService.retainerDeliveryStatus>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  async function read() {
    setBusy(true);setMessage('');setPolicy(undefined);
    try {
      const result=await commercialDraftingService.retainerNoticePolicy(versionId,context);
      if (isCommercialDraftingContextCurrent(context)) setPolicy(result.latest);
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not load the retainer notice policy.');}
    finally {setBusy(false);}
  }
  async function inspectDelivery() {
    setBusy(true);setMessage('');setDelivery(null);
    try {
      const result=await commercialDraftingService.retainerDeliveryStatus(versionId,context);
      if (isCommercialDraftingContextCurrent(context)) setDelivery(result);
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not load retainer delivery status.');}
    finally {setBusy(false);}
  }
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (policy===undefined || busy) return;
    const fields=new FormData(event.currentTarget);
    const text=(name:string)=>String(fields.get(name)??'').trim();
    setBusy(true);setMessage('');
    try {
      const result=await commercialDraftingService.retainerNoticePolicy(versionId,context,{
        expectedVersion:policy?.version??0,effectiveFrom:text('date'),locale:text('locale'),title:text('title'),
        body:text('body'),reason:text('reason'),manager:{userId:text('manager'),role:text('managerRole')},
        finance:{userId:text('finance'),role:text('financeRole')}
      });
      if (isCommercialDraftingContextCurrent(context)) {setPolicy(result.latest);setMessage('Notice policy saved.');}
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not save. Check the recipient accounts, held roles and effective date, then reload the policy.');}
    finally {setBusy(false);}
  }
  return <section aria-label="Retainer risk recipients">
    <button type="button" disabled={busy} onClick={()=>void read()}>Review retainer risk recipients</button>
    <button type="button" disabled={busy} onClick={()=>void inspectDelivery()}>Check retainer alert deliveries</button>
    {delivery && <div>{delivery.scanFailure && <p>Capacity evaluation needs a retry.</p>}{delivery.events.length===0 && <p>No recorded retainer alerts.</p>}
      {delivery.events.map(e=><details key={e.id}><summary>{e.startsOn} through {e.endsOn} · {e.kind} · {e.deliveredAt?'Delivered':
        e.failure==='POLICY_UNAVAILABLE'?'Configure a notice policy':e.failure==='RECIPIENTS_UNAVAILABLE'?'Check assigned owners and named recipients':
        e.failure?'Delivery needs a retry':'Pending'}</summary>{e.nextAttempt && <p>Next attempt {e.nextAttempt}</p>}
        <ol>{e.history.map(h=><li key={h.attempt}>Attempt {h.attempt} · {h.at} · {h.failure??'Delivered'}</li>)}</ol>
      </details>)}</div>}
    {policy!==undefined && <form key={policy?.id??'new'} onSubmit={save}><fieldset disabled={busy}>
      <legend>{policy?'Notice policy version '+policy.version+' · Effective '+policy.effectiveFrom:'Configure retainer risk recipients'}</legend>
      <RiskNoticePolicyFields policy={policy} today={today}/>
      <button>Save notice policy</button>
    </fieldset></form>}
    {message && <p role="status">{message}</p>}
  </section>;
}
