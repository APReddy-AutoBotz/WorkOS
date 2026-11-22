import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const candidates='/api/v1/rate-candidates', approvals='/api/v1/commercial-candidate-approvals', adoptions='/api/v1/approved-rate-sources';
const keys=['approval.action_required','approval.rejected_or_correction_required','approval.completed'];
const ok=(response,status=200)=>{assert.equal(response.status,status,JSON.stringify(response.body));return response.body;};
export async function adoptHourlyRate({request,ids,contractId,workerId,today,end,currency,effectiveFrom=today},kind,amount,priority=1) {
  const bindingType = kind === 'billing' ? 'contract' : 'worker',
    bindingId = kind === 'billing' ? contractId : workerId,
    candidate = ok(
      await request(candidates + '/candidates', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          streamId: randomUUID(),
          expectedLatestId: null,
          kind,
          bindingType,
          bindingId,
          effectiveFrom,
          effectiveTo: end,
          currency,
          unit: 'HOUR',
          amount,
          priority,
          reason: 'Synthetic governed source',
        },
      }),
      201,
    ).candidate,
    owner = ok(
      await request(candidates + '/owners', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          candidateId: candidate.id,
          expectedOwnerEventId: null,
          ownerUserId: ids.manager.id,
          ownerRole: 'Admin',
          reason: 'Synthetic rate owner',
        },
      }),
      201,
    ),
    definition = {
      entityType: 'CommercialCandidate',
      kind,
      candidateId: candidate.id,
      stages: [{ userId: ids.second.id, role: 'Admin' }],
      locale: 'en-US',
      templates: keys.map((key) => ({
        key,
        subject: 'Review {{stageNumber}}',
        body: 'Source {{sourceRef}}',
      })),
      completionInApp: false,
    },
    policy = ok(
      await request(approvals + '/policies', {
        method: 'POST',
        body: {
          expectedOwnerKey: owner.ownerKey,
          requestId: randomUUID(),
          expectedLatestId: null,
          effectiveFrom: today,
          definition,
          reason: 'Synthetic rate policy',
        },
      }),
      201,
    ).policy,
    approval = ok(
      await request(approvals + '/requests', {
        method: 'POST',
        body: {
          expectedOwnerKey: owner.ownerKey,
          requestId: randomUUID(),
          candidateId: candidate.id,
          expectedOwnerEventId: owner.owner.id,
          expectedPolicyId: policy.id,
          reason: 'Synthetic review',
        },
      }),
      201,
    ).approval,
    actor = ok(await request(approvals + '/instances/' + approval.id, { identity: ids.second }));
  ok(
    await request(approvals + '/instances/' + approval.id + '/decisions', {
      method: 'POST',
      identity: ids.second,
      body: {
        expectedOwnerKey: actor.ownerKey,
        requestId: randomUUID(),
        expectedCandidateId: candidate.id,
        expectedOwnerEventId: owner.owner.id,
        expectedPolicyId: policy.id,
        expectedSequence: 0,
        decision: 'Approved',
        reason: 'Synthetic source review',
      },
    }),
    201,
  );
  const inspected = ok(await request(adoptions + '/candidates/' + candidate.id)),
    r = inspected.reviews[0];
  return ok(
    await request(adoptions + '/adoptions', {
      method: 'POST',
      body: {
        expectedOwnerKey: inspected.ownerKey,
        requestId: randomUUID(),
        candidateId: candidate.id,
        expectedOwnerEventId: r.ownerEventId,
        approvalId: r.approvalId,
        expectedPolicyId: r.policyId,
        expectedFinalTransitionId: r.finalTransitionId,
        reason: 'Synthetic source adoption',
      },
    }),
    201,
  ).adoption;
}
