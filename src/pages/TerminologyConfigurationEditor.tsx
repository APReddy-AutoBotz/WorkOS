import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {PageHeader} from '../components/ui/PageHeader';
import {adminService} from '../services/api';
import {ApiClientError, resetBackendCheck} from '../services/apiClient';
import {captureOrganizationProfileContext, isOrganizationProfileContextCurrent, type OrganizationProfileContext} from '../services/organizationProfileScope';
import {TERMINOLOGY_KEYS, takeTerminologyFeedback, type TerminologyConfiguration} from '../services/terminologyConfiguration';
import type {TerminologyKey, TerminologyValue} from '../config/productConfig';

type EditorState = {
  generation: number;
  context: OrganizationProfileContext | null;
  status: 'loading' | 'ready' | 'saving' | 'blocked' | 'error';
  draft?: TerminologyConfiguration;
  message?: string;
};
const buttonClass = 'rounded-xl border border-slate-300 px-4 py-2 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
const inputClass = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-3 text-heading focus-visible:outline focus-visible:outline-2 disabled:bg-slate-100';
const safeError = (error: unknown, saving: boolean) => {
  const status = error instanceof ApiClientError ? error.status : 0;
  if ([401, 403].includes(status)) return 'Terminology access could not be confirmed. Reload after checking your access.';
  if (saving && status === 400) return 'Terminology was not saved. Check the fields and effective date.';
  if (saving && status === 409) return 'Terminology was not saved because its effective date conflicts with the latest server version. Reload before making another change.';
  return saving ? 'Save could not be confirmed. Reload terminology before trying again.' : 'Terminology could not be loaded. Check your connection and try again.';
};

