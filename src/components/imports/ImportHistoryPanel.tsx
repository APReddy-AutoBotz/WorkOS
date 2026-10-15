import {useEffect, useRef, useState} from 'react';
import type {ImportExportLog} from '../../types';

const PAGE_SIZE = 8;
const ERROR_PAGE_SIZE = 20;

export const ImportHistoryDetails = ({item}: {item: ImportExportLog}) => {
  const [visibleErrors, setVisibleErrors] = useState(ERROR_PAGE_SIZE);
  const errors = Array.isArray(item.errors) ? item.errors : [];
  return (
    <details className="mt-3 rounded-xl border border-border-light p-3">
      <summary className="cursor-pointer text-xs font-bold text-primary focus-visible:outline focus-visible:outline-2">
        View details for {item.fileName}
      </summary>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs break-words">
        <div><dt className="font-bold">Batch reference</dt><dd>{item.id}</dd></div>
        <div><dt className="font-bold">Channel</dt><dd>{item.channel}</dd></div>
        <div><dt className="font-bold">Processing result</dt><dd>{item.status}: {item.validRows} valid, {item.errorRows} errors, {item.totalRows} total rows</dd></div>
        {item.schemaVersion && <div><dt className="font-bold">Schema version</dt><dd>{item.schemaVersion}</dd></div>}
        {item.schemaVersion && item.dryRun !== undefined && <div><dt className="font-bold">Server-side dry run</dt><dd>{item.dryRun ? 'Yes' : 'No'}</dd></div>}
      </dl>
      {errors.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs text-body/70">Saved row diagnostics. Source identifiers are caller-supplied diagnostics, not verified identities. Row numbers refer to parsed nonblank records.</p>
          <ol className="mt-3 space-y-3" aria-label={`Row diagnostics for ${item.fileName}`}>
            {errors.slice(0, visibleErrors).map((error, index) => (
              <li key={index} className="rounded-lg bg-slate-50 p-3 text-xs break-words">
                <p className="font-bold">Row {Number.isInteger(error?.rowNumber) && error.rowNumber > 0 ? error.rowNumber : 'Unknown'}{typeof error?.field === 'string' && error.field ? ` · ${error.field}` : ''}</p>
                <p className="mt-1">Source identifier: {typeof error?.sourceIdentifier === 'string' ? error.sourceIdentifier : 'Not supplied'}</p>
                <p className="mt-1">{typeof error?.message === 'string' ? error.message : 'Diagnostic details unavailable.'}</p>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-body/60" role="status">Showing {Math.min(visibleErrors, errors.length)} of {errors.length} saved diagnostics</p>
          {visibleErrors < errors.length && <button type="button" className="mt-2 text-xs font-bold text-primary underline" onClick={() => setVisibleErrors(value => value + ERROR_PAGE_SIZE)}>Show more row diagnostics</button>}
        </div>
      ) : <p className="mt-3 text-xs text-body/70">No row-level diagnostics were retained for this operation.</p>}
    </details>
  );
};

export const ImportHistoryPanel = ({
  loadHistory,
  revision = 0,
}: {
  loadHistory: () => Promise<ImportExportLog[]>;
  revision?: number;
}) => {
  const [history, setHistory] = useState<ImportExportLog[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [scopeVersion, setScopeVersion] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    const clearForScopeChange = () => {
      requestVersion.current += 1;
      setHistory([]);
      setStatus('loading');
      setPage(0);
      setScopeVersion(value => value + 1);
    };
    window.addEventListener('workos:organization-scope-changed', clearForScopeChange);
    return () => window.removeEventListener('workos:organization-scope-changed', clearForScopeChange);
  }, []);

  useEffect(() => {
    let active = true;
    const request = ++requestVersion.current;
    setHistory([]);
    setStatus('loading');
    setPage(0);
    void Promise.resolve().then(loadHistory).then(rows => {
      if (!active || request !== requestVersion.current) return;
      setHistory(rows.slice(0, 100));
      setStatus('ready');
    }).catch(() => {
      if (!active || request !== requestVersion.current) return;
      setHistory([]);
      setStatus('error');
    });
    return () => { active = false; };
  }, [loadHistory, revision, retry, scopeVersion]);

  const pageCount = Math.ceil(history.length / PAGE_SIZE);
  return (
    <section className="bg-white border border-border-light rounded-3xl p-8 shadow-sm" aria-labelledby="import-history-title">
      <h3 id="import-history-title" className="text-sm font-bold text-heading uppercase tracking-widest mb-6">Import / Export History</h3>
      {status === 'loading' && <p role="status" className="text-xs text-body/70">Loading operation history…</p>}
      {status === 'error' && <div role="alert" className="text-xs text-danger">
        <p>Operation history could not be loaded. Check your connection and workspace access, then try again.</p>
        <button type="button" className="mt-3 font-bold underline" onClick={() => setRetry(value => value + 1)}>Retry history</button>
      </div>}
      {status === 'ready' && history.length === 0 && <p className="p-4 bg-slate-50 rounded-2xl text-xs text-body/60">No bulk data operations have been run yet in this workspace.</p>}
      {status === 'ready' && history.length > 0 && <>
        <p className="mb-4 text-xs text-body/60">{history.length >= 100 ? 'Latest 100 operations in this workspace.' : `${history.length} recent operations in this workspace.`}</p>
        <ul className="space-y-4">
          {history.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(item => (
            <li key={`${scopeVersion}:${revision}:${retry}:${item.id}`} className="p-4 rounded-2xl border border-border-light">
              <p className="text-xs font-bold text-heading break-words">{item.fileName}</p>
              <p className="mt-1 text-xs text-body/70">{item.operation} · {item.status} · {item.validRows}/{item.totalRows} valid</p>
              <p className="mt-1 text-xs text-body/60">{new Date(item.timestamp).toLocaleString()} by {item.userName}</p>
              <ImportHistoryDetails item={item} />
            </li>
          ))}
        </ul>
        {pageCount > 1 && <nav className="mt-5 flex items-center justify-between gap-3 text-xs" aria-label="Operation history pages">
          <button type="button" className="font-bold text-primary disabled:opacity-40" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button>
          <span role="status">Page {page + 1} of {pageCount}</span>
          <button type="button" className="font-bold text-primary disabled:opacity-40" disabled={page + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next</button>
        </nav>}
      </>}
    </section>
  );
};
