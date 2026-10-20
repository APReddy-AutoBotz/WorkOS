import {cloneElement, isValidElement, useEffect, useId, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {termPluralTitle, termTitle} from '../config/terminology';
import {ApiClientError} from '../services/apiClient';
import {
  captureCommercialLifecycleContext, commercialLifecycleService, isCommercialLifecycleContextCurrent,
  type CommercialLifecycleContext, type LifecycleWorkspace, type LifecycleEntityType, type LifecycleState,
  type LifecycleEvent, type LifecycleHistory, type LifecycleReadiness, type LifecycleContract,
  type LifecycleEngagement, type GovernedProject, type CreateGovernedProjectInput,
} from '../services/commercialLifecycle';

type RecordRow = LifecycleContract | LifecycleEngagement | GovernedProject;
type Entity = {type: LifecycleEntityType; id: string; label: string};
type TransitionDraft = Entity & {kind: 'transition'; lease: number; expectedSequence: number; state: LifecycleState;
  contractVersionId: string | null; reason: string; approvalReference: string};
type ProjectDraft = CreateGovernedProjectInput & {kind: 'project'; lease: number; source: 'new' | 'legacy'; promotionConfirmed: boolean};
type Draft = TransitionDraft | ProjectDraft;
type Inspection = Entity & {sequence: number; kind: 'history' | 'readiness'; status: 'loading' | 'ready' | 'error';
  history?: LifecycleHistory; readiness?: LifecycleReadiness};
type WorkspaceState = {
  generation: number; context: CommercialLifecycleContext | null; status: 'loading' | 'ready' | 'error' | 'blocked';
  workspace?: LifecycleWorkspace; draft?: Draft; inspection?: Inspection; saving?: boolean; requiresReload?: boolean;
  message?: string; saveError?: string;
};
const buttonClass = 'rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
const inputClass = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2.5 text-sm text-heading focus-visible:outline focus-visible:outline-2 disabled:bg-slate-100';
const panelClass = 'min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6';
const Field = ({label, children}: {label: string; children: ReactNode}) => {
  const id = useId();
  return <div className="min-w-0 text-sm font-semibold"><label htmlFor={id}>{label}</label>
    {isValidElement<{id?: string}>(children) ? cloneElement(children, {id}) : children}</div>;
};
const recordLabel = (row: RecordRow) => 'number' in row ? row.number : row.code;
const nextState = (event: LifecycleEvent | null): LifecycleState => event?.state === 'Active' ? 'On Hold' : 'Active';
const actionLabel = (event: LifecycleEvent | null) => event?.state === 'Active' ? 'Put on hold' : event ? 'Resume' : 'Activate';
const errorStatus = (error: unknown) => error instanceof ApiClientError ? error.status : 0;
const denied = (error: unknown) => [401, 403].includes(errorStatus(error));
const commandError = (error: unknown) => {
  const code = error instanceof ApiClientError ? error.code : undefined;
  const known: Record<string, string> = {
    COMMERCIAL_ACTIVE_DEPENDENCIES: 'Not changed. Put active governed children on hold first; no child was changed automatically.',
    COMMERCIAL_PARENT_NOT_ACTIVE: 'Not changed. The parent must be Active on the exact pinned contract version. Reload to inspect its current state.',
    COMMERCIAL_PIN_CONFLICT: 'Not changed. The immutable contract version cannot be replaced through a lifecycle transition.',
    COMMERCIAL_TERMS_SUPERSEDED: 'Not changed. Initial activation requires the contract version effective today in UTC. Reload before continuing.',
    COMMERCIAL_INACTIVE_DATES: 'Not changed. The immutable dates do not cover the current UTC date.',
    COMMERCIAL_PROJECT_BUDGET_EXCEEDED: 'Not saved. Combined project allocations cannot exceed the parent budget. Allocation is not consumption or invoice readiness.',
    COMMERCIAL_LEGACY_HISTORY_PRESENT: 'Not promoted. Existing assignment or work history requires a separately governed conversion.',
    COMMERCIAL_LEGACY_PROMOTION_MISMATCH: 'Not promoted. A Proposed project must still match the exact code, name, manager, dates, client and billability.',
    COMMERCIAL_INTERNAL_POLICY: 'Not saved. Internal and pre-sales projects must remain non-billable with zero commercial budget allocation.',
  };
  if (code && known[code]) return known[code];
  if (errorStatus(error) === 409) return 'Not changed because lifecycle or linked records changed. Reload before trying again.';
  if ([400, 404, 422].includes(errorStatus(error))) return 'Not saved. Check the required fields, scoped references, dates, parent terms and decimal budget allocation.';
  return 'The command outcome could not be confirmed. Do not submit it again. Reload and inspect server history before deciding what to do next.';
};

/** Commercial-only evidence. Immutable drafting snapshots never become live
 * lifecycle authority, and each request retains its original session/scope. */
export const CommercialLifecycleWorkspace = () => {
  const generation = useRef(0); const inspectionSequence = useRef(0); const draftLease = useRef(0); const mounted = useRef(false);
  const initial: WorkspaceState = {generation: 0, context: null, status: 'loading'};
  const [state, setState] = useState<WorkspaceState>(initial); const live = useRef(initial);
  const publish = (next: WorkspaceState) => {live.current = next; setState(next);};
  const current = (owner: WorkspaceState) => mounted.current && owner.generation === generation.current
    && Boolean(owner.context && isCommercialLifecycleContextCurrent(owner.context));
  const block = () => {
    ++generation.current; ++inspectionSequence.current; ++draftLease.current;
    publish({generation: generation.current, context: null, status: 'blocked'});
  };
  const discardStale = (owner: WorkspaceState) => {
    if (current(owner)) return false;
    if (mounted.current && owner.generation === generation.current) block();
    return true;
  };
  const reloadForGeneration = (renderGeneration: number) => {
    const previous = live.current;
    if (!mounted.current || previous.generation !== renderGeneration || previous.saving) return;
    const request = ++generation.current; ++inspectionSequence.current; ++draftLease.current;
    const context = captureCommercialLifecycleContext(() => mounted.current && request === generation.current);
    const owner: WorkspaceState = {generation: request, context, status: context ? 'loading' : 'blocked'};
    publish(owner);
    if (!context) return;
    void commercialLifecycleService.getWorkspace(context).then(workspace => {
      if (!discardStale(owner)) publish({...owner, status: 'ready', workspace});
    }).catch(error => {
      if (discardStale(owner)) return;
      if (denied(error)) {block(); return;}
      publish({...owner, status: 'error', message: 'Commercial lifecycle could not be loaded. Check your connection and reload.'});
    });
  };
  useEffect(() => {
    mounted.current = true;
    const checkAccess = () => {const owner = live.current; if (owner.context && !isCommercialLifecycleContextCurrent(owner.context)) block();};
    const changed = () => block();
    window.addEventListener('workos:organization-scope-switch-requested', changed);
    window.addEventListener('workos:organization-scope-changed', checkAccess);
    window.addEventListener('storage', checkAccess); window.addEventListener('focus', checkAccess);
    reloadForGeneration(live.current.generation);
    return () => {
      mounted.current = false; ++generation.current; ++inspectionSequence.current; ++draftLease.current;
      window.removeEventListener('workos:organization-scope-switch-requested', changed);
      window.removeEventListener('workos:organization-scope-changed', checkAccess);
      window.removeEventListener('storage', checkAccess); window.removeEventListener('focus', checkAccess);
    };
  }, []);
  const recordExists = (owner: WorkspaceState, type: LifecycleEntityType, id: string) => {
    const rows: RecordRow[] = type === 'Contract' ? owner.workspace?.contracts || [] : type === 'Engagement' ? owner.workspace?.engagements || [] : owner.workspace?.projects || [];
    return rows.find(row => row.id === id);
  };
  const inspect = (kind: 'history' | 'readiness', type: LifecycleEntityType, id: string) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.saving || owner.status !== 'ready' || discardStale(owner)) return;
    const row = recordExists(owner, type, id); if (!row) return;
    const sequence = ++inspectionSequence.current;
    const inspection: Inspection = {type, id, label: recordLabel(row), sequence, kind, status: 'loading'};
    publish({...owner, inspection});
    const request = kind === 'history' ? commercialLifecycleService.getHistory(type, id, owner.context)
      : commercialLifecycleService.getReadiness(type, id, owner.context);
    void request.then(value => {
      if (discardStale(owner) || sequence !== inspectionSequence.current || live.current.inspection?.sequence !== sequence) return;
      publish({...live.current, inspection: {...inspection, status: 'ready',
        ...(kind === 'history' ? {history: value as LifecycleHistory} : {readiness: value as LifecycleReadiness})}});
    }).catch(error => {
      if (discardStale(owner) || sequence !== inspectionSequence.current || live.current.inspection?.sequence !== sequence) return;
      if (denied(error)) {block(); return;}
      publish({...live.current, inspection: {...inspection, status: 'error'}});
    });
  };
  const canEdit = (owner: WorkspaceState) => owner.generation === state.generation && owner.status === 'ready'
    && !owner.saving && !owner.requiresReload && Boolean(owner.context?.canManage) && !discardStale(owner);
  const startTransition = (type: LifecycleEntityType, id: string) => {
    const owner = live.current; if (!canEdit(owner)) return;
    const row = recordExists(owner, type, id); if (!row || (row.lifecycle?.sequence || 0) >= 200) return;
    const draft: TransitionDraft = {kind: 'transition', lease: ++draftLease.current, type, id, label: recordLabel(row),
      expectedSequence: row.lifecycle?.sequence || 0, state: nextState(row.lifecycle),
      contractVersionId: row.lifecycle ? row.lifecycle.contractVersionId : row.contractVersionId, reason: '', approvalReference: ''};
    publish({...owner, draft, saveError: undefined, message: undefined});
  };
  const startProject = () => {
    const owner = live.current; if (!canEdit(owner)) return;
    const draft: ProjectDraft = {kind: 'project', lease: ++draftLease.current, source: 'new', promotionConfirmed: false, engagementId: '', projectId: null,
      code: '', name: '', managerId: '', startsOn: '', endsOn: '', billable: false, budgetAllocation: '0', reason: ''};
    publish({...owner, draft, saveError: undefined, message: undefined});
  };
  const edit = (patch: Partial<TransitionDraft> | Partial<ProjectDraft>) => {
    const owner = live.current;
    if (!canEdit(owner) || !owner.draft || owner.draft.lease !== state.draft?.lease) return;
    publish({...owner, draft: {...owner.draft, ...patch} as Draft, saveError: undefined});
  };
  const chooseEngagement = (id: string) => {
    const owner = live.current; if (!canEdit(owner) || owner.draft?.kind !== 'project' || owner.draft.lease !== state.draft?.lease) return;
    const parent = owner.workspace?.engagements.find(row => row.id === id && row.lifecycle?.state === 'Active');
    edit({engagementId: parent?.id || '', projectId: null, promotionConfirmed: false, code: '', name: '', managerId: parent?.managerId || '',
      startsOn: parent?.startsOn || '', endsOn: parent?.endsOn || '', billable: parent?.billable || false, budgetAllocation: '0'});
  };
  const chooseLegacy = (id: string) => {
    const owner = live.current; if (!canEdit(owner) || owner.draft?.kind !== 'project' || owner.draft.lease !== state.draft?.lease) return;
    const parent = owner.workspace?.engagements.find(row => row.id === owner.draft!.engagementId);
    const project = owner.workspace?.choices.legacyProjects.find(row => row.id === id && row.clientId === parent?.clientId);
    edit({projectId: project?.id || null, promotionConfirmed: false, code: project?.code || '', name: project?.name || '', managerId: project?.managerId || '',
      startsOn: project?.startsOn || '', endsOn: project?.endsOn || '', billable: project?.billable || false});
  };
  const dismissDraft = () => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.saving || owner.draft?.lease !== state.draft?.lease || discardStale(owner)) return;
    ++draftLease.current; publish({...owner, draft: undefined, saveError: undefined});
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); const owner = live.current;
    if (!canEdit(owner) || !owner.draft || owner.draft.lease !== state.draft?.lease) return;
    const draft = owner.draft;
    if (draft.kind === 'project' && draft.source === 'legacy' && (!draft.projectId || !draft.promotionConfirmed)) return;
    publish({...owner, saving: true, saveError: undefined, message: undefined});
    try {
      if (draft.kind === 'transition') await commercialLifecycleService.transition(draft.type, draft.id, {
        expectedSequence: draft.expectedSequence, state: draft.state, contractVersionId: draft.contractVersionId,
        reason: draft.reason, approvalReference: draft.approvalReference.trim() || null,
      }, owner.context);
      else await commercialLifecycleService.createProject({engagementId: draft.engagementId, projectId: draft.source === 'legacy' ? draft.projectId : null,
        code: draft.code, name: draft.name, managerId: draft.managerId, startsOn: draft.startsOn, endsOn: draft.endsOn,
        billable: draft.billable, budgetAllocation: draft.budgetAllocation, reason: draft.reason}, owner.context);
      if (discardStale(owner)) return;
      ++draftLease.current; ++inspectionSequence.current;
      const success: WorkspaceState = {...owner, status: 'loading', workspace: undefined, draft: undefined, inspection: undefined,
        saving: false, requiresReload: false, message: 'Lifecycle command saved. Refreshing server records…'};
      publish(success);
      // Confirmed commands are never re-dispatched, even if this read fails.
      try {
        const workspace = await commercialLifecycleService.getWorkspace(owner.context);
        if (!discardStale(owner)) publish({...success, status: 'ready', workspace, message: 'Lifecycle command saved. Server records refreshed.'});
      } catch (error) {
        if (discardStale(owner)) return;
        if (denied(error)) {block(); return;}
        publish({...success, status: 'error', message: 'Lifecycle command saved, but server records could not be refreshed. Reload to see the current state.'});
      }
    } catch (error) {
      if (discardStale(owner)) return;
      if (denied(error)) {block(); return;}
      publish({...owner, saving: false, requiresReload: ![400, 404, 422].includes(errorStatus(error)), saveError: commandError(error)});
    }
  };

  const owned = Boolean(state.context && current(state));
  const workspace = owned && state.status === 'ready' ? state.workspace : undefined;
  const canManage = Boolean(owned && state.context?.canManage);
  const draft = workspace && canManage ? state.draft : undefined;
  const inspection = workspace ? state.inspection : undefined;
  const projectDraft = draft?.kind === 'project' ? draft : undefined;
  const parent = workspace?.engagements.find(row => row.id === projectDraft?.engagementId);
  const projectTitle = termTitle('project'); const projectPlural = termPluralTitle('project');
  const engagementTitle = termTitle('engagement'); const engagementPlural = termPluralTitle('engagement');
  const managerTitle = termTitle('manager');
  const legacy = projectDraft?.source === 'legacy';
  const busy = Boolean(state.saving || state.requiresReload);
  const ownerName = (id: string) => workspace?.choices.owners.find(row => row.id === id)?.name || id;
  const transitionTitle = draft?.kind === 'transition'
    ? `${draft.state === 'On Hold' ? 'Put on hold' : draft.expectedSequence ? 'Resume' : 'Activate'} ${draft.label}` : '';
  const actionButtons = (type: LifecycleEntityType, row: RecordRow) => <div className="mt-3 flex flex-wrap gap-2">
    {canManage && <button type="button" className={buttonClass} disabled={busy || (row.lifecycle?.sequence || 0) >= 200}
      onClick={() => startTransition(type, row.id)}>{row.lifecycle?.state === 'Active' ? `Put ${recordLabel(row)} on hold` : `${actionLabel(row.lifecycle)} ${recordLabel(row)}`}</button>}
    <button type="button" className={buttonClass} disabled={Boolean(state.saving)} onClick={() => inspect('history', type, row.id)}>View history for {recordLabel(row)}</button>
    <button type="button" className={buttonClass} disabled={Boolean(state.saving)} onClick={() => inspect('readiness', type, row.id)}>Inspect closure dependencies for {recordLabel(row)}</button>
  </div>;
  const recordCard = (type: LifecycleEntityType, row: RecordRow) => <li key={row.id} className="min-w-0 rounded-xl border border-slate-200 p-4">
    <h4 className="font-semibold">{recordLabel(row)} · {row.name}</h4>
    <p className="mt-1 text-sm">Live lifecycle: <strong>{row.lifecycle?.state || 'Not activated'}</strong>{row.lifecycle ? ` · sequence ${row.lifecycle.sequence} · effective ${row.lifecycle.effectiveOn} UTC` : '. Immutable draft only.'}</p>
    <p className="mt-1 break-all text-sm">Pinned lifecycle version: {row.lifecycle ? row.lifecycle.contractVersionId || 'None (internal / pre-sales)' : 'Not pinned until activation'}.</p>
    <p className="mt-1 break-all text-sm text-slate-600">Immutable {type === 'Contract' ? 'currently effective drafting' : 'binding / drafting'} snapshot: {row.contractVersionId || 'No contract (internal / pre-sales)'} · {row.startsOn} to {row.endsOn}.</p>
    {'model' in row && <p className="mt-1 text-sm">Model: {row.model.replaceAll('_', ' ')} · {row.currency} · {row.billable ? 'Billable policy' : 'Non-billable policy'} · {managerTitle}: {ownerName(row.managerId)}.</p>}
    {'budgetAllocation' in row && <p className="mt-1 text-sm">Commercial budget allocation: {row.budgetAllocation} {row.currency}. {row.origin === 'explicit-legacy-promotion' ? 'Explicit Proposed promotion.' : 'New governed record.'}</p>}
    {actionButtons(type, row)}
  </li>;

  return <section aria-label="Governed commercial lifecycle" className="mt-8 space-y-5 border-t border-slate-200 pt-8">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-bold">Governed commercial lifecycle</h2>
        <p className="mt-2 max-w-4xl text-sm text-slate-600">Activate, hold and resume contracts, {engagementPlural.toLowerCase()} and {projectPlural.toLowerCase()} using append-only server evidence. Immutable drafting records remain separate from live lifecycle.</p></div>
      <button type="button" className={buttonClass} disabled={Boolean(owned && (state.saving || state.status === 'loading'))}
        onClick={() => reloadForGeneration(state.generation)}>Reload lifecycle workspace</button>
    </div>
    {state.status === 'loading' && <p role="status">{state.message || 'Loading governed commercial lifecycle…'}</p>}
    {!owned && state.status !== 'loading' && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4">Scope or access changed. Lifecycle content, confidential history and unsaved input have been cleared. Reload with commercial-view access and a selected organization and legal entity. A submitted command may still complete in its original scope.</p>}
    {owned && state.status !== 'loading' && state.message && <p role={state.status === 'error' ? 'alert' : 'status'} className="rounded-xl border border-slate-300 p-4">{state.message}</p>}
    {workspace && <>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
        <p>Server snapshot: {workspace.asOf} UTC. {canManage ? 'Governed lifecycle manage access enabled.' : 'Read-only commercial access. A separate lifecycle manage permission is required for commands.'}</p>
        <p className="mt-1">Activation and resumption require valid current dates and an Active parent on the exact immutable contract version. Hold active children before their parent. Changes are effective today in UTC; backdating and future-dating are not available.</p>
        {Object.values(workspace.limits.truncated).some(Boolean) && <p role="status" className="mt-2 font-semibold">Some results or choices were truncated at {workspace.limits.pageSize}. These lists are bounded and cannot prove that dependencies are absent.</p>}
      </div>
      <aside aria-label="Closure unavailable" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
        <p className="font-semibold">Terminal close and delete are unavailable.</p><p className="mt-1">{workspace.closure.message}</p>
        <p className="mt-1">Missing evidence is unknown, never assumed zero: {workspace.closure.unavailableEvidence.join('; ')}.</p>
      </aside>
      {canManage && <button type="button" className={buttonClass} disabled={busy} onClick={startProject}>New governed {projectTitle.toLowerCase()}</button>}
      {state.requiresReload && !draft && <p role="alert">Reload and inspect current server history before starting another command.</p>}
      {draft && <section className={panelClass} aria-label="Governed lifecycle editor">
        <h3 className="mb-3 text-lg font-bold">{draft.kind === 'transition' ? transitionTitle : legacy ? `Promote Proposed ${projectTitle.toLowerCase()}` : `New governed ${projectTitle.toLowerCase()}`}</h3>
        {state.saveError && <p role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">{state.saveError}</p>}
        <form onSubmit={save}>
          <fieldset disabled={busy} className="grid min-w-0 gap-4 md:grid-cols-2">
            <legend className="sr-only">{draft.kind === 'transition' ? 'Lifecycle transition fields' : `${projectTitle} binding fields`}</legend>
            {draft.kind === 'transition' ? <>
              <p className="text-sm md:col-span-2">Append {draft.state} at expected sequence {draft.expectedSequence}. Effective date is assigned by the server as today in UTC. This does not modify draft terms, authorize billing, or close the record.</p>
              <p className="break-all text-sm md:col-span-2">Immutable pinned contract version: {draft.contractVersionId || 'None (internal / pre-sales)'}. The pin cannot be changed here.</p>
              <Field label="Approval reference (optional)"><input className={inputClass} maxLength={200} value={draft.approvalReference} onChange={event => edit({approvalReference: event.target.value})} /></Field>
            </> : <>
              <Field label={`Parent ${engagementTitle.toLowerCase()}`}><select className={inputClass} required value={draft.engagementId} onChange={event => chooseEngagement(event.target.value)}>
                <option value="">Select Active {engagementTitle.toLowerCase()}</option>{workspace.engagements.filter(row => row.lifecycle?.state === 'Active').map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
              </select></Field>
              <Field label={`${projectTitle} source`}><select className={inputClass} value={draft.source} onChange={event => {
                const source = event.target.value as 'new' | 'legacy';
                edit({source, projectId: null, promotionConfirmed: false, code: '', name: '', managerId: parent?.managerId || '', startsOn: parent?.startsOn || '', endsOn: parent?.endsOn || '', billable: parent?.billable || false});
              }}><option value="new">New governed {projectTitle.toLowerCase()}</option><option value="legacy">Explicitly promote existing Proposed {projectTitle.toLowerCase()}</option></select></Field>
              {legacy && <Field label={`Existing Proposed ${projectTitle.toLowerCase()}`}><select className={inputClass} required disabled={!parent} value={draft.projectId || ''} onChange={event => chooseLegacy(event.target.value)}>
                <option value="">Select Proposed {projectTitle.toLowerCase()}</option>{workspace.choices.legacyProjects.filter(row => parent && row.clientId === parent.clientId).map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}{row.neutralMapped ? ' · neutral mapping retained' : ''}</option>)}
              </select></Field>}
              <p className="break-all text-sm text-slate-600 md:col-span-2">Model, currency, client, attribution and immutable contract version are inherited from the parent. Pinned version: {parent?.contractVersionId || 'None selected / internal'}. The server validates active ownership, dates, exact parent pin and combined budget allocations.</p>
              <Field label="Code"><input className={inputClass} required readOnly={legacy} maxLength={80} pattern="[A-Z0-9][A-Z0-9_-]{0,79}" value={draft.code} onChange={event => edit({code: event.target.value})} /></Field>
              <Field label="Name"><input className={inputClass} required readOnly={legacy} maxLength={200} value={draft.name} onChange={event => edit({name: event.target.value})} /></Field>
              <Field label={managerTitle}><select className={inputClass} required disabled={legacy} value={draft.managerId} onChange={event => edit({managerId: event.target.value})}>
                <option value="">Select active {managerTitle.toLowerCase()}</option>{draft.managerId && !workspace.choices.owners.some(row => row.id === draft.managerId) && <option value={draft.managerId}>{draft.managerId} · not in returned active choices</option>}
                {workspace.choices.owners.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select></Field>
              <Field label="Starts on"><input className={inputClass} required readOnly={legacy} type="date" min={parent?.startsOn} max={parent?.endsOn} value={draft.startsOn} onChange={event => edit({startsOn: event.target.value})} /></Field>
              <Field label="Ends on"><input className={inputClass} required readOnly={legacy} type="date" min={draft.startsOn || parent?.startsOn} max={parent?.endsOn} value={draft.endsOn} onChange={event => edit({endsOn: event.target.value})} /></Field>
              <Field label="Billable"><select className={inputClass} disabled={legacy || !parent?.billable} value={draft.billable ? 'yes' : 'no'} onChange={event => edit({billable: event.target.value === 'yes'})}>
                <option value="no">Non-billable</option><option value="yes">Billable policy</option>
              </select></Field>
              <Field label="Commercial budget allocation"><input className={inputClass} required inputMode="decimal" pattern="(0|[1-9]\d{0,13})(\.\d{1,4})?" readOnly={Boolean(parent && !parent.billable)} value={draft.budgetAllocation} onChange={event => edit({budgetAllocation: event.target.value})} /></Field>
              <p className="text-sm text-slate-600 md:col-span-2">Budget allocation is a commercial limit, not consumption, revenue or invoice eligibility. Internal and pre-sales work remains non-billable with zero commercial allocation. New bindings activate immediately, so their dates must cover today in UTC.</p>
              {legacy && <div className="text-sm md:col-span-2"><p>Promotion requires an unchanged Proposed record with no assignments or work history. Existing IDs and neutral mappings are retained, not silently migrated or removed.</p>
                <label className="mt-3 flex items-start gap-2"><input type="checkbox" required checked={draft.promotionConfirmed} onChange={event => edit({promotionConfirmed: event.target.checked})} />I explicitly confirm promotion of this exact Proposed record into the selected Active parent.</label></div>}
            </>}
            <div className="md:col-span-2"><Field label="Reason"><textarea className={inputClass} required minLength={3} maxLength={1000} rows={3} value={draft.reason} onChange={event => edit({reason: event.target.value})} /></Field></div>
          </fieldset>
          <div className="mt-5 flex flex-wrap gap-2"><button type="submit" className={buttonClass} disabled={busy}>{state.saving ? 'Saving lifecycle command…' : draft.kind === 'transition' ? 'Confirm lifecycle transition' : `${legacy ? 'Promote' : 'Create'} and activate ${projectTitle.toLowerCase()}`}</button>
            <button type="button" className={buttonClass} disabled={Boolean(state.saving)} onClick={dismissDraft}>Cancel lifecycle editor</button></div>
        </form>
      </section>}
      {inspection && <section className={panelClass} aria-label={inspection.kind === 'history' ? 'Confidential lifecycle history' : 'Closure dependency inspection'}>
        <h3 className="text-lg font-bold">{inspection.kind === 'history' ? 'Lifecycle history' : 'Closure dependencies'} · {inspection.label}</h3>
        <p className="mt-1 text-sm text-slate-600">Commercial-only evidence. No close or delete action is available.</p>
        {inspection.status === 'loading' && <p role="status" className="mt-3">Loading {inspection.kind === 'history' ? 'confidential lifecycle history' : 'closure dependencies'}…</p>}
        {inspection.status === 'error' && <p role="alert" className="mt-3">The inspection could not be confirmed. Select the inspection again to retry the read.</p>}
        {inspection.history && (inspection.history.events.length ? <ol className="mt-4 space-y-3" aria-label="Lifecycle events, newest first">{inspection.history.events.map(event => <li key={event.id} className="rounded-xl border border-slate-200 p-3 text-sm">
          <p className="font-semibold">Sequence {event.sequence} · {event.state} · {event.effectiveOn} UTC</p>
          <p className="mt-1 whitespace-pre-wrap break-words">Reason: {event.reason}</p><p className="mt-1 break-words">Approval reference: {event.approvalReference || 'None supplied'}</p>
          <p className="mt-1 break-all">Pinned version: {event.contractVersionId || 'None (internal / pre-sales)'}</p><p className="mt-1 break-all">Actor: {event.actorId} · Active role: {event.activeRole}</p>
          <p className="mt-1 break-all">Event: {event.id} · Correlation: {event.correlationId} · Operation: {event.operationId}</p>
        </li>)}</ol> : <p className="mt-3">No lifecycle events. This draft has not been activated.</p>)}
        {inspection.readiness && <div className="mt-3 space-y-2 text-sm"><p>Checked: {inspection.readiness.checkedOn} UTC. {inspection.readiness.message}</p>
          <dl className="grid gap-2 sm:grid-cols-2">{([
            ['Open assignments', inspection.readiness.evidence.openAssignments], ['Draft / submitted work lines', inspection.readiness.evidence.draftSubmittedWorkLines],
            ['Pending timesheet approvals', inspection.readiness.evidence.pendingTimesheetApprovals], ['Unaccepted milestones', inspection.readiness.evidence.unacceptedMilestones],
            ['Draft purchase orders', inspection.readiness.evidence.draftPurchaseOrders],
            ['Owner active', inspection.readiness.evidence.ownerActive === null ? 'Not applicable / unknown' : inspection.readiness.evidence.ownerActive ? 'Yes' : 'No'],
          ] as const).map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><dt className="font-semibold">{label}</dt><dd>{value}</dd></div>)}</dl>
          <p className="font-semibold">Missing evidence is unknown, never zero: {inspection.readiness.unavailableEvidence.join('; ')}.</p>
          <p>Zero returned counts do not establish permission to close. Approved-unbilled work, commercial balances, PO consumption and milestone settlement are not established here.</p>
        </div>}
      </section>}
      <section className={panelClass} aria-label="Contract live lifecycle"><h3 className="mb-4 text-lg font-bold">Contracts / SOWs</h3>
        {workspace.contracts.length ? <ul className="grid gap-4 lg:grid-cols-2">{workspace.contracts.map(row => recordCard('Contract', row))}</ul> : <p className="text-sm">No currently effective contracts were returned for this scope. Future-only terms are not activation candidates.</p>}</section>
      <section className={panelClass} aria-label={`${engagementTitle} live lifecycle`}><h3 className="mb-4 text-lg font-bold">{engagementPlural}</h3>
        {workspace.engagements.length ? <ul className="grid gap-4 lg:grid-cols-2">{workspace.engagements.map(row => recordCard('Engagement', row))}</ul> : <p className="text-sm">No manually drafted {engagementPlural.toLowerCase()} were returned for this scope. Neutral legacy mappings are not lifecycle authority.</p>}</section>
      <section className={panelClass} aria-label={`${projectTitle} live lifecycle`}><h3 className="mb-4 text-lg font-bold">Governed {projectPlural.toLowerCase()}</h3>
        {workspace.projects.length ? <ul className="grid gap-4 lg:grid-cols-2">{workspace.projects.map(row => recordCard('Project', row))}</ul> : <p className="text-sm">No governed {projectPlural.toLowerCase()} were returned. Creating an explicit binding is separate from existing neutral mappings.</p>}</section>
    </>}
  </section>;
};
