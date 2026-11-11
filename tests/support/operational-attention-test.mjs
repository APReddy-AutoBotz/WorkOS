// Synthetic responses only. No database fixture is executed.
import {createHash} from 'node:crypto';
import {calculateActualWork} from '../../shared/actual-work.mjs';
import {calculateNativeForecast} from '../../shared/native-forecast.mjs';
import {actualFixtureCapacity} from './actual-work-test.mjs';
import {OPERATIONAL_KINDS, operationalSelection, operationalConfidence} from '../../shared/operational-control.mjs';

const day = '2026-11-11', observedAt = day + 'T12:00:00.000Z';
const scope = {organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal'};
const user = {id: '11111111-1111-4111-8111-111111111111', employeeId: '11111111-1111-4111-8111-111111111111', userName: 'synthetic-attention-reader', role: 'Admin', permissionRole: 'Admin', permissions: ['employees.view', 'reports.view_utilization', 'projects.view', 'allocations.view', 'approvals.view', 'timesheets.submit']};
const ownerKey = createHash('sha256').update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId])).digest('hex');
const selection = operationalSelection(day, day, day, 1);
const pending = Array.from({length: 5}, (_, i) => ({kind: 'Work', id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`, stage: 0, sourceToken: 'e'.repeat(64), sourceEventId: `synthetic-stage-${i}`, pendingAt: `2026-11-${String(10 - i).padStart(2, '0')}T12:00:00.000Z`, decisionAuthority: 'RequiresFreshReview'}));
function worker(index) {
  const id = `worker-${String(index).padStart(2, '0')}`;
  const capacity = JSON.parse(JSON.stringify(actualFixtureCapacity(day)).replaceAll('synthetic-worker', id));
  const actual = {...calculateActualWork({employeeId: id, startsOn: day, endsOn: day, capacity, rows: [], sourceLimited: index === 1}), sourceToken: 'a'.repeat(64), observedAt, sourceRefs: {capacityToken: capacity.sourceToken, headerCount: 0, entryCount: 0, submissionCount: 0, decisionCount: 0}};
  const nativeCapacity = {status: 'available', eligible: true, totals: {scheduledHoursExact: '8', holidayReductionHoursExact: '0', leaveReductionHoursExact: '0', availableHoursExact: '8', eligibleHoursExact: '8'}, sourceToken: 'c'.repeat(64), reasonCodes: []};
  const forecast = {...calculateNativeForecast({employeeId: id, startsOn: day, endsOn: selection.forecastEndsOn, months: 1, thresholds: index === 1 ? null : {bench: '20', low: '80', high: '100'}, capacities: [nativeCapacity, nativeCapacity], sourceReason: null, assignments: [{id: `assignment-${index}`, projectId: 'synthetic-project', projectCode: 'SYN', projectName: 'Synthetic project', revision: 'd'.repeat(64), versionId: null, sequence: 0, quantityUnit: 'percentage', quantityExact: index === 0 ? '120' : '100', startsOn: day, endsOn: index === 0 ? selection.forecastEndsOn : '2027-01-01', status: 'Active', states: ['included', 'included']}]}), sourceToken: 'f'.repeat(64), observedAt};
  const row = {worker: {id, code: `SYN-${index}`, name: index === 0 ? 'Synthetic Álvaro' : `Synthetic worker ${index}`, status: 'Active'}, actual, forecast, pending: OPERATIONAL_KINDS.map(kind => index === 0 && kind === 'Work' ? {kind, state: 'limited', items: pending} : index === 1 && kind === 'Leave' ? {kind, state: 'not_permitted', items: null} : {kind, state: 'available', items: []}), confidence: []};
  row.confidence = operationalConfidence(row);
  return row;
}
const base = {contractVersion: 'operational-control/1', ...scope, ownerKey, actorUserId: user.id, activeRole: user.role, selection, roster: {totalActive: 11, sourceToken: 'b'.repeat(64), nextAfter: 'worker-09'}, coverage: 'CurrentPage', workers: Array.from({length: 10}, (_, i) => worker(i)), today: day, sourceToken: 'c'.repeat(64), observedAt};
const next = {...base, roster: {...base.roster, nextAfter: null}, workers: [worker(10)], sourceToken: 'd'.repeat(64)};

export {day, scope, user, selection, pending, base, next};
