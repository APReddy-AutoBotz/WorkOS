import assert from 'node:assert/strict';
import test from 'node:test';
import {buildOperationalAttention, filterOperationalAttention} from '../src/lib/operationalAttention.ts';

// Synthetic presentation fixtures. API shape/scope validation remains the decoder's job.
const pending = (id = 'review-1', pendingAt = '2026-11-08T12:00:00.000Z') => ({kind:'Work',id,stage:1,sourceToken:'source-token',sourceEventId:'event-1',pendingAt,decisionAuthority:'RequiresFreshReview'});
const worker = (id = 'worker-1') => ({worker:{id,code:id,name:'Élodie 東京',status:'Active'},actual:{status:'available'},forecast:{status:'available',thresholds:{bench:'10',low:'40',high:'150'},points:[{date:'2026-11-11',status:'available',declaredPercentageExact:'120',band:'within'}],assignments:[],endings:[]},pending:[{kind:'Work',state:'available',items:[]}]});
const page = (workers = []) => ({coverage:'CurrentPage',workers,today:'2026-11-11',observedAt:'2026-11-11T12:00:00.000Z',roster:{totalActive:500,nextAfter:'later'},sourceToken:'snapshot'});
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze);Object.freeze(value); } return value; };

test('empty page and normal/native-within rows produce no inferred signals', () => {
  assert.deepEqual(buildOperationalAttention(page()).summary,{pageWorkers:0,workersWithAttention:0,itemsByCategory:{approvals:0,staffing:0,data:0},workersByCategory:{approvals:0,staffing:0,data:0},visiblePendingStages:0,pendingSourcesIncomplete:false});
  assert.equal(buildOperationalAttention(page([worker()])).items.length,0);
});
test('not applicable is not missing data or zero utilization', () => {
  const row=worker();row.actual.status='not_applicable';row.forecast.status='not_applicable';row.forecast.points=[{date:'2026-11-11',status:'not_applicable',band:null,declaredPercentageExact:null}];
  assert.deepEqual(buildOperationalAttention(page([row])).items,[]);
});
test('limited, unavailable and restricted are visible without hidden-count inference', () => {
  const row=worker();row.actual.status='unavailable';row.forecast.status='unavailable';
  row.pending=[{kind:'Work',state:'limited',items:[pending()]},{kind:'Leave',state:'unavailable',items:null},{kind:'Creation',state:'not_permitted',items:null}];
  const result=buildOperationalAttention(page([row]));
  assert.equal(result.summary.itemsByCategory.data,5);assert.equal(result.summary.visiblePendingStages,1);assert.equal(result.summary.pendingSourcesIncomplete,true);
  assert.equal(result.summary.pageWorkers,1);assert.equal(result.summary.workersByCategory.data,1);
  assert.equal(result.items.filter(x=>x.category==='data'&&x.target===null).length,3);
  assert.equal(result.items.find(x=>x.title.includes('restricted')).detail.includes('No pending count can be inferred'),true);
});
test('age uses snapshot time, floors whole days and preserves exact approval handoff', () => {
  const row=worker();const original=pending();row.pending[0].items=[original,pending('future','2026-11-12T12:00:00.000Z'),pending('partial','2026-11-10T13:00:00.000Z')];
  const {items}=buildOperationalAttention(page([row]));
  assert.deepEqual(items.map(x=>x.approval.id),['review-1','partial','future']);
  assert.deepEqual(items.map(x=>x.pendingDays),[3,0,0]);assert.strictEqual(items[0].approval,original);assert.strictEqual(items[0].row,row);assert.strictEqual(items[0].worker,row.worker);
  assert.equal(items[2].detail.includes('after this snapshot'),true);assert.equal(items[0].target,'approval');
});
test('uses existing native bands, not hardcoded 100 percent or invented thresholds', () => {
  const row=worker();row.forecast.points.push({date:'2026-12-11',status:'available',declaredPercentageExact:'160',band:'overload'},{date:'2027-01-11',status:'available',declaredPercentageExact:'8',band:'bench'},{date:'2027-02-11',status:'available',declaredPercentageExact:'20',band:'underload'});
  const result=buildOperationalAttention(page([row]));assert.equal(result.items.length,3);assert.equal(result.items.some(x=>x.detail.includes('120%')),false);assert.ok(result.items.every(x=>x.target==='forecast'));
  row.forecast.thresholds=null;assert.equal(buildOperationalAttention(page([row])).items.length,0);
});
test('unavailable points are never classified; known points survive incomplete aggregate', () => {
  const row=worker();row.forecast.status='unavailable';row.forecast.points=[{date:'2026-11-11',status:'unavailable',band:null,declaredPercentageExact:null},{date:'2026-12-11',status:'available',band:'bench',declaredPercentageExact:'8'}];
  const result=buildOperationalAttention(page([row]));assert.equal(result.summary.itemsByCategory.data,1);assert.equal(result.summary.itemsByCategory.staffing,1);assert.ok(result.items.every(x=>!x.detail.includes('null%')));
});
test('recorded endings include today and future, not elapsed endings or invented gaps', () => {
  const row=worker();row.forecast.endings=[{assignmentId:'old',endsOn:'2026-11-10'},{assignmentId:'today',endsOn:'2026-11-11'},{assignmentId:'future',endsOn:'2026-12-01'}];row.forecast.assignments=[{id:'future',projectCode:'DEMO',projectName:'Synthetic project'}];
  const {items}=buildOperationalAttention(page([row]));assert.equal(items.length,2);assert.ok(items.some(x=>x.detail.includes('DEMO · Synthetic project')));assert.ok(items.every(x=>x.detail.includes('not a confirmed future staffing gap')));
});
test('summaries count unique current-page workers, not company roster totals', () => {
  const a=worker('a'),b=worker('b');a.actual.status='unavailable';a.pending[0].items=[pending(),pending('second')];b.actual.status='unavailable';
  const {summary}=buildOperationalAttention(page([a,b]));assert.equal(summary.pageWorkers,2);assert.equal(summary.workersWithAttention,2);assert.equal(summary.workersByCategory.approvals,1);assert.equal(summary.visiblePendingStages,2);
  assert.throws(()=>buildOperationalAttention(page([a,a])),/unique workers/);
});
test('Unicode visible-text search and category filters never search hidden source tokens', () => {
  const row=worker();row.pending[0].items=[pending()];row.actual.status='unavailable';const {items}=buildOperationalAttention(page([row]));
  assert.equal(filterOperationalAttention(items,'all','E\u0301LODIE').length,2);assert.equal(filterOperationalAttention(items,'approvals','東京').length,1);assert.equal(filterOperationalAttention(items,'data','WORKER-1').length,1);assert.equal(filterOperationalAttention(items,'all','source-token').length,0);assert.equal(filterOperationalAttention(items,'all','whole').length,1);
});
test('stable ties and keys, no source mutation, fresh output and no cross-page retention', () => {
  const a=worker('a'),b=worker('b');a.pending[0].items=[pending('second'),pending('first')];b.pending[0].items=[pending()];const source=freeze(page([b,a]));const before=JSON.stringify(source);
  const one=buildOperationalAttention(source),two=buildOperationalAttention({...source,workers:[a,b]});assert.deepEqual(one.items.map(x=>x.key),two.items.map(x=>x.key));assert.equal(new Set(one.items.map(x=>x.key)).size,3);assert.equal(JSON.stringify(source),before);
  const filtered=filterOperationalAttention(one.items);assert.notStrictEqual(filtered,one.items);assert.equal(buildOperationalAttention(page()).items.length,0);
});
