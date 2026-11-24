import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {PageHeader} from '../components/ui/PageHeader';
import {adminService} from '../services/api';
import {ApiClientError, resetBackendCheck} from '../services/apiClient';
import {captureOrganizationProfileContext, isOrganizationProfileContextCurrent, type OrganizationProfileContext} from '../services/organizationProfileScope';
import type {OrganizationProfile, OrganizationSetupReadiness} from '../types';

type EditorState = {
  generation: number;
  context: OrganizationProfileContext | null;
  status: 'loading' | 'ready' | 'saving' | 'blocked' | 'error';
  draft?: OrganizationProfile;
  message?: string;
};
type ReadinessState = {status: 'loading' | 'ready' | 'error'; value?: OrganizationSetupReadiness};
const buttonClass = 'rounded-xl border border-slate-300 px-4 py-2 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
const inputClass = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-3 text-heading focus-visible:outline focus-visible:outline-2 disabled:bg-slate-100';
const safeError = (error: unknown, saving: boolean) => {
  const status = error instanceof ApiClientError ? error.status : 0;
  if ([401, 403].includes(status)) return 'Organization profile access could not be confirmed. Reload after checking your access.';
  if (saving && status === 400) return 'Profile was not saved. Check the fields and effective date.';
  if (saving && status === 409) return 'Profile was not saved because its effective date conflicts with the latest server version. Reload before making another change.';
  return saving ? 'Save could not be confirmed. Reload profile before trying again.' : 'Organization profile could not be loaded. Check your connection and try again.';
};

