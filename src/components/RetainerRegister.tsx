import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext,type ContractTerms} from '../services/commercialDrafting';

const register=commercialDraftingService.retainerRegister;
export function RetainerRegister({contractId,version,startsOn,context}:{contractId:string;version:ContractTerms;startsOn:string;context:CommercialDraftingContext}) {
  const [result,setResult]=useState<Awaited<ReturnType<typeof register>>>();
  const [engagement,setEngagement]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(issue=false) {
    if (busy || !isCommercialDraftingContextCurrent(context)) return;
    setBusy(true);setError('');
    try {
      const statement=result?.statement;
      if (issue && (!statement || !engagement || reason.trim().length<3)) return;
      const data=await register(contractId,version,startsOn,context,issue && statement ?
        {statementId:statement.statementId,reviewId:statement.reviewId,engagementId:engagement,reason:reason.trim()} : undefined);
      if (isCommercialDraftingContextCurrent(context)) {setResult(data);setEngagement('');setReason('');}
    } catch {setResult(undefined);setError('Reload the register to check the period, billing authority and any saved charge.');}
    finally {setBusy(false);}
  }
  if (!isCommercialDraftingContextCurrent(context)) return null;
  return <section aria-label={'Retainer billing '+startsOn}>
    <button type="button" className="underline" disabled={busy} onClick={()=>load()}>Inspect retainer billing register</button>
    {error && <p role="alert">{error}</p>}
    {result?.receipt && <p role="status">Approved-unbilled · {result.receipt.currency} {result.receipt.amount} · {result.receipt.eligibleOn} · register item {result.receipt.itemId}</p>}
    {result && !result.receipt && (!result.statement || !result.engagements.length) && <p>No eligible approved charge for this period.</p>}
    {result?.statement && result.engagements.length>0 && <div><p>Approved period charge · {result.statement.currency} {result.statement.amount}</p>
      <label>Responsible billing engagement<select value={engagement} onChange={e=>setEngagement(e.target.value)}>
        <option value="">Select engagement</option>{result.engagements.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <label>Registration reason<input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
      <button type="button" disabled={busy || !engagement || reason.trim().length<3} onClick={()=>load(true)}>Register approved retainer charge</button></div>}
  </section>;
}
