import {useMemo, useState} from 'react';
import {ArrowUpRight, CircleAlert, ClipboardCheck, Search, Users} from 'lucide-react';
import {buildOperationalAttention, filterOperationalAttention, type AttentionCategory, type AttentionItem} from '../lib/operationalAttention';
import type {OperationalPage} from '../services/operationalControl';

const categories = [
  {key: 'all', label: 'All attention'},
  {key: 'approvals', label: 'Pending reviews'},
  {key: 'staffing', label: 'Staffing signals'},
  {key: 'data', label: 'Data gaps'},
] as const;
const categoryLabel: Record<AttentionCategory, string> = {approvals: 'Pending review', staffing: 'Staffing signal', data: 'Data gap'};
const sourceLabel = {actual: 'Inspect actual source', forecast: 'Inspect forecast source', approval: 'Open source review'};
const pageSize = 8;

export function OperationalAttentionPanel({page, onOpen}: {page: OperationalPage; onOpen: (item: AttentionItem) => void; key?: string}) {
  const [category, setCategory] = useState<AttentionCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(pageSize);
  const {items, summary} = useMemo(() => buildOperationalAttention(page), [page]);
  const filtered = useMemo(() => filterOperationalAttention(items, category, query), [items, category, query]);
  const shown = filtered.slice(0, visible);
  const reset = () => {setCategory('all'); setQuery(''); setVisible(pageSize);};
  const stats = [
    {label: 'Workers with attention', value: `${summary.workersWithAttention} / ${summary.pageWorkers}`, Icon: Users},
    {label: 'Visible pending stages', value: summary.visiblePendingStages, Icon: ClipboardCheck},
    {label: 'Workers with staffing signals', value: summary.workersByCategory.staffing, Icon: Users},
    {label: 'Workers with data gaps', value: summary.workersByCategory.data, Icon: CircleAlert},
  ];

  return <section aria-label="Operational attention" className="my-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="border-b border-slate-200 bg-slate-50 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-heading">Current page only</p><h2 className="mt-1 text-xl font-semibold text-slate-900">What needs attention</h2><p className="mt-2 max-w-3xl text-sm text-slate-600">Find pending reviews, configured staffing signals and missing source data. Open the original source before acting.</p></div>
        <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600">Observed snapshot, not live</span>
      </div>
      <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({label, value, Icon}) => <div key={label} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4"><dt className="flex items-center gap-2 text-sm text-slate-600"><Icon aria-hidden="true" size={16}/>{label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{value}</dd></div>)}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-slate-600">Counts cover only these {summary.pageWorkers} workers and their returned sources, not the entire roster. Categories may overlap. No company totals or approval authority are inferred.</p>
      {summary.pendingSourcesIncomplete && <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Some review sources are limited, unavailable or restricted. Visible pending stages are not a complete count; hidden counts are unknown.</p>}
    </div>
    <div className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div aria-label="Attention categories" className="flex flex-wrap gap-2">{categories.map(({key, label}) => <button key={key} type="button" aria-pressed={category === key} onClick={() => {setCategory(key); setVisible(pageSize);}} className={`rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-heading ${category === key ? 'border-heading bg-heading text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>{label} <span className="ml-1 tabular-nums">{key === 'all' ? items.length : summary.itemsByCategory[key]}</span></button>)}</div>
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-heading sm:max-w-sm"><Search aria-hidden="true" size={16} className="shrink-0 text-slate-500"/><span className="sr-only">Search current-page attention</span><input type="search" value={query} onChange={e => {setQuery(e.target.value); setVisible(pageSize);}} placeholder="Worker, code or source detail" className="min-w-0 w-full bg-transparent text-sm outline-none"/></label>
      </div>
      <p role="status" aria-live="polite" className="my-4 text-sm text-slate-600">Showing {shown.length} of {filtered.length} matching attention items on this page.</p>
      {items.length === 0 ? <div className="rounded-xl border border-slate-200 bg-slate-50 p-5"><h3 className="font-semibold text-slate-900">No attention signals in the returned sources</h3><p className="mt-1 text-sm text-slate-600">This is not a claim that all work is complete or that other pages and scopes are clear. Inspect worker evidence below for source detail.</p></div> : filtered.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 p-5"><p>No attention items match these filters.</p><button type="button" onClick={reset} className="mt-2 text-sm font-medium text-heading underline">Clear attention filters</button></div> : <ol className="space-y-3">
        {shown.map(item => <li key={item.key}><article aria-label={`${categoryLabel[item.category]} for ${item.worker.code}: ${item.title}`} className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0"><span className={`text-xs font-semibold uppercase tracking-wide ${item.category === 'data' ? 'text-amber-800' : item.category === 'approvals' ? 'text-heading' : 'text-slate-600'}`}>{categoryLabel[item.category]}</span><h3 className="mt-1 break-words font-semibold text-slate-900">{item.title}</h3><p className="mt-1 break-words text-sm font-medium text-slate-700">{item.worker.name} · {item.worker.code}</p><p className="mt-2 break-words text-sm leading-relaxed text-slate-600">{item.detail}</p></div>
          {item.target && <button type="button" onClick={() => onOpen(item)} aria-label={`${sourceLabel[item.target]} for ${item.worker.code}: ${item.title}${item.approval ? ` ${item.approval.id} stage ${item.approval.stage + 1}` : ""}`} className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-heading">{sourceLabel[item.target]}<ArrowUpRight size={16} aria-hidden="true"/></button>}
        </article></li>)}
      </ol>}
      {shown.length < filtered.length && <button type="button" onClick={() => setVisible(count => count + pageSize)} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700">Show more attention items ({filtered.length - shown.length} remaining)</button>}
      <p className="mt-4 text-xs leading-relaxed text-slate-500">Data gaps appear first, then pending reviews oldest first, then staffing signals. Age is measured at observation, not an overdue or SLA verdict. Staffing bands use existing configured thresholds in native percentage units, never converted hours. Recorded assignment endings do not imply an unstaffed worker.</p>
    </div>
  </section>;
}
