import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { commercialFixture as f, commercialServerDir } from './commercial-drafting-test.mjs';
import { seedWorkApproval, workApprovalWorkers as workers, readApprovalOwner } from './work-approval-test.mjs';
import { shiftCapacityDate } from '../../shared/worker-capacity.mjs';
export const NOTICE_BASE = '/api/v1/work-approvals/deadlines';
export const noticeDefinition = (identities, mode = 'due') => ({ workerIds: [workers.first], reminderMinutesBeforeDeadline: mode === 'due' ? 2880 : 0, overdueBoundary: 'grace-end', escalationOwner: { userId: identities.second.id, role: 'Admin' }, locale: 'en-GB', templates: [{ key: 'work_period.submission_due', subject: 'Due {{periodCode}}', body: 'Worker {{workerCode}} submit by {{deadlineAt}}; reminder {{reminderAt}}.' }, { key: 'work_period.submission_overdue', subject: 'Overdue {{periodCode}}', body: 'Worker {{workerCode}} deadline {{deadlineAt}}, grace {{graceEndsAt}}.' }] });
export const seedPeriodNotices = async (pool, mode = 'due') => { const x = await seedWorkApproval(pool); await pool.query("update reporting_periods set starts_on=$1,ends_on=$2 where id='synthetic-category-next'", [shiftCapacityDate(x.today, 3), shiftCapacityDate(x.today, 9)]); await pool.query("update reporting_periods set ends_on=$1 where id='synthetic-category-current'", [mode === 'due' ? shiftCapacityDate(x.today, 2) : x.today]); return { ...x, mode, periodId: 'synthetic-category-current', workerId: workers.first }; };
export const configurePeriodNotices = async (request, fx, definition = noticeDefinition(fx.identities, fx.mode)) => { let r = await request('/api/v1/work-capture-policy', { method: 'POST', body: { expectedLatestId: null, effectiveFrom: fx.today, minimumIncrement: '0.25', dailyMaximum: '24', weeklyMaximum: '168', commentRequired: false, submissionDeadline: { anchor: 'weekly-end-date', timezone: 'UTC', daysAfterPeriodEnd: 0, time: '00:00', graceMinutes: 0, lateTreatment: 'warn' } } }); assert.equal(r.status, 201, JSON.stringify(r.body)); const capture = r.body; r = await request(NOTICE_BASE + '/policies', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, fx.identities.manager), expectedLatestId: null, effectiveFrom: fx.today, definition, reason: 'Synthetic explicit period notice timing owner and in-app templates' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { capture, policy: r.body.policy }; };
export const previewPeriodNotice = (request, fx, identity = fx.identities.manager) => request(NOTICE_BASE + '/preview?' + new URLSearchParams({ employeeId: fx.workerId, periodId: fx.periodId }), { identity });
export const evaluatePeriodNotice = async (request, fx, v, requestId = randomUUID(), extra = {}) => request(NOTICE_BASE + '/evaluate', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, fx.identities.manager), employeeId: fx.workerId, periodId: fx.periodId, expectedSourceToken: v.sourceToken, expectedEventKey: v.eventKey, requestId, reason: 'Synthetic explicit deadline evaluation', ...extra } });
export const withPrePeriodNoticeMigrations = async (test) => { const d = await mkdtemp(join(tmpdir(), 'workos-period-notice-upgrade-')); try {
    await mkdir(join(d, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(d, 'schema.sql'));
    for (const name of await readdir(join(commercialServerDir, 'migrations')))
        if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 3)) < 64)
            await copyFile(join(commercialServerDir, 'migrations', name), join(d, 'migrations', name));
    return await test(d);
}
finally {
    await rm(d, { recursive: true, force: true });
} };
