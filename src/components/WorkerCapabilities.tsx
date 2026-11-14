import {useEffect,useRef,useState} from 'react';
import {validCapabilities} from '../../shared/workforce-capabilities.mjs';
import {captureCapabilityContext,isCapabilityContextCurrent,workforceCapabilitiesService,type CapabilityContext,type CapabilityPage,type CapabilityProfile as Profile} from '../services/workforceCapabilities';
import {ApiClientError} from '../services/apiClient';
import {CapabilityProfile} from './CapabilityProfile';
const empty=():Profile=>({skills:[],certifications:[],availabilityNote:null});
export const WorkerCapabilities=({employeeId}:{employeeId:string;key?:string})=>{
 const [page,setPage]=useState<CapabilityPage|null>(null),[draft,setDraft]=useState<Profile>(empty),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[blocked,setBlocked]=useState(false);
 const generation=useRef(0),owner=useRef<CapabilityContext|null>(null);
 useEffect(()=>{
  const clear=()=>{++generation.current;owner.current=null;setPage(null);setDraft(empty());setReason('');setBusy(false);setBlocked(true);setNotice('Access or scope changed. Load capabilities again.');};
  const check=()=>{if(owner.current&&!isCapabilityContextCurrent(owner.current))clear();};
  const events=['workos:organization-scope-switch-requested','workos:organization-scope-changed'];events.forEach(e=>window.addEventListener(e,clear));window.addEventListener('storage',check);window.addEventListener('focus',check);
  return()=>{++generation.current;events.forEach(e=>window.removeEventListener(e,clear));window.removeEventListener('storage',check);window.removeEventListener('focus',check);};
 },[employeeId]);
 const load=async(before:number|null=null)=>{
  const request=++generation.current,context=captureCapabilityContext('read',()=>request===generation.current);owner.current=context;setBusy(true);setNotice('');setPage(null);setDraft(empty());setReason('');setBlocked(true);
  try{const result=await workforceCapabilitiesService.get(employeeId,before,context);if(request===generation.current){setPage(result);setDraft(result.current?structuredClone(result.current.profile):empty());setBlocked(false);}}
  catch{if(request===generation.current)setNotice('Capabilities are unavailable for this account, worker or scope. Reload before editing.');}
  finally{if(request===generation.current)setBusy(false);}
 };
 const save=async()=>{
  if(!page||blocked)return;const request=++generation.current,context=captureCapabilityContext('manage',()=>request===generation.current);owner.current=context;setBusy(true);setNotice('');
  try{const current=await workforceCapabilitiesService.save(employeeId,{expectedLatestId:page.current?.id??null,profile:draft,reason},context);if(request===generation.current){const latestPage=page.versions[0]?.id===page.current?.id;setPage({...page,current,versions:latestPage?[current,...page.versions].slice(0,10):[current],nextBeforeSequence:latestPage?(page.versions.length>=10?page.versions[8].sequence:page.nextBeforeSequence):(current.sequence>1?current.sequence:null)});setDraft(structuredClone(current.profile));setReason('');setNotice('Capability version recorded.');}}
  catch(e){if(request===generation.current){const known=e instanceof ApiClientError&&[400,409].includes(e.status);setBlocked(!known||e instanceof ApiClientError&&e.status===409);setNotice(e instanceof ApiClientError&&e.status===409?'Capabilities changed in another session. Your edits remain here; load the current version before saving.':known?'Check the complete profile and reason.':'Save could not be confirmed. Load capabilities before retrying.');}}
  finally{if(request===generation.current)setBusy(false);}
 };
 const canManage=Boolean(captureCapabilityContext('manage'));
 return <section aria-label="Worker capabilities" className="my-4 space-y-3 rounded-xl border p-4 text-sm">
  <h2 className="font-semibold">Skills, certifications and availability notes</h2>
  <p>Buyer-entered planning information; certifications are not externally verified. Notes do not calculate availability or capacity. Proficiency labels have no inferred rank.</p>
  <button disabled={busy} onClick={()=>void load()}>Load capabilities</button>{busy&&<p role="status">Loading or saving capabilities…</p>}{notice&&<p role="status">{notice}</p>}
  {page&&<><p>{page.current?`Current recorded version ${page.current.sequence}`:'No capability profile has been recorded.'}</p>{page.current&&<CapabilityProfile profile={page.current.profile}/>}
   {canManage&&<form className="space-y-3" onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy||blocked} className="space-y-3"><legend>Edit capability profile</legend>
    {draft.skills.map((s,i)=><div key={i} className="flex flex-wrap gap-2"><label>Skill {i+1}<input className="input-field" value={s.skill} onChange={e=>setDraft(d=>({...d,skills:d.skills.map((v,j)=>j===i?{...v,skill:e.target.value}:v)}))}/></label><label>Proficiency {i+1}<input className="input-field" value={s.proficiency??''} onChange={e=>setDraft(d=>({...d,skills:d.skills.map((v,j)=>j===i?{...v,proficiency:e.target.value||null}:v)}))}/></label><button type="button" onClick={()=>setDraft(d=>({...d,skills:d.skills.filter((_,j)=>i!==j)}))}>Remove skill {i+1}</button></div>)}
    <button type="button" disabled={draft.skills.length>=50} onClick={()=>setDraft(d=>({...d,skills:[...d.skills,{skill:'',proficiency:null}]}))}>Add skill</button>
    {draft.certifications.map((c,i)=><div key={i} className="flex flex-wrap gap-2"><label>Certification {i+1}<input className="input-field" value={c.certification} onChange={e=>setDraft(d=>({...d,certifications:d.certifications.map((v,j)=>j===i?{...v,certification:e.target.value}:v)}))}/></label><label>Valid from {i+1}<input type="date" value={c.validFrom} onChange={e=>setDraft(d=>({...d,certifications:d.certifications.map((v,j)=>j===i?{...v,validFrom:e.target.value}:v)}))}/></label><label>Valid through {i+1}<input type="date" disabled={c.noExpiry} value={c.validThrough??''} onChange={e=>setDraft(d=>({...d,certifications:d.certifications.map((v,j)=>j===i?{...v,validThrough:e.target.value||null}:v)}))}/></label><label><input type="checkbox" checked={c.noExpiry} onChange={e=>setDraft(d=>({...d,certifications:d.certifications.map((v,j)=>j===i?{...v,noExpiry:e.target.checked,validThrough:null}:v)}))}/>Explicitly no expiry {i+1}</label><button type="button" onClick={()=>setDraft(d=>({...d,certifications:d.certifications.filter((_,j)=>i!==j)}))}>Remove certification {i+1}</button></div>)}
    <button type="button" disabled={draft.certifications.length>=50} onClick={()=>setDraft(d=>({...d,certifications:[...d.certifications,{certification:'',validFrom:'',validThrough:null,noExpiry:false}]}))}>Add certification</button>
    <label className="block">Availability note<textarea className="input-field" value={draft.availabilityNote??''} onChange={e=>setDraft(d=>({...d,availabilityNote:e.target.value||null}))}/></label>
    <p>Use unique exact labels of 1–100 characters, at most 50 skills and 50 certifications. Each certification needs valid dates or explicit no expiry. Notes allow 3,000 characters.</p>
    {!validCapabilities(draft)&&<p role="alert">Complete the labels and certification dates, remove duplicate labels, and check text limits before saving.</p>}
    <button type="button" onClick={()=>setDraft(empty())}>Clear profile contents</button><label className="block">Change reason<input className="input-field" maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label><button type="submit" disabled={!validCapabilities(draft)||!reason.trim()||reason.trim().length>1000}>Record capability version</button>
   </fieldset></form>}
   <h3 className="font-semibold">Retained capability versions</h3><p>Recorded information is retained; later entries do not verify or rewrite earlier versions.</p>
   {page.versions.map(v=><article key={v.id} aria-label={`Capability version ${v.sequence}`} className="border-t py-2"><p>Version {v.sequence} · {new Date(v.createdAt).toLocaleString()} · {v.activeRole} · {v.source} · Reason: {v.reason}</p><CapabilityProfile profile={v.profile}/></article>)}
   {page.nextBeforeSequence!==null&&<button disabled={busy} onClick={()=>void load(page.nextBeforeSequence)}>Load older capability versions</button>}
  </>}
 </section>;
};
