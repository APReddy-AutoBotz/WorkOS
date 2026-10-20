import {useEffect, useRef, useState} from 'react';
import {Link} from 'react-router-dom';
import {PageHeader} from '../components/ui/PageHeader';
import {resetBackendCheck} from '../services/apiClient';
import {CALENDAR_ROW_CAP, captureCalendarReadContext, isCalendarReadContextCurrent, workingCalendarInspectorService,
  type CalendarReadContext, type WorkingCalendar, type WorkingCalendarHoliday} from '../services/workingCalendarInspector';

type State = {
  generation: number; context: CalendarReadContext | null; list: 'loading' | 'ready' | 'error' | 'blocked';
  calendars: WorkingCalendar[]; selectedId: string | null; selection: number;
  detail: 'idle' | 'loading' | 'ready' | 'error'; holidays: WorkingCalendarHoliday[];
};
const buttonClass = 'rounded-xl border border-slate-300 px-4 py-2 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const bounds = (item: {effectiveFrom: string; effectiveTo: string | null}) => `${item.effectiveFrom} to ${item.effectiveTo || 'no saved end date'}`;
const applicability = (calendar: WorkingCalendar) => calendar.applicabilityType === 'legal_entity'
  ? `Legal entity: ${calendar.legalEntityId}` : calendar.applicabilityType === 'country'
    ? `Country: ${calendar.countryCode}` : `Worker-group version-row ID: ${calendar.workerGroupId}`;

