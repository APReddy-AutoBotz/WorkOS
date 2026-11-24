import {cloneElement, isValidElement, useEffect, useId, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {termTitle} from '../config/terminology';
import {ApiClientError} from '../services/apiClient';
import {commercialLifecycleService, type LifecycleEntityType, type LifecycleWorkspace} from '../services/commercialLifecycle';
import {
  captureCommercialAmendmentContext, commercialAmendmentService, isCommercialAmendmentContextCurrent, sameAmendmentTerms,
  type AmendmentInput, type AmendmentPreview, type AmendmentTerms, type AmendmentWorkspace, type CommercialAmendmentContext,
} from '../services/commercialAmendments';

type Selection = {type: LifecycleEntityType; id: string};
type Draft = AmendmentTerms & {lease: number; effectiveOn: string; reason: string; approvalReference: string};
type Preview = {value: AmendmentPreview; input: AmendmentInput; lease: number};
type WorkspaceState = {
  generation: number; context: CommercialAmendmentContext | null; status: 'loading' | 'ready' | 'error' | 'blocked';
  choices?: LifecycleWorkspace; selection: Selection; detailStatus?: 'loading' | 'ready' | 'error'; detail?: AmendmentWorkspace;
  draft?: Draft; preview?: Preview; saving?: 'preview' | 'apply'; requiresReload?: boolean; message?: string; error?: string;
};
const buttonClass = 'rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
const inputClass = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2.5 text-sm text-heading focus-visible:outline focus-visible:outline-2 disabled:bg-slate-100 read-only:bg-slate-50';
const panelClass = 'min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6';
const Field = ({label, children}: {label: string; children: ReactNode}) => {
  const id = useId();
  return <div className="min-w-0 text-sm font-semibold"><label htmlFor={id}>{label}</label>
    {isValidElement<{id?: string}>(children) ? cloneElement(children, {id}) : children}</div>;
};
const errorStatus = (error: unknown) => error instanceof ApiClientError ? error.status : 0;
const denied = (error: unknown) => [401, 403].includes(errorStatus(error));
const records = (workspace: LifecycleWorkspace | undefined, type: LifecycleEntityType) =>
  type === 'Contract' ? workspace?.contracts || [] : type === 'Engagement' ? workspace?.engagements || [] : workspace?.projects || [];
const latestDate = (...dates: string[]) => dates.reduce((latest, value) => value > latest ? value : latest, '');
const nextDate = (value: string) => {const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10);};
const termsText = (terms: AmendmentTerms, currency: string) => `${terms.startsOn} to ${terms.endsOn} · ${currency} ${terms.budget}${terms.effortPolicy===undefined || terms.effortPolicy==='disabled'?'':' · Approved delivery effort, half-up to '+terms.effortPolicy+' decimals'}${terms.elapsedTimePolicy===undefined?'':terms.elapsedTimePolicy==='disabled'?' · Elapsed-time valuation disabled':' · Elapsed-time valuation, half-up to '+terms.elapsedTimePolicy+' decimals'}${terms.budgetHours===undefined?'':' · Budgeted hours '+terms.budgetHours}${terms.marginThresholdPercent===undefined?'':terms.marginThresholdPercent==='disabled'?' / Margin threshold disabled':' / Margin threshold '+terms.marginThresholdPercent+'%'}${terms.budgetWarningPercent===undefined?'':terms.budgetWarningPercent==='disabled'?' · Budget warnings disabled':' · Budget warning at '+terms.budgetWarningPercent+'%'}${terms.expenseBudget===undefined?'':' · Expense budget '+currency+' '+terms.expenseBudget}${terms.laborCostBudget===undefined?'':' · Labor-cost budget '+currency+' '+terms.laborCostBudget}`;
const commandError = (error: unknown, applying: boolean) => {
  if ([400, 404, 422].includes(errorStatus(error))) return 'Not saved. Check the selected immutable version, effective date, preserved start date, budget, reason and approval reference. The server also validates parent adoption and dependencies.';
  if (applying) return 'The amendment outcome could not be confirmed. Do not submit again. Reload and inspect protected history before deciding what to do next.';
  return 'The preview could not be confirmed. No amendment command was submitted. Reload before previewing again.';
};
const conflictReason = (error: unknown) => {
  const code = error instanceof ApiClientError ? error.code : undefined;
  const messages: Record<string, string> = {
    COMMERCIAL_AMENDMENT_PARENT_TERMS: 'The parent must explicitly adopt this version and cover the remaining term first.',
    COMMERCIAL_PARENT_NOT_ACTIVE: 'The parent must be Active before adopting its terms.',
    COMMERCIAL_AMENDMENT_DEPENDENCIES: 'Remaining child dates, assignments or work extend beyond the proposed term. No child was changed.',
    COMMERCIAL_AMENDMENT_DATE_CONFLICT: 'Use a current or future UTC date later than prior amendments. Only one pending amendment is permitted.',
    COMMERCIAL_AMENDMENT_PIN_CONFLICT: 'Select a newer immutable version of this same scoped contract.',
    COMMERCIAL_AMENDMENT_LIMIT: 'The complete dependency set exceeds the bounded amendment workflow. No partial amendment is allowed.',
  };
  return code && messages[code] ? `${messages[code]} ` : '';
};

