import type { OperationalPage, OperationalRow, PendingControl } from '../services/operationalControl';

export type AttentionCategory = 'approvals' | 'staffing' | 'data';
export type AttentionItem = {
  key: string;
  category: AttentionCategory;
  worker: OperationalRow['worker'];
  row: OperationalRow;
  title: string;
  detail: string;
  target: 'actual' | 'forecast' | 'approval' | null;
  approval?: NonNullable<PendingControl['items']>[number];
  pendingDays?: number;
};
export type AttentionSummary = {
  pageWorkers: number;
  workersWithAttention: number;
  itemsByCategory: Record<AttentionCategory, number>;
  workersByCategory: Record<AttentionCategory, number>;
  visiblePendingStages: number;
  pendingSourcesIncomplete: boolean;
};
const categories: AttentionCategory[] = ['data', 'approvals', 'staffing'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Presentation only: accepts a decoded, scope-bound current page, never a raw API response.
 * Retained row/item references are handed back to the existing fresh-source review flows.
 * Counts and elapsed age are not business calculations or approval authority.
 */
export function buildOperationalAttention(page: OperationalPage): { items: AttentionItem[]; summary: AttentionSummary } {
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  let pendingSourcesIncomplete = false;
  for (const row of page.workers) {
    if (seen.has(row.worker.id)) throw new TypeError('Attention requires a decoded page with unique workers.');
    seen.add(row.worker.id);
    const add = (category: AttentionCategory, parts: string[], title: string, detail: string, target: AttentionItem['target'], extra: Partial<Pick<AttentionItem, 'approval' | 'pendingDays'>> = {}) => {
      items.push({key: JSON.stringify([row.worker.id, category, ...parts]), category, worker: row.worker, row, title, detail, target, ...extra});
    };
    if (row.actual.status === 'unavailable') {
      add('data', ['actual'], 'Actual work unavailable', 'Actual work could not be confirmed for the selected period. Open the source for details; unavailable does not mean zero.', 'actual');
    }
    if (row.forecast.status === 'unavailable') {
      add('data', ['forecast'], 'Native forecast unavailable', 'The complete forecast could not be confirmed. Available dated points, if any, remain separate from unknown values.', 'forecast');
    }
    for (const source of row.pending) {
      if (source.state !== 'available') {
        pendingSourcesIncomplete = true;
        const detail = source.state === 'limited'
          ? 'Only the returned pending stages are visible. More may exist; refresh or use the governed review inbox to inspect the source.'
          : source.state === 'not_permitted'
            ? 'Pending stages are not permitted in the current scope. No pending count can be inferred.'
            : 'Pending stages could not be confirmed. No pending count can be inferred.';
        add('data', ['pending', source.kind], `${source.kind} review coverage ${source.state === 'not_permitted' ? 'restricted' : source.state}`, detail, null);
      }
      // Unavailable/restricted sources never contribute a zero or a stage assertion.
      if (source.state !== 'available' && source.state !== 'limited') continue;
      for (const approval of source.items ?? []) {
        const pendingDays = Math.max(0, Math.floor((Date.parse(page.observedAt) - Date.parse(approval.pendingAt)) / 86_400_000));
        const age = Date.parse(approval.pendingAt) > Date.parse(page.observedAt)
          ? 'The recorded pending time is after this snapshot; elapsed age is 0 days.'
          : `${pendingDays} whole ${pendingDays === 1 ? 'day' : 'days'} elapsed at this snapshot.`;
        add('approvals', [approval.kind, approval.id, String(approval.stage)], `${approval.kind} source review pending`, `Source ${approval.id} · stage ${approval.stage + 1}. ${age} Recorded pending time: ${approval.pendingAt}. Fresh source review is required; age is not an SLA assessment.`, 'approval', {approval, pendingDays});
      }
    }
    // Classifications come from the native forecast, never frontend thresholds or hours.
    if (row.forecast.thresholds !== null) {
      for (const point of row.forecast.points) {
        if (point.status !== 'available' || !['overload', 'bench', 'underload'].includes(point.band ?? '')) continue;
        add('staffing', ['band', point.date], `Native forecast: ${point.band}`, `${point.date}: ${point.declaredPercentageExact}% declared assignment quantity. Band uses the source's configured thresholds; it is not physical utilization.`, 'forecast');
      }
    }
    for (const ending of row.forecast.endings ?? []) {
      if (ending.endsOn < page.today) continue;
      const assignment = row.forecast.assignments?.find(item => item.id === ending.assignmentId);
      const label = assignment ? `${assignment.projectCode} · ${assignment.projectName}` : `Assignment ${ending.assignmentId}`;
      add('staffing', ['ending', ending.assignmentId, ending.endsOn], 'Recorded assignment ending', `${label} ends ${ending.endsOn}. This is a recorded ending, not a confirmed future staffing gap.`, 'forecast');
    }
  }
  items.sort((a, b) => categories.indexOf(a.category) - categories.indexOf(b.category)
    || (a.approval && b.approval ? compare(a.approval.pendingAt, b.approval.pendingAt) : 0)
    || compare(a.worker.code, b.worker.code) || compare(a.worker.id, b.worker.id) || compare(a.key, b.key));
  const itemsByCategory = {approvals: 0, staffing: 0, data: 0};
  const workersByCategory = {approvals: 0, staffing: 0, data: 0};
  for (const category of categories) {
    const selected = items.filter(item => item.category === category);
    itemsByCategory[category] = selected.length;
    workersByCategory[category] = new Set(selected.map(item => item.worker.id)).size;
  }
  return {items, summary: {
    pageWorkers: seen.size,
    workersWithAttention: new Set(items.map(item => item.worker.id)).size,
    itemsByCategory, workersByCategory,
    visiblePendingStages: itemsByCategory.approvals,
    pendingSourcesIncomplete,
  }};
}

const searchable = (value: string) => value.normalize('NFKC').toLowerCase();
export function filterOperationalAttention(items: readonly AttentionItem[], category: AttentionCategory | 'all' = 'all', query = ''): AttentionItem[] {
  const search = searchable(query.trim());
  return items.filter(item => (category === 'all' || item.category === category)
    && (!search || searchable([item.worker.name, item.worker.code, item.title, item.detail].join(' ')).includes(search)));
}
