import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {validCapabilityCriteria} from '../../shared/workforce-capabilities.mjs';
import {captureCapabilityContext,isCapabilityContextCurrent,workforceCapabilitiesService,type CapabilityContext,type CapabilityCriteria,type CapabilitySearch} from '../services/workforceCapabilities';
import {CapabilityProfile} from './CapabilityProfile';
const empty=():CapabilityCriteria=>({skill:null,proficiency:null,certification:null,validOn:null});
export const CapabilityPlanner=()=>{
 const [criteria,setCriteria]=useState<CapabilityCriteria>(empty),[result,setResult]=useState<CapabilitySearch|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const generation=useRef(0),owner=useRef<CapabilityContext|null>(null);
 useEffect(()=>{const clear=()=>{++generation.current;owner.current=null;setCriteria(empty());setResult(null);setBusy(false);setNotice('Access or scope changed. Search again for the current scope.');};const check=()=>{if(owner.current&&!isCapabilityContextCurrent(owner.current))clear();};const events=['workos:organization-scope-switch-requested','workos:organization-scope-changed'];events.forEach(e=>window.addEventListener(e,clear));window.addEventListener('storage',check);window.addEventListener('focus',check);return()=>{++generation.current;events.forEach(e=>window.removeEventListener(e,clear));window.removeEventListener('storage',check);window.removeEventListener('focus',check);};},[]);
 const search=async(after:string|null=null)=>{const request=++generation.current,context=captureCapabilityContext('search',()=>request===generation.current);owner.current=context;setBusy(true);setNotice('');setResult(null);try{const page=await workforceCapabilitiesService.search(criteria,after,context);if(request===generation.current)setResult(page);}catch{if(request===generation.current)setNotice('Capability search is unavailable. Check exact criteria, validity date and current access.');}finally{if(request===generation.current)setBusy(false);}};
 const change=(key:keyof CapabilityCriteria,value:string)=>{++generation.current;setResult(null);setBusy(false);setNotice('');setCriteria(c=>({...c,[key]:value||null}));};
 if(!captureCapabilityContext('search'))return null;
 return <section aria-label="Capability planner" className="space-y-3 rounded-xl border p-4 text-sm"><h2 className="font-semibold">Find recorded capabilities</h2>
  <p>Exact labels, combined with AND. Certification dates are inclusive. No skill ranking, provider verification, capacity calculation or staffing recommendation is inferred. Results use the latest recorded profile, not historical knowledge as of the validity date.</p>
  <form onSubmit={e=>{e.preventDefault();void search();}}><fieldset disabled={busy} className="flex flex-wrap gap-3"><legend>Capability criteria</legend>{(['skill','proficiency','certification','validOn'] as const).map(k=><label key={k}>{({skill:'Exact skill',proficiency:'Exact proficiency',certification:'Exact certification',validOn:'Certification valid on'})[k]}<input className="input-field" type={k==='validOn'?'date':'text'} value={criteria[k]??''} onChange={e=>change(k,e.target.value)}/></label>)}<button type="submit" disabled={!validCapabilityCriteria(criteria)}>Search capabilities</button></fieldset></form>
  {busy&&<p role="status">Searching current scoped capability profiles…</p>}{notice&&<p role="alert">{notice}</p>}
  {result&&<><p>{result.workers.length} workers on this page. Each result identifies its recorded version; employment, availability and assignment eligibility require their separate authoritative checks.</p>{result.workers.length===0&&<p>No workers match these criteria in this scope.</p>}
   {result.workers.map(w=><article key={w.employeeId} aria-label={`Capability result ${w.employeeCode}`} className="border-t py-2"><Link to={`/employees/${encodeURIComponent(w.employeeId)}`}>{w.employeeName} · {w.employeeCode}</Link>{w.current?<><p>Recorded version {w.current.sequence} · {w.current.id}</p><CapabilityProfile profile={w.current.profile}/></>:<p>No capability profile recorded.</p>}</article>)}
   {result.nextAfterEmployeeId!==null&&<button disabled={busy} onClick={()=>void search(result.nextAfterEmployeeId)}>Next capability page</button>}
  </>}
 </section>;
};
