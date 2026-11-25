import {useEffect, useRef, useState} from 'react';
import {Link, Navigate} from 'react-router-dom';
import {api, getOrganizationScope, getToken} from '../services/apiClient';
import {authService} from '../services/authService';
import {hasPermission} from '../services/permissions';
import {applyTeamsRelease} from '../config/featureFlags';

type Decision = {revision:number; enabled:boolean; evidence:string; activated_at:string; owner_id:string; module:string};
type ReleaseState = {environment:string; decisions:Decision[]};

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
  const decision = state?.decisions.find(item => item.module === 'teams');
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
      const receipt = await api.requestWithContext<Decision>('PUT',path+'/teams',{
        enabled:!decision?.enabled, expectedRevision:decision?.revision ?? 0, evidence:evidence.trim(),
      },{scope,token});
      if (!active.current || token !== getToken() || organizationId !== getOrganizationScope()?.organizationId) return;
      applyTeamsRelease(organizationId,receipt.enabled);
      setState({...state,decisions:[receipt]});
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
      <p>Teams is <strong>{decision?.enabled ? 'enabled' : 'disabled'}</strong> for {organizationId} in {state.environment}.</p>
      {decision?.enabled && <Link className="underline" to="/integrations/teams">Open Teams mapping</Link>}
      {decision && <p>Last decision by {decision.owner_id} on {new Date(decision.activated_at).toLocaleString()}. {decision.evidence}</p>}
      <label className="block">Release evidence<textarea className="input-field" maxLength={1000} value={evidence}
        disabled={saving} onChange={event=>setEvidence(event.target.value)}/></label>
      <button className="btn-primary" disabled={saving || !evidence.trim()} onClick={save}>{decision?.enabled ? 'Disable Teams' : 'Enable Teams'}</button>
    </>}
    <button className="btn-secondary" disabled={saving} onClick={()=>{setMessage('');setReload(i=>i+1);}}>Reload decision</button>
    <p role="status">{message || (!state ? 'Loading release settingsâ€¦' : '')}</p>
  </section>;
}
