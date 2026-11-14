import {useEffect, useRef, useState} from 'react';
import {validCapacityRange} from '../../shared/worker-capacity.mjs';
import {ApiClientError} from '../services/apiClient';
import {term, termTitle} from '../config/terminology';
import {ProjectContributionExport} from './ProjectContributionExport';
import {captureProjectContributionContext, isProjectContributionContextCurrent, projectContributionService, type ProjectContributionContext, type ProjectContributionReport} from '../services/projectContribution';

const hours = (value: string | null | undefined) => value == null ? 'Unavailable' : `${value}h`;
const percentage = (value: ProjectContributionReport['result']) => value.percentage ? `${value.percentage.displayPercent}%` : value.status === 'not_applicable' ? 'Not applicable' : 'Unavailable';

export const ProjectContribution = ({projectId}: {projectId: string; key?: string}) => <ProjectContributionView key={projectId} projectId={projectId}/>;
const ProjectContributionView = ({projectId}: {projectId: string; key?: string}) => {
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [report, setReport] = useState<ProjectContributionReport | null>(null);
  const [retentionPending, setRetentionPending] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'denied'>('idle');
  const generation = useRef(0), mounted = useRef(false), owner = useRef<ProjectContributionContext | null>(null);
  const clear = (next: typeof phase = 'idle') => {generation.current++; owner.current = null; setReport(null); setRetentionPending(false); setPhase(next);};
  useEffect(() => {
    mounted.current = true;
    const block = () => clear('denied');
    const check = () => {if (owner.current && !isProjectContributionContextCurrent(owner.current)) block();};
    window.addEventListener('workos:organization-scope-switch-requested', block);
    window.addEventListener('workos:organization-scope-changed', block);
    window.addEventListener('storage', check);
    window.addEventListener('focus', check);
    return () => {mounted.current = false; generation.current++; window.removeEventListener('workos:organization-scope-switch-requested', block); window.removeEventListener('workos:organization-scope-changed', block); window.removeEventListener('storage', check); window.removeEventListener('focus', check);};
  }, []);
  const load = async () => {
    if (phase === 'loading' || retentionPending || !validCapacityRange(from, to)) return;
    const request = ++generation.current;
    const context = captureProjectContributionContext(() => mounted.current && generation.current === request);
    if (!context) {clear('denied'); return;}
    owner.current = context; setReport(null); setPhase('loading');
    try {
      const result = await projectContributionService.period({projectId, startsOn: from, endsOn: to}, context);
      if (!mounted.current || generation.current !== request) return;
      if (!isProjectContributionContextCurrent(context)) {clear('denied'); return;}
      setReport(result); setPhase('ready');
    } catch (error) {
      if (!mounted.current || generation.current !== request) return;
      setReport(null); setPhase(error instanceof ApiClientError && [401, 403].includes(error.status) ? 'denied' : 'failed');
    }
  };
  if (!captureProjectContributionContext()) return null;
  const projectTerm = term('project'), projectTitle = termTitle('project');
  return <section aria-label={`Governed ${projectTerm} contribution`} className="mt-8 rounded-2xl border border-border-light bg-white p-6 space-y-4">
    <div><h2 className="text-lg font-semibold text-heading">Approved {projectTerm} contribution</h2><p className="text-sm text-body/70 mt-1">Approved included {projectTerm} work divided by the visible cohort’s effective eligible capacity for the entire selected period.</p></div>
    <form className="flex flex-wrap items-end gap-4" onSubmit={event => {event.preventDefault(); void load();}}>
      <label className="text-sm">Period starts<input className="block border rounded px-3 py-2 mt-1" aria-label={`${projectTitle} period starts`} type="date" value={from} disabled={retentionPending} onChange={event => {clear(); setFrom(event.target.value);}}/></label>
      <label className="text-sm">Period ends<input className="block border rounded px-3 py-2 mt-1" aria-label={`${projectTitle} period ends`} type="date" value={to} disabled={retentionPending} onChange={event => {clear(); setTo(event.target.value);}}/></label>
      <button type="submit" className="btn-primary px-4 py-2" disabled={phase === 'loading' || retentionPending || !validCapacityRange(from, to)}>{phase === 'failed' || phase === 'denied' ? `Retry ${projectTerm} contribution` : `Load ${projectTerm} contribution`}</button>
    </form>
    <p className="text-xs text-body/70">Choose up to 366 dates. Each visible worker with a recorded assignment or {projectTerm} work in the period counts once. Capacity covers the full period, including part-time schedules and once-only leave/holiday reductions. This is {projectTerm} contribution, not whole-worker utilization or billing eligibility.</p>
    {phase === 'loading' && <p role="status">Loading {projectTerm} contribution…</p>}
    {phase === 'failed' && <p role="alert">{projectTitle} contribution could not be loaded. Check your connection and retry.</p>}
    {phase === 'denied' && <p role="alert">{projectTitle} reporting access or scope changed. Check your current access before retrying.</p>}
    {report && <article aria-label={`Current ${projectTerm} contribution`} className="space-y-4">
      <p className="text-sm">{report.result.startsOn} – {report.result.endsOn} · Observed {report.result.observedAt}</p>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div><dt className="text-xs text-body/70">Approved {projectTerm} contribution</dt><dd className="text-2xl font-semibold text-primary">{percentage(report.result)}</dd>{report.result.percentage && <p className="text-xs">Rounded display · exact percentage {report.result.percentage.numeratorExact}/{report.result.percentage.denominatorExact}</p>}</div>
        <div><dt className="text-xs text-body/70">Included approved {projectTerm} work</dt><dd className="text-xl">{hours(report.result.includedHoursExact)}</dd></div>
        <div><dt className="text-xs text-body/70">Effective eligible capacity</dt><dd className="text-xl">{hours(report.result.eligibleAvailableHoursExact)}</dd></div>
      </dl>
      {report.result.reasonCodes.length > 0 && <p role="status">{report.result.reasonCodes.includes('NO_VISIBLE_COHORT') ? `No visible workers have an assignment or ${projectTerm} work in this period.` : `Calculation context: ${report.result.reasonCodes.join(', ')}. Unknown inputs are not zero.`}</p>}
      {report.result.controls && <p className="text-sm">Work controls: Draft {report.result.controls.hoursByStatus.Draft}h · Submitted {report.result.controls.hoursByStatus.Submitted}h · Rejected {report.result.controls.hoursByStatus.Rejected}h · Approved {report.result.controls.hoursByStatus.Approved}h. Approved reconciliation: included {report.result.controls.knownIncludedHoursExact}h + excluded {report.result.controls.knownExcludedHoursExact}h + unresolved {report.result.controls.unresolvedApprovedHoursExact}h.</p>}
      {report.result.rows && report.result.rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="text-left font-medium mb-2">Visible worker contribution · {report.result.workerCount} distinct workers</caption><thead><tr><th scope="col">Worker</th><th scope="col">Included approved</th><th scope="col">Eligible capacity</th><th scope="col">Contribution</th><th scope="col">Context</th></tr></thead><tbody>{report.result.rows.map((row, index) => <tr key={row.employeeId} className="border-t"><th scope="row" className="py-3 font-normal">{report.workers[index].name} · {report.workers[index].code}</th><td>{hours(row.includedHoursExact)}</td><td>{hours(row.eligibleAvailableHoursExact)}</td><td>{row.percentage ? `${row.percentage.displayPercent}%` : row.status === 'not_applicable' ? 'Not applicable' : 'Unavailable'}</td><td>{row.reasonCodes.join(', ') || 'Resolved'}</td></tr>)}</tbody></table></div>}
      <p className="text-xs text-body/70">Uses retained category inclusion and matching approved-work evidence. Observation reflects current source records, not a reconstruction of past approval-time state.</p>
      {owner.current && <ProjectContributionExport key={report.result.sourceToken + report.result.observedAt} result={report.result} context={owner.current} onPendingChange={setRetentionPending} onAccessDenied={() => clear('denied')}/>}
    </article>}
  </section>;
};
