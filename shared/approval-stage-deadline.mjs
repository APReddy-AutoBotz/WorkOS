import {approvalKeys} from './work-approval.mjs';

export function currentStageDeadline(minutes, stage, createdAt, transitions, observedAt) {
  if (minutes === undefined || stage === null) return undefined;
  const startedAt = stage === 0 ? createdAt : transitions[stage - 1].createdAt;
  const dueAt = new Date(new Date(startedAt).getTime() + minutes * 60_000).toISOString();
  const observed = new Date(observedAt).toISOString();
  return {stage, dueAt, observedAt: observed, overdue: dueAt < observed};
}

export function validStageDeadline(value, minutes, stage, createdAt, transitions) {
  if (minutes === undefined || stage === null) return value === undefined;
  if (!approvalKeys(value,['stage','dueAt','observedAt','overdue'])) return false;
  if (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) return false;
  const start = stage === 0 ? createdAt : transitions[stage - 1]?.createdAt;
  if (!start || Date.parse(value.observedAt) < Date.parse(start)) return false;
  const expected = currentStageDeadline(minutes,stage,createdAt,transitions,value.observedAt);
  return value.stage === stage && value.dueAt === expected.dueAt
    && value.observedAt === expected.observedAt && value.overdue === expected.overdue;
}

export function validStageDeliveries(rows,minutes,stages,createdAt,transitions){
  if (rows === undefined) return true;
  if (!Number.isInteger(minutes) || !Array.isArray(rows) || !rows.length || rows.length>stages.length) return false;
  return rows.every((row,i)=>{
    if (!approvalKeys(row,['stage','dueAt','attempts','status']) || !Number.isInteger(row.stage)
        || row.stage<0 || row.stage>=stages.length || (i>0 && row.stage<=rows[i-1].stage)
        || !Number.isInteger(row.attempts) || row.attempts<0) return false;
    const start=row.stage===0?createdAt:transitions[row.stage-1]?.createdAt;
    return start && new Date(Date.parse(start)+minutes*60000).toISOString()===row.dueAt
      && (row.attempts===0 ? row.status==='Pending' : ['Delivered','RecipientUnavailable'].includes(row.status));
  });
}