export const WorkingCalendarInspector = () => {
  const generation = useRef(0);
  const mounted = useRef(false);
  const initial: State = {generation: 0, context: null, list: 'loading', calendars: [], selectedId: null, selection: 0, detail: 'idle', holidays: []};
  const [state, setState] = useState(initial);
  const live = useRef(initial);
  const publish = (next: State) => {live.current = next; setState(next);};
  const current = (owner: State) => mounted.current && owner.generation === generation.current
    && Boolean(owner.context && isCalendarReadContextCurrent(owner.context));
  const invalidate = () => {
    ++generation.current;
    publish({...initial, generation: generation.current, list: 'blocked'});
  };
  const discardStale = (owner: State) => {
    if (current(owner)) return false;
    if (mounted.current && owner.generation === generation.current) invalidate();
    return true;
  };
  const reloadForGeneration = (renderGeneration: number, renderSelection: number, mounting = false) => {
    if (!mounted.current || live.current.generation !== renderGeneration || live.current.selection !== renderSelection) return;
    if (!mounting && live.current.context && discardStale(live.current)) return;
    const request = ++generation.current;
    const context = captureCalendarReadContext(() => mounted.current && request === generation.current);
    const owner: State = {...initial, generation: request, context, list: context ? 'loading' : 'blocked'};
    publish(owner);
    if (!context) return;
    resetBackendCheck();
    void workingCalendarInspectorService.getCalendars(context).then(calendars => {
      if (!discardStale(owner)) publish({...owner, list: 'ready', calendars});
    }).catch(() => {
      if (!discardStale(owner)) publish({...owner, list: 'error'});
    });
  };
  const select = (id: string, retry = false) => {
    const owner = live.current;
    // Every callback leases the rendered request AND selection. Retained
    // callbacks cannot issue reads for a replacement context or selection.
    if (owner.generation !== state.generation || owner.selection !== state.selection || owner.list !== 'ready') return;
    if (discardStale(owner) || !owner.calendars.some(calendar => calendar.id === id)) return;
    if (retry && (owner.selectedId !== id || owner.detail !== 'error')) return;
    if (!retry && owner.selectedId === id) return;
    const next: State = {...owner, selectedId: id, selection: owner.selection + 1, detail: 'loading', holidays: []};
    publish(next);
    if (retry) resetBackendCheck();
    const ownsSelection = () => !discardStale(next) && live.current.selectedId === id && live.current.selection === next.selection;
    const context: CalendarReadContext = {...owner.context!, isCurrent: () => Boolean(owner.context?.isCurrent()
      && live.current.selectedId === id && live.current.selection === next.selection)};
    void workingCalendarInspectorService.getHolidays(id, context).then(holidays => {
      if (ownsSelection()) publish({...next, detail: 'ready', holidays});
    }).catch(() => {
      if (ownsSelection()) publish({...next, detail: 'error'});
    });
  };
  useEffect(() => {
    mounted.current = true;
    const checkAccess = () => {
      const owner = live.current;
      if (owner.context && !isCalendarReadContextCurrent(owner.context)) invalidate();
    };
    window.addEventListener('workos:organization-scope-switch-requested', invalidate);
    window.addEventListener('workos:organization-scope-changed', checkAccess);
    window.addEventListener('storage', checkAccess);
    window.addEventListener('focus', checkAccess);
    reloadForGeneration(live.current.generation, live.current.selection, true);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', invalidate);
      window.removeEventListener('workos:organization-scope-changed', checkAccess);
      window.removeEventListener('storage', checkAccess);
      window.removeEventListener('focus', checkAccess);
    };
  }, []);
  const owned = state.context && current(state);
  const selected = owned && state.list === 'ready' ? state.calendars.find(calendar => calendar.id === state.selectedId) : undefined;
  return <div className="mx-auto max-w-6xl pb-12">
    <PageHeader title="Working calendars" subtitle="Inspect saved calendar configuration and holiday authority for the selected scope." breadcrumb={['System', 'Working calendars']} />
    <div className="mb-5 flex flex-wrap justify-between gap-3">
      <Link className="font-semibold underline focus-visible:outline focus-visible:outline-2" to="/admin">Governance Settings</Link>
      <button type="button" className={buttonClass} onClick={() => reloadForGeneration(state.generation, state.selection)}>Reload calendars</button>
    </div>
    <p className="mb-4 text-sm text-slate-600">Read-only configuration snapshot. This does not assign calendars, select a winning calendar for a worker, or calculate capacity or legacy utilization. Worker groups are shown by their saved version-row ID, not an inferred name or lineage.</p>
    {(state.list === 'blocked' || (state.context && !owned)) && <p role="alert" className="rounded-xl border border-amber-300 p-4">Scope or access changed. Calendar results cleared. Reload with settings-management access and a selected organization and legal entity.</p>}
    {owned && <p className="mb-4 break-words text-sm">Snapshot effective date: <strong>{state.context!.asOf}</strong>. Organization: {state.context!.scope.organizationId}. Legal entity: {state.context!.scope.legalEntityId}. Reload captures the current date again. Historical and future exploration is not included.</p>}
    {owned && state.list === 'loading' && <p role="status">Loading calendars…</p>}
    {owned && state.list === 'error' && <div role="alert" className="rounded-xl border border-amber-300 p-4">
      <p>Calendars could not be loaded or confirmed. No calendar results are available.</p>
      <button type="button" className={`${buttonClass} mt-3`} onClick={() => reloadForGeneration(state.generation, state.selection)}>Retry calendars</button>
    </div>}
    {owned && state.list === 'ready' && <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      <section aria-labelledby="calendar-list-title" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 id="calendar-list-title" className="text-lg font-bold">Returned calendars ({state.calendars.length})</h2>
        <p className="my-2 text-sm text-slate-600">Effective versions returned for this selected scope and date. Active and inactive flags are persisted values, not a worker assignment.</p>
        {state.calendars.length === 0 && <p role="status">No calendars returned for this scope and snapshot. This is not an exhaustive absence claim.</p>}
        {state.calendars.length === CALENDAR_ROW_CAP && <p role="status" className="my-3 rounded-lg bg-amber-50 p-3">The 200-calendar response limit was reached. Additional matching calendars may exist; this list is not exhaustive.</p>}
        <ul className="space-y-3">{state.calendars.map(calendar => <li key={calendar.id} className="min-w-0 rounded-xl border border-slate-200 p-3">
          <h3 className="break-words font-bold">{calendar.name}</h3>
          <p className="break-words text-sm">Code: {calendar.code}. Status: {calendar.active ? 'Active' : 'Inactive'}.</p>
          <p className="break-words text-sm">{applicability(calendar)}</p>
          <button type="button" className={`${buttonClass} mt-2`} aria-pressed={state.selectedId === calendar.id} onClick={() => select(calendar.id)}>Inspect {calendar.code}</button>
        </li>)}</ul>
      </section>
      <section aria-labelledby="calendar-detail-title" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 id="calendar-detail-title" className="text-lg font-bold">Calendar details and holidays</h2>
        {!selected && <p className="mt-3">Select a returned calendar to load its holiday authority.</p>}
        {selected && <>
          <h3 className="mt-4 break-words font-bold">{selected.name}</h3>
          <dl className="my-4 space-y-2 break-words text-sm">
            {Object.entries({'Code': selected.code, 'Calendar version-row ID': selected.id, 'Applicability': applicability(selected),
              ...(selected.countryAuthorityLegalEntityId ? {'Country authority legal entity': selected.countryAuthorityLegalEntityId} : {}),
              'Time zone': selected.timezone, 'Working weekdays': selected.workingDays.map(day => weekdays[day]).join(', '),
              'Standard hours per working day': String(selected.hoursPerDay), 'Effective bounds (inclusive)': bounds(selected),
              'Saved status': selected.active ? 'Active' : 'Inactive'}).map(([label, value]) => <div key={label}><dt className="font-semibold">{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <h3 className="font-bold">Holiday authority</h3>
          <p className="mt-1 text-sm text-slate-600">Holiday versions effective on the same snapshot date. A holiday date is a saved calendar date, not a time-zone instant; dates may fall outside the current year.</p>
          {state.detail === 'loading' && <p role="status" className="mt-3">Loading holidays…</p>}
          {state.detail === 'error' && <div role="alert" className="mt-3 rounded-xl border border-amber-300 p-3">
            <p>Holidays could not be loaded or confirmed. Calendar details remain available.</p>
            <button type="button" className={`${buttonClass} mt-3`} onClick={() => select(selected.id, true)}>Retry holidays</button>
          </div>}
          {state.detail === 'ready' && <>
            {state.holidays.length === 0 && <p role="status" className="mt-3">No holidays returned for this calendar and snapshot. This is not an exhaustive absence claim.</p>}
            {state.holidays.length === CALENDAR_ROW_CAP && <p role="status" className="my-3 rounded-lg bg-amber-50 p-3">The 200-holiday response limit was reached. Additional matching holidays may exist; this list is not exhaustive.</p>}
            <ul className="mt-3 space-y-3">{state.holidays.map(holiday => <li key={holiday.id} className="break-words rounded-lg border border-slate-200 p-3 text-sm">
              <p className="font-bold">{holiday.holidayDate}: {holiday.label}</p>
              <p>{holiday.holidayType}. Status: {holiday.active ? 'Active' : 'Inactive'}.</p>
              <p>Effective bounds (inclusive): {bounds(holiday)}.</p>
            </li>)}</ul>
          </>}
        </>}
      </section>
    </div>}
  </div>;
};