/** Separate append-only terms, never a rewrite of drafting, activation or work.
 * Every asynchronous result retains its original identity/scope and editor lease. */
export const CommercialAmendmentWorkspace = ({selectionWorkspace}: {selectionWorkspace?: LifecycleWorkspace} = {}) => {
  const generation = useRef(0); const inspectionSequence = useRef(0); const draftLease = useRef(0); const mounted = useRef(false);
  const initial: WorkspaceState = {generation: 0, context: null, status: 'loading', selection: {type: 'Contract', id: ''}};
  const [state, setState] = useState<WorkspaceState>(initial); const live = useRef(initial);
  const publish = (next: WorkspaceState) => {live.current = next; setState(next);};
  const current = (owner: WorkspaceState) => mounted.current && owner.generation === generation.current
    && Boolean(owner.context && isCommercialAmendmentContextCurrent(owner.context));
  const block = () => {
    ++generation.current; ++inspectionSequence.current; ++draftLease.current;
    publish({generation: generation.current, context: null, status: 'blocked', selection: {type: 'Contract', id: ''}});
  };
  const discardStale = (owner: WorkspaceState) => {
    if (current(owner)) return false;
    if (mounted.current && owner.generation === generation.current) block();
    return true;
  };
  const draftFor = (detail: AmendmentWorkspace): Draft => ({...detail.currentTerms, contractVersionId: '', lease: ++draftLease.current,
    effectiveOn: detail.asOf, reason: '', approvalReference: ''});
  const readSelection = async (owner: WorkspaceState, selection: Selection, message?: string) => {
    const row = records(owner.choices, selection.type).find(item => item.id === selection.id);
    const unsupported = row && (!row.contractVersionId || ('model' in row && ['internal', 'pre_sales'].includes(row.model)));
    const request = ++inspectionSequence.current; ++draftLease.current;
    const next: WorkspaceState = {...owner, selection, detail: undefined, draft: undefined, preview: undefined, saving: undefined,
      requiresReload: false, error: undefined, message, detailStatus: row && !unsupported && row.lifecycle ? 'loading' : undefined};
    publish(next);
    if (!row || unsupported || !row.lifecycle) return;
    try {
      const detail = await commercialAmendmentService.getWorkspace(selection.type, selection.id, owner.context);
      if (discardStale(owner) || request !== inspectionSequence.current) return;
      publish({...next, detailStatus: 'ready', detail, draft: draftFor(detail)});
    } catch (error) {
      if (discardStale(owner) || request !== inspectionSequence.current) return;
      if (denied(error)) {block(); return;}
      publish({...next, detailStatus: 'error', error: 'Material terms could not be loaded. Reload to inspect current server evidence.'});
    }
  };
  const reloadForGeneration = (renderGeneration: number, suppliedChoices?: LifecycleWorkspace) => {
    const previous = live.current;
    if (!mounted.current || previous.generation !== renderGeneration || previous.saving) return;
    const request = ++generation.current; ++inspectionSequence.current; ++draftLease.current;
    const context = captureCommercialAmendmentContext(() => mounted.current && request === generation.current);
    const owner: WorkspaceState = {generation: request, context, status: context ? 'loading' : 'blocked', selection: previous.selection};
    publish(owner);
    if (!context) return;
    const load = suppliedChoices ? Promise.resolve(suppliedChoices) : commercialLifecycleService.getWorkspace(context);
    void load.then(choices => {
      if (!discardStale(owner)) void readSelection({...owner, choices, status: 'ready'}, owner.selection);
    }).catch(error => {
      if (discardStale(owner)) return;
      if (denied(error)) {block(); return;}
      publish({...owner, status: 'error', error: 'Amendment record choices could not be loaded. Check your connection and reload.'});
    });
  };
  useEffect(() => {
    mounted.current = true;
    const checkAccess = () => {const owner = live.current; if (owner.context && !isCommercialAmendmentContextCurrent(owner.context)) block();};
    const changed = () => block();
    window.addEventListener('workos:organization-scope-switch-requested', changed);
    window.addEventListener('workos:organization-scope-changed', checkAccess);
    window.addEventListener('storage', checkAccess); window.addEventListener('focus', checkAccess);
    reloadForGeneration(live.current.generation, selectionWorkspace);
    return () => {
      mounted.current = false; ++generation.current; ++inspectionSequence.current; ++draftLease.current;
      window.removeEventListener('workos:organization-scope-switch-requested', changed);
      window.removeEventListener('workos:organization-scope-changed', checkAccess);
      window.removeEventListener('storage', checkAccess); window.removeEventListener('focus', checkAccess);
    };
  }, []);
  const choose = (selection: Selection) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.saving || owner.status !== 'ready' || discardStale(owner)) return;
    void readSelection(owner, selection);
  };
  const canEdit = (owner: WorkspaceState) => owner.generation === state.generation && owner.status === 'ready' && owner.detailStatus === 'ready'
    && !owner.saving && !owner.requiresReload && Boolean(owner.context?.canManage && owner.detail && owner.draft)
    && !owner.detail?.pending && (owner.detail?.sequence || 0) < 200 && !discardStale(owner);
  const edit = (patch: Partial<Draft>) => {
    const owner = live.current;
    if (!canEdit(owner) || owner.draft!.lease !== state.draft?.lease) return;
    publish({...owner, draft: {...owner.draft!, ...patch}, preview: undefined, error: undefined, message: undefined});
  };
  const chooseVersion = (id: string) => {
    const owner = live.current;
    if (!canEdit(owner)) return;
    const version = owner.detail!.versions.find(item => item.id === id);
    const contract = owner.selection.type === 'Contract';
    edit({contractVersionId: version?.id || '', ...(contract && version ? {startsOn: version.startsOn, endsOn: version.endsOn, budget: version.value} : {}),
      ...(version ? {effectiveOn: latestDate(owner.draft!.effectiveOn, owner.detail!.asOf, version.effectiveFrom, version.startsOn,
        owner.detail!.history.length ? nextDate(owner.detail!.history[0].effectiveOn) : '')} : {})});
  };
  // Reads only. Conflicts invalidate the preview and refresh evidence, never
  // automatically re-dispatch a preview or material amendment command.
  const refreshAfterCommand = async (owner: WorkspaceState, message: string) => {
    ++inspectionSequence.current; ++draftLease.current;
    const saved = message.startsWith('Amendment saved.');
    const refreshing: WorkspaceState = {...owner, status: 'loading', choices: undefined, detail: undefined, draft: undefined,
      preview: undefined, saving: undefined, requiresReload: true,
      message: saved ? 'Amendment saved. Refreshing server evidence…' : 'The preview was invalidated. Refreshing server evidence without retrying the amendment…', error: undefined};
    publish(refreshing);
    try {
      const choices = await commercialLifecycleService.getWorkspace(owner.context);
      if (discardStale(owner)) return;
      await readSelection({...refreshing, status: 'ready', choices}, owner.selection, message);
    } catch (error) {
      if (discardStale(owner)) return;
      if (denied(error)) {block(); return;}
      publish({...refreshing, status: 'error', message: undefined,
        error: `${saved ? 'Amendment saved, but current records' : 'No amendment was applied after the conflict. Current records'} could not be refreshed. Reload before continuing.`});
    }
  };
  const inputFor = (owner: WorkspaceState): AmendmentInput => ({expectedSequence: owner.detail!.sequence,
    expectedLifecycleSequence: owner.detail!.lifecycle.sequence, expectedContractVersion: owner.detail!.latestContractVersion,
    contractVersionId: owner.draft!.contractVersionId, effectiveOn: owner.draft!.effectiveOn, startsOn: owner.draft!.startsOn,
    endsOn: owner.draft!.endsOn, budget: owner.draft!.budget, ...(owner.draft!.marginThresholdPercent===undefined?{}:{marginThresholdPercent:owner.draft!.marginThresholdPercent}), ...(owner.draft!.budgetWarningPercent===undefined?{}:{budgetWarningPercent:owner.draft!.budgetWarningPercent}), ...(owner.draft!.effortPolicy===undefined?{}:{effortPolicy:owner.draft!.effortPolicy}), ...(owner.draft!.elapsedTimePolicy===undefined?{}:{elapsedTimePolicy:owner.draft!.elapsedTimePolicy}), ...(owner.draft!.budgetHours?{budgetHours:owner.draft!.budgetHours}:{}), ...(owner.draft!.expenseBudget?{expenseBudget:owner.draft!.expenseBudget}:{}), ...(owner.draft!.laborCostBudget?{laborCostBudget:owner.draft!.laborCostBudget}:{}), reason: owner.draft!.reason.trim(), approvalReference: owner.draft!.approvalReference.trim()});
  const preview = async (event: FormEvent) => {
    event.preventDefault(); const owner = live.current;
    if (!canEdit(owner) || owner.draft!.lease !== state.draft?.lease || !owner.draft!.contractVersionId) return;
    const input = inputFor(owner); const lease = owner.draft!.lease;
    publish({...owner, saving: 'preview', preview: undefined, error: undefined, message: undefined});
    try {
      const value = await commercialAmendmentService.preview(owner.selection.type, owner.selection.id, input, owner.context);
      if (discardStale(owner) || live.current.draft?.lease !== lease) return;
      if (!sameAmendmentTerms(value.before, owner.detail!.currentTerms)) throw new ApiClientError('Preview terms changed.', {status: 409});
      publish({...owner, saving: undefined, preview: {value, input, lease}, error: undefined, message: undefined});
    } catch (error) {
      if (discardStale(owner) || live.current.draft?.lease !== lease) return;
      if (denied(error)) {block(); return;}
      if (errorStatus(error) === 409) {await refreshAfterCommand(owner, `${conflictReason(error)}The preview was not accepted. Server records were reloaded. Review them and preview again.`); return;}
      publish({...owner, saving: undefined, preview: undefined, requiresReload: ![400, 404, 422].includes(errorStatus(error)), error: commandError(error, false)});
    }
  };
  const apply = async () => {
    const owner = live.current;
    if (!canEdit(owner) || !owner.preview || owner.preview.lease !== owner.draft!.lease || owner.preview !== state.preview) return;
    const confirmed = owner.preview;
    publish({...owner, saving: 'apply', error: undefined, message: undefined});
    try {
      await commercialAmendmentService.apply(owner.selection.type, owner.selection.id, {...confirmed.input, previewToken: confirmed.value.previewToken}, owner.context);
      if (discardStale(owner)) return;
      await refreshAfterCommand(owner, 'Amendment saved. Protected history and current server terms were refreshed. No child was amended automatically.');
    } catch (error) {
      if (discardStale(owner)) return;
      if (denied(error)) {block(); return;}
      if (errorStatus(error) === 409) {await refreshAfterCommand(owner, `${conflictReason(error)}Not applied because the preview or linked terms changed. Server records were reloaded. Review them and create a new preview.`); return;}
      publish({...owner, saving: undefined, preview: undefined, requiresReload: ![400, 404, 422].includes(errorStatus(error)), error: commandError(error, true)});
    }
  };

  const owned = Boolean(state.context && current(state));
  const choices = owned && state.status === 'ready' ? state.choices : undefined;
  const availableRecords = records(choices, state.selection.type).filter(row => row.contractVersionId
    && !('model' in row && ['internal', 'pre_sales'].includes(row.model)));
  const detail = choices && state.detailStatus === 'ready' ? state.detail : undefined;
  const canManage = Boolean(owned && state.context?.canManage);
  const draft = detail && canManage ? state.draft : undefined;
  const selected = records(choices, state.selection.type).find(row => row.id === state.selection.id);
  const unsupported = selected && (!selected.contractVersionId || ('model' in selected && ['internal', 'pre_sales'].includes(selected.model)));
  const busy = Boolean(state.saving || state.requiresReload);
  const contract = state.selection.type === 'Contract';
  const currentVersion = detail?.versions.find(version => version.id === detail.currentTerms.contractVersionId);
  const targetVersion = detail?.versions.find(version => version.id === draft?.contractVersionId);
  const versionChoices = detail?.versions.filter(version => version.version > (currentVersion?.version || 0)
    && version.model === detail.identity.model && version.currency === detail.identity.currency) || [];
  const minimumEffectiveOn = detail ? latestDate(detail.asOf, detail.history.length ? nextDate(detail.history[0].effectiveOn) : detail.asOf,
    targetVersion?.effectiveFrom || '', targetVersion?.startsOn || '', draft?.startsOn || '') : '';
  const maximumEffectiveOn = draft && targetVersion ? [draft.endsOn, targetVersion.endsOn].sort()[0] : undefined;
  const entityLabel = (type: LifecycleEntityType) => type === 'Contract' ? 'Contract / SOW' : termTitle(type === 'Project' ? 'project' : 'engagement');
  const previewValue = detail && draft ? state.preview : undefined;
  const snapshot = (title: string, terms: AmendmentTerms) => <div className="min-w-0 rounded-xl border border-slate-200 p-3">
    <h4 className="font-semibold">{title}</h4><p className="mt-1 text-sm">{termsText(terms, detail!.identity.currency)}</p>
    <p className="mt-1 break-all text-xs">Contract version: {terms.contractVersionId}</p></div>;

  return <section aria-label="Governed commercial amendments" className="mt-8 space-y-5 border-t border-slate-200 pt-8">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-bold">Governed commercial amendments</h2>
      <p className="mt-2 max-w-4xl text-sm text-slate-600">Explicit, effective-dated amendments for one contract, {termTitle('engagement').toLowerCase()} or {termTitle('project').toLowerCase()} at a time. Drafts, activation pins and accepted past work remain immutable. No billing recalculation or automatic child cascade.</p></div>
      <button type="button" className={buttonClass} disabled={Boolean(owned && (state.saving || state.status === 'loading'))}
        onClick={() => reloadForGeneration(state.generation)}>Reload amendment workspace</button></div>
    {state.status === 'loading' && <p role="status">{state.message || 'Loading amendment record choices…'}</p>}
    {!owned && state.status !== 'loading' && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4">Scope or access changed. Amendment content, protected history, preview and unsaved input were cleared. Reload with commercial-view access and a selected organization and legal entity. A submitted amendment may still complete in its original scope.</p>}
    {owned && state.message && state.status !== 'loading' && <p role="status" className="rounded-xl border border-slate-200 p-4">{state.message}</p>}
    {owned && state.error && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4">{state.error}</p>}
    {choices && <>
      <div className={`${panelClass} space-y-4`}><p className="text-sm">Record choices as of {choices.asOf} UTC. {canManage ? 'Amendment and lifecycle manage access enabled.' : 'Read-only. Applying amendments requires separate amendment and lifecycle manage permissions.'}</p>
        {Object.values(choices.limits.truncated).some(Boolean) && <p role="status" className="text-sm font-semibold">Record choices are bounded at {choices.limits.pageSize}; this is not an exhaustive absence claim.</p>}
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Record type"><select className={inputClass} disabled={Boolean(state.saving)} value={state.selection.type}
          onChange={event => choose({type: event.target.value as LifecycleEntityType, id: ''})}>
          {(['Contract', 'Engagement', 'Project'] as const).map(type => <option key={type} value={type}>{entityLabel(type)}</option>)}</select></Field>
          <Field label="Record"><select className={inputClass} disabled={Boolean(state.saving)} value={state.selection.id} onChange={event => choose({...state.selection, id: event.target.value})}>
            <option value="">Select record</option>{availableRecords.map(row => <option key={row.id} value={row.id}>{'number' in row ? row.number : row.code} · {row.name}</option>)}</select></Field></div>
        <p className="text-sm text-slate-600">Internal, pre-sales and non-contract records are not supported by commercial term amendments and are excluded from record choices.</p>
        {!availableRecords.length && <p className="text-sm">No supported scoped records returned for this type.</p>}
        {unsupported && <p role="status">Internal, pre-sales and non-contract records are not supported by commercial term amendments.</p>}
        {selected && !unsupported && !selected.lifecycle && <p role="status">Activate this record through governed lifecycle before amending its commercial terms.</p>}
      </div>
      {state.detailStatus === 'loading' && <p role="status">Loading current terms and protected amendment history…</p>}
      {detail && <>
        <section className={panelClass} aria-label="Activation and current terms"><h3 className="text-lg font-bold">{detail.identity.name} · activation and current terms</h3>
          <p className="mt-2 text-sm">Server terms as of {detail.asOf} UTC · amendment sequence {detail.sequence} · lifecycle {detail.lifecycle.state}, sequence {detail.lifecycle.sequence}.</p>
          <p className="mt-1 text-sm">Model: {detail.identity.model.replaceAll('_', ' ')} · currency {detail.identity.currency}. Identity, model, client, currency and billability are not amendment fields.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">{snapshot('Immutable activation snapshot', detail.activationTerms)}{snapshot('Current effective terms', detail.currentTerms)}</div>
          {detail.pending && <p role="status" className="mt-4 font-semibold">A future amendment is pending. Another amendment cannot be previewed or applied until it becomes effective.</p>}
          {detail.sequence >= 200 && <p role="status" className="mt-4">The bounded amendment history is full. Further amendments are unavailable.</p>}
          <p className="mt-3 text-sm text-slate-600">Current child terms retain their own pin until separately amended. Parent adoption and child date/budget dependencies are validated by the server for the exact effective date.</p>
        </section>
        {draft && <form className={panelClass} aria-label="Material commercial amendment" onSubmit={preview}>
          <h3 className="text-lg font-bold">Prepare explicit amendment</h3>
          <fieldset disabled={busy || detail.pending || detail.sequence >= 200} className="mt-4 grid min-w-0 gap-4 md:grid-cols-2">
            <Field label="Target contract version"><select className={inputClass} required value={draft.contractVersionId} onChange={event => chooseVersion(event.target.value)}>
              <option value="">Select immutable version</option>{versionChoices.map(version => <option key={version.id} value={version.id}>Version {version.version} · effective {version.effectiveFrom} · {version.name}</option>)}</select></Field>
            <Field label="Effective on (UTC)"><input className={inputClass} type="date" required min={minimumEffectiveOn} max={maximumEffectiveOn} value={draft.effectiveOn} onChange={event => edit({effectiveOn: event.target.value})} /></Field>
            <Field label="Amended starts on"><input className={inputClass} type="date" required readOnly value={draft.startsOn} /></Field>
            <Field label="Amended ends on"><input className={inputClass} type="date" required min={latestDate(draft.startsOn, draft.effectiveOn)} readOnly={contract} value={draft.endsOn} onChange={event => edit({endsOn: event.target.value})} /></Field>
            <Field label="Amended budget (decimal)"><input className={inputClass} required inputMode="decimal" pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" maxLength={19} readOnly={contract} value={draft.budget} onChange={event => edit({budget: event.target.value})} /></Field>
            {detail.entityType==='Engagement' && detail.identity.model==='managed_service' &&
              <Field label="Standing margin threshold (%)"><input className={inputClass} aria-label="Standing margin threshold (%)"
                pattern="-?(0|[1-9][0-9]{0,11})([.][0-9]{1,2})?" placeholder="Disabled"
                value={draft.marginThresholdPercent==='disabled'?'':draft.marginThresholdPercent??''}
                onChange={event=>edit({marginThresholdPercent:event.target.value||'disabled'})}/></Field>}
            {detail.entityType!=='Contract' && detail.identity.model==='fixed_fee' &&
              <Field label="Expense budget"><input className={inputClass} inputMode="decimal" maxLength={19}
                required={detail.currentTerms.expenseBudget!==undefined} pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" value={draft.expenseBudget??''}
                onChange={event=>edit({expenseBudget:event.target.value})}/></Field>}
            {detail.entityType==='Engagement' && detail.identity.model==='fixed_fee' &&
              <><Field label="Operational earned-management policy"><select className={inputClass} value={draft.effortPolicy!==undefined && draft.effortPolicy!=='disabled'?'effort-'+draft.effortPolicy:draft.elapsedTimePolicy??'disabled'}
                onChange={event=>{
                  const selected=event.target.value;
                  edit(selected.startsWith('effort-')?{effortPolicy:selected.slice('effort-'.length),elapsedTimePolicy:'disabled'}:
                    {elapsedTimePolicy:selected,effortPolicy:'disabled'});
                }}>
                <option value="disabled">Disabled</option>
                {['0','1','2','3','4'].map(precision=><option key={precision} value={precision}>Elapsed service days · half-up to {precision} decimals</option>)}
                {['0','1','2','3','4'].map(precision=><option key={'effort-'+precision} value={'effort-'+precision}>Approved delivery hours · half-up to {precision} decimals</option>)}
              </select></Field>
              <Field label="Budget warning (% used)"><input className={inputClass} inputMode="numeric" maxLength={3}
                pattern="([1-9][0-9]?|100)" placeholder="Disabled" value={draft.budgetWarningPercent==='disabled'?'':draft.budgetWarningPercent??''}
                onChange={event=>edit({budgetWarningPercent:event.target.value||'disabled'})}/></Field>
              <Field label="Budgeted hours"><input className={inputClass} inputMode="decimal" maxLength={19}
                required={detail.currentTerms.budgetHours!==undefined} pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" value={draft.budgetHours??''}
                onChange={event=>edit({budgetHours:event.target.value})}/></Field>
              <Field label="Labor-cost budget"><input className={inputClass} inputMode="decimal" maxLength={19}
                required={detail.currentTerms.laborCostBudget!==undefined} pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" value={draft.laborCostBudget??''}
                onChange={event=>edit({laborCostBudget:event.target.value})}/></Field></>}
            <Field label="Approval reference"><input className={inputClass} required maxLength={200} value={draft.approvalReference} onChange={event => edit({approvalReference: event.target.value})} /></Field>
            <div className="md:col-span-2"><Field label="Reason for amendment"><textarea className={inputClass} required minLength={3} maxLength={1000} rows={3} value={draft.reason} onChange={event => edit({reason: event.target.value})} /></Field></div>
            <p className="text-sm text-slate-600 md:col-span-2">{contract ? 'Contract dates and budget must exactly match the selected immutable version.' : 'The historical start date stays unchanged. Explicitly enter the amended end date and budget, and select a version already adopted by the parent for this effective date.'} Only newer compatible contract versions are offered. Amounts remain decimal strings; no browser financial totals are calculated.</p>
            {!versionChoices.length && <p role="status" className="text-sm md:col-span-2">No newer compatible immutable contract version was returned. Append the required version through commercial drafting, then reload.</p>}
            <div className="md:col-span-2"><button className={buttonClass} type="submit" disabled={!draft.contractVersionId || Boolean(previewValue)}>{state.saving === 'preview' ? 'Preparing amendment preview…' : 'Preview amendment'}</button></div>
          </fieldset>
          {previewValue && <section className="mt-5 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4" aria-label="Amendment preview">
            <h4 className="font-bold">Review exact amendment preview</h4><p className="text-sm">Server preview as of {previewValue.value.asOf} UTC · effective {previewValue.value.effectiveOn} UTC.</p>
            <div className="grid gap-3 sm:grid-cols-2">{snapshot('Before amendment', previewValue.value.before)}{snapshot('After amendment', previewValue.value.after)}</div>
            <p className="text-sm">Governed project dependencies checked: {previewValue.value.dependencies.projects}. No dependent record is changed automatically.</p>
            {!!previewValue.value.warnings.length && <ul className="list-disc space-y-1 pl-5 text-sm">{previewValue.value.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            <p className="break-words text-sm">Reason: {previewValue.input.reason} · Approval reference: {previewValue.input.approvalReference}</p>
            <p className="text-sm">Confirming appends exactly these material terms using the server preview token. Any edit discards this preview and requires another preview.</p>
            <div className="flex flex-wrap gap-2"><button className={buttonClass} type="button" disabled={busy} onClick={apply}>{state.saving === 'apply' ? 'Applying amendment…' : 'Confirm and apply amendment'}</button>
              <button className={buttonClass} type="button" disabled={busy} onClick={() => {const owner = live.current; if (canEdit(owner) && owner.preview === state.preview) publish({...owner, preview: undefined});}}>Discard preview</button></div>
          </section>}
        </form>}
        <section className={panelClass} aria-label="Protected amendment history"><h3 className="text-lg font-bold">Protected amendment history</h3>
          <p className="mt-2 text-sm">Append-only evidence, newest first. Activation records, old drafts and accepted work are not rewritten.</p>
          {!detail.history.length ? <p className="mt-3 text-sm">No material amendments recorded.</p> : <ol className="mt-4 space-y-3">{detail.history.map(event => <li key={event.id} className="min-w-0 rounded-xl border border-slate-200 p-3 text-sm">
            <p className="font-semibold">Sequence {event.sequence} · effective {event.effectiveOn} UTC · {event.effectiveOn > detail.asOf ? 'Pending' : 'Effective'}</p>
            <p className="mt-1">{termsText(event, detail.identity.currency)}</p><p className="mt-1 break-all">Contract version: {event.contractVersionId}</p>
            <p className="mt-1 whitespace-pre-wrap break-words">Reason: {event.reason}</p><p className="mt-1 break-words">Approval reference: {event.approvalReference}</p>
            <p className="mt-1 break-all">Actor: {event.actorId} · Active role: {event.activeRole}</p><p className="mt-1 break-all">Event: {event.id} · Correlation: {event.correlationId} · Operation: {event.operationId}</p>
          </li>)}</ol>}
        </section>
      </>}
    </>}
  </section>;
};