export const OrganizationProfileEditor = () => {
  const generation = useRef(0);
  const mounted = useRef(false);
  const readinessRequest = useRef(0);
  const initial: EditorState = {generation: 0, context: null, status: 'loading'};
  const [state, setState] = useState<EditorState>(initial);
  const live = useRef<EditorState>(initial);
  const [readiness, setReadiness] = useState<ReadinessState>({status: 'loading'});
  const publish = (next: EditorState) => { live.current = next; setState(next); };
  const current = (owner: EditorState) => mounted.current && owner.generation === generation.current
    && Boolean(owner.context && isOrganizationProfileContextCurrent(owner.context));

  const discardStale = (owner: EditorState) => {
    if (current(owner)) return false;
    if (mounted.current && owner.generation === generation.current) {
      ++generation.current;
      ++readinessRequest.current;
      publish({generation: generation.current, context: null, status: 'blocked'});
      setReadiness({status: 'loading'});
    }
    return true;
  };

  const refreshReadiness = (owner: EditorState) => {
    const request = ++readinessRequest.current;
    setReadiness({status: 'loading'});
    void adminService.getOrganizationSetupReadinessForProfile(owner.context).then(value => {
      if (discardStale(owner) || request !== readinessRequest.current) return;
      if (value.organizationId !== owner.context!.scope.organizationId
        || value.legalEntityId !== owner.context!.scope.legalEntityId
        || value.authority !== 'persisted-server-state') throw new Error('Readiness scope did not match');
      setReadiness({status: 'ready', value});
    }).catch(() => {
      if (!discardStale(owner) && request === readinessRequest.current) setReadiness({status: 'error'});
    });
  };

  const reloadForGeneration = (renderGeneration: number) => {
    if (!mounted.current || live.current.generation !== renderGeneration || live.current.status === 'saving') return;
    const request = ++generation.current;
    const context = captureOrganizationProfileContext(() => mounted.current && request === generation.current);
    const owner: EditorState = {generation: request, context, status: context ? 'loading' : 'blocked'};
    publish(owner);
    ++readinessRequest.current;
    setReadiness({status: 'loading'});
    if (!context) return;
    resetBackendCheck();
    refreshReadiness(owner);
    void adminService.getOrganizationProfile(context).then(profile => {
      if (discardStale(owner)) return;
      if (profile.organizationId !== context.scope.organizationId) throw new Error('Profile scope did not match');
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
      ++readinessRequest.current;
      // An in-flight mutation is not cancelled. Its server result belongs only
      // to the original context and cannot restore a draft or success here.
      publish({generation: generation.current, context: null, status: 'blocked'});
      setReadiness({status: 'loading'});
    };
    const checkAccess = () => {
      const owner = live.current;
      if (owner.context && !isOrganizationProfileContextCurrent(owner.context)) changed();
    };
    window.addEventListener('workos:organization-scope-switch-requested', changed);
    window.addEventListener('workos:organization-scope-changed', changed);
    window.addEventListener('storage', checkAccess);
    window.addEventListener('focus', checkAccess);
    // StrictMode replays mount effects with the original render closure.
    // Start from the live generation internally; UI callbacks remain leased.
    reloadForGeneration(live.current.generation);
    return () => {
      mounted.current = false;
      ++generation.current;
      ++readinessRequest.current;
      window.removeEventListener('workos:organization-scope-switch-requested', changed);
      window.removeEventListener('workos:organization-scope-changed', changed);
      window.removeEventListener('storage', checkAccess);
      window.removeEventListener('focus', checkAccess);
    };
  }, []);

  const edit = (field: keyof OrganizationProfile, value: string | number | NonNullable<OrganizationProfile['branding']>) => {
    const owner = live.current;
    if (owner.generation !== state.generation || owner.status !== 'ready' || !owner.draft || !current(owner)) return;
    publish({...owner, draft: {...owner.draft, [field]: value}, message: undefined});
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const owner = live.current;
    // Lock synchronously, before the first await or React rerender. Retained
    // callbacks carry their render generation, not permission to use a new draft.
    if (owner.generation !== state.generation || owner.status !== 'ready' || !owner.draft || !current(owner)) return;
    publish({...owner, status: 'saving', message: undefined});
    try {
      const profile = await adminService.updateOrganizationProfile({...owner.draft}, owner.context);
      if (discardStale(owner)) return;
      if (profile.organizationId !== owner.context!.scope.organizationId) throw new Error('Saved profile scope did not match');
      publish({...owner, status: 'ready', draft: profile, message: profile.effectiveFrom > new Date().toISOString().slice(0, 10)
        ? `Organization profile scheduled for ${profile.effectiveFrom}.` : 'Organization profile saved.'});
      refreshReadiness(owner);
    } catch (error) {
      if (discardStale(owner)) return;
      const knownRejection = error instanceof ApiClientError && [400, 409].includes(error.status);
      publish({...owner, status: knownRejection ? 'ready' : 'error', message: safeError(error, true)});
    }
  };

  const owned = state.context && current(state);
  const visibleDraft = owned && ['ready', 'saving'].includes(state.status) ? state.draft : undefined;
  const field = (name: keyof OrganizationProfile, label: string, options: {maxLength?: number; pattern?: string; type?: string} = {}) => <label className="block min-w-0 text-sm font-semibold text-heading" key={name}>
    {label}<input className={inputClass} name={name} value={String(visibleDraft?.[name] ?? '')} required {...options}
      onChange={event => edit(name, event.target.value)} />
  </label>;

  return <div className="mx-auto max-w-4xl pb-12">
    <PageHeader title="Organization profile" subtitle="Maintain ordinary company metadata for the selected organization." breadcrumb={['System', 'Organization profile']} />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <Link className="font-semibold underline focus-visible:outline focus-visible:outline-2" to="/admin">Governance Settings</Link>
      <button type="button" className={buttonClass} onClick={reload} disabled={Boolean(owned && state.status === 'saving')}>Reload profile</button>
    </div>
    <p className="mb-5 text-sm text-slate-600">Organization settings and branding apply across its legal entities from the effective date.</p>
    {(state.status === 'blocked' || (state.context && !owned)) && <p role="alert" className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4">Scope or access changed. Draft cleared. Reload profile with settings-management access and a selected organization and legal entity. An already submitted save may still complete in its original scope.</p>}
    {owned && state.status === 'loading' && <p role="status">Loading organization profile…</p>}
    {owned && state.message && <p role={state.status === 'ready' && /^Organization profile (saved|scheduled)/.test(state.message) ? 'status' : 'alert'} className="mb-5 rounded-xl border border-slate-300 p-4">{state.message}</p>}
    {visibleDraft && <form onSubmit={save} aria-label="Organization profile editor" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <fieldset disabled={state.status === 'saving'}>
        <legend className="mb-4 text-lg font-bold">Profile details</legend>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          <label className="block min-w-0 text-sm font-semibold">Organization ID<input className={inputClass} value={visibleDraft.organizationId} readOnly /></label>
          <label className="block min-w-0 text-sm font-semibold">Organization code<input className={inputClass} value={visibleDraft.code} readOnly /></label>
          {field('name', 'Organization name', {maxLength: 150})}
          {field('legalName', 'Legal name', {maxLength: 200})}
          {field('productDisplayName', 'Product display name', {maxLength: 150})}
          {field('supportContact', 'Support contact', {maxLength: 254})}
          {field('defaultLocale', 'Default locale', {maxLength: 35})}
          {field('defaultTimeZone', 'Default timezone', {maxLength: 80})}
          {field('baseCurrency', 'Base currency', {maxLength: 3, pattern: '[A-Z]{3}'})}
          {field('fiscalYearStart', 'Fiscal year start', {pattern: '[0-9]{2}-[0-9]{2}'})}
          <div className="min-w-0 text-sm font-semibold"><label htmlFor="profile-week-start">Week start day</label><select id="profile-week-start" name="defaultWeekStart" className={inputClass} value={visibleDraft.defaultWeekStart} onChange={event => edit('defaultWeekStart', Number(event.target.value))}>
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select></div>
          {field('effectiveFrom', 'Effective from', {type: 'date'})}
        </div>
        <fieldset id="branding" className="mt-6 grid gap-4 md:grid-cols-2">
          <legend className="font-semibold text-heading">Branding</legend>
          <p className="md:col-span-2 text-sm text-slate-600">Use image paths hosted by your deployment. Accent colors must have at least 4.5:1 contrast against white.</p>
          {([['logoUrl','Logo path'],['compactMarkUrl','Compact mark path'],['faviconUrl','Favicon path'],
            ['primaryAccent','Primary accent'],['secondaryAccent','Secondary accent'],
            ['emailBrand','Email branding label'],['reportBrand','Report branding label']] as const).map(([key,label]) =>
            <label key={key} className="text-sm font-semibold">{label}
              <input className={inputClass} value={visibleDraft.branding?.[key] ?? ''}
                placeholder={key.endsWith('Url') ? '/brand/asset.svg' : key.endsWith('Accent') ? '#003761' : undefined}
                onChange={event => {
                  const next = {...visibleDraft.branding};
                  if (event.target.value) next[key] = event.target.value;
                  else delete next[key];
                  edit('branding',next);
                }} />
            </label>)}
          <div className="md:col-span-2 rounded-lg border p-4" aria-label="Brand preview"
            style={{borderColor:visibleDraft.branding?.primaryAccent,color:visibleDraft.branding?.secondaryAccent}}>
            {visibleDraft.branding?.logoUrl && /^\/(?!\/)[a-zA-Z0-9_./-]+\.(?:svg|png|jpe?g|webp|gif|ico)$/i.test(visibleDraft.branding.logoUrl) &&
              !visibleDraft.branding.logoUrl.split('/').some(part => part === '.' || part === '..') &&
              <img src={visibleDraft.branding.logoUrl} alt="" className="mb-2 h-8" />}
            <strong>{visibleDraft.productDisplayName}</strong> · {visibleDraft.name}
          </div>
        </fieldset>
        <p className="mt-5 text-sm text-slate-600">Use an effective date on or after the latest saved version. Saving on the same date updates that version; earlier dates can conflict. Reload returns the currently effective profile, not a future scheduled version.</p>
        <button className={`${buttonClass} mt-5 bg-primary text-white`} type="submit">{state.status === 'saving' ? 'Saving profile…' : 'Save profile'}</button>
      </fieldset>
    </form>}
    {owned && <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" aria-labelledby="profile-readiness-title">
      <h2 id="profile-readiness-title" className="text-lg font-bold">Organization setup readiness</h2>
      <p className="mt-1 text-sm text-slate-600">Separate server-derived checks for the selected organization and legal entity. Saving a profile does not mark other sections complete.</p>
      {readiness.status === 'loading' && <p role="status" className="mt-3">Loading setup readiness…</p>}
      {readiness.status === 'error' && <p role="status" className="mt-3">Setup readiness could not be loaded. Profile editing is independent.</p>}
      {readiness.status === 'ready' && readiness.value && <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {Object.entries(readiness.value.checks).map(([key, complete]) => <div className="rounded-lg border border-slate-200 p-3" key={key}>
          <dt className="capitalize">{key.replaceAll('_', ' ')}</dt><dd className="font-semibold">{complete ? 'Configured' : 'Required'}</dd>
        </div>)}
      </dl>}
    </section>}
  </div>;
};
