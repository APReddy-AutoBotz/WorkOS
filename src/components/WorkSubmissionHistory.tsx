import {WorkCategory} from './WorkCategory';
import {WorkSourceIdentity} from './WorkSourceIdentity';
import {SubmissionTiming} from './SubmissionTiming';
import {useEffect,useRef,useState} from 'react';
import {ApiClientError} from '../services/apiClient';
import {captureWorkCaptureContext,isWorkCaptureContextCurrent,type WorkCaptureContext} from '../services/workCaptureModes';
import {workSubmissionHistoryService,type WorkHistoryPage} from '../services/workSubmissionHistory';
const formatInstant=(value:string)=>new Date(value).toLocaleString();
export const WorkSubmissionHistory=({timesheetId,expectedEmployeeId}:{timesheetId:string;expectedEmployeeId?:string;key?:string})=>{
 const [open,setOpen]=useState(false),[page,setPage]=useState<WorkHistoryPage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),owner=useRef<WorkCaptureContext|null>(null),cursor=useRef<number|null>(null);
 useEffect(()=>{
  const clear=()=>{++generation.current;owner.current=null;setPage(null);setBusy(false);setError('Access or scope changed. Load history again for the current work period.');};
  const check=()=>{if(owner.current&&!isWorkCaptureContextCurrent(owner.current))clear();};
  window.addEventListener('workos:organization-scope-switch-requested',clear);window.addEventListener('workos:organization-scope-changed',clear);window.addEventListener('storage',check);window.addEventListener('focus',check);
  return()=>{++generation.current;window.removeEventListener('workos:organization-scope-switch-requested',clear);window.removeEventListener('workos:organization-scope-changed',clear);window.removeEventListener('storage',check);window.removeEventListener('focus',check);};
 },[]);
 const load=async(before:number|null)=>{
  const request=++generation.current;cursor.current=before;const context=captureWorkCaptureContext(()=>request===generation.current);owner.current=context;setOpen(true);setPage(null);setError('');setBusy(true);
  try{const result=await workSubmissionHistoryService.get(timesheetId,before,context,expectedEmployeeId);if(request===generation.current)setPage(result);}
  catch(failure){if(request===generation.current)setError(failure instanceof ApiClientError&&[401,403,404].includes(failure.status)?'Retained work history is unavailable for this account, scope or work period. Reload work before trying again.':'Retained work history could not be loaded. Retry for the current work period.');}
  finally{if(request===generation.current)setBusy(false);}
 };
 const close=()=>{++generation.current;owner.current=null;setPage(null);setError('');setBusy(false);setOpen(false);};
 return <section aria-label="Retained work history" className="my-4 rounded-xl border border-slate-200 p-4 text-sm break-words">
  <div className="flex flex-wrap gap-3"><h2 className="font-semibold">Submission and correction history</h2>{open?<button onClick={close}>Close history</button>:<button onClick={()=>void load(null)}>Load retained history</button>}</div>
  {open&&<><p className="my-2">These are retained submissions and recorded decisions. Current draft edits are separate. Work saved before history tracking may have no retained versions.</p>
   {busy&&<p role="status">Loading retained work history…</p>}
   {error&&<div role="alert"><p>{error}</p><button disabled={busy} onClick={()=>void load(cursor.current)}>Retry history</button></div>}
   {page&&<><p>Work period ending {page.weekEnding}. {page.submissions.length} retained versions on this page.</p>
    {page.submissions.length===0?<p>No retained submissions on this page. Earlier work is not assigned an inferred submission or decision history.</p>:page.submissions.map(submission=><article key={submission.id} aria-label={`Retained submission ${submission.sequence}`} className="my-3 rounded-lg border p-3">
     <h3 className="font-semibold">Submission {submission.sequence}</h3><SubmissionTiming checks={submission.submissionTiming} retained/><p>Submitted <time dateTime={submission.createdAt}>{formatInstant(submission.createdAt)}</time> · {submission.activeRole} · {submission.source}</p>
     {submission.decision?<p>{submission.decision.status} <time dateTime={submission.decision.createdAt}>{formatInstant(submission.decision.createdAt)}</time> · {submission.decision.activeRole} · {submission.decision.source}{submission.decision.reason?` · Reason: ${submission.decision.reason}`:''}</p>:<p>No retained decision for this submission.</p>}
     <ul>{submission.entries.map(entry=><li key={entry.entryId} className="my-2 border-t pt-2"><p>{entry.workDate} · {entry.hoursExact}h · {entry.workType} · {entry.billable?'Billable':'Non-billable'}</p><p>{entry.clientName||''}{entry.category?` · ${entry.category}`:''}{entry.projectId?` · Project reference: ${entry.projectId}`:''}</p><WorkCategory value={entry.categoryReference} code={entry.categoryCode}/><WorkSourceIdentity value={entry.sourceIdentity}/><p>Comment: {entry.remark||'None recorded'}</p><p>Reference: {entry.workReference===undefined?'Not retained in this historical version':entry.workReference||'None recorded'}</p>
      {entry.evidenceUrl?<a href={entry.evidenceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open retained evidence link</a>:<p>Evidence link: {entry.evidenceUrl===undefined?'Not retained in this historical version':'None recorded'}</p>}</li>)}</ul>
    </article>)}
    <nav aria-label="Retained history pages" className="flex flex-wrap gap-4"><button disabled={busy} onClick={()=>void load(null)}>Latest versions</button>{page.nextBeforeSequence!==null&&<button disabled={busy} onClick={()=>void load(page.nextBeforeSequence)}>Older versions</button>}</nav>
   </>}
  </>}
 </section>;
};
