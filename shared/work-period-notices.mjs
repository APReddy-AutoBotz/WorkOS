import { approvalKeys, approvalText, approvalUuid, approvalRecipients } from './work-approval.mjs';
import { compareCapabilityIds } from './workforce-capabilities.mjs';
export const PERIOD_NOTICE_VERSION = 'work-period-notice/1';
export const PERIOD_NOTICE_KEYS = ['work_period.submission_due', 'work_period.submission_overdue'];
export const PERIOD_NOTICE_VARIABLES = ['workerCode', 'periodCode', 'deadlineAt', 'graceEndsAt', 'reminderAt'];
export const validPeriodNoticeTemplate = t => approvalKeys(t, ['key', 'subject', 'body']) && PERIOD_NOTICE_KEYS.includes(t.key) && approvalText(t.subject, 200) && approvalText(t.body, 8000) && [t.subject, t.body].every(s => { let ok = true; const left = s.replace(/\{\{([a-zA-Z]+)\}\}/g, (_m, k) => { if (!PERIOD_NOTICE_VARIABLES.includes(k))
    ok = false; return ''; }); return ok && !/[{}]/.test(left); });
export const PERIOD_NOTICE_VALUE_LIMITS=Object.freeze({workerCode:200,periodCode:200,deadlineAt:40,graceEndsAt:40,reminderAt:40});
export const PERIOD_NOTICE_RENDER_LIMITS=Object.freeze({title:1200,body:12000});
const boundedRender=(template,values)=>{if(!approvalKeys(values,PERIOD_NOTICE_VARIABLES)||PERIOD_NOTICE_VARIABLES.some(k=>!approvalText(values[k],PERIOD_NOTICE_VALUE_LIMITS[k])))throw new RangeError('Notice operating values exceed the supported source contract.');const render=s=>s.replace(/\{\{([a-zA-Z]+)\}\}/g,(_m,k)=>values[k]),out={title:render(template.subject),body:render(template.body)};if(!approvalText(out.title,PERIOD_NOTICE_RENDER_LIMITS.title)||!approvalText(out.body,PERIOD_NOTICE_RENDER_LIMITS.body))throw new RangeError('Rendered notice exceeds the supported in-app contract.');return out;};
const templateFits=t=>{try{boundedRender(t,Object.fromEntries(PERIOD_NOTICE_VARIABLES.map(k=>[k,'x'.repeat(PERIOD_NOTICE_VALUE_LIMITS[k])])));return true;}catch{return false;}};
export const validPeriodNoticeDefinition = d => { try {
    return approvalKeys(d, ['workerIds', 'reminderMinutesBeforeDeadline', 'overdueBoundary', 'escalationOwner', 'locale', 'templates']) && Array.isArray(d.workerIds) && d.workerIds.length <= 200 && d.workerIds.every((x, i) => approvalText(x) && (!i || compareCapabilityIds(d.workerIds[i - 1], x) < 0)) && Number.isInteger(d.reminderMinutesBeforeDeadline) && d.reminderMinutesBeforeDeadline >= 0 && d.reminderMinutesBeforeDeadline <= 527040 && ['deadline', 'grace-end'].includes(d.overdueBoundary) && approvalKeys(d.escalationOwner, ['userId', 'role']) && approvalUuid(d.escalationOwner.userId) && approvalText(d.escalationOwner.role, 100) && approvalText(d.locale,100) && Intl.getCanonicalLocales(d.locale)[0] === d.locale && Array.isArray(d.templates) && d.templates.length === 2 && d.templates.every(validPeriodNoticeTemplate) && d.templates.every(templateFits) && new Set(d.templates.map(x => x.key)).size === 2;
}
catch {
    return false;
} };
export const periodNoticePhase = (timing, definition, periodStartsOn, now) => { if (!validPeriodNoticeDefinition(definition))
    throw TypeError('Explicit period notice definition required.'); const deadline = Date.parse(timing.deadlineAt), grace = Date.parse(timing.graceEndsAt), instant = Date.parse(now), start = Date.parse(periodStartsOn + 'T00:00:00Z'); if (![deadline, grace, instant, start].every(Number.isFinite) || grace < deadline)
    throw TypeError('Valid retained UTC timing required.'); const reminder = deadline - definition.reminderMinutesBeforeDeadline * 60000, overdue = definition.overdueBoundary === 'deadline' ? deadline : grace; return { reminderAt: new Date(reminder).toISOString(), overdueAt: new Date(overdue).toISOString(), state: reminder < start ? 'unavailable' : instant > overdue ? 'overdue' : instant >= reminder ? 'due' : 'not_due', eventKey: reminder < start ? null : instant > overdue ? PERIOD_NOTICE_KEYS[1] : instant >= reminder ? PERIOD_NOTICE_KEYS[0] : null }; };
export const periodNoticeRecipients = (workerId, ownerId, key) => { if (!approvalUuid(workerId) || !PERIOD_NOTICE_KEYS.includes(key) || key === PERIOD_NOTICE_KEYS[1] && !approvalUuid(ownerId))
    throw TypeError('Required authoritative notice identities unavailable.'); const rows = [{ userId: workerId, reason: 'affected_worker' }]; if (key === PERIOD_NOTICE_KEYS[1])
    rows.push({ userId: ownerId, reason: 'requester' }); return approvalRecipients(rows).map(r => ({ ...r, reasons: r.reasons.map(x => x === 'requester' ? 'configured_escalation_owner' : x).sort() })); };
export const periodNoticeIdentity = (sourceVersion, key, operationId) => { if (!/^[a-f0-9]{64}$/.test(sourceVersion) || !PERIOD_NOTICE_KEYS.includes(key) || !approvalText(operationId))
    throw TypeError('Canonical notice identity unavailable.'); return `work-period/${sourceVersion}/${key}/${encodeURIComponent(operationId)}`; };
export const renderPeriodNotice=(template,values)=>{if(!validPeriodNoticeTemplate(template))throw TypeError('Invalid period notice template.');return boundedRender(template,values);};
