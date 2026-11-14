import {useEffect, useRef, useState} from 'react';
import {ApiClientError} from '../services/apiClient';
import {isProjectContributionContextCurrent, type ProjectContributionContext, type ProjectContributionResult} from '../services/projectContribution';
import {projectContributionEvidenceService as service, type ProjectEvidence, type ProjectRetentionIntent} from '../services/projectContributionEvidence';

export const ProjectContributionExport = ({result, context, onPendingChange, onAccessDenied}: {result: ProjectContributionResult; context: ProjectContributionContext; onPendingChange: (pending: boolean) => void; onAccessDenied: () => void; key?: string}) => {
  const [reason, setReason] = useState(''), [message, setMessage] = useState('');
  const [pending, setPending] = useState<ProjectRetentionIntent | null>(null), pendingRef = useRef<ProjectRetentionIntent | null>(null);
  const [saved, setSaved] = useState<ProjectEvidence | null>(null), [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [history, setHistory] = useState<ProjectEvidence[] | null>(null), [nextBefore, setNextBefore] = useState<string | null>(null);
  const mounted = useRef(false), generation = useRef(0);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; generation.current++;};}, []);
  const selection = {projectId: result.projectId, startsOn: result.startsOn, endsOn: result.endsOn};
  const active = () => mounted.current && isProjectContributionContextCurrent(context);
  const begin = () => {
    if (busyRef.current || !active()) return null;
    busyRef.current = true; setBusy(true); setMessage('');
    const current = ++generation.current;
    return {...context, isCurrent: () => active() && generation.current === current};
  };
  const end = () => {busyRef.current = false; if (mounted.current) setBusy(false);};
  const track = (intent: ProjectRetentionIntent | null) => {pendingRef.current = intent; setPending(intent); onPendingChange(Boolean(intent));};
  const denied = (error: unknown) => {if (error instanceof ApiClientError && [401, 403].includes(error.status)) {onAccessDenied(); return true;} return false;};
  const retain = async (original?: ProjectRetentionIntent) => {
    if (!original && (pendingRef.current || !reason.trim())) return;
    const captured = begin(); if (!captured) return;
    const intent = original ?? {requestId: crypto.randomUUID(), expectedSourceToken: result.sourceToken, reason: reason.trim()};
    track(intent);
    try {
      const response = await service.retain(selection, intent, captured);
      if (!active()) return;
      setSaved(response.evidence); track(null); setMessage('Report retained. Download its verified CSV when ready.');
    } catch (error) {
      if (!active()) return;
      if (denied(error)) return;
      if (error instanceof ApiClientError && error.status === 409 && error.code === 'PROJECT_EVIDENCE_SOURCE_CHANGED') {
        track(null); setMessage('Sources changed before retention. Reload the contribution before saving another report.');
      } else setMessage('Retention is not confirmed. Reconcile the original request before changing the period or creating another report.');
    } finally {end();}
  };
  const reconcile = async () => {
    const intent = pendingRef.current; if (!intent) return;
    const captured = begin(); if (!captured) return;
    try {
      const response = await service.reconcile(selection, intent, captured);
      if (!active()) return;
      setSaved(response); track(null); setMessage('The original report is confirmed. No new report was created.');
    } catch (error) {
      if (active() && !denied(error)) setMessage('The original report is not confirmed yet. A missing receipt may still be in flight. Keep this request and reconcile again or explicitly retry the same request.');
    } finally {end();}
  };
  const loadHistory = async (before: string | null) => {
    const captured = begin(); if (!captured) return;
    setHistory(null); setNextBefore(null);
    try {
      const response = await service.history(selection, before, captured);
      if (!active()) return;
      setHistory(response.evidence); setNextBefore(response.nextBefore);
    } catch (error) {if (active() && !denied(error)) setMessage('Retained history could not be loaded. Retry explicitly; unavailable history is not an empty history.');}
    finally {end();}
  };
  const download = async (evidence: ProjectEvidence) => {
    const captured = begin(); if (!captured) return;
    try {
      const response = await service.artifact(selection, evidence, captured);
      if (!active()) return;
      const url = URL.createObjectURL(new Blob([response.csv], {type: 'text/csv;charset=utf-8'}));
      const link = document.createElement('a'); link.href = url; link.download = response.evidence.artifact.fileName;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Verified retained CSV downloaded.');
    } catch (error) {if (active() && !denied(error)) setMessage('The retained CSV could not be verified or accessed. No download was produced.');}
    finally {end();}
  };
  if (!context.canExport) return null;
  return <section aria-label="Retained contribution exports" className="border-t pt-4 space-y-3">
    <h3 className="font-semibold">Retained report exports</h3>
    <p className="text-sm text-body/70">Retain this observation with its exact controls and source reference. Later changes do not rewrite saved reports. Every download checks your current access.</p>
    <label className="block text-sm">Retention reason<textarea aria-label="Report retention reason" className="block w-full border rounded p-2 mt-1" maxLength={1000} value={reason} disabled={busy || Boolean(pending)} onChange={event => setReason(event.target.value)}/></label>
    <div className="flex flex-wrap gap-3">
      <button type="button" className="btn-primary px-3 py-2" disabled={busy || Boolean(pending) || !reason.trim()} onClick={() => void retain()}>Retain report for export</button>
      <button type="button" className="border rounded px-3 py-2" disabled={busy} onClick={() => void loadHistory(null)}>Load retained report history</button>
    </div>
    {pending && <div className="rounded border p-3 space-y-2"><p role="status">An original retention request remains unresolved. Period changes and new report saves are blocked until it is reconciled.</p><div className="flex flex-wrap gap-3">
      <button type="button" className="border rounded px-3 py-2" disabled={busy} onClick={() => void reconcile()}>Reconcile original report request</button>
      <button type="button" className="border rounded px-3 py-2" disabled={busy} onClick={() => void retain(pending)}>Retry same report request</button>
    </div></div>}
    {busy && <p role="status">Checking retained report…</p>}
    {message && <p role="status">{message}</p>}
    {saved && <div className="rounded border p-3"><p>Confirmed report · {saved.createdAt} · {saved.reason}</p><button type="button" className="border rounded px-3 py-2 mt-2" disabled={busy} onClick={() => void download(saved)}>Download confirmed report CSV</button></div>}
    {history && <div className="space-y-2"><h4 className="font-medium">Retained reports for this period</h4>{history.length === 0 ? <p>No retained reports are visible for this period.</p> : <ul className="space-y-2">{history.map(row => <li key={row.id} className="rounded border p-3"><p>{row.createdAt} · {row.result.status} · {row.reason}</p><button type="button" className="border rounded px-3 py-2 mt-2" disabled={busy} onClick={() => void download(row)}>Download retained CSV</button></li>)}</ul>}
      {nextBefore && <button type="button" className="border rounded px-3 py-2" disabled={busy} onClick={() => void loadHistory(nextBefore)}>Older retained reports</button>}
    </div>}
  </section>;
};
