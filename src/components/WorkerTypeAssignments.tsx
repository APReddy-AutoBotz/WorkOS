import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,ApiClientError} from '../services/apiClient';
import {captureDirectoryContext,isDirectoryContextCurrent} from '../services/workforceDirectory';

const date=z.string().date(),id=z.string().uuid();
const timeline=z.object({
  employeeId:z.string(),ownerKey:z.string(),on:date,latestId:id.nullable(),nextBefore:date.nullable(),moreOptions:z.boolean(),
  options:z.array(z.object({id:z.string(),name:z.string(),code:z.string()}).strict()).max(50),
  history:z.array(z.object({id,effectiveFrom:date,workerTypeId:z.string().nullable(),label:z.string().nullable(),reason:z.string()}).strict()).max(20),
}).strict();
const receipt=z.object({id,employeeId:z.string(),ownerKey:z.string(),replayed:z.boolean()}).strict();
type Command={requestId:string;expectedOwnerKey:string;expectedLatestId:string|null;workerTypeId:string|null;effectiveFrom:string;reason:string};

export function WorkerTypeAssignments({workerId,ownerKey,onSaved}:{workerId:string;ownerKey:string;onSaved:()=>void}){
  const [day,setDay]=useState(()=>new Date().toISOString().slice(0,10)),[search,setSearch]=useState(''),[selected,setSelected]=useState(''),
    [reason,setReason]=useState(''),[data,setData]=useState<z.infer<typeof timeline>|null>(null),[busy,setBusy]=useState(false),
    [message,setMessage]=useState(''),[pending,setPending]=useState<Command|null>(null);
  const mounted=useRef(false),locked=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const path='/api/v1/workforce-directory/workers/'+encodeURIComponent(workerId)+'/type-assignments';
  const clear=()=>{setData(null);setSelected('');setMessage('');};
  const run=async(method:'GET'|'POST',cmd?:Command,before?:string)=>{
    if(locked.current)return;
    const context=captureDirectoryContext(()=>mounted.current);
    if(!context)return;
    locked.current=true;setBusy(true);setMessage('');
    try{
      const query=new URLSearchParams({on:day,search,...before?{before}:{}});
      const result=await api.requestWithContext<unknown>(method,path+(cmd?'':'?'+query),cmd,context);
      if(!isDirectoryContextCurrent(context))return;
      if(cmd){
        const saved=receipt.parse(result);
        if(saved.id!==cmd.requestId || saved.ownerKey!==ownerKey || saved.employeeId!==workerId)throw Error();
        setPending(null);setData(null);setReason('');setSelected('');setMessage('Worker type assignment recorded.');onSaved();
      }else{
        const page=timeline.parse(result);
        if(page.employeeId!==workerId || page.ownerKey!==ownerKey || page.on!==day)throw Error();
        setData(page);setSelected('');
      }
    }catch(e){
      if(!isDirectoryContextCurrent(context))return;
      if(cmd && e instanceof ApiClientError && [400,403,404,409].includes(e.status)){
        setPending(null);clear();setMessage('Assignment refused. Reload the timeline before making another change.');
      }else setMessage(cmd?'Outcome uncertain. Retry the same assignment to recover its receipt.':'Classification timeline unavailable.');
    }finally{locked.current=false;if(mounted.current)setBusy(false);}
  };
  const save=()=>{
    if(!data || !selected || reason.trim().length<3)return;
    const cmd={requestId:crypto.randomUUID(),expectedOwnerKey:ownerKey,expectedLatestId:data.latestId,workerTypeId:selected==='clear'?null:selected.slice(3),effectiveFrom:day,reason:reason.trim()};
    setPending(cmd);void run('POST',cmd);
  };
  return <section aria-label="Worker type maintenance">
    <h3>Worker type assignments</h3>
    <fieldset disabled={busy||Boolean(pending)}>
      <label>Effective date <input type="date" value={day} onChange={e=>{clear();setDay(e.target.value);}}/></label>
      <label>Find worker type <input value={search} maxLength={100} onChange={e=>{clear();setSearch(e.target.value);}}/></label>
      <button type="button" disabled={!day} onClick={()=>void run('GET')}>Load types and assignments</button>
      {data && <>
        {data.moreOptions && <p>Refine the search to see more worker types.</p>}
        <label>Worker type to assign <select value={selected} onChange={e=>setSelected(e.target.value)}>
          <option value="">Choose a type</option><option value="clear">Unclassified</option>
          {data.options.map(o=><option key={o.id} value={'id:'+o.id}>{o.name} · {o.code}</option>)}
        </select></label>
        <label>Classification reason <input value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
        <button type="button" disabled={!selected||reason.trim().length<3} onClick={save}>Record dated assignment</button>
        {data.history.length>0 && <ul aria-label="Recorded worker type assignments">{data.history.map(v=><li key={v.id}>{v.effectiveFrom} · {v.label??'Unclassified'} · {v.reason}</li>)}</ul>}
        {data.nextBefore && <button type="button" onClick={()=>void run('GET',undefined,data.nextBefore!)}>Older assignments</button>}
      </>}
    </fieldset>
    {pending && <button type="button" disabled={busy} onClick={()=>void run('POST',pending)}>Retry original assignment</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
