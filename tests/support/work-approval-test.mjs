import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commercialFixture as f, commercialServerDir } from './commercial-drafting-test.mjs';
import { seedActualWork, adoptActualInputs } from './actual-work-test.mjs';
import { compareCapabilityIds } from '../../shared/workforce-capabilities.mjs';
export const WORK_APPROVAL_BASE = '/api/v1/work-approvals';
export const workApprovalWorkers = { first: 'synthetic-staged-first', correction: 'synthetic-staged-correction', locked: 'synthetic-staged-locked', optional: 'synthetic-staged-optional', legacyImport: 'synthetic-staged-import-legacy', versionedImport: 'synthetic-staged-import-versioned' };
export const withPreWorkApprovalMigrations = async (test) => { const d = await mkdtemp(join(tmpdir(), 'workos-staged-work-upgrade-')); try {
    await mkdir(join(d, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(d, 'schema.sql'));
    for (const name of await readdir(join(commercialServerDir, 'migrations')))
        if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 3)) < 63)
            await copyFile(join(commercialServerDir, 'migrations', name), join(d, 'migrations', name));
    return await test(d);
}
finally {
    await rm(d, { recursive: true, force: true });
} };
export const seedWorkApproval = async (pool) => {
    const fixture = await seedActualWork(pool), { identities } = fixture;
    await pool.query("insert into role_permissions(role_name,permission_key,enabled)select 'Admin',k,true from unnest($1::text[])k on conflict(role_name,permission_key)do update set enabled=true", [['permissions.manage', 'notifications.manage', 'notifications.view']]);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Employee','notifications.view',true)on conflict(role_name,permission_key)do update set enabled=true");
    const account = async (key, role, workerId = null) => { const id = randomUUID(), username = 'synthetic-staged-' + key; await pool.query("insert into users(id,username,email,status,employee_record_id,employee_id)values($1,$2,$3,'Active',$4,$5)", [id, username, username + '@example.test', workerId, workerId]); await pool.query('insert into user_roles(user_id,role_id)select $1,id from roles where name=$2', [id, role]); await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)', [id, f.organizationId, f.legalEntityId]); return { id, username, role, ...(workerId ? { employeeRecordId: workerId, employeeId: workerId } : {}) }; };
    identities.second = await account('second-approver', 'Admin');
    identities.requester = await account('requester', 'Admin');
    for (const [key, id] of Object.entries(workApprovalWorkers)) {
        await pool.query("insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)values($1,$1,$2,$3,'Consultant','Delivery','US','director-commercial','Active',$4,$5)", [id, 'Synthetic staged ' + key, id + '@example.test', f.organizationId, f.legalEntityId]);
        identities[key] = await account(key, 'Employee', id);
    }
    return fixture;
};
export const stagedDefinition = identities => ({ entityType: 'Timesheet', workerIds: [f.ownerId, ...Object.values(workApprovalWorkers)].sort(compareCapabilityIds), stages: [{ userId: identities.manager.id, role: 'Admin' }, { userId: identities.second.id, role: 'Admin' }], locale: 'en-GB', completionInApp: true, templates: [{ key: 'approval.action_required', subject: 'Review {{sourceRef}}', body: 'Worker {{workerCode}} needs stage {{stageNumber}}.' }, { key: 'approval.rejected_or_correction_required', subject: 'Correct {{sourceRef}}', body: 'Worker {{workerCode}}: {{decisionReason}}' }, { key: 'approval.completed', subject: 'Completed {{sourceRef}}', body: 'Worker {{workerCode}} completed stage {{stageNumber}}.' }] });
export const readApprovalOwner = async (request, identity) => { const r = await request(WORK_APPROVAL_BASE + '/inbox', { identity }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.ownerKey, /^[a-f0-9]{64}$/); return r.body.ownerKey; };
export const adoptStagedPolicy = async (request, identities, today, definition = stagedDefinition(identities)) => { const ownerKey = await readApprovalOwner(request, identities.manager), r = await request(WORK_APPROVAL_BASE + '/policies', { method: 'POST', body: { expectedOwnerKey: ownerKey, expectedLatestId: null, effectiveFrom: today, definition, reason: 'Synthetic explicit selected work routing and in-app templates' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.policy; };
export const stagedWorkEntries = (today, hours = '1.25') => [{ work_type: 'Non-client Work', category_code: 'CAT0', work_date: today, hours, billable: false, remark: 'Synthetic staged operational work' }];
export const submitStagedWork = async (request, identity, today, extra = {}) => { const id = identity.employeeRecordId, body = { employee_id: id, week_ending: today, status: 'Submitted', entries: stagedWorkEntries(today), ...extra }, r = await request('/api/timesheets', { method: 'POST', identity, body }); assert.equal(r.status, 200, JSON.stringify(r.body)); const list = await request(WORK_APPROVAL_BASE + '/instances?timesheetId=' + r.body.id, { identity }); assert.equal(list.status, 200, JSON.stringify(list.body)); return { source: r.body, instance: [...list.body.instances].sort((a, b) => a.submissionSequence - b.submissionSequence).at(-1), instances: list.body.instances, ownerKey: list.body.ownerKey }; };
export const prepareStagedWork = async (request, identities, today) => { for (const id of Object.values(workApprovalWorkers))
    await adoptActualInputs(request, today, id); };
