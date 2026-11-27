import {useState} from 'react';
import {commercialDraftingService as service,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

type Register=Awaited<ReturnType<typeof service.projectCosts>>;
export function ProjectCosts({context,engagement,day,onDecision}:{context:CommercialDraftingContext;engagement:string;day:string;onDecision:()=>Promise<void>}) {
  const [register,setRegister]=useState<Register|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [project,setProject]=useState(''),[reference,setReference]=useState(''),[amount,setAmount]=useState(''),[reason,setReason]=useState('');
  async function load() {
    const result=await service.projectCosts(engagement,day,context);
    if(isCommercialDraftingContextCurrent(context))setRegister(result);
  }
  async function run(action:()=>Promise<void>) {
    setBusy(true);setError('');
    try {await action();}
    catch {if(isCommercialDraftingContextCurrent(context)){setRegister(null);setError('Inspect the cost register to confirm the current entries and decisions.');}}
    finally {setBusy(false);}
  }
  async function decide(id:string,decision:'Approved'|'Rejected') {
    await service.recordProjectCost(engagement,context,{id,decision,reason});
    if(isCommercialDraftingContextCurrent(context)){setReason('');await load();await onDecision();}
  }
  return <fieldset disabled={busy}><legend>Non-labor project costs</legend>
    <button type="button" onClick={()=>void run(load)}>Inspect cost entries for {day}</button>
    {error && <p role="status">{error}</p>}
    {register && <>
      {context.canPrepareProjectCost && <form onSubmit={e=>{e.preventDefault();void run(async()=>{
        await service.recordProjectCost(engagement,context,{id:crypto.randomUUID(),day,projectId:project,reference,amount});
        if(isCommercialDraftingContextCurrent(context)){setAmount('');setReference('');await load();}
      });}}>
        <label>Cost project <select required value={project} onChange={e=>setProject(e.target.value)}><option value="">Choose project</option>{register.projects.map(p=><option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
        <label>Cost reference <input required maxLength={160} value={reference} onChange={e=>setReference(e.target.value)}/></label>
        <label>Incurred amount ({register.currency}) <input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
        <button>Submit cost for finance approval</button>
      </form>}
      {context.canDecideProjectCost && register.entries.some(e=>!e.decision&&!e.preparedByMe) &&
        <label>Decision reason <input minLength={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
      {!register.entries.length?<p>No cost entries for this date.</p>:<ul>{register.entries.map(entry=><li key={entry.id}>
        {register.projects.find(p=>p.id===entry.projectId)?.code} · {entry.reference} · {register.currency} {entry.amount} · {entry.decision??'Pending approval'} {entry.reason}
        {!entry.decision&&!entry.preparedByMe&&context.canDecideProjectCost&&(['Approved','Rejected'] as const).map(d=><button key={d} type="button" disabled={reason.trim().length<3} onClick={()=>void run(()=>decide(entry.id,d))}>{d==='Approved'?'Approve':'Reject'} {entry.reference}</button>)}
      </li>)}</ul>}
    </>}
  </fieldset>;
}