export const TerminologyConfigurationEditor = () => {
  const generation = useRef(0);
  const mounted = useRef(false);
  const initial: EditorState = {generation: 0, context: null, status: 'loading'};
  const [state, setState] = useState<EditorState>(initial);
  const live = useRef<EditorState>(initial);
  const publish = (next: EditorState) => { live.current = next; setState(next); };
  const current = (owner: EditorState) => mounted.current && owner.generation === generation.current
    && Boolean(owner.context && isOrganizationProfileContextCurrent(owner.context));

  const discardStale = (owner: EditorState) => {
    if (current(owner)) return false;
    if (mounted.current && owner.generation === generation.current) {
      ++generation.current;
      publish({generation: generation.current, context: null, status: 'blocked'});
    }
    return true;
  };

  const reloadForGeneration = (renderGeneration: number, preserveFeedback = false) => {
    if (!mounted.current || live.current.generation !== renderGeneration || live.current.status === 'saving') return;
    const request = ++generation.current;
    const context = captureOrganizationProfileContext(() => mounted.current && request === generation.current);
    const message = preserveFeedback ? takeTerminologyFeedback(context, false) : undefined;
    if (!preserveFeedback) takeTerminologyFeedback(context);
    const owner: EditorState = {generation: request, context, status: context ? 'loading' : 'blocked', message};
    publish(owner);
    if (!context) return;
    resetBackendCheck();
    void adminService.getTerminologyConfiguration(context).then(profile => {
      if (discardStale(owner)) return;
      takeTerminologyFeedback(context);
      publish({...owner, status: 'ready', draft: profile});
    }).catch(error => {
      if (!discardStale(owner)) publish({...owner, status: 'error', message: safeError(error, false)});
    });
  };

  const reload = () => reloadForGeneration(state.generation);

  useEffect(() => {
    mounted.current = true;
    const changed = () => {
      ++generation.current;
      // An in-flight mutation is not cancelled. Its server result belongs only
      // to the original context and cannot restore a draft or success here.
      publish({generation: generation.current, context: null, status: 'blocked'});
    };
    const checkAccess = () => {
      const owner = live.current;
      if (owner.context && !isOrganizationProfileContextCurrent(owner.context)) changed();
    };
    window.addEventListener('workos:organization-scope-switch-requested', changed);
    window.addEventListener('workos:organization-scope-changed', checkAccess);
    window.addEventListener('storage', checkAccess);
    window.addEventListener('focus', checkAccess);
    // StrictMode replays mount effects with the original render closure.
    // Start from the live generation internally; UI callbacks remain leased.
    reloadForGeneration(live.current.generation, true);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', changed);
      window.removeEventListener('workos:organization-scope-changed', checkAccess);
      window.removeEventListener('storage', checkAccess);
      window.removeEventListener('focus', checkAccess);
    };
  }, []);

  const edit = (key: TerminologyKey | 'effectiveFrom', field: keyof TerminologyValue | null, value: string) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.status !== 'ready' || !owner.draft || !current(owner)) return;
    const draft = key === 'effectiveFrom' ? {...owner.draft, effectiveFrom: value}
      : {...owner.draft, terms: {...owner.draft.terms, [key]: {...owner.draft.terms[key], [field!]: value}}};
    publish({...owner, draft, message: undefined});
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const owner = live.current;
    // Lock synchronously, before the first await or React rerender. Retained
    // callbacks carry their render generation, not permission to use a new draft.
    if (owner.generation !== state.generation || owner.status !== 'ready' || !owner.draft || !current(owner)) return;
    publish({...owner, status: 'saving', message: undefined});
    try {
      const profile = await adminService.saveTerminologyConfiguration({...owner.draft}, owner.context);
      if (discardStale(owner)) return;
      publish({...owner, status: 'ready', draft: profile, message: takeTerminologyFeedback(owner.context, false)});
    } catch (error) {
      if (discardStale(owner)) return;
      const knownRejection = error instanceof ApiClientError && [400, 409].includes(error.status);
      publish({...owner, status: knownRejection ? 'ready' : 'error', message: safeError(error, true)});
    }
  };

  const owned = state.context && current(state);
  const visibleDraft = owned && ['ready', 'saving'].includes(state.status) ? state.draft : undefined;
  return <div className="mx-auto max-w-5xl pb-12">
    <PageHeader title="Terminology configuration" subtitle="Configure organization-wide labels without changing canonical data keys." breadcrumb={['System', 'Terminology']} />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <Link className="font-semibold underline focus-visible:outline focus-visible:outline-2" to="/admin">Governance Settings</Link>
      <button type="button" className={buttonClass} onClick={reload} disabled={Boolean(owned && state.status === 'saving')}>Reload terminology</button>
    </div>
    <p className="mb-5 text-sm text-slate-600">Terms apply across this organization's legal entities. These previews do not change the live interface until you explicitly save. Canonical keys, permissions, routes and export filenames stay unchanged. This does not configure branding or production email templates.</p>
    {(state.status === 'blocked' || (state.context && !owned)) && <p role="alert" className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4">Scope or access changed. Draft cleared. Reload terminology with settings-management access and a selected organization and legal entity. An already submitted save may still complete in its original scope.</p>}
    {owned && state.status === 'loading' && <p role="status">Loading terminology…</p>}
    {owned && state.message && <p role={state.status === 'ready' && /^Terminology (saved|scheduled)/.test(state.message) ? 'status' : 'alert'} className="mb-5 rounded-xl border border-slate-300 p-4">{state.message}</p>}
    {visibleDraft && <form onSubmit={save} aria-label="Terminology configuration editor" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <fieldset disabled={state.status === 'saving'}>
        <legend className="mb-4 text-lg font-bold">Approved domain terms</legend>
        <div className="grid min-w-0 gap-5 md:grid-cols-2">
          {TERMINOLOGY_KEYS.map(key => <section key={key} className="min-w-0 rounded-xl border border-slate-200 p-4" aria-labelledby={`term-${key}`}>
            <h2 id={`term-${key}`} className="font-bold">Canonical key: {key}</h2>
            {(['singular', 'plural', 'helpText'] as const).map(name => <div key={name} className="mt-3 text-sm font-semibold">
              <label htmlFor={`term-${key}-${name}`}>{key} {name === 'helpText' ? 'help text' : name}</label>
              {name === 'helpText' ? <textarea id={`term-${key}-${name}`} className={inputClass} maxLength={500} value={visibleDraft.terms[key][name]} onChange={event => edit(key, name, event.target.value)} />
                : <input id={`term-${key}-${name}`} className={inputClass} required pattern={'.*\\S.*'} maxLength={100} value={visibleDraft.terms[key][name]} onChange={event => edit(key, name, event.target.value)} />}
            </div>)}
          </section>)}
        </div>
        <label className="mt-5 block text-sm font-semibold" htmlFor="terminology-effective-from">Effective from</label>
        <input id="terminology-effective-from" className={inputClass} type="date" required value={visibleDraft.effectiveFrom} onChange={event => edit('effectiveFrom', null, event.target.value)} />
        <p className="mt-4 text-sm text-slate-600">Reload reads currently effective terms, not a future scheduled version. Same-date saves replace that version, so the last save wins. Earlier dates can conflict with a newer scheduled version. This is not an edit lock. Future labels require a runtime reload or navigation on or after their date; no midnight activation timer is provided.</p>
        <button className={`${buttonClass} mt-5 bg-primary text-white`} type="submit">{state.status === 'saving' ? 'Saving terminology…' : 'Save terminology'}</button>
      </fieldset>
      <section className="mt-6 rounded-xl bg-slate-50 p-4" aria-labelledby="terminology-preview-title">
        <h2 id="terminology-preview-title" className="font-bold">Representative previews, not live changes</h2>
        <p className="mt-3 break-words" data-testid="navigation-preview">Navigation: {visibleDraft.terms.employee.plural} · {visibleDraft.terms.project.plural}</p>
        <p className="mt-2 break-words" data-testid="form-preview">Form: {visibleDraft.terms.project.singular} name · {visibleDraft.terms.manager.singular}</p>
        <p className="mt-2 break-words" data-testid="report-preview">Report: {visibleDraft.terms.worklog.plural} · {visibleDraft.terms.engagement.plural}</p>
        <p className="mt-2 whitespace-pre-wrap break-words" data-testid="help-preview">Help: {visibleDraft.terms.employee.helpText || '(No help text)'}</p>
      </section>
    </form>}
  </div>;
};
