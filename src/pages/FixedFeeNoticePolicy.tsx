import {useState,type FormEvent} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

type Policy = Awaited<ReturnType<typeof commercialDraftingService.riskNoticePolicy>>['latest'];

export function FixedFeeNoticePolicy({context,engagement,today}:{context:CommercialDraftingContext;engagement:string;today:string}) {
  const [policy,setPolicy]=useState<Policy|undefined>(undefined);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  async function read() {
    setBusy(true);setMessage('');setPolicy(undefined);
    try {
      const result=await commercialDraftingService.riskNoticePolicy(engagement,context);
      if (isCommercialDraftingContextCurrent(context)) setPolicy(result.latest);
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not load the engagement notice policy.');}
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
      });
      if (isCommercialDraftingContextCurrent(context)) {setPolicy(result.latest);setMessage('Notice policy saved.');}
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not save. Check the recipient accounts, held roles and effective date, then reload the policy.');}
    finally {setBusy(false);}
  }
  return <section aria-label="Budget warning recipients">
    <button type="button" disabled={busy} onClick={()=>void read()}>Review budget warning recipients</button>
    {policy!==undefined && <form key={policy?.id??'new'} onSubmit={save}><fieldset disabled={busy}>
      <legend>{policy?'Notice policy version '+policy.version+' · Effective '+policy.effectiveFrom:'Configure budget warning recipients'}</legend>
      <label>Effective from <input type="date" name="date" min={today.slice(0,10)} required defaultValue={policy && policy.effectiveFrom>today.slice(0,10)?policy.effectiveFrom:today.slice(0,10)}/></label>
      <label>Commercial manager user ID <input name="manager" required defaultValue={policy?.manager.userId}/></label>
      <label>Commercial manager role <input name="managerRole" required defaultValue={policy?.manager.role}/></label>
      <label>Finance or billing owner user ID <input name="finance" required defaultValue={policy?.finance.userId}/></label>
      <label>Finance or billing owner role <input name="financeRole" required defaultValue={policy?.finance.role}/></label>
      <label>Template locale <input name="locale" required defaultValue={policy?.locale} placeholder="en-GB"/></label>
      <label>Notification title <input name="title" maxLength={200} required defaultValue={policy?.title}/></label>
      <label>Notification body <textarea name="body" maxLength={2000} required defaultValue={policy?.body}/></label>
      <label>Reason for change <input name="reason" minLength={3} maxLength={1000} required/></label>
      <button>Save notice policy</button>
    </fieldset></form>}
    {message && <p role="status">{message}</p>}
  </section>;
}
