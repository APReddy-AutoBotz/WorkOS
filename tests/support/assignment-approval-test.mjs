import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedWorkApproval, readApprovalOwner, stagedDefinition } from './work-approval-test.mjs';
import { commercialFixture as f, commercialServerDir } from './commercial-drafting-test.mjs';
export const ASSIGNMENT_APPROVAL_BASE = '/api/v1/work-approvals/assignments';
export const assignmentApprovalDefinition = identities => ({ ...stagedDefinition(identities), entityType: 'Assignment', workerIds: [f.ownerId], materialFields: ['billable', 'endsOn', 'quantityExact', 'role', 'startsOn', 'status'] });
export const seedAssignmentApproval = seedWorkApproval;
export const withPreAssignmentApprovalMigrations = async (test) => { const d = await mkdtemp(join(tmpdir(), 'workos-assignment-approval-upgrade-')); try {
    await mkdir(join(d, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(d, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
        if (/^\d{3}[a-z]?_.*\.sql$/.test(n) && Number(n.slice(0, 3)) < 65)
            await copyFile(join(commercialServerDir, 'migrations', n), join(d, 'migrations', n));
    return await test(d);
}
finally {
    await rm(d, { recursive: true, force: true });
} };
export const adoptAssignmentApproval = async (request, fx, definition = assignmentApprovalDefinition(fx.identities)) => {
    const r = await request(ASSIGNMENT_APPROVAL_BASE + '/policies', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, fx.identities.manager), expectedLatestId: null, effectiveFrom: fx.today, definition, reason: 'Synthetic explicit material assignment policy' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.policy;
};
export const createApprovalAssignment = async (request, fx) => {
    const r = await request('/api/allocations', { method: 'POST', identity: fx.identities.requester, body: { employee_id: f.ownerId, project_id: f.projectId, role_on_project: 'Synthetic proposed role', percentage: 20, start_date: fx.today, end_date: fx.today, billable: false, status: 'Active', comments: 'Synthetic effective source' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
};
export const getAssignmentApprovalSource = async (request, id, identity) => { const r = await request(ASSIGNMENT_APPROVAL_BASE + '/sources/' + id, { identity }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r; };
export const proposeAssignment = async (request, fx, source, extra = {}, requestId = randomUUID()) => {
    const { assignmentId: _id, employeeId: _worker, projectId: _project, ...d } = source.snapshot;
    return request(ASSIGNMENT_APPROVAL_BASE + '/sources/' + source.assignmentId + '/proposals', { method: 'POST', identity: fx.identities.requester, body: { expectedOwnerKey: await readApprovalOwner(request, fx.identities.requester), expectedRevision: source.revision, expectedLatestId: source.versionId, definition: { ...d, quantityExact: '25' }, requestId, reason: 'Synthetic material proposal', ...extra } });
};
export const decideAssignment = async (request, identity, instance, decision = 'Approved', extra = {}, requestId = randomUUID()) => request(ASSIGNMENT_APPROVAL_BASE + '/instances/' + instance.id + '/decisions', { method: 'POST', identity, body: { expectedOwnerKey: await readApprovalOwner(request, identity), expectedSourceToken: instance.sourceToken, expectedSequence: instance.state.sequence, requestId, decision, reason: 'Synthetic named assignment decision', ...extra } });
