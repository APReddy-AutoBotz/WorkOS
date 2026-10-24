import {useEffect,useRef,useState} from 'react';
import {api} from '../services/apiClient';
import {captureWorkCaptureContext,assertWorkCaptureContext,isWorkCaptureContextCurrent} from '../services/workCaptureModes';
import {normalizeSubmissionTiming,type SubmissionTiming as Timing} from '../services/submissionDeadline';
const utc=(value:string)=>new Date(value).toISOString().replace('T',' ').replace('.000Z',' UTC').replace(/Z$/,' UTC');
export const SubmissionTiming=({checks,retained=false}:{checks?:Timing[];retained?:boolean})=>checks?.length?<section aria-label={retained?'Retained submission timing':'Submission deadline timing'} className="my-3 rounded-xl border border-slate-300 bg-slate-50 p-3 text-sm break-words">
 <h2 className="font-semibold">{retained?'Timing recorded at submission':'Configured submission deadlines'}</h2>
 <ul>{checks.map(check=><li key={check.periodId}>{check.periodCode}: deadline {utc(check.deadlineAt)}; grace ends {utc(check.graceEndsAt)}; {check.state}; late treatment {check.lateTreatment}. Checked {utc(check.checkedAt)}.</li>)}</ul>
 <p>{retained?'This retained result does not change with later clocks or policy versions.':'This is a point-in-time preview. The server checks again when submitting. Draft saves remain subject to existing work rules.'}</p>
</section>:null;
export const SubmissionDeadlinePreview=({dates}:{dates:string[]})=>{
 const key=[...new Set(dates)].sort().join(','),generation=useRef(0),[checks,setChecks]=useState<Timing[]|undefined>(),[message,setMessage]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{const request=++generation.current;let blocked=false;const context=captureWorkCaptureContext(()=>request===generation.current&&!blocked);
  const clear=()=>{blocked=true;++generation.current;setChecks(undefined);setMessage('Submission timing access or scope changed. Reload timing for the current work.');};
  const current=()=>Boolean(context&&isWorkCaptureContextCurrent(context));const check=()=>{if(!current())clear();};
  setChecks(undefined);setMessage('Loading submission timing…');
  void(async()=>{try{const owner=assertWorkCaptureContext(context);const raw=await api.requestWithContext<{organizationId:string;legalEntityId:string;checks:unknown}>('GET',`/api/v1/work-submission-deadline?dates=${encodeURIComponent(key)}`,undefined,owner);assertWorkCaptureContext(owner);if(raw.organizationId!==owner.scope.organizationId||raw.legalEntityId!==owner.scope.legalEntityId)throw Error('Scope mismatch');const parsed=normalizeSubmissionTiming(raw.checks);if(!parsed)throw Error('Unavailable timing');if(current()){setChecks(parsed);setMessage(parsed.length?'':'No explicit submission deadline resolved for these dates.');}}
   catch{if(request===generation.current){setChecks(undefined);setMessage('Submission timing is unavailable. Retry timing; submission still uses authoritative server checks.');}}})();
  window.addEventListener('workos:organization-scope-switch-requested',clear);window.addEventListener('workos:organization-scope-changed',clear);window.addEventListener('storage',check);window.addEventListener('focus',check);
  return()=>{++generation.current;window.removeEventListener('workos:organization-scope-switch-requested',clear);window.removeEventListener('workos:organization-scope-changed',clear);window.removeEventListener('storage',check);window.removeEventListener('focus',check);};
 },[key,retry]);
 return <div aria-label="Submission timing preview"><SubmissionTiming checks={checks}/><p role="status">{message}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>Reload submission timing</button></div>;
};
