import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {BUSINESS_STRUCTURE_TYPES,validBusinessCommand,businessCode} from '../../shared/business-structure.mjs';
import {calendarLabel} from '../../shared/calendar-authoring.mjs';
import {validCapabilityDate} from '../../shared/workforce-capabilities.mjs';
import {termTitle} from '../config/terminology';
import {ApiClientError} from '../services/apiClient';
import {businessStructureService as service,captureBusinessContext,isBusinessContextCurrent,type BusinessType,type BusinessContext,type BusinessCommand,type BusinessHistory,type BusinessList,type BusinessParents,type BusinessParentOption,type BusinessImpact,type BusinessReceipt} from '../services/businessStructure';
type Intent={command:BusinessCommand;sequence:number};
const label=(type:BusinessType)=>({business_unit:termTitle('businessUnit'),department:'Department',cost_centre:'Cost centre',practice:'Practice',location:'Location',region:termTitle('region')})[type];
export const BusinessStructureWorkspace=()=>{
 const[type,setType]=useState<BusinessType|''>(''),[list,setList]=useState<BusinessList|null>(null),[history,setHistory]=useState<BusinessHistory|null>(null),[parents,setParents]=useState<BusinessParents|null>(null),[parent,setParent]=useState<BusinessParentOption|null>(null),[parentChoice,setParentChoice]=useState<''|'none'|'selected'>('');
 const[code,setCode]=useState(''),[name,setName]=useState(''),[date,setDate]=useState(''),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[impact,setImpact]=useState<BusinessImpact|null>(null),[retireReason,setRetireReason]=useState(''),[retireConfirmed,setRetireConfirmed]=useState(false);
 const[receipt,setReceipt]=useState<BusinessReceipt|null>(null),[intent,setIntent]=useState<Intent|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const generation=useRef(0),mounted=useRef(false),flight=useRef(false),context=useRef<BusinessContext|null>(null);
 const reset=()=>{setHistory(null);setParents(null);setParent(null);setParentChoice('');setCode('');setName('');setDate('');setReason('');setConfirmed(false);setImpact(null);setRetireReason('');setRetireConfirmed(false);setReceipt(null);};
 const clear=()=>{++generation.current;context.current=null;flight.current=false;setList(null);reset();setIntent(null);setBusy(false);};
 const block=()=>{clear();setType('');setNotice('Account, role or scope changed. Unsent catalog changes and prior responses cleared. Reload explicitly.');};
 useEffect(()=>{
  mounted.current=true;const check=()=>{if(context.current&&!isBusinessContextCurrent(context.current))block();};
  window.addEventListener('workos:organization-scope-switch-requested',block);window.addEventListener('workos:organization-scope-changed',block);window.addEventListener('focus',check);window.addEventListener('storage',check);
  return()=>{mounted.current=false;++generation.current;window.removeEventListener('workos:organization-scope-switch-requested',block);window.removeEventListener('workos:organization-scope-changed',block);window.removeEventListener('focus',check);window.removeEventListener('storage',check);};
 },[]);
 const current=(c:BusinessContext)=>mounted.current&&isBusinessContextCurrent(c);
 const run=async(action:(c:BusinessContext)=>Promise<void>)=>{
  if(flight.current)return;if(context.current&&!isBusinessContextCurrent(context.current)){block();return;}
  const n=generation.current,c=context.current??captureBusinessContext(()=>mounted.current&&generation.current===n);if(!c){block();return;}context.current=c;flight.current=true;setBusy(true);setNotice('');
  try{await action(c);}catch(e){if(mounted.current&&generation.current===n){if(!isBusinessContextCurrent(c)){block();return;}setNotice(e instanceof ApiClientError?e.message:'Catalog operation could not be confirmed. Reconcile the original request before another write.');}}
  finally{if(mounted.current&&generation.current===n){flight.current=false;setBusy(false);}}
 };
 const load=(after:string|null=null)=>{if(type)void run(async c=>{const r=await service.list(type,after,c);if(current(c)){setList(r);reset();}});};
 const read=(id:string,before:number|null=null)=>void run(async c=>{
  const r=await service.history(id,before,c);if(current(c)){if(r.latest.type!==type||before!==null&&r.latest.eventId!==history?.latest.eventId)throw new ApiClientError('Catalog source changed. Reload current history.',{status:409});setHistory(r);
   if(before===null){setCode(r.latest.code);setName(r.latest.definition.name);setDate('');setParents(null);setParent(null);setParentChoice('');setReason('');setConfirmed(false);setImpact(null);setRetireReason('');setRetireConfirmed(false);setReceipt(null);}
  }
 });
 const loadParents=(after:string|null=null)=>{if(type&&validCapabilityDate(date))void run(async c=>{
  const r=await service.parents(type,date,history?.lineageId??null,after,c);if(current(c)){setParents(after&&parents?{...r,parents:[...parents.parents,...r.parents.filter(x=>!parents.parents.some(y=>y.parent.itemId===x.parent.itemId))]}:r);setParent(null);setParentChoice('');setConfirmed(false);}
 });};
 const loadImpact=()=>{if(history)void run(async c=>{const r=await service.impact(history.lineageId,c);if(current(c)){if(r.latestId!==history.latest.eventId||r.nativeItemId!==history.latest.nativeItemId)throw new ApiClientError('Catalog source changed. Reload current history before retirement.',{status:409});setImpact(r);setRetireConfirmed(false);}});};
 const saved=(r:BusinessReceipt)=>{reset();setReceipt(r);setIntent(null);setList(null);setNotice('Catalog command confirmed. Reload current sources before another change. Existing consumer references are never rebound automatically.');};
 const submit=(command:BusinessCommand,sequence:number)=>{
  if(intent||!validBusinessCommand(command)){setNotice('Complete the explicit catalog fields, parent choice, source confirmation and reason.');return;}
  const item={command,sequence};void run(async c=>{setIntent(item);try{const r=await service.apply(command,sequence,c);if(current(c))saved(r);}catch(e){if(current(c)&&e instanceof ApiClientError&&[400,403,404,409].includes(e.status)){setIntent(null);setList(null);setParents(null);setParent(null);setImpact(null);setNotice(e.message+' Reload current history and source options before another command.');}else throw e;}});
 };
 const append=()=>{if(!list||!type||!confirmed||!parentChoice||parentChoice==='selected'&&!parent)return;submit({requestId:crypto.randomUUID(),lineageId:history?.lineageId??null,expectedLatestId:history?.latest.eventId??null,type,code,action:'Append',effectiveFrom:date,definition:{name,parentId:parentChoice==='selected'?parent!.parent.itemId:null},expectedParentToken:parentChoice==='selected'?parent!.parentToken:null,reason},history?.latest.sequence??0);};
 const retire=()=>{if(!history||!impact||impact.total!==0||impact.latestId!==history.latest.eventId||!retireConfirmed)return;const e=history.latest;submit({requestId:crypto.randomUUID(),lineageId:e.lineageId,expectedLatestId:e.eventId,type:e.type,code:e.code,action:'Retire',effectiveFrom:e.effectiveFrom,definition:structuredClone(e.definition),expectedParentToken:null,reason:retireReason},e.sequence);};
 const reconcile=()=>{if(intent)void run(async c=>{const r=await service.reconcile(intent.command,intent.sequence,c);if(current(c))saved(r);});};
 const allowed=Boolean(captureBusinessContext()),locked=!allowed||busy||Boolean(intent)||!list||history?.latest.action==='Retire',appendReady=businessCode(code)&&calendarLabel(name,150)&&validCapabilityDate(date)&&(!list||date>=list.serverDate)&&calendarLabel(reason,1000)&&Boolean(parentChoice)&&confirmed;
 return <main className="mx-auto max-w-5xl space-y-4 pb-12">
  <h1 className="text-2xl font-semibold">Business structure</h1>
  <p>Configure explicit legal-entity-owned catalog sources. Later effective versions receive new exact references and close the earlier date interval. Existing workers, calendars and commercial sources keep their pinned references; expired references remain unavailable until explicitly changed through their existing workflows.</p>
  {!allowed&&<p role="alert">Existing settings access and a selected organization and legal entity are required.</p>}
  <label>Catalog family<select aria-label="Catalog family" value={type} disabled={!allowed||busy||Boolean(intent)||Boolean(history)} onChange={e=>{clear();setType(e.target.value as BusinessType|'');setNotice('');}}><option value="">Choose an explicit catalog family</option>{BUSINESS_STRUCTURE_TYPES.map(t=><option key={t} value={t}>{label(t as BusinessType)}</option>)}</select></label>
  <button disabled={!allowed||!type||busy||Boolean(intent)} onClick={()=>load()}>Load authored catalog sources</button>
  {busy&&<p role="status">Confirming current catalog sources…</p>}{notice&&<p role="status">{notice}</p>}
  {intent&&<section aria-label="Unconfirmed catalog command"><p>Original request {intent.command.requestId} is unconfirmed. Editing and new writes are stopped. A missing receipt may still be in flight; no write is retried automatically.</p><button disabled={busy} onClick={reconcile}>Reconcile original catalog request</button></section>}
  {list&&<section aria-label="Authored catalog sources"><p>Server UTC date: {list.serverDate}. New governed sources only; existing shared or legacy records are not implicitly adopted.</p><button disabled={busy||Boolean(intent)} onClick={reset}>Start new catalog lineage</button>
   {list.lineages.length===0&&<p>No governed catalog sources exist in this selected scope.</p>}
   <ul>{list.lineages.map(l=><li key={l.id}>{l.latest.code} · {l.latest.definition.name} · {l.latest.action==='Retire'?'Inactive':'Active'} · source date {l.latest.effectiveFrom} <button disabled={busy||Boolean(intent)} onClick={()=>read(l.id)}>Inspect catalog {l.latest.code}</button></li>)}</ul>
   {list.nextAfter&&<button disabled={busy||Boolean(intent)} onClick={()=>load(list.nextAfter)}>Next authored catalog sources</button>}
  </section>}
  <form onSubmit={e=>{e.preventDefault();append();}}><fieldset disabled={locked} className="space-y-3 border p-4"><legend>{history?'Append effective catalog version':'Create new catalog lineage'}</legend>
   <label>Catalog code<input aria-label="Catalog code" value={code} disabled={locked||Boolean(history)} maxLength={50} onChange={e=>{setCode(e.target.value);setConfirmed(false);}}/></label>
   <label>Catalog name<input aria-label="Catalog name" value={name} maxLength={150} onChange={e=>{setName(e.target.value);setConfirmed(false);}}/></label>
   <label>Catalog effective date<input aria-label="Catalog effective date" type="date" value={date} onChange={e=>{setDate(e.target.value);setParents(null);setParent(null);setParentChoice('');setConfirmed(false);}}/></label>
   <label>Catalog parent choice<select aria-label="Catalog parent choice" value={parentChoice} onChange={e=>{setParentChoice(e.target.value as ''|'none'|'selected');setConfirmed(false);}}><option value="">Choose explicitly</option><option value="none">No parent / explicitly clear parent</option>{parent&&<option value="selected">Use inspected parent {parent.parent.code}</option>}</select></label>
   <button type="button" disabled={!type||!validCapabilityDate(date)} onClick={()=>loadParents()}>Load eligible catalog parents</button>
   {parents&&<section aria-label="Eligible catalog parents"><p>Exact active same-family owned sources covering {date}; no title or manager mapping is inferred.</p>{parents.parents.length===0&&<p>No eligible parent source is available for this selection.</p>}<ul>{parents.parents.map(p=><li key={p.parent.itemId}>{p.parent.code} · {p.parent.name} · {p.parent.effectiveFrom}–{p.parent.effectiveTo??'open'} <button type="button" onClick={()=>{setParent(p);setParentChoice('selected');setConfirmed(false);}}>Use catalog parent {p.parent.code}</button></li>)}</ul>{parents.nextAfter&&<button type="button" onClick={()=>loadParents(parents.nextAfter)}>More eligible catalog parents</button>}</section>}
   {parentChoice==='selected'&&parent&&<p>Inspected exact parent reference: {parent.parent.itemId} · {parent.parent.name}.</p>}
   <label>Catalog change reason<textarea aria-label="Catalog change reason" value={reason} maxLength={1000} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label>
   <label><input type="checkbox" aria-label="Confirm exact catalog source and effective boundary" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I inspected the complete name/parent and effective boundary; existing references will not be reassigned.</label>
   <button type="submit" disabled={locked||!appendReady}>Record catalog version</button>
  </fieldset></form>
  {history&&<>
   <section aria-label="Immutable catalog history"><h2 className="text-xl font-semibold">Retained source history</h2><p>{label(history.latest.type)} · {history.latest.code} · {history.latest.action==='Retire'?'Inactive terminal lineage':'Active lineage'}.</p><ol>{history.events.map(e=><li key={e.eventId}>V{e.sequence} · {e.action} · {e.definition.name} · from {e.effectiveFrom}{e.retiredOn&&' · retired '+e.retiredOn}<p>Source reference: {e.nativeItemId}. Parent: {e.parentSource?e.parentSource.code+' · '+e.parentSource.name:'none'}.</p><p>{e.activeRole} · {e.source} · {e.createdAt} · {e.reason}</p></li>)}</ol>{history.nextBefore&&<button disabled={busy||Boolean(intent)} onClick={()=>read(history.lineageId,history.nextBefore)}>Earlier catalog history</button>}</section>
   <section aria-label="Catalog retirement"><h2 className="text-xl font-semibold">Retire inspected unused source</h2><p>Only the latest currently effective unused source can be retired. Current or retained references prevent this operation. Future cancellation, shared/legacy adoption and automatic reassignment are unavailable.</p>
    <button disabled={locked} onClick={loadImpact}>Load catalog dependency counts</button>
    {impact&&<section aria-label="Catalog dependency counts"><p>Total exact references: {impact.total}</p><ul>{Object.entries(impact.counts).map(([family,count])=><li key={family}>{({catalogChildren:'Catalog children',workingCalendars:'Working calendars',capacityVersions:'Capacity versions',commercialEngagements:'Commercial attributions',commercialBindings:'Retained commercial bindings'}as Record<string,string>)[family]}: {count}</li>)}</ul>{impact.total>0&&<p>References prevent unused-node retirement. No hidden identities or commercial values are exposed.</p>}</section>}
    <fieldset disabled={locked||!impact||impact.total!==0}><legend>Retire {history.latest.code} · {history.latest.definition.name}</legend><label>Retirement reason<textarea aria-label="Catalog retirement reason" value={retireReason} maxLength={1000} onChange={e=>{setRetireReason(e.target.value);setRetireConfirmed(false);}}/></label><label><input type="checkbox" aria-label="Confirm unused catalog retirement" checked={retireConfirmed} onChange={e=>setRetireConfirmed(e.target.checked)}/>I inspected this exact current source and its dependency counts.</label><button disabled={locked||!impact||impact.total!==0||!retireConfirmed||!calendarLabel(retireReason,1000)||Boolean(list&&history.latest.effectiveFrom>list.serverDate)} onClick={retire}>Retire unused catalog source</button></fieldset>
   </section>
  </>}
  {receipt&&<section aria-label="Confirmed catalog command"><h2>Confirmed {receipt.event.action==='Retire'?'retirement':'catalog version'}</h2><p>{receipt.event.code} · {receipt.event.definition.name} · V{receipt.event.sequence} · {receipt.event.action==='Retire'?'Inactive':'Active'}.</p><p>Exact source reference: {receipt.event.nativeItemId} · from {receipt.event.effectiveFrom}{receipt.event.retiredOn&&' · retired '+receipt.event.retiredOn}.</p><p>Original request: {receipt.event.requestId}. Existing consumer references and previous evidence are retained.</p></section>}
  <nav><Link to="/admin/calendar-scope-authoring">Open country/group calendars</Link> · <Link to="/workforce/directory">Open scoped workforce directory</Link></nav>
 </main>;
};
