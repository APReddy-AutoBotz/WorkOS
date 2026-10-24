import {WorkCategoryEditor} from '../components/WorkCategoryEditor';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {PageHeader} from '../components/ui/PageHeader';
import {captureOrganizationProfileContext, isOrganizationProfileContextCurrent, type OrganizationProfileContext} from '../services/organizationProfileScope';
import {workCapturePolicyService, type CapturePolicyDraft, type CapturePolicyWorkspace} from '../services/workCapturePolicy';
import {ApiClientError, resetBackendCheck} from '../services/apiClient';

type State = {generation: number; context: OrganizationProfileContext | null;
  status: 'loading' | 'ready' | 'saving' | 'blocked' | 'error' | 'uncertain';
  workspace?: CapturePolicyWorkspace; draft?: CapturePolicyDraft; message?: string};
const control = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-3 disabled:bg-slate-100';
const button = 'rounded-xl border border-slate-300 px-4 py-2 font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2';

export const WorkCapturePolicyEditor = () => {
  const [deadlineProfile,setDeadlineProfile]=useState<'off'|'utc'>('off');
  const [deadlineFields,setDeadlineFields]=useState({days:'',time:'',grace:'',treatment:''});
  const mounted = useRef(false), generation = useRef(0);
  const initial: State = {generation: 0, context: null, status: 'loading'};
  const live = useRef<State>(initial), [state, setState] = useState(initial);
  const publish = (next: State) => { live.current = next; setState(next); };
  const current = (owner: State) => mounted.current && owner.generation === generation.current
    && Boolean(owner.context && isOrganizationProfileContextCurrent(owner.context));
  const block = () => {
    ++generation.current;
    publish({generation: generation.current, context: null, status: 'blocked', message: 'Access or scope changed. Reload for the selected legal entity.'});
  };
  const reload = () => {
    if (!mounted.current || live.current.status === 'saving') return;
    const request = ++generation.current;
    const context = captureOrganizationProfileContext(() => mounted.current && request === generation.current);
    const owner: State = {generation: request, context, status: context ? 'loading' : 'blocked'};
    publish(owner);
    if (!context) return;
    resetBackendCheck();
    void workCapturePolicyService.get(context).then(workspace => {
      if (!current(owner)) { if (mounted.current && request === generation.current) block(); return; }
      const latest = workspace.versions[0];
      setDeadlineProfile(latest?.submissionDeadline?'utc':'off');
      setDeadlineFields({days:latest?.submissionDeadline?String(latest.submissionDeadline.daysAfterPeriodEnd):'',time:latest?.submissionDeadline?.time??'',grace:latest?.submissionDeadline?String(latest.submissionDeadline.graceMinutes):'',treatment:latest?.submissionDeadline?.lateTreatment??''});
      // These are unsaved form suggestions, never an installed default policy.
      publish({...owner, status: 'ready', workspace, draft: {expectedLatestId: workspace.latestId,
        effectiveFrom: workspace.activationDates[0] || '', minimumIncrement: latest?.minimumIncrement || '0.25',
        dailyMaximum: latest?.dailyMaximum ?? null, weeklyMaximum: latest?.weeklyMaximum ?? null,
        commentRequired: latest?.commentRequired || false, evidenceRequired: latest?.evidenceRequired || false, overtime:latest?.overtime??null,submissionDeadline:latest?.submissionDeadline??null}});
    }).catch(() => {
      if (current(owner)) publish({...owner, status: 'error', message: 'Capture policy could not be loaded. Check access and connection, then reload.'});
      else if(mounted.current&&request===generation.current)block();
    });
  };
  useEffect(() => {
    mounted.current = true;
    const check = () => { if (live.current.context && !isOrganizationProfileContextCurrent(live.current.context)) block(); };
    window.addEventListener('workos:organization-scope-switch-requested', block);
    window.addEventListener('workos:organization-scope-changed', block);
    window.addEventListener('storage', check); window.addEventListener('focus', check);
    reload();
    return () => {
      mounted.current = false; ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', block);
      window.removeEventListener('workos:organization-scope-changed', block);
      window.removeEventListener('storage', check); window.removeEventListener('focus', check);
    };
  }, []);
  const edit = (field: keyof CapturePolicyDraft, value: CapturePolicyDraft[keyof CapturePolicyDraft]) => {
    if (live.current !== state || state.status !== 'ready' || !current(state)) return;
    publish({...state, draft: {...state.draft!, [field]: value}, message: undefined});
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const owner = live.current;
    if (owner.status !== 'ready' || !owner.draft || !current(owner)) return;
    publish({...owner, status: 'saving', message: undefined});
    try {
      const draft={...owner.draft};
      if(deadlineProfile==='utc'){if(!/^\d+$/.test(deadlineFields.days)||!/^\d+$/.test(deadlineFields.grace)||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(deadlineFields.time)||!['warn','block'].includes(deadlineFields.treatment)){publish({...owner,status:'ready',message:'Enter all explicit deadline and grace values.'});return;}draft.submissionDeadline={anchor:'weekly-end-date',timezone:'UTC',daysAfterPeriodEnd:Number(deadlineFields.days),time:deadlineFields.time,graceMinutes:Number(deadlineFields.grace),lateTreatment:deadlineFields.treatment as 'warn'|'block'};}else draft.submissionDeadline=null;
      await workCapturePolicyService.append(draft, owner.context);
      if (!current(owner)) { if (mounted.current && owner.generation === generation.current) block(); return; }
      publish({...owner, status: 'uncertain', message: 'Policy version appended. Reload to review the retained version before making another change.'});
    } catch (error) {
      if (!current(owner)) { if (mounted.current && owner.generation === generation.current) block(); return; }
      const status = error instanceof ApiClientError ? error.status : 0;
      if (status === 400) publish({...owner, status: 'ready', message: 'Policy was not saved. Check quantities and activation date.'});
      else publish({...owner, status: 'uncertain', message: status === 409
        ? 'Policy was not saved because its version or activation date changed. Reload before trying again.'
        : 'Save could not be confirmed. Reload before trying again. Do not resubmit an uncertain save.'});
    }
  };
  return <div className="mx-auto max-w-5xl space-y-6 p-6">
    <PageHeader title="Work capture policy" subtitle="Append effective-dated increments, aggregate limits, standard-hour thresholds, required comments and evidence URLs for the selected legal entity." breadcrumb={['Admin', 'Work capture policy']} />
    <Link to="/admin" className="underline">Back to governance settings</Link>
    <p>Policies activate only at an authoritative Weekly reporting-period start. All recorded worker work counts across headers and states. Blank maximums add no capture cap. Existing worker, assignment, date, period-lock and approval controls still apply.</p>
    <p>No policy is installed by default. This increment editor does not configure overtime approval exceptions, protected reopening or capture modes. Evidence requirements apply to every positive entry under the effective policy; zero entries are exempt.</p>
    <WorkCategoryEditor/>
    <p>Standard-hour thresholds are optional buyer rules. Select warning or blocking and enter daily and/or Weekly values explicitly. Existing hard maxima still apply; this does not calculate payroll, premium rates or financial value. Daily and Weekly conditions are separate, not additive payable hours.</p>
    <div aria-live="polite" role="status">{state.message || (state.status === 'loading' ? 'Loading capture policy…' : state.status === 'saving' ? 'Appending policy version…' : '')}</div>
    <button className={button} disabled={state.status === 'saving' || state.status === 'loading'} onClick={reload}>Reload capture policy</button>
    {state.workspace && <section aria-label="Capture policy history" className="space-y-2">
      <h2 className="font-bold">Retained versions</h2>
      {!state.workspace.versions.length && <p>No explicit capture policy. Existing neutral compatibility applies.</p>}
      {state.workspace.versions.map(policy => <p key={policy.id}>Version {policy.sequence}, effective {policy.effectiveFrom}: increment {policy.minimumIncrement}h; daily maximum {policy.dailyMaximum ?? 'not configured'}; Weekly maximum {policy.weeklyMaximum ?? 'not configured'}; comments {policy.commentRequired ? 'required' : 'optional'}; evidence URLs {policy.evidenceRequired ? 'required' : 'optional'}. Submission deadline: {policy.submissionDeadline?`${policy.submissionDeadline.daysAfterPeriodEnd} day(s) after Weekly end date at ${policy.submissionDeadline.time} UTC; grace ${policy.submissionDeadline.graceMinutes} minute(s); ${policy.submissionDeadline.lateTreatment}`:'not configured'}. Standard thresholds: {policy.overtime?`${policy.overtime.action}; daily ${policy.overtime.dailyThreshold??'not configured'}h; Weekly ${policy.overtime.weeklyThreshold??'not configured'}h`:'not configured'}.</p>)}
      {state.workspace.truncated && <p>Only the latest 50 versions are shown.</p>}
    </section>}
    {state.draft && <form onSubmit={save} className="space-y-4">
      <fieldset disabled={state.status !== 'ready'} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-bold">Append a new version</legend>
        <label>Weekly activation date<select className={control} required value={state.draft.effectiveFrom} onChange={event => edit('effectiveFrom', event.target.value)}><option value="">Select configured Weekly start</option>{state.workspace?.activationDates.map(date => <option key={date}>{date}</option>)}</select></label>
        <label>Minimum increment (hours)<input className={control} required inputMode="decimal" value={state.draft.minimumIncrement} onChange={event => edit('minimumIncrement', event.target.value)} /></label>
        <label>Daily maximum (hours, blank for no cap)<input className={control} inputMode="decimal" value={state.draft.dailyMaximum ?? ''} onChange={event => edit('dailyMaximum', event.target.value || null)} /></label>
        <label>Weekly maximum (hours, blank for no cap)<input className={control} inputMode="decimal" value={state.draft.weeklyMaximum ?? ''} onChange={event => edit('weeklyMaximum', event.target.value || null)} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={state.draft.commentRequired} onChange={event => edit('commentRequired', event.target.checked)} />Require a comment on every positive entry</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={state.draft.evidenceRequired || false} onChange={event => edit('evidenceRequired', event.target.checked)} />Require an evidence URL on every positive entry</label>
        <label>Standard-hour treatment<select aria-label="Standard-hour treatment" className={control} value={state.draft.overtime?.action??'off'} onChange={event=>edit('overtime',event.target.value==='off'?null:{action:event.target.value as 'warn'|'block',dailyThreshold:state.draft?.overtime?.dailyThreshold??null,weeklyThreshold:state.draft?.overtime?.weeklyThreshold??null})}><option value="off">Not configured / explicitly off</option><option value="warn">Warn when exceeded</option><option value="block">Block capture when exceeded</option></select></label>
        {state.draft.overtime&&<><label>Daily standard threshold (hours, optional)<input className={control} inputMode="decimal" value={state.draft.overtime.dailyThreshold??''} onChange={event=>edit('overtime',{...state.draft!.overtime!,dailyThreshold:event.target.value||null})}/></label><label>Weekly standard threshold (hours, optional)<input className={control} inputMode="decimal" value={state.draft.overtime.weeklyThreshold??''} onChange={event=>edit('overtime',{...state.draft!.overtime!,weeklyThreshold:event.target.value||null})}/></label><p>Enter at least one positive threshold. No value is supplied automatically.</p></>}
        <label>Submission deadline profile<select aria-label="Submission deadline profile" className={control} value={deadlineProfile} onChange={event=>setDeadlineProfile(event.target.value as 'off'|'utc')}><option value="off">Not configured / explicitly off</option><option value="utc">Explicit Weekly end-date UTC profile</option></select></label>
        {deadlineProfile==='utc'&&<><p>Enter every value explicitly. The deadline is the authoritative Weekly end date plus the selected days, at the selected UTC time. Other timezones are unsupported; no local/DST conversion is inferred. Draft saving is unchanged.</p>
         <label>Days after Weekly end date<input className={control} inputMode="numeric" required value={deadlineFields.days} onChange={event=>setDeadlineFields({...deadlineFields,days:event.target.value})}/></label>
         <label>Deadline time (HH:mm UTC)<input className={control} required placeholder="HH:mm" value={deadlineFields.time} onChange={event=>setDeadlineFields({...deadlineFields,time:event.target.value})}/></label>
         <label>Grace duration (minutes)<input className={control} inputMode="numeric" required value={deadlineFields.grace} onChange={event=>setDeadlineFields({...deadlineFields,grace:event.target.value})}/></label>
         <label>Late submission treatment<select aria-label="Late submission treatment" className={control} required value={deadlineFields.treatment} onChange={event=>setDeadlineFields({...deadlineFields,treatment:event.target.value})}><option value="">Select explicitly</option><option value="warn">Warn and retain timing</option><option value="block">Block overdue submission</option></select></label></>}
        <button className={button} type="submit" disabled={!state.draft.effectiveFrom}>Append capture policy</button>
      </fieldset>
      {!state.workspace?.activationDates.length && <p>Configure a future Weekly reporting period before appending a policy. No date is invented here.</p>}
    </form>}
  </div>;
};
