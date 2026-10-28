import {cloneElement, isValidElement, useEffect, useId, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {PageHeader} from '../components/ui/PageHeader';
import {RateCandidates} from '../components/RateCandidates';
import {GovernedTmWorkspace} from '../components/GovernedTmWorkspace';
import {TmBillingEligibilityWorkspace} from '../components/TmBillingEligibilityWorkspace';
import {InvoiceDraftWorkspace} from '../components/InvoiceDraftWorkspace';
import {InvoiceBatchApprovalWorkspace} from '../components/InvoiceBatchApprovalWorkspace';
import {termPluralTitle, termTitle} from '../config/terminology';
import {ApiClientError} from '../services/apiClient';
import {
  captureCommercialDraftingContext, commercialDraftingService, isCommercialDraftingContextCurrent,
  COMMERCIAL_CONTRACT_MODELS, ENGAGEMENT_MODELS,
  type CommercialDraftingContext, type CommercialWorkspace, type ContractDetail,
  type ContractModel, type EngagementModel, type CreateContractInput, type AppendContractVersionInput,
  type CreateEngagementInput, type CreatePurchaseOrderInput, type CreateMilestoneInput,
} from '../services/commercialDrafting';

type DraftKind = 'contract' | 'revision' | 'engagement' | 'purchaseOrder' | 'milestone';
type Draft = {
  kind: DraftKind; lease: number; contractId: string; expectedVersion: number; number: string; clientId: string;
  name: string; code: string; model: EngagementModel; startsOn: string; endsOn: string; effectiveFrom: string;
  currency: string; value: string; budget: string; billingTerms: string; documents: {name: string; url: string}[];
  ownerId: string; contractVersionId: string; attributionId: string; warningThresholdPercent: string;
  engagementId: string; dueOn: string; amount: string; reason: string;
};
type DetailState = {sequence: number; id: string; status: 'loading' | 'ready' | 'error'; value?: ContractDetail};
type WorkspaceState = {
  generation: number; context: CommercialDraftingContext | null; status: 'loading' | 'ready' | 'error' | 'blocked';
  workspace?: CommercialWorkspace; detail?: DetailState; draft?: Draft; saving?: boolean; uncertain?: boolean;
  message?: string; saveError?: string;
};
const buttonClass = 'rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
const inputClass = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2.5 text-sm text-heading focus-visible:outline focus-visible:outline-2 disabled:bg-slate-100';
const panelClass = 'min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6';
const moneyPattern = '(0|[1-9]\\d{0,13})(\\.\\d{1,4})?';
const modelLabel = (model: EngagementModel) => ({time_and_materials: 'Time and materials', fixed_fee: 'Fixed fee', milestone: 'Milestone based',
  retainer: 'Retainer', managed_service: 'Managed service', internal: 'Internal initiative', pre_sales: 'Pre-sales / non-billable'}[model]);
const blankDraft = (kind: DraftKind, lease: number): Draft => ({kind, lease, contractId: '', expectedVersion: 0, number: '', clientId: '', name: '', code: '',
  model: 'time_and_materials', startsOn: '', endsOn: '', effectiveFrom: '', currency: '', value: '', budget: '', billingTerms: '', documents: [],
  ownerId: '', contractVersionId: '', attributionId: '', warningThresholdPercent: '', engagementId: '', dueOn: '', amount: '', reason: ''});
const safeError = (error: unknown, saving = false) => {
  const status = error instanceof ApiClientError ? error.status : 0;
  if ([401, 403].includes(status)) return 'Commercial drafting access could not be confirmed. Check your access, then reload.';
  if (saving && [400, 404, 422].includes(status)) return 'Draft not saved. Check the required fields, dates, decimal amounts and linked terms.';
  if (saving && status === 409) return 'Draft not saved because the latest server version or a linked record changed. Reload before retrying.';
  return saving ? 'Save outcome could not be confirmed. Keep this draft for reference and reload before trying again to avoid duplicates.'
    : 'Commercial drafting could not be loaded. Check your connection and try again.';
};
const Field = ({label, children}: {label: string; children: ReactNode}) => {
  const id = useId();
  // Keep option text out of the label's accessible name. Every Field owns one
  // input, select or textarea and links it explicitly, including repeated links.
  return <div className="block min-w-0 text-sm font-semibold"><label htmlFor={id}>{label}</label>
    {isValidElement<{id?: string}>(children) ? cloneElement(children, {id}) : children}</div>;
};

export const CommercialDraftingWorkspace = () => {
  const generation = useRef(0);
  const detailSequence = useRef(0);
  const draftLease = useRef(0);
  const mounted = useRef(false);
  const initial: WorkspaceState = {generation: 0, context: null, status: 'loading'};
  const [state, setState] = useState<WorkspaceState>(initial);
  const live = useRef(initial);
  const publish = (next: WorkspaceState) => { live.current = next; setState(next); };
  const current = (owner: WorkspaceState) => mounted.current && owner.generation === generation.current
    && Boolean(owner.context && isCommercialDraftingContextCurrent(owner.context));
  const block = () => {
    ++generation.current; ++detailSequence.current; ++draftLease.current;
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
    const request = ++generation.current;
    ++detailSequence.current; ++draftLease.current;
    const context = captureCommercialDraftingContext(() => mounted.current && request === generation.current);
    const owner: WorkspaceState = {generation: request, context, status: context ? 'loading' : 'blocked'};
    publish(owner);
    if (!context) return;
    void commercialDraftingService.getWorkspace(context).then(workspace => {
      if (!discardStale(owner)) publish({...owner, status: 'ready', workspace});
    }).catch(error => {
      if (!discardStale(owner)) publish({...owner, status: 'error', message: safeError(error)});
    });
  };
  const reload = () => reloadForGeneration(state.generation);
  useEffect(() => {
    mounted.current = true;
    const checkAccess = () => { const owner = live.current; if (owner.context && !isCommercialDraftingContextCurrent(owner.context)) block(); };
    const changed = () => block();
    window.addEventListener('workos:organization-scope-switch-requested', changed);
    window.addEventListener('workos:organization-scope-changed', checkAccess);
    window.addEventListener('storage', checkAccess);
    window.addEventListener('focus', checkAccess);
    reloadForGeneration(live.current.generation);
    return () => {
      mounted.current = false; ++generation.current; ++detailSequence.current; ++draftLease.current;
      window.removeEventListener('workos:organization-scope-switch-requested', changed);
      window.removeEventListener('workos:organization-scope-changed', checkAccess);
      window.removeEventListener('storage', checkAccess);
      window.removeEventListener('focus', checkAccess);
    };
  }, []);

  const inspect = (id: string) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.saving || discardStale(owner) || !owner.workspace?.contracts.some(contract => contract.id === id)) return;
    if (owner.detail?.id === id && owner.detail.status === 'loading') return;
    const sequence = ++detailSequence.current;
    const detail: DetailState = {id, sequence, status: 'loading'};
    publish({...owner, detail});
    void commercialDraftingService.getContract(id, owner.context).then(value => {
      if (discardStale(owner) || sequence !== detailSequence.current || live.current.detail?.id !== id) return;
      publish({...live.current, detail: {...detail, status: 'ready', value}});
    }).catch(error => {
      if (discardStale(owner) || sequence !== detailSequence.current || live.current.detail?.id !== id) return;
      if (error instanceof ApiClientError && [401, 403].includes(error.status)) { block(); return; }
      publish({...live.current, detail: {...detail, status: 'error'}});
    });
  };
  const startDraft = (kind: DraftKind) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.saving || owner.uncertain || owner.status !== 'ready' || !owner.context?.canManage || discardStale(owner)) return;
    let draft = blankDraft(kind, ++draftLease.current);
    if (kind === 'revision') {
      const detail = owner.detail?.status === 'ready' ? owner.detail.value : undefined;
      const latest = detail?.versions.find(version => version.version === detail.latestVersion);
      if (!detail || !latest) return;
      draft = {...draft, ...latest, documents: latest.documents.map(document => ({...document})), contractId: detail.id,
        number: detail.number, clientId: detail.clientId, expectedVersion: detail.latestVersion, effectiveFrom: ''};
    }
    publish({...owner, draft, uncertain: false, message: undefined, saveError: undefined});
  };
  const edit = (patch: Partial<Draft>) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.draft?.lease !== state.draft?.lease || !owner.draft || owner.saving || owner.uncertain || discardStale(owner)) return;
    publish({...owner, draft: {...owner.draft, ...patch}, saveError: undefined});
  };
  const chooseContract = (id: string) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.draft?.lease !== state.draft?.lease || owner.saving || owner.uncertain || discardStale(owner)) return;
    const contract = owner.workspace?.contracts.find(item => item.id === id);
    edit({contractId: id, contractVersionId: contract?.terms.id || '', clientId: contract?.clientId || '',
      ...(contract ? {currency: contract.terms.currency, startsOn: contract.terms.effectiveFrom, endsOn: contract.terms.endsOn} : {})});
    if (contract) inspect(id);
  };
  const chooseVersion = (id: string) => {
    const owner = live.current;
    const terms = owner.detail?.status === 'ready' && owner.detail.id === owner.draft?.contractId
      ? owner.detail.value?.versions.find(version => version.id === id)
      : owner.workspace?.contracts.find(contract => contract.id === owner.draft?.contractId)?.terms;
    if (terms?.id !== id) return;
    edit({contractVersionId: id, currency: terms.currency, startsOn: terms.effectiveFrom, endsOn: terms.endsOn});
  };
  const closeDraft = () => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.draft?.lease !== state.draft?.lease || owner.saving || discardStale(owner)) return;
    ++draftLease.current;
    publish({...owner, draft: undefined, uncertain: false, saveError: undefined});
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const owner = live.current;
    if (owner.generation !== state.generation || owner.draft?.lease !== state.draft?.lease || !owner.draft || owner.saving || owner.uncertain
      || owner.status !== 'ready' || !owner.context?.canManage || discardStale(owner)) return;
    const draft = owner.draft;
    publish({...owner, saving: true, message: undefined, saveError: undefined});
    const terms = {name: draft.name, model: draft.model as ContractModel, startsOn: draft.startsOn, endsOn: draft.endsOn,
      effectiveFrom: draft.effectiveFrom, currency: draft.currency, value: draft.value, billingTerms: draft.billingTerms,
      documents: draft.documents.map(document => ({...document})), reason: draft.reason};
    try {
      let savedContract: ContractDetail | undefined;
      if (draft.kind === 'contract') savedContract = await commercialDraftingService.createContract({...terms, number: draft.number, clientId: draft.clientId} satisfies CreateContractInput, owner.context);
      if (draft.kind === 'revision') savedContract = await commercialDraftingService.appendContractVersion(draft.contractId, {...terms, expectedVersion: draft.expectedVersion} satisfies AppendContractVersionInput, owner.context);
      if (draft.kind === 'engagement') {
        const internal = ['internal', 'pre_sales'].includes(draft.model);
        await commercialDraftingService.createEngagement({code: draft.code, name: draft.name, model: draft.model, ownerId: draft.ownerId,
          startsOn: draft.startsOn, endsOn: draft.endsOn, currency: draft.currency, budget: draft.budget, reason: draft.reason,
          contractId: internal ? null : draft.contractId, contractVersionId: internal ? null : draft.contractVersionId,
          clientId: internal ? null : draft.clientId, attributionId: internal ? draft.attributionId : null} satisfies CreateEngagementInput, owner.context);
      }
      if (draft.kind === 'purchaseOrder') await commercialDraftingService.createPurchaseOrder({contractId: draft.contractId, contractVersionId: draft.contractVersionId,
        number: draft.number, value: draft.value, currency: draft.currency, startsOn: draft.startsOn, endsOn: draft.endsOn,
        warningThresholdPercent: draft.warningThresholdPercent, reason: draft.reason} satisfies CreatePurchaseOrderInput, owner.context);
      if (draft.kind === 'milestone') await commercialDraftingService.createMilestone({engagementId: draft.engagementId, code: draft.code, name: draft.name,
        dueOn: draft.dueOn, amount: draft.amount, currency: draft.currency, reason: draft.reason} satisfies CreateMilestoneInput, owner.context);
      if (discardStale(owner)) return;
      ++draftLease.current;
      const sequence = ++detailSequence.current;
      const success: WorkspaceState = {...owner, draft: undefined, saving: false, uncertain: false, message: 'Draft saved. Refreshing server records…',
        detail: savedContract ? {id: savedContract.id, sequence, status: 'ready', value: savedContract} : owner.detail};
      // A confirmed save is never retried implicitly, even if the refresh fails.
      publish({...success, status: 'loading', workspace: undefined});
      try {
        const workspace = await commercialDraftingService.getWorkspace(owner.context);
        if (!discardStale(owner)) publish({...success, status: 'ready', workspace, message: 'Draft saved. Server records refreshed.'});
      } catch {
        if (!discardStale(owner)) publish({...success, status: 'error', workspace: undefined, message: 'Draft saved, but records could not be refreshed. Reload to see current server records.'});
      }
    } catch (error) {
      if (discardStale(owner)) return;
      const status = error instanceof ApiClientError ? error.status : 0;
      if ([401, 403].includes(status)) { block(); return; }
      const retryable = [400, 404, 422].includes(status);
      publish({...owner, saving: false, uncertain: !retryable, saveError: safeError(error, true)});
    }
  };

  const owned = Boolean(state.context && current(state));
  const workspace = owned && state.status === 'ready' ? state.workspace : undefined;
  const draft = workspace && state.context?.canManage ? state.draft : undefined;
  const detail = workspace ? state.detail : undefined;
  const canManage = Boolean(owned && state.context?.canManage);
  const engagementTitle = termTitle('engagement');
  const engagementPlural = termPluralTitle('engagement');
  const title = draft ? ({contract: 'New contract / SOW', revision: `Append revision to ${draft.number}`, engagement: `New ${engagementTitle.toLowerCase()}`,
    purchaseOrder: 'New purchase order', milestone: 'New draft milestone'}[draft.kind]) : '';
  const internal = draft && ['internal', 'pre_sales'].includes(draft.model);
  const selectedContract = workspace?.contracts.find(contract => contract.id === draft?.contractId);
  const versionChoices = detail?.status === 'ready' && detail.id === draft?.contractId ? detail.value!.versions
    : selectedContract ? [selectedContract.terms] : [];
  const textInput = (key: keyof Draft, label: string, options: {required?: boolean; type?: string; pattern?: string; maxLength?: number; disabled?: boolean} = {}) =>
    <Field label={label}><input className={inputClass} required={options.required !== false} type={options.type || 'text'} pattern={options.pattern}
      maxLength={options.maxLength || 200} disabled={options.disabled} value={String(draft?.[key] ?? '')} onChange={event => edit({[key]: event.target.value})} /></Field>;
  const selectContract = <>
    <Field label="Contract / SOW"><select className={inputClass} required value={draft?.contractId || ''} onChange={event => chooseContract(event.target.value)}>
      <option value="">Select contract</option>{workspace?.contracts.filter(contract => draft?.kind !== 'engagement' || contract.terms.model === draft.model)
        .map(contract => <option key={contract.id} value={contract.id}>{contract.number} · {contract.terms.name}</option>)}
    </select></Field>
    <Field label="Pinned contract version"><select className={inputClass} required value={draft?.contractVersionId || ''} onChange={event => chooseVersion(event.target.value)}>
      <option value="">Select saved version</option>{versionChoices.map(version => <option key={version.id} value={version.id}>Version {version.version} · effective {version.effectiveFrom} · {modelLabel(version.model)}</option>)}
    </select></Field>
    <p className="text-sm text-slate-600 md:col-span-2">Select an immutable saved version. Dates, model, client and currency are validated by the server. Inspect the contract below to review all returned versions.</p>
  </>;

  return <div className="mx-auto max-w-7xl pb-12">
    <PageHeader title="Commercial drafting" subtitle={`Confidential contract terms, ${engagementPlural.toLowerCase()}, purchase orders and draft milestones.`} breadcrumb={['Delivery', 'Commercial drafting']} />
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-3xl text-sm text-slate-600">Commercial drafts remain separate from activation, closure, consumption and invoice readiness. Protected T&M calculations appear in their own scoped workspace. The server validates every saved record.</p>
      <button type="button" className={buttonClass} onClick={reload} disabled={Boolean(owned && (state.saving || state.status === 'loading'))}>{state.status === 'error' ? 'Retry workspace' : 'Reload workspace'}</button>
    </div>
    {(!owned && state.status !== 'loading') && <p role="alert" className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4">Scope or access changed. Content and draft cleared. Reload with commercial-view access and a selected organization and legal entity. A submitted save may still complete in its original scope.</p>}
    {owned && state.status === 'loading' && <p role="status" className="mb-5">{state.message || 'Loading commercial drafting…'}</p>}
    {owned && state.message && state.status !== 'loading' && <p role={state.status === 'error' ? 'alert' : 'status'} className="mb-5 rounded-xl border border-slate-300 p-4">{state.message}</p>}
    {workspace && <>
      <RateCandidates kind="billing" choices={[...workspace.contracts.map(x=>({type:'contract' as const,id:x.id,label:x.number})),...workspace.engagements.map(x=>({type:'engagement' as const,id:x.id,label:x.name}))]}/>
      <GovernedTmWorkspace choices={workspace.engagements.filter(x=>x.model==='time_and_materials').map(x=>({id:x.id,label:x.name}))}/>
      <TmBillingEligibilityWorkspace choices={workspace.engagements.filter(x=>x.model==='time_and_materials').map(x=>({id:x.id,label:x.name}))}/>
      <InvoiceDraftWorkspace choices={workspace.engagements.flatMap(x=>x.model==='time_and_materials'&&x.clientId&&x.contractId&&x.currency?[{id:x.id,label:x.name,clientId:x.clientId,contractId:x.contractId,currency:x.currency}]:[])}/>
      <InvoiceBatchApprovalWorkspace choices={workspace.engagements.filter(x=>x.model==='time_and_materials').map(x=>({id:x.id,label:x.name}))}/>
      <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
        <p>Server snapshot: {workspace.asOf}. {canManage ? 'Commercial drafting access enabled.' : 'Read-only commercial access. A separate manage permission is required to create drafts.'}</p>
        <p className="mt-1">Legacy {termPluralTitle('project').toLowerCase()} mapped: {workspace.legacyMappings.mappedProjects} of {workspace.legacyMappings.totalProjects}. Neutral migration snapshot coverage only; governed bindings appear separately below. Mapping does not establish invoice eligibility.</p>
        {Object.values(workspace.limits.truncated).some(Boolean) && <p role="status" className="mt-2 font-semibold">Some records or choices were truncated at {workspace.limits.pageSize}. These are bounded results, not an exhaustive absence claim.</p>}
      </div>
      {canManage && <div className="mb-6 flex flex-wrap gap-2" aria-label="Create commercial drafts">
        <button type="button" className={buttonClass} disabled={state.saving || state.uncertain} onClick={() => startDraft('contract')}>New contract / SOW</button>
        <button type="button" className={buttonClass} disabled={state.saving || state.uncertain} onClick={() => startDraft('engagement')}>New {engagementTitle.toLowerCase()}</button>
        <button type="button" className={buttonClass} disabled={state.saving || state.uncertain} onClick={() => startDraft('purchaseOrder')}>New purchase order</button>
        <button type="button" className={buttonClass} disabled={state.saving || state.uncertain} onClick={() => startDraft('milestone')}>New draft milestone</button>
      </div>}
      {draft && <section className={`${panelClass} mb-6`} aria-label="Commercial draft editor">
        <h2 className="mb-4 text-lg font-bold">{title}</h2>
        {state.saveError && <p role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">{state.saveError}</p>}
        {draft.kind === 'revision' && <p className="mb-4 text-sm">Appending after version {draft.expectedVersion}. Existing versions, model and currency remain immutable. The effective date must be after both the latest version and today in UTC, within the coverage dates. A concurrent change will be rejected, not overwritten.</p>}
        <form onSubmit={save} aria-label={title}>
          <fieldset disabled={state.saving || state.uncertain}>
            <legend className="sr-only">Draft fields</legend>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              {(draft.kind === 'contract' || draft.kind === 'revision') && <>
                {draft.kind === 'contract' && <>{textInput('number', 'Contract / SOW number', {pattern: '[A-Z0-9]([A-Z0-9_]|-){0,79}', maxLength: 80})}
                  <Field label="Client"><select className={inputClass} required value={draft.clientId} onChange={event => edit({clientId: event.target.value})}><option value="">Select client</option>
                    {workspace.choices.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></Field></>}
                {textInput('name', 'Contract name')}
                <Field label="Commercial model"><select className={inputClass} disabled={draft.kind === 'revision'} value={draft.model} onChange={event => edit({model: event.target.value as ContractModel})}>
                  {COMMERCIAL_CONTRACT_MODELS.map(model => <option key={model} value={model}>{modelLabel(model)}</option>)}</select></Field>
                {textInput('startsOn', 'Starts on', {type: 'date'})}{textInput('endsOn', 'Ends on', {type: 'date'})}
                {textInput('effectiveFrom', 'Terms effective from', {type: 'date'})}{textInput('currency', 'Currency (ISO code)', {pattern: '[A-Z]{3}', maxLength: 3, disabled: draft.kind === 'revision'})}
                {textInput('value', 'Contract value (decimal)', {pattern: moneyPattern, maxLength: 19})}
                <Field label="Billing terms"><textarea className={inputClass} required maxLength={4000} value={draft.billingTerms} onChange={event => edit({billingTerms: event.target.value})} /></Field>
                <div className="min-w-0 md:col-span-2"><h3 className="text-sm font-semibold">Document link metadata (optional)</h3>
                  {draft.documents.map((document, index) => <div key={index} className="mt-3 grid min-w-0 gap-3 md:grid-cols-[1fr_2fr_auto]">
                    <Field label={`Document ${index + 1} name`}><input className={inputClass} required maxLength={200} value={document.name} onChange={event => edit({documents: draft.documents.map((item, itemIndex) => itemIndex === index ? {...item, name: event.target.value} : item)})} /></Field>
                    <Field label={`Document ${index + 1} URL`}><input className={inputClass} required type="url" pattern="https:/{2}.+" maxLength={2048} value={document.url} onChange={event => edit({documents: draft.documents.map((item, itemIndex) => itemIndex === index ? {...item, url: event.target.value} : item)})} /></Field>
                    <button className={`${buttonClass} self-end`} type="button" onClick={() => edit({documents: draft.documents.filter((_, itemIndex) => itemIndex !== index)})}>Remove document {index + 1}</button>
                  </div>)}
                  <button className={`${buttonClass} mt-3`} type="button" disabled={draft.documents.length >= 10} onClick={() => edit({documents: [...draft.documents, {name: '', url: ''}]})}>Add document link</button>
                  <p className="mt-2 text-xs text-slate-600">HTTPS links only, maximum 10. No file upload. Do not include access tokens or credentials in URLs.</p>
                </div>
              </>}
              {draft.kind === 'engagement' && <>
                {textInput('code', `${engagementTitle} code`, {pattern: '[A-Z0-9]([A-Z0-9_]|-){0,79}', maxLength: 80})}{textInput('name', `${engagementTitle} name`)}
                <Field label="Commercial model"><select className={inputClass} value={draft.model} onChange={event => edit({model: event.target.value as EngagementModel, contractId: '', contractVersionId: '', clientId: '', attributionId: '', currency: '', startsOn: '', endsOn: ''})}>
                  {ENGAGEMENT_MODELS.map(model => <option key={model} value={model}>{modelLabel(model)}</option>)}</select></Field>
                <Field label={`${engagementTitle} owner`}><select className={inputClass} required value={draft.ownerId} onChange={event => edit({ownerId: event.target.value})}><option value="">Select owner</option>
                  {workspace.choices.owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></Field>
                {!internal ? selectContract : <><Field label="Business-unit / cost-centre attribution"><select className={inputClass} required value={draft.attributionId} onChange={event => edit({attributionId: event.target.value})}><option value="">Select attribution</option>
                  {workspace.choices.attributions.map(attribution => <option key={attribution.id} value={attribution.id}>{attribution.name} ({attribution.code})</option>)}</select></Field>
                  <p className="self-end text-sm text-slate-600">Internal and pre-sales drafts are non-billable and have no client or contract linkage.</p></>}
                {textInput('startsOn', 'Starts on', {type: 'date'})}{textInput('endsOn', 'Ends on', {type: 'date'})}
                {textInput('currency', 'Currency (ISO code)', {pattern: '[A-Z]{3}', maxLength: 3, disabled: !internal})}
                {textInput('budget', 'Budget (decimal)', {pattern: moneyPattern, maxLength: 19})}
              </>}
              {draft.kind === 'purchaseOrder' && <>
                {selectContract}{textInput('number', 'Purchase order number', {pattern: '[A-Z0-9]([A-Z0-9_]|-){0,79}', maxLength: 80})}{textInput('value', 'Purchase order value (decimal)', {pattern: moneyPattern, maxLength: 19})}
                {textInput('currency', 'Currency (pinned terms)', {disabled: true})}{textInput('warningThresholdPercent', 'Warning threshold percent (0–100)', {pattern: '\\d{1,3}(\\.\\d{1,2})?', maxLength: 6})}
                {textInput('startsOn', 'Starts on', {type: 'date'})}{textInput('endsOn', 'Ends on', {type: 'date'})}
              </>}
              {draft.kind === 'milestone' && <>
                <Field label={engagementTitle}><select className={inputClass} required value={draft.engagementId} onChange={event => {
                  const engagement = workspace.engagements.find(item => item.id === event.target.value);
                  edit({engagementId: event.target.value, currency: engagement?.currency || ''});
                }}><option value="">Select {engagementTitle.toLowerCase()}</option>{workspace.engagements.map(engagement => <option key={engagement.id} value={engagement.id}>{engagement.code} · {engagement.name}</option>)}</select></Field>
                {textInput('code', 'Milestone code', {pattern: '[A-Z0-9]([A-Z0-9_]|-){0,79}', maxLength: 80})}{textInput('name', 'Milestone name')}{textInput('dueOn', 'Due on', {type: 'date'})}
                {textInput('amount', 'Milestone amount (decimal)', {pattern: moneyPattern, maxLength: 19})}{textInput('currency', 'Currency (linked terms)', {disabled: true})}
                <p className="text-sm text-slate-600 md:col-span-2">Saved milestones remain Draft and are not accepted or billing eligible.</p>
              </>}
              <div className="md:col-span-2"><Field label="Reason for creation / revision"><textarea className={inputClass} required minLength={3} maxLength={1000} value={draft.reason} onChange={event => edit({reason: event.target.value})} /></Field></div>
            </div>
            <p className="mt-4 text-xs text-slate-600">Amounts are entered and sent as decimal strings with up to 14 whole digits and 4 decimal places. No browser financial totals are calculated.</p>
            <button className={`${buttonClass} mt-4 bg-primary text-white`} type="submit">{state.saving ? 'Saving draft…' : draft.kind === 'revision' ? 'Append contract revision' : 'Save draft'}</button>
          </fieldset>
          <button className={`${buttonClass} mt-3 sm:ml-3`} type="button" disabled={state.saving} onClick={closeDraft}>Discard draft</button>
        </form>
      </section>}
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <section className={panelClass} aria-label="Contracts and SOWs"><h2 className="mb-4 text-lg font-bold">Contracts / SOWs ({workspace.contracts.length})</h2>
          {!workspace.contracts.length && <p>No contracts returned for this scope.</p>}
          <ul className="space-y-4">{workspace.contracts.map(contract => <li key={contract.id} className="min-w-0 rounded-xl border border-slate-200 p-4">
            <h3 className="break-words font-bold">{contract.number} · {contract.terms.name}</h3>
            <p className="mt-2 break-words text-sm">Latest saved version {contract.latestVersion}. {modelLabel(contract.terms.model)}. {contract.terms.currency} {contract.terms.value}.</p>
            <p className="mt-1 text-sm">Latest terms effective {contract.terms.effectiveFrom}. {contract.currentTerms ? `Currently effective version ${contract.currentTerms.version}: ${contract.currentTerms.currency} ${contract.currentTerms.value}.` : 'No currently effective terms returned.'}</p>
            <button type="button" className={`${buttonClass} mt-3`} disabled={state.saving || (detail?.id === contract.id && detail.status === 'loading')} onClick={() => inspect(contract.id)}>Inspect {contract.number}</button>
          </li>)}</ul>
        </section>
        <section className={panelClass} aria-label="Contract version history"><h2 className="mb-4 text-lg font-bold">Immutable contract version history</h2>
          {!detail && <p>Select a contract to load its saved versions and full billing terms.</p>}
          {detail?.status === 'loading' && <p role="status">Loading contract versions…</p>}
          {detail?.status === 'error' && <><p role="alert">Contract versions could not be loaded. No version history is being shown.</p><button type="button" className={`${buttonClass} mt-3`} onClick={() => inspect(detail.id)}>Retry contract versions</button></>}
          {detail?.status === 'ready' && detail.value && <>
            <h3 className="mb-3 break-words font-bold">{detail.value.number}</h3>
            {canManage && <button type="button" className={`${buttonClass} mb-4`} disabled={state.saving || state.uncertain} onClick={() => startDraft('revision')}>Append effective revision</button>}
            <ol className="space-y-4">{[...detail.value.versions].sort((a, b) => b.version - a.version).map(version => <li key={version.id} className="min-w-0 rounded-xl border border-slate-200 p-4">
              <h4 className="break-words font-bold">Version {version.version} · {version.name}</h4>
              <p className="mt-2 text-sm">Effective {version.effectiveFrom}. Coverage {version.startsOn} to {version.endsOn}. {modelLabel(version.model)}.</p>
              <p className="mt-1 text-sm">{version.currency} {version.value}</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">Billing terms: {version.billingTerms || 'No billing terms saved.'}</p>
              {!!version.documents.length && <ul className="mt-2 space-y-1">{version.documents.map((document, index) => <li key={index}><a className="break-all text-sm underline" href={document.url} target="_blank" rel="noopener noreferrer">{document.name}</a></li>)}</ul>}
            </li>)}</ol>
          </>}
        </section>
        <section className={panelClass} aria-label={`${engagementPlural} drafts`}><h2 className="mb-4 text-lg font-bold">{engagementPlural} ({workspace.engagements.length})</h2>
          {!workspace.engagements.length && <p>No {engagementPlural.toLowerCase()} returned for this scope.</p>}
          <ul className="space-y-3">{workspace.engagements.map(engagement => <li key={engagement.id} className="break-words rounded-xl border border-slate-200 p-3">
            <h3 className="font-bold">{engagement.code} · {engagement.name}</h3><p className="mt-1 text-sm">{modelLabel(engagement.model)} · {engagement.status} · {engagement.billable ? 'Commercial terms linked' : 'Non-billable'}.</p>
            <p className="mt-1 text-sm">{engagement.startsOn} to {engagement.endsOn}. Budget {engagement.currency} {engagement.budget}.</p>
            {engagement.contractVersionId && <p className="mt-1 text-xs">Pinned terms ID: {engagement.contractVersionId}</p>}
          </li>)}</ul>
        </section>
        <div className="min-w-0 space-y-6">
          <section className={panelClass} aria-label="Purchase order drafts"><h2 className="mb-4 text-lg font-bold">Purchase orders ({workspace.purchaseOrders.length})</h2>
            {!workspace.purchaseOrders.length && <p>No purchase orders returned for this scope.</p>}
            <ul className="space-y-3">{workspace.purchaseOrders.map(order => <li key={order.id} className="break-words rounded-xl border border-slate-200 p-3"><h3 className="font-bold">{order.number} · {order.status}</h3>
              <p className="mt-1 text-sm">{order.currency} {order.value}. {order.startsOn} to {order.endsOn}. Warning threshold {order.warningThresholdPercent}%.</p><p className="mt-1 text-xs">Pinned terms ID: {order.contractVersionId}. No consumption or remaining-value claim.</p></li>)}</ul>
          </section>
          <section className={panelClass} aria-label="Draft milestones"><h2 className="mb-4 text-lg font-bold">Draft milestones ({workspace.milestones.length})</h2>
            {!workspace.milestones.length && <p>No milestones returned for this scope.</p>}
            <ul className="space-y-3">{workspace.milestones.map(milestone => <li key={milestone.id} className="break-words rounded-xl border border-slate-200 p-3"><h3 className="font-bold">{milestone.code} · {milestone.name}</h3>
              <p className="mt-1 text-sm">Due {milestone.dueOn}. {milestone.currency} {milestone.amount}. Draft, not accepted, not billing eligible.</p></li>)}</ul>
          </section>
        </div>
      </div>
    </>}
  </div>;
};
