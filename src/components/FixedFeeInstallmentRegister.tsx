import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,
  type CommercialDraftingContext,type ContractTerms} from '../services/commercialDrafting';
import {ApiClientError} from '../services/apiClient';

type Receipt = Awaited<ReturnType<typeof commercialDraftingService.installmentRegister>>[number];
export function FixedFeeInstallmentRegister({context,version,engagements}:{context:CommercialDraftingContext;
  version:ContractTerms; engagements:{id:string;name:string}[]}) {
  const [receipts,setReceipts]=useState<Receipt[]>();
  const [installment,setInstallment]=useState('');
  const [engagement,setEngagement]=useState('');
  const [reason,setReason]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  async function load(write:boolean) {
    if (pending.current || !isCommercialDraftingContextCurrent(context)) return;
    pending.current=true;
    setBusy(true);
    setMessage('');
    try {
      const result=await commercialDraftingService.installmentRegister(version.id,context,
        write?{installment:Number(installment),engagementId:engagement,reason}:undefined);
      if (isCommercialDraftingContextCurrent(context)) {
        setReceipts(result);
        if (write) {setInstallment('');setReason('');}
      }
    } catch (error) {
      if (isCommercialDraftingContextCurrent(context)) {
        setReceipts(undefined);
        setMessage(error instanceof ApiClientError && [403,409].includes(error.status) ? error.message :
          'The register could not be confirmed. Inspect it again before retrying.');
      }
    } finally {pending.current=false;setBusy(false);}
  }
  return <fieldset disabled={busy}><legend>Fixed-fee billing eligibility</legend>
    <button type="button" onClick={()=>void load(false)}>Inspect installment register</button>
    {message && <p role="alert">{message}</p>}
    {receipts && <>
      {receipts.length===0 ? <p>No registered installments for this contract.</p> :
        <ul>{receipts.map(r=><li key={r.itemId}>Installment {r.installment} · {r.currency} {r.amount} · Approved {r.eligibleOn} · Due {r.dueOn} · Engagement {r.engagementId} · Contract version {r.contractVersionId} · Register item {r.itemId}</li>)}</ul>}
      {context.canManage && <><label>Scheduled installment <select value={installment} onChange={e=>setInstallment(e.target.value)}>
        <option value="">Select an installment</option>{version.installments?.map((row,i)=>
          <option key={i} value={i+1} disabled={receipts.some(r=>r.installment===i+1)}>{i+1} · {row.dueOn} · {version.currency} {row.amount}</option>)}</select></label>
        <label>Billing engagement <select value={engagement} onChange={e=>setEngagement(e.target.value)}>
          <option value="">Select an engagement</option>{engagements.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label>Installment approval reason <input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
        <button type="button" disabled={!installment || !engagement || reason.trim().length<3}
          onClick={()=>void load(true)}>Approve due installment</button>
      </>}
    </>}
  </fieldset>;
}
