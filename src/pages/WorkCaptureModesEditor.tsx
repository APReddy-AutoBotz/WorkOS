import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {PageHeader} from '../components/ui/PageHeader';
import {captureOrganizationProfileContext,isOrganizationProfileContextCurrent,type OrganizationProfileContext} from '../services/organizationProfileScope';
import {workCaptureModesSettingsService,type CaptureModesSettings,type CaptureModesDraft,type CaptureMode} from '../services/workCaptureModes';
import {ApiClientError,resetBackendCheck} from '../services/apiClient';

type State={generation:number;context:OrganizationProfileContext|null;status:'loading'|'ready'|'saving'|'blocked'|'error'|'uncertain';
  workspace?:CaptureModesSettings;draft?:CaptureModesDraft;message?:string};
const button='rounded-xl border border-slate-300 px-4 py-2 font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2';
export const WorkCaptureModesEditor=()=>{
  const mounted=useRef(false),generation=useRef(0);
  const initial:State={generation:0,context:null,status:'loading'};
  const live=useRef<State>(initial),[state,setState]=useState(initial);
  const publish=(next:State)=>{live.current=next;setState(next);};
  const current=(owner:State)=>mounted.current&&owner.generation===generation.current&&Boolean(owner.context&&isOrganizationProfileContextCurrent(owner.context));
  const block=()=>{++generation.current;publish({generation:generation.current,context:null,status:'blocked',message:'Access or scope changed. Reload for the selected legal entity.'});};
  const reload=()=>{
    if(!mounted.current||live.current.status==='saving')return;
    const request=++generation.current,context=captureOrganizationProfileContext(()=>mounted.current&&request===generation.current);
    const owner:State={generation:request,context,status:context?'loading':'blocked'};publish(owner);if(!context)return;
    resetBackendCheck();void workCaptureModesSettingsService.get(context).then(workspace=>{
      if(!current(owner)){if(mounted.current&&request===generation.current)block();return;}
      publish({...owner,status:'ready',workspace,draft:{expectedLatestId:workspace.latestId,enabledModes:[...(workspace.versions[0]?.enabledModes||[])]}});
    }).catch(()=>{if(current(owner))publish({...owner,status:'error',message:'Capture modes could not be loaded. Check access and connection, then reload.'});else if(mounted.current&&request===generation.current)block();});
  };
  useEffect(()=>{
    mounted.current=true;const check=()=>{if(live.current.context&&!isOrganizationProfileContextCurrent(live.current.context))block();};
    window.addEventListener('workos:organization-scope-switch-requested',block);window.addEventListener('workos:organization-scope-changed',block);
    window.addEventListener('storage',check);window.addEventListener('focus',check);reload();
    return()=>{mounted.current=false;++generation.current;window.removeEventListener('workos:organization-scope-switch-requested',block);window.removeEventListener('workos:organization-scope-changed',block);window.removeEventListener('storage',check);window.removeEventListener('focus',check);};
  },[]);
  const toggle=(mode:CaptureMode,enabled:boolean)=>{
    const owner=live.current;if(owner!==state||owner.status!=='ready'||!owner.draft||!current(owner))return;
    const selected=new Set(owner.draft.enabledModes);if(enabled)selected.add(mode);else selected.delete(mode);
    publish({...owner,draft:{...owner.draft,enabledModes:(['weekly','daily'] as CaptureMode[]).filter(value=>selected.has(value))},message:undefined});
  };
  const save=async(event:FormEvent)=>{
    event.preventDefault();const owner=live.current;
    if(owner.status!=='ready'||!owner.draft?.enabledModes.length||!current(owner))return;
    publish({...owner,status:'saving',message:undefined});
    try{
      await workCaptureModesSettingsService.append(owner.draft,owner.context);
      if(!current(owner)){if(mounted.current&&owner.generation===generation.current)block();return;}
      publish({...owner,status:'uncertain',message:'Capture modes appended. Reload to review the retained version before another change.'});
    }catch(error){
      if(!current(owner)){if(mounted.current&&owner.generation===generation.current)block();return;}
      const status=error instanceof ApiClientError?error.status:0;
      publish({...owner,status:status===400?'ready':'uncertain',message:status===400?'Select one or both capture modes.':status===409
        ?'Capture modes changed. Reload before trying again.':'Save could not be confirmed. Reload before trying again. Do not resubmit an uncertain save.'});
    }
  };
  return <div className="mx-auto max-w-5xl space-y-6 p-6">
    <PageHeader title="Work capture modes" subtitle="Explicit daily/weekly presentation enablement for the selected legal entity." breadcrumb={['Admin','Work capture modes']}/>
    <Link to="/admin" className="underline">Back to governance settings</Link>
    <p>No capture modes are enabled by default. Both views retain the same weekly header, whole-header submission, approvals and reporting-period controls. This does not configure a daily approval model or change organization calendars.</p>
    <p>New mode-aware saves pin this version and the complete work revision. Existing legacy API/import contracts remain supported; importing does not adopt a presentation mode.</p>
    <div role="status" aria-live="polite">{state.message||(state.status==='loading'?'Loading capture modes…':state.status==='saving'?'Appending capture modes…':'')}</div>
    <button className={button} disabled={state.status==='saving'||state.status==='loading'} onClick={reload}>Reload capture modes</button>
    {state.workspace&&<section aria-label="Capture mode history"><h2 className="font-bold">Retained versions</h2>
      {!state.workspace.versions.length&&<p>No explicit capture modes. No default has been adopted.</p>}
      {state.workspace.versions.map(version=><p key={version.id}>Version {version.sequence}: {version.enabledModes.join(', ')}.</p>)}
      {state.workspace.truncated&&<p>Only the latest 50 versions are shown.</p>}
    </section>}
    {state.draft&&<form onSubmit={save}><fieldset disabled={state.status!=='ready'} className="space-y-4">
      <legend className="font-bold">Append explicit capture modes</legend>
      <label className="flex gap-2"><input type="checkbox" checked={state.draft.enabledModes.includes('weekly')} onChange={event=>toggle('weekly',event.target.checked)}/>Enable weekly grid</label>
      <label className="flex gap-2"><input type="checkbox" checked={state.draft.enabledModes.includes('daily')} onChange={event=>toggle('daily',event.target.checked)}/>Enable daily entry</label>
      <button className={button} type="submit" disabled={!state.draft.enabledModes.length}>Append capture modes</button>
    </fieldset></form>}
  </div>;
};
