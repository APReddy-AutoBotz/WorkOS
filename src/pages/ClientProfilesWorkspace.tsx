import {cloneElement, isValidElement, useEffect, useId, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {PageHeader} from '../components/ui/PageHeader';
import {ApiClientError} from '../services/apiClient';
import {captureClientProfilesContext, clientProfilesService, isClientProfilesContextCurrent,
  type ClientProfilesContext, type ClientProfilesWorkspace as Workspace, type ClientProfileDetail as Detail, type ClientProfile,
  type ClientBillingUnit, type UnitProfile, type BillingContact} from '../services/clientProfiles';

type Draft = {lease: number; kind: 'client' | 'unit-new' | 'unit-revision'; clientId: string; unitId: string; expectedVersion: number;
  code: string; unitKind: ClientBillingUnit['kind']; effectiveFrom: string; legalName: string; displayName: string; parentClientId: string;
  defaultCurrency: string; billingContacts: BillingContact[]; reason: string; afterDate: string};
type DetailState = {id: string; sequence: number; status: 'loading' | 'ready' | 'error'; value?: Detail};
type State = {generation: number; context: ClientProfilesContext | null; status: 'loading' | 'ready' | 'error' | 'blocked';
  workspace?: Workspace; detail?: DetailState; draft?: Draft; saving?: boolean; uncertain?: boolean; message?: string; saveError?: string;
  asOfInput: string; asOfQuery?: string};
const button = 'rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
const input = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2.5 text-sm text-heading focus-visible:outline focus-visible:outline-2 disabled:bg-slate-100';
const panel = 'min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6';
const nullable = (value: string) => value.trim() || null;
const today = () => new Date().toISOString().slice(0, 10);
const nextDate = (value: string) => {const result = new Date(`${value}T00:00:00.000Z`);result.setUTCDate(result.getUTCDate() + 1);return result.toISOString().slice(0, 10);};
const safeError = (error: unknown, saving = false) => {
  const status = error instanceof ApiClientError ? error.status : 0;
  if ([401, 403].includes(status)) return 'Client profile access could not be confirmed. Reload with current access.';
  if (saving && [400, 404, 422].includes(status)) return 'Profile not saved. Check dates, required fields and scoped references. The server validates every snapshot.';
  if (saving && status === 409) return 'Profile not saved because a version, code or hierarchy changed. Reload before another save.';
  return saving ? 'Save outcome could not be confirmed. Reload before another save to avoid duplicates.' : 'Client profiles could not be loaded. Check your connection and retry.';
};
const Field = ({label, children}: {label: string; children: ReactNode}) => {
  const id = useId();return <div className="min-w-0 text-sm font-semibold"><label htmlFor={id}>{label}</label>
    {isValidElement<{id?: string}>(children) ? cloneElement(children, {id}) : children}</div>;
};
const ProfileValues = ({value, parentName}: {value: ClientProfile | UnitProfile | null; parentName?: (id: string) => string}) => !value ?
  <p className="text-sm">No effective commercial profile. Missing legal/display names, billing contacts and currency are not inferred from the operational label.</p> :
  <div className="space-y-1 break-words text-sm">
    <p>Version {value.version} · effective {value.effectiveFrom}</p><p>Legal name: {value.legalName ?? 'Not provided'}</p>
    <p>Display name: {value.displayName ?? 'Not provided'}</p><p>Default currency: {value.defaultCurrency ?? 'Not provided'}</p>
    {'parentClientId' in value && <p>Parent client: {value.parentClientId ? parentName?.(value.parentClientId) || value.parentClientId : 'None'}</p>}
    <p>Billing contacts: {value.billingContacts.length ? '' : 'None provided'}</p>
    {!!value.billingContacts.length && <ul className="space-y-1">{value.billingContacts.map((contact, index) => <li key={index}>{contact.name} · {contact.email}</li>)}</ul>}
  </div>;

export const ClientProfilesWorkspace = () => {
  const generation = useRef(0), detailSequence = useRef(0), draftLease = useRef(0), mounted = useRef(false);
  const initial: State = {generation: 0, context: null, status: 'loading', asOfInput: ''};
  const [state, setState] = useState<State>(initial);const live = useRef(initial);
  const publish = (next: State) => {live.current = next;setState(next);};
  const current = (owner: State) => mounted.current && owner.generation === generation.current && Boolean(owner.context && isClientProfilesContextCurrent(owner.context));
  const block = () => {++generation.current;++detailSequence.current;++draftLease.current;publish({generation: generation.current, context: null, status: 'blocked', asOfInput: ''});};
  const discardStale = (owner: State) => {if (current(owner)) return false;if (mounted.current && owner.generation === generation.current) block();return true;};
  const reloadFor = (renderGeneration: number, asOf?: string, initializing = false) => {
    const previous = live.current;if (!mounted.current || previous.generation !== renderGeneration || previous.saving) return;
    if (!initializing && previous.context && !isClientProfilesContextCurrent(previous.context)) {block();return;}
    const request = ++generation.current;++detailSequence.current;++draftLease.current;
    const context = captureClientProfilesContext(() => mounted.current && request === generation.current);
    const owner: State = {generation: request, context, status: context ? 'loading' : 'blocked', asOfInput: asOf || '', asOfQuery: asOf};publish(owner);
    if (!context) return;
    void clientProfilesService.getWorkspace(context, asOf).then(workspace => {if (!discardStale(owner)) publish({...owner, status: 'ready', workspace});})
      .catch(error => {if (discardStale(owner)) return;if (error instanceof ApiClientError && [401, 403].includes(error.status)) {block();return;}
        publish({...owner, status: 'error', message: safeError(error)});});
  };
  useEffect(() => {
    mounted.current = true;
    const check = () => {if (live.current.context && !isClientProfilesContextCurrent(live.current.context)) block();};
    window.addEventListener('workos:organization-scope-switch-requested', block);window.addEventListener('workos:organization-scope-changed', check);
    window.addEventListener('storage', check);window.addEventListener('focus', check);reloadFor(live.current.generation, undefined, true);
    return () => {mounted.current = false;++generation.current;++detailSequence.current;++draftLease.current;
      window.removeEventListener('workos:organization-scope-switch-requested', block);window.removeEventListener('workos:organization-scope-changed', check);
      window.removeEventListener('storage', check);window.removeEventListener('focus', check);};
  }, []);
  const inspect = (id: string) => {
    const owner = live.current;if (owner.generation !== state.generation || owner.saving || owner.draft || discardStale(owner)
      || !owner.workspace?.clients.some(client => client.id === id) || (owner.detail?.id === id && owner.detail.status !== 'error')) return;
    const sequence = ++detailSequence.current;const detail: DetailState = {id, sequence, status: 'loading'};publish({...owner, detail});
    void clientProfilesService.getClient(id, owner.context, owner.asOfQuery).then(value => {
      if (!discardStale(owner) && sequence === detailSequence.current && live.current.detail?.id === id) publish({...live.current, detail: {...detail, status: 'ready', value}});
    }).catch(error => {if (discardStale(owner) || sequence !== detailSequence.current || live.current.detail?.id !== id) return;
      if (error instanceof ApiClientError && [401, 403].includes(error.status)) {block();return;}publish({...live.current, detail: {...detail, status: 'error'}});});
  };
  const back = () => {
    const owner = live.current;if (owner.generation !== state.generation || owner.detail?.sequence !== state.detail?.sequence || owner.saving || owner.draft || discardStale(owner)) return;
    ++detailSequence.current;publish({...owner, detail: undefined});
  };
  const start = (kind: Draft['kind'], unitId = '') => {
    const owner = live.current;if (owner.generation !== state.generation || owner.saving || owner.uncertain || owner.draft || owner.status !== 'ready'
      || !owner.context?.canManage || discardStale(owner) || owner.detail?.sequence !== state.detail?.sequence || owner.detail?.status !== 'ready') return;
    const client = owner.detail.value!;const unit = client.billingUnits.find(unit => unit.id === unitId);
    if (client.status.toLowerCase() !== 'active' || (kind !== 'client' && !client.latestVersion) || (kind === 'unit-revision' && !unit)
      || (kind === 'client' && client.latestVersion >= 200) || (kind === 'unit-revision' && unit!.latestVersion >= 200)) return;
    const latest = kind === 'client' ? client.latestProfile : kind === 'unit-revision' ? unit!.versions.find(version => version.version === unit!.latestVersion)! : null;
    const draft: Draft = {lease: ++draftLease.current, kind, clientId: client.id, unitId, expectedVersion: kind === 'client' ? client.latestVersion : unit?.latestVersion || 0,
      code: kind === 'client' ? client.code || '' : unit?.code || '', unitKind: unit?.kind || 'billing_entity', effectiveFrom: '',
      legalName: latest?.legalName || '', displayName: latest?.displayName || '', defaultCurrency: latest?.defaultCurrency || '',
      parentClientId: kind === 'client' ? client.latestProfile?.parentClientId || '' : '', billingContacts: latest?.billingContacts.map(contact => ({...contact})) || [],
      reason: '', afterDate: latest ? nextDate([today(), latest.effectiveFrom].sort().at(-1)!) : today()};
    publish({...owner, draft, saveError: undefined, message: undefined});
  };
  const edit = (patch: Partial<Draft>) => {
    const owner = live.current;if (owner.generation !== state.generation || !owner.draft || owner.draft.lease !== state.draft?.lease || owner.saving || owner.uncertain || discardStale(owner)) return;
    publish({...owner, draft: {...owner.draft, ...patch}, saveError: undefined});
  };
  const cancel = () => {
    const owner = live.current;if (owner.generation !== state.generation || !owner.draft || owner.draft.lease !== state.draft?.lease || owner.saving || discardStale(owner)) return;
    ++draftLease.current;publish({...owner, draft: undefined, saveError: undefined,
      message: owner.uncertain ? 'Save outcome or latest version remains unconfirmed. Reload before another save.' : undefined});
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();const owner = live.current;
    if (owner.generation !== state.generation || !owner.draft || owner.draft.lease !== state.draft?.lease || owner.saving || owner.uncertain
      || owner.status !== 'ready' || !owner.context?.canManage || discardStale(owner)) return;
    const draft = owner.draft;publish({...owner, saving: true, message: undefined, saveError: undefined});
    const fields = {effectiveFrom: draft.effectiveFrom, legalName: nullable(draft.legalName), displayName: nullable(draft.displayName),
      defaultCurrency: nullable(draft.defaultCurrency), billingContacts: draft.billingContacts.map(contact => ({name: contact.name.trim(), email: contact.email.trim()})), reason: draft.reason};
    try {
      const detail = draft.kind === 'client' ? await clientProfilesService.appendClientProfile(draft.clientId, {...fields, code: draft.code, parentClientId: nullable(draft.parentClientId), expectedVersion: draft.expectedVersion}, owner.context)
        : draft.kind === 'unit-new' ? await clientProfilesService.createBillingUnit(draft.clientId, {...fields, code: draft.code, kind: draft.unitKind}, owner.context)
          : await clientProfilesService.appendBillingUnitVersion(draft.clientId, draft.unitId, {...fields, expectedVersion: draft.expectedVersion}, owner.context);
      if (discardStale(owner)) return;++draftLease.current;const sequence = ++detailSequence.current;
      const success: State = {...owner, draft: undefined, saving: false, uncertain: false, asOfInput: '', asOfQuery: undefined, workspace: undefined,
        detail: {id: detail.id, sequence, status: 'ready', value: detail}, message: 'Profile saved. Returning to the current server snapshot.', status: 'loading'};publish(success);
      try {const workspace = await clientProfilesService.getWorkspace(owner.context);if (!discardStale(owner)) publish({...success, status: 'ready', workspace, message: 'Profile saved. Current server records refreshed. Existing commercial pins are unchanged.'});}
      catch (error) {if (discardStale(owner)) return;if (error instanceof ApiClientError && [401, 403].includes(error.status)) {block();return;}
        publish({...success, status: 'error', workspace: undefined, detail: undefined, message: 'Profile saved, but records could not be refreshed. Reload to see current server records. Do not repeat the save.'});}
    } catch (error) {
      if (discardStale(owner)) return;const status = error instanceof ApiClientError ? error.status : 0;
      if ([401, 403].includes(status)) {block();return;}publish({...owner, saving: false, uncertain: ![400, 404, 422].includes(status), saveError: safeError(error, true)});
    }
  };
  const owned = Boolean(state.context && current(state));const workspace = owned && state.status === 'ready' ? state.workspace : undefined;
  const detailState = workspace ? state.detail : undefined;const detail = detailState?.status === 'ready' ? detailState.value : undefined;
  const canManage = Boolean(owned && state.context?.canManage);const draft = workspace && canManage ? state.draft : undefined;
  const locked = Boolean(state.saving || state.uncertain || draft);const parentName = (id: string) => workspace?.clients.find(client => client.id === id)?.operationalName || `Scoped client reference ${id}`;
  const draftTitle = draft?.kind === 'client' ? draft.expectedVersion ? 'Append client profile revision' : 'Initialize client profile' : draft?.kind === 'unit-new' ? 'Add billing unit' : 'Append billing unit revision';
  const field = (key: 'code' | 'effectiveFrom' | 'legalName' | 'displayName' | 'defaultCurrency', label: string, options: {required?: boolean; type?: string; pattern?: string; maxLength?: number; disabled?: boolean; min?: string} = {}) =>
    <Field label={label}><input className={input} value={draft?.[key] || ''} onChange={event => edit({[key]: event.target.value})} required={options.required}
      type={options.type || 'text'} pattern={options.pattern} maxLength={options.maxLength || 200} disabled={options.disabled} min={options.min} /></Field>;
  return <div className="mx-auto max-w-7xl pb-12">
    <PageHeader title="Client profiles" subtitle="Scoped customer profiles, parent accounts and billing units with immutable effective-dated history." breadcrumb={['Delivery', 'Client profiles']} />
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-3xl text-sm text-slate-600">The selected buyer legal entity owns these records. Customer billing entities are separate identities, not buyer legal entities. No operational client, contract, engagement or existing version pin is changed here.</p>
      <button className={button} type="button" onClick={() => reloadFor(state.generation, state.asOfQuery)} disabled={Boolean(owned && (state.saving || state.status === 'loading'))}>{state.status === 'error' ? 'Retry workspace' : 'Reload workspace'}</button>
    </div>
    {!owned && state.status !== 'loading' && <p role="alert" className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4">Scope or access changed. Content and draft cleared. Reload with client-profile view access and a selected organization and legal entity. A submitted save may still complete in its original scope.</p>}
    {owned && state.status === 'loading' && <p role="status">{state.message || 'Loading client profiles…'}</p>}
    {owned && state.message && state.status !== 'loading' && <p role={state.status === 'error' || state.uncertain ? 'alert' : 'status'} className="mb-5 rounded-xl border border-slate-300 p-4">{state.message}</p>}
    {workspace && <>
      <form onSubmit={event => {event.preventDefault();if (live.current.generation === state.generation && !live.current.saving && !live.current.draft && !discardStale(live.current)) reloadFor(state.generation, state.asOfInput || undefined);}} className="mb-5 flex flex-wrap items-end gap-3" aria-label="Client profile date selection">
        <Field label="As-of date"><input className={input} type="date" disabled={Boolean(state.saving || draft)} value={state.asOfInput} onChange={event => {
          const owner = live.current;if (owner.generation === state.generation && !owner.saving && !owner.draft && !discardStale(owner)) publish({...owner, asOfInput: event.target.value});
        }} /></Field><button type="submit" className={button} disabled={Boolean(state.saving || draft)}>Apply as-of date</button>
      </form>
      <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"><p>Server snapshot: {workspace.asOf}. {canManage ? 'Client profile management access enabled.' : 'Read-only client profile access. A separate manage permission is required to save.'}</p>
        <p className="mt-1">Currency defaults are explicit selection aids for future drafting only. Historical terms and existing commercial pins are never rewritten.</p>
        {workspace.truncated && <p role="status" className="mt-2 font-semibold">Clients were truncated at {workspace.limit}. These bounded results are not an exhaustive absence claim.</p>}
        {state.uncertain && <p role="alert" className="mt-2 font-semibold">Reload before another save. Cancelling the editor does not confirm an uncertain outcome.</p>}
      </div>
      {draft && <section aria-label="Client profile editor" className={`${panel} mb-6`}><h2 className="mb-4 text-lg font-bold">{draftTitle}</h2>
        <p className="mb-4 text-sm">Full snapshot, not a partial patch. Blank optional values are saved as explicitly missing. {draft.expectedVersion ? `Appending after version ${draft.expectedVersion}; effective date must be after both today in UTC and the latest saved effective date.` : 'First version may take effect today in UTC or later.'} Existing records are immutable. No dates, names or currencies are guessed.</p>
        {state.saveError && <p role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">{state.saveError}</p>}
        <form onSubmit={save} aria-label={draftTitle}><fieldset disabled={state.saving || state.uncertain}><legend className="sr-only">Profile fields</legend>
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            {field('code', draft.kind === 'client' ? 'Client code' : 'Unit code', {required: true, disabled: draft.expectedVersion > 0, pattern: '[A-Z0-9][A-Z0-9_-]{0,79}', maxLength: 80})}
            {draft.kind !== 'client' && <Field label="Unit kind"><select className={input} disabled={draft.kind === 'unit-revision'} value={draft.unitKind} onChange={event => edit({unitKind: event.target.value as Draft['unitKind']})}><option value="billing_entity">Billing entity</option><option value="business_unit">Business unit</option></select></Field>}
            {field('effectiveFrom', 'Effective from', {type: 'date', required: true, min: draft.afterDate})}{field('legalName', 'Legal name')}{field('displayName', 'Display name')}
            {draft.kind === 'client' && <Field label="Parent client"><select className={input} value={draft.parentClientId} onChange={event => edit({parentClientId: event.target.value})}><option value="">None</option>
              {draft.parentClientId && !workspace.clients.some(client => client.id === draft.parentClientId) && <option value={draft.parentClientId}>Existing scoped parent reference {draft.parentClientId}</option>}
              {workspace.clients.filter(client => client.id !== draft.clientId).map(client => <option key={client.id} value={client.id}>{client.operationalName}</option>)}</select></Field>}
            {field('defaultCurrency', 'Default currency (ISO code)', {pattern: '[A-Z]{3}', maxLength: 3})}
            <div className="min-w-0 md:col-span-2"><h3 className="font-semibold">Billing contacts</h3>{draft.billingContacts.map((contact, index) => <div key={index} className="mt-3 grid min-w-0 gap-3 md:grid-cols-[1fr_1fr_auto]">
              <Field label={`Billing contact ${index + 1} name`}><input className={input} required maxLength={200} value={contact.name} onChange={event => edit({billingContacts: draft.billingContacts.map((item, i) => i === index ? {...item, name: event.target.value} : item)})} /></Field>
              <Field label={`Billing contact ${index + 1} email`}><input className={input} required type="email" maxLength={254} value={contact.email} onChange={event => edit({billingContacts: draft.billingContacts.map((item, i) => i === index ? {...item, email: event.target.value} : item)})} /></Field>
              <button type="button" className={`${button} self-end`} onClick={() => edit({billingContacts: draft.billingContacts.filter((_, i) => i !== index)})}>Remove billing contact {index + 1}</button>
            </div>)}<button type="button" className={`${button} mt-3`} disabled={draft.billingContacts.length >= 10} onClick={() => edit({billingContacts: [...draft.billingContacts, {name: '', email: ''}]})}>Add billing contact</button></div>
            <div className="md:col-span-2"><Field label="Reason for profile change"><textarea className={input} required minLength={3} maxLength={1000} value={draft.reason} onChange={event => edit({reason: event.target.value})} /></Field></div>
          </div><button type="submit" className={`${button} mt-4 bg-primary text-white`}>{state.saving ? 'Saving profile…' : 'Save profile'}</button>
        </fieldset><button type="button" className={`${button} mt-3 sm:ml-3`} disabled={state.saving} onClick={cancel}>Cancel</button></form>
      </section>}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[1fr_2fr]">
        <section className={panel} aria-label="Client profile list"><h2 className="mb-4 text-lg font-bold">Clients ({workspace.clients.length})</h2>
          {!workspace.clients.length && <p>No clients returned for this scope.</p>}<ul className="space-y-4">{workspace.clients.map(client => <li key={client.id} className="min-w-0 rounded-xl border border-slate-200 p-4">
            <h3 className="break-words font-bold">{client.operationalName}</h3><p className="mt-1 break-words text-sm">Code: {client.code ?? 'Not provided'} · Operational status: {client.status}</p>
            {!client.latestVersion && <p className="mt-2 text-sm font-semibold">Incomplete legacy client: no commercial profile. Operational label is not a legal or display name.</p>}
            <p className="mt-2 text-sm">{client.currentProfile ? `Current profile version ${client.currentProfile.version}.` : 'No profile effective at this snapshot.'} {client.latestProfile ? `Latest saved version ${client.latestVersion}, effective ${client.latestProfile.effectiveFrom}${client.latestProfile.effectiveFrom > workspace.asOf ? ' (future at snapshot)' : ''}.` : ''}</p>
            <button type="button" className={`${button} mt-3`} disabled={Boolean(state.saving || draft || (detailState?.id === client.id && detailState.status !== 'error'))} onClick={() => inspect(client.id)}>Inspect {client.operationalName}</button>
          </li>)}</ul>
        </section>
        <section className={panel} aria-label="Client profile detail"><h2 className="mb-4 text-lg font-bold">Client profile detail</h2>
          {!detailState && <p>Select a client to inspect its profiles and billing units.</p>}
          {detailState && <button className={`${button} mb-4`} type="button" disabled={Boolean(state.saving || draft)} onClick={back}>Back to client list</button>}
          {detailState?.status === 'loading' && <p role="status">Loading client profile detail…</p>}
          {detailState?.status === 'error' && <><p role="alert">Client profile detail could not be loaded. No prior detail is shown.</p><button className={`${button} mt-3`} type="button" onClick={() => inspect(detailState.id)}>Retry client profile</button></>}
          {detail && <>
            <h3 className="break-words text-lg font-bold">{detail.operationalName}</h3><p className="mt-2 break-words text-sm">Operational master: industry {detail.industry ?? 'Not provided'} · status {detail.status} · account owner {detail.accountOwnerId ?? 'Not provided'}. These fields remain managed in the existing client master.</p>
            <p className="mt-2 text-sm">Client code: {detail.code ?? 'Not provided'}. Detail snapshot: {detail.asOf}.</p>
            {detail.truncated && <p role="status" className="mt-2 text-sm font-semibold">Billing units were truncated at {detail.limit}. These bounded results are not exhaustive.</p>}
            {canManage && <div className="my-4 flex flex-wrap gap-2"><button type="button" className={button} disabled={locked || detail.latestVersion >= 200 || detail.status.toLowerCase() !== 'active'} onClick={() => start('client')}>{detail.latestVersion ? 'Append client profile revision' : 'Initialize client profile'}</button>
              <button type="button" className={button} disabled={locked || !detail.latestVersion || detail.billingUnits.length >= 200 || detail.status.toLowerCase() !== 'active'} onClick={() => start('unit-new')}>Add billing unit</button></div>}
            {!detail.latestVersion && <p className="my-3 text-sm font-semibold">Incomplete legacy client. Initialize an explicit profile before adding billing units. Missing commercial fields are not inferred.</p>}
            {detail.status.toLowerCase() !== 'active' && <p className="my-3 text-sm">Inactive operational clients are read-only here.</p>}
            <div className="my-4 grid min-w-0 gap-4 md:grid-cols-2"><section className="min-w-0 rounded-xl border border-slate-200 p-3" aria-label="Current client profile"><h4 className="mb-2 font-bold">Current profile at snapshot</h4><ProfileValues value={detail.currentProfile} parentName={parentName} /></section>
              <section className="min-w-0 rounded-xl border border-slate-200 p-3" aria-label="Latest client profile"><h4 className="mb-2 font-bold">Latest saved profile {detail.latestProfile && detail.latestProfile.effectiveFrom > detail.asOf ? '(future at snapshot)' : ''}</h4><ProfileValues value={detail.latestProfile} parentName={parentName} /></section></div>
            <section aria-label="Client profile history"><h4 className="mb-3 font-bold">Immutable client profile history ({detail.versions.length})</h4><ol className="space-y-3">{[...detail.versions].sort((a, b) => b.version - a.version).map(version => <li className="min-w-0 rounded-xl border border-slate-200 p-3" key={version.id}><ProfileValues value={version} parentName={parentName} /></li>)}</ol></section>
            <section className="mt-6" aria-label="Client billing units"><h4 className="mb-3 font-bold">Customer billing entities and business units ({detail.billingUnits.length})</h4>
              {!detail.billingUnits.length && <p className="text-sm">No billing units returned for this client.</p>}<ul className="space-y-4">{detail.billingUnits.map(unit => <li className="min-w-0 rounded-xl border border-slate-200 p-3" key={unit.id}>
                <h5 className="break-words font-bold">{unit.code} · {unit.kind === 'billing_entity' ? 'Billing entity' : 'Business unit'}</h5>
                <p className="mt-1 text-sm">Latest saved version {unit.latestVersion}, effective {unit.versions.find(version => version.version === unit.latestVersion)?.effectiveFrom}.</p>
                <div className="my-3 grid min-w-0 gap-4 md:grid-cols-2"><section className="min-w-0"><h6 className="my-2 font-semibold">Current unit profile at snapshot</h6><ProfileValues value={unit.currentProfile} /></section>
                  <section className="min-w-0"><h6 className="my-2 font-semibold">Latest saved unit profile {unit.versions.find(version => version.version === unit.latestVersion)!.effectiveFrom > detail.asOf ? '(future at snapshot)' : ''}</h6><ProfileValues value={unit.versions.find(version => version.version === unit.latestVersion)!} /></section></div>
                {canManage && <button className={`${button} my-3`} type="button" disabled={locked || unit.latestVersion >= 200 || detail.status.toLowerCase() !== 'active'} onClick={() => start('unit-revision', unit.id)}>Append unit revision {unit.code}</button>}
                <details className="mt-3"><summary className="cursor-pointer font-semibold">Immutable unit history ({unit.versions.length})</summary><ol className="mt-3 space-y-3">{[...unit.versions].sort((a, b) => b.version - a.version).map(version => <li key={version.id} className="min-w-0 rounded-lg border border-slate-200 p-3"><ProfileValues value={version} /></li>)}</ol></details>
              </li>)}</ul>
            </section>
          </>}
        </section>
      </div>
    </>}
  </div>;
};
