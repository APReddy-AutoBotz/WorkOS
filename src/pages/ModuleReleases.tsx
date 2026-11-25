import {useEffect, useRef, useState} from 'react';
import {Link, Navigate} from 'react-router-dom';
import {api, getOrganizationScope, getToken} from '../services/apiClient';
import {authService} from '../services/authService';
import {hasPermission} from '../services/permissions';
import {applyModuleReleases, type EnterpriseFeatureFlag} from '../config/featureFlags';

type Decision = {revision:number; enabled:boolean; evidence:string; activated_at:string; owner_id:string; module:string};
type ReleaseState = {environment:string; decisions:Decision[]};

const modules = {
  teams:{label:'Teams', link:'Teams mapping', path:'/integrations/teams'},
  entra:{label:'Entra administration', link:'identity mapping', path:'/integrations/identity'},
  leave:{label:'Leave', link:'leave administration', path:'/leave/admin'},
  notifications:{label:'Notification center', link:'notification center', path:'/notifications'},
  planning:{label:'Planning workspace', link:'planning workspace', path:'/planning'},
} satisfies Record<EnterpriseFeatureFlag,{label:string; link:string; path:string}>;

export function ModuleReleases() {
  const user = authService.getCurrentUser();
  const scope = getOrganizationScope();
  if (!scope || !hasPermission(user,'releases.manage')) return <Navigate to="/no-access" replace/>;
  return <div key={[scope.organizationId,scope.legalEntityId,user?.id,user?.role].join('/')}>
    <ReleaseForm organizationId={scope.organizationId} legalEntityId={scope.legalEntityId}/>
  </div>;
}

function ReleaseForm({organizationId,legalEntityId}:{organizationId:string;legalEntityId:string}) {
  const [state,setState] = useState<ReleaseState>();
  const [evidence,setEvidence] = useState('');
  const [message,setMessage] = useState('');
  const [saving,setSaving] = useState(false);
  const [reload,setReload] = useState(0);
  const active = useRef(false);
  const token = getToken();
  const [module,setModule] = useState<EnterpriseFeatureFlag>('teams');
  const decision = state?.decisions.find(item => item.module === module);
  const {label, link, path:modulePath} = modules[module];
  const path = '/api/v1/organization-setup/module-releases';
  useEffect(() => {
    active.current = true;
    let current = true;
    setState(undefined);
    api.requestWithContext<ReleaseState>('GET',path,undefined,{scope:{organizationId,legalEntityId},token})
      .then(result => { if (current) setState(result); })
      .catch(error => { if (current) setMessage(error.message); });
    return () => { current = false; active.current = false; };
  },[organizationId,legalEntityId,token,reload]);

  const save = async () => {
    const scope = getOrganizationScope();
    if (!state || saving || !evidence.trim() || token !== getToken() ||
        scope?.organizationId !== organizationId || scope.legalEntityId !== legalEntityId) return;
    setSaving(true);
    setMessage('');
    try {
      const receipt = await api.requestWithContext<Decision>('PUT',path+'/'+module,{
        enabled:!decision?.enabled, expectedRevision:decision?.revision ?? 0, evidence:evidence.trim(),
      },{scope,token});
      if (!active.current || token !== getToken() || organizationId !== getOrganizationScope()?.organizationId) return;
      const decisions = [...state.decisions.filter(item => item.module !== module),receipt];
      applyModuleReleases(organizationId,Object.fromEntries(decisions.map(item => [item.module,item.enabled])));
      setState({...state,decisions});
      setEvidence('');
      setMessage('Release decision saved.');
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : 'Could not save the decision.');
    } finally {
      if (active.current) setSaving(false);
    }
  };
  return <section className="space-y-4 rounded-xl border bg-white p-6">
    <h1 className="text-xl font-bold">Module release settings</h1>
    {state && <>
      <label htmlFor="release-module">Module</label>
      <select id="release-module" value={module} disabled={saving} onChange={event=>{
        setModule(event.target.value as EnterpriseFeatureFlag); setEvidence(''); setMessage('');
      }}>{Object.entries(modules).map(([key,item]) => <option key={key} value={key}>{item.label}</option>)}</select>
      <p>{label} is <strong>{decision?.enabled ? 'enabled' : 'disabled'}</strong> for {organizationId} in {state.environment}.</p>
      {decision?.enabled && <Link className="underline" to={modulePath}>Open {link}</Link>}
      {decision && <p>Last decision by {decision.owner_id} on {new Date(decision.activated_at).toLocaleString()}. {decision.evidence}</p>}
      <label className="block">Release evidence<textarea className="input-field" maxLength={1000} value={evidence}
        disabled={saving} onChange={event=>setEvidence(event.target.value)}/></label>
      <button className="btn-primary" disabled={saving || !evidence.trim()} onClick={save}>{(decision?.enabled ? 'Disable ' : 'Enable ')+label}</button>
    </>}
    <button className="btn-secondary" disabled={saving} onClick={()=>{setMessage('');setReload(i=>i+1);}}>Reload decision</button>
    <p role="status">{message || (!state ? 'Loading release settingsâ€¦' : '')}</p>
  </section>;
}
