import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext,type Engagement} from '../services/commercialDrafting';

export function RetainerAlertAssignments({versionId,contractId,context,engagements}:{versionId:string;contractId:string;context:CommercialDraftingContext;engagements:Engagement[]}) {
  const [version,setVersion]=useState<number|null>(null);
  const [ids,setIds]=useState<string[]>([]);
  const [reason,setReason]=useState('');
  const [extra,setExtra]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const choices=engagements.filter(e=>e.contractId===contractId && e.model==='retainer');
  async function submit(write:boolean) {
    if (pending.current || (write && version===null)) return;
    pending.current=true;setBusy(true);setMessage('');
    try {
      const result=await commercialDraftingService.retainerAssignments(versionId,context,
        write?{expectedVersion:version!,engagementIds:ids,reason:reason.trim()}:undefined);
      if (!isCommercialDraftingContextCurrent(context)) return;
      setVersion(result.version);setIds(result.assignments.map(a=>a.engagementId));setReason('');setExtra('');
      setMessage(!result.assignments.length?'No engagements assigned for alerts.':result.assignments.some(a=>!a.ownerAvailable)?
        'An assigned engagement needs a current owner with inbox access.':'All assigned engagement owners have inbox access.');
    } catch {if (isCommercialDraftingContextCurrent(context)) setMessage('Could not confirm assignments. Reload and check the contract and current access.');}
    finally {pending.current=false;setBusy(false);}
  }
  return <fieldset disabled={busy}><legend>Retainer version alert assignments</legend>
    <button type="button" onClick={()=>void submit(false)}>Review alert assignments</button>
    {version!==null && <div><p>Assignment version {version}</p>
      {[...new Set([...choices.map(e=>e.id),...ids])].map(id=><label key={id}><input type="checkbox" checked={ids.includes(id)}
        onChange={event=>setIds(event.target.checked?[...ids,id]:ids.filter(i=>i!==id))}/>{choices.find(e=>e.id===id)?.name??id}</label>)}
      <label>Additional engagement ID <input value={extra} onChange={event=>setExtra(event.target.value)}/></label>
      <button type="button" disabled={!extra.trim() || ids.includes(extra.trim())} onClick={()=>{setIds([...ids,extra.trim()]);setExtra('');}}>Add engagement</button>
      <label>Assignment reason <input value={reason} maxLength={1000} onChange={event=>setReason(event.target.value)}/></label>
      <button type="button" disabled={reason.trim().length<3} onClick={()=>void submit(true)}>Save alert assignments</button>
    </div>}{message && <p role="status">{message}</p>}
  </fieldset>;
}
