import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialFixture as f,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import { seedCapacity } from './support/worker-capacity-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const root = '/api/v1/commercial-candidate-approvals',
  ok = (v, n = 200) => {
    assert.equal(v.status, n, JSON.stringify(v.body));
    return v.body;
  };
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedCapacity(pool),
    admin = fx.identities.manager,
    reviewer = fx.identities.denied;
  for (const k of ['commercial.rate_candidates.view', 'commercial.rate_candidates.manage'])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  for (const k of [
    'commercial.contracts.view',
    'commercial.rate_candidates.view',
    'commercial.rate_approvals.decide',
    'notifications.view',
    'approvals.view',
    'employees.view',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    { databaseUrl, identities: fx.identities, onServerError: (s) => process.stderr.write(s) },
    async ({ request }) => {
      const contract = ok(
        await request('/contracts', {
          method: 'POST',
          body: {
            number: 'SYN-COMMERCIAL-APPROVAL',
            clientId: f.clientId,
            name: 'Synthetic contract',
            model: 'time_and_materials',
            startsOn: fx.today,
            endsOn: shift(fx.today, 90),
            effectiveFrom: fx.today,
            currency: 'USD',
            value: '100.0000',
            billingTerms: 'Synthetic terms',
            documents: [],
            reason: 'Synthetic fixture',
          },
        }),
        201,
      );
      const rate = ok(
        await request('/api/v1/rate-candidates/candidates', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            streamId: randomUUID(),
            expectedLatestId: null,
            kind: 'billing',
            bindingType: 'contract',
            bindingId: contract.id,
            effectiveFrom: fx.today,
            effectiveTo: fx.today,
            currency: 'USD',
            unit: 'HOUR',
            amount: '42.0001',
            priority: 1,
            reason: 'Synthetic confidential candidate',
          },
        }),
        201,
      ).candidate;
      const ownerResponse = ok(
          await request('/api/v1/rate-candidates/owners', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              candidateId: rate.id,
              expectedOwnerEventId: null,
              ownerUserId: admin.id,
              ownerRole: 'Admin',
              reason: 'Synthetic owner',
            },
          }),
          201,
        ),
        owner = ownerResponse.owner;
      const keys = [
          'approval.action_required',
          'approval.rejected_or_correction_required',
          'approval.completed',
        ],
        definition = {
          entityType: 'CommercialCandidate',
          kind: 'billing',
          candidateId: rate.id,
          stages: [{ userId: reviewer.id, role: 'TeamLead' }],
          locale: 'en-US',
          templates: keys.map((key) => ({
            key,
            subject: 'Review {{stageNumber}}',
            body: 'Source {{sourceRef}}',
          })),
          completionInApp: false,
        };
      const polCmd = {
          expectedOwnerKey: ownerResponse.ownerKey,
          requestId: randomUUID(),
          expectedLatestId: null,
          effectiveFrom: fx.today,
          definition,
          reason: 'Synthetic policy',
        },
        policy = ok(await request(root + '/policies', { method: 'POST', body: polCmd }), 201).policy;
      assert.equal(ok(await request(root + '/policies', { method: 'POST', body: polCmd })).replayed, true);
      const reqCmd = {
          expectedOwnerKey: ownerResponse.ownerKey,
          requestId: randomUUID(),
          candidateId: rate.id,
          expectedOwnerEventId: owner.id,
          expectedPolicyId: policy.id,
          reason: 'Synthetic request',
        },
        req = ok(await request(root + '/requests', { method: 'POST', body: reqCmd }), 201).approval;
      assert.equal(req.state.status, 'Pending');
      assert.equal(ok(await request(root + '/requests', { method: 'POST', body: reqCmd })).replayed, true);
      assert.equal(ok(await request(root + '/receipts/request/' + reqCmd.requestId)).approval.id, req.id);
      const inbox = ok(await request('/api/v1/work-approvals/inbox', { identity: reviewer })),
        notice = inbox.notifications.find(
          (n) => n.kind === 'commercial-candidate-approval' && n.instanceId === req.id,
        );
      assert(notice);
      assert.equal(notice.eventKey, 'approval.action_required');
      assert.equal(notice.candidateId, rate.id);
      assert(!JSON.stringify(notice).includes('42.0001'));
      const ack = ok(
        await request('/api/v1/work-approvals/inbox/' + notice.id + '/read', {
          method: 'POST',
          body: { expectedOwnerKey: inbox.ownerKey },
          identity: reviewer,
        }),
      );
      assert(ack.notification.readAt);
      assert.equal(
        (
          await request('/api/v1/work-approvals/inbox/' + notice.id + '/read', {
            method: 'POST',
            body: { expectedOwnerKey: ownerResponse.ownerKey },
            identity: admin,
          })
        ).status,
        404,
      );
      const legacy = ok(await request('/api/approvals'));
      assert(!legacy.some((x) => x.entity_type === 'CommercialCandidateApproval'));
      const compat = (
        await pool.query(
          "select id from approval_records where entity_type='CommercialCandidateApproval' and entity_id=$1",
          [req.id],
        )
      ).rows[0];
      assert.equal(
        (
          await request('/api/approvals/' + compat.id + '/status', {
            method: 'PATCH',
            body: { status: 'Rejected', comments: 'Synthetic' },
          })
        ).status,
        404,
      );
      const actorView = ok(await request(root + '/instances/' + req.id, { identity: reviewer })),
        dec = {
          expectedOwnerKey: actorView.ownerKey,
          requestId: randomUUID(),
          expectedCandidateId: rate.id,
          expectedOwnerEventId: owner.id,
          expectedPolicyId: policy.id,
          expectedSequence: 0,
          decision: 'Rejected',
          reason: 'Synthetic review',
        },
        result = ok(
          await request(root + '/instances/' + req.id + '/decisions', {
            method: 'POST',
            body: dec,
            identity: reviewer,
          }),
          201,
        ).approval;
      assert.equal(result.state.status, 'Rejected');
      assert.equal(
        ok(
          await request(root + '/instances/' + req.id + '/decisions', {
            method: 'POST',
            body: dec,
            identity: reviewer,
          }),
        ).replayed,
        true,
      );
      const managerInbox = ok(await request('/api/v1/work-approvals/inbox', { identity: admin })),
        rejectedNotice = managerInbox.notifications.find(
          (n) =>
            n.kind === 'commercial-candidate-approval' &&
            n.instanceId === req.id &&
            n.eventKey === 'approval.rejected_or_correction_required',
        );
      assert(rejectedNotice);
      assert.deepEqual(rejectedNotice.reasons, ['commercial_change_owner', 'requester']);
      assert(!JSON.stringify(rejectedNotice).includes('42.0001'));
      const rows = (
        await pool.query(
          'select reasons from commercial_candidate_approval_recipients r join commercial_candidate_approval_events e on e.id=r.event_id where e.instance_id=$1 and e.event_key=$2',
          [req.id, 'approval.rejected_or_correction_required'],
        )
      ).rows;
      assert.deepEqual(rows[0].reasons, ['commercial_change_owner', 'requester']);
      assert.equal(rows.length, 1);
      const events = (
        await pool.query('select title,body from commercial_candidate_approval_events where instance_id=$1', [
          req.id,
        ])
      ).rows;
      assert(!JSON.stringify(events).includes('42.0001'));
      assert(!JSON.stringify(events).includes('Synthetic review'));
      for (const k of [
        'commercial.contracts.view',
        'commercial.rate_candidates.view',
        'commercial.rate_approvals.decide',
        'notifications.view',
        'approvals.view',
        'employees.view',
      ])
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled)values('Employee',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
          [k],
        );
      const rate2 = ok(
          await request('/api/v1/rate-candidates/candidates', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              streamId: randomUUID(),
              expectedLatestId: null,
              kind: 'billing',
              bindingType: 'contract',
              bindingId: contract.id,
              effectiveFrom: fx.today,
              effectiveTo: fx.today,
              currency: 'USD',
              unit: 'HOUR',
              amount: '31.0000',
              priority: 2,
              reason: 'Synthetic second candidate',
            },
          }),
          201,
        ).candidate,
        own2 = ok(
          await request('/api/v1/rate-candidates/owners', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              candidateId: rate2.id,
              expectedOwnerEventId: null,
              ownerUserId: admin.id,
              ownerRole: 'Admin',
              reason: 'Synthetic owner',
            },
          }),
          201,
        ).owner;
      const def2 = {
          ...definition,
          candidateId: rate2.id,
          stages: [
            { userId: reviewer.id, role: 'TeamLead' },
            { userId: fx.identities.reader.id, role: 'Employee' },
          ],
        },
        pol2 = ok(
          await request(root + '/policies', {
            method: 'POST',
            body: { ...polCmd, requestId: randomUUID(), definition: def2 },
          }),
          201,
        ).policy,
        req2 = ok(
          await request(root + '/requests', {
            method: 'POST',
            body: {
              ...reqCmd,
              requestId: randomUUID(),
              candidateId: rate2.id,
              expectedOwnerEventId: own2.id,
              expectedPolicyId: pol2.id,
            },
          }),
          201,
        ).approval;
      const actor1 = ok(await request(root + '/instances/' + req2.id, { identity: reviewer })),
        dec1 = {
          ...dec,
          expectedOwnerKey: actor1.ownerKey,
          requestId: randomUUID(),
          expectedCandidateId: rate2.id,
          expectedOwnerEventId: own2.id,
          expectedPolicyId: pol2.id,
          decision: 'Approved',
        },
        mid = ok(
          await request(root + '/instances/' + req2.id + '/decisions', {
            method: 'POST',
            body: dec1,
            identity: reviewer,
          }),
          201,
        ).approval;
      assert.deepEqual(mid.state, { status: 'Pending', sequence: 1, currentStage: 1 });
      const actor2 = ok(await request(root + '/instances/' + req2.id, { identity: fx.identities.reader })),
        dec2 = { ...dec1, expectedOwnerKey: actor2.ownerKey, requestId: randomUUID(), expectedSequence: 1 },
        final = ok(
          await request(root + '/instances/' + req2.id + '/decisions', {
            method: 'POST',
            body: dec2,
            identity: fx.identities.reader,
          }),
          201,
        ).approval;
      assert.equal(final.state.status, 'Approved');
      assert.equal(
        (await pool.query('select status from approval_records where entity_id=$1', [req2.id])).rows[0]
          .status,
        'Approved',
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_events where instance_id=$1',
            [req2.id],
          )
        ).rows[0].n,
        3,
      );
      for (const k of [
        'commercial.cost_candidates.view',
        'commercial.cost_candidates.manage',
        'commercial.cost_approvals.decide',
      ])
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
          [k],
        );
      await pool.query(
        "insert into user_roles(user_id,role_id)select $1,id from roles where name='Admin' on conflict do nothing",
        [reviewer.id],
      );
      const costApprover = { ...reviewer, role: 'Admin' };
      const costOwnerId = randomUUID();
      await pool.query(
        "insert into users(id,username,email,status) values($1,'synthetic-cost-owner','synthetic-cost-owner@example.test','Active')",
        [costOwnerId],
      );
      await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='Admin'", [
        costOwnerId,
      ]);
      await pool.query(
        'insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',
        [costOwnerId, f.organizationId, f.legalEntityId],
      );
      const cost = ok(
          await request('/api/v1/rate-candidates/candidates', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              streamId: randomUUID(),
              expectedLatestId: null,
              kind: 'cost',
              bindingType: 'worker',
              bindingId: f.ownerId,
              effectiveFrom: fx.today,
              effectiveTo: fx.today,
              currency: 'USD',
              unit: 'HOUR',
              amount: '73.0007',
              priority: 1,
              reason: 'Synthetic cost',
            },
          }),
          201,
        ).candidate,
        costOwn = ok(
          await request('/api/v1/rate-candidates/owners', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              candidateId: cost.id,
              expectedOwnerEventId: null,
              ownerUserId: costOwnerId,
              ownerRole: 'Admin',
              reason: 'Synthetic cost owner',
            },
          }),
          201,
        ).owner,
        costDef = {
          ...definition,
          kind: 'cost',
          candidateId: cost.id,
          stages: [{ userId: reviewer.id, role: 'Admin' }],
        },
        costPolicy = ok(
          await request(root + '/policies', {
            method: 'POST',
            body: { ...polCmd, requestId: randomUUID(), definition: costDef },
          }),
          201,
        ).policy,
        costReq = ok(
          await request(root + '/requests', {
            method: 'POST',
            body: {
              ...reqCmd,
              requestId: randomUUID(),
              candidateId: cost.id,
              expectedOwnerEventId: costOwn.id,
              expectedPolicyId: costPolicy.id,
            },
          }),
          201,
        ).approval;
      assert.equal(
        (await request(root + '/instances/' + costReq.id, { identity: fx.identities.reader })).status,
        403,
      );
      const costCompat = (
        await pool.query(
          "select id from approval_records where entity_type='CommercialCandidateApproval' and entity_id=$1",
          [costReq.id],
        )
      ).rows[0];
      const workerLegacy = ok(await request('/api/approvals', { identity: fx.identities.reader }));
      assert(!workerLegacy.some((x) => x.entity_type === 'CommercialCandidateApproval'));
      assert.equal(
        (
          await request('/api/approvals/' + costCompat.id + '/status', {
            method: 'PATCH',
            body: { status: 'Approved', comments: 'Synthetic bypass' },
            identity: admin,
          })
        ).status,
        404,
      );
      assert.equal(
        (await pool.query('select status from approval_records where id=$1', [costCompat.id])).rows[0].status,
        'Pending',
      );
      const costActor = ok(await request(root + '/instances/' + costReq.id, { identity: costApprover })),
        costDec = {
          ...dec,
          expectedOwnerKey: costActor.ownerKey,
          requestId: randomUUID(),
          expectedCandidateId: cost.id,
          expectedOwnerEventId: costOwn.id,
          expectedPolicyId: costPolicy.id,
        };
      assert.equal(
        ok(
          await request(root + '/instances/' + costReq.id + '/decisions', {
            method: 'POST',
            body: costDec,
            identity: costApprover,
          }),
          201,
        ).approval.state.status,
        'Rejected',
      );
      const workerInbox = ok(
          await request('/api/v1/work-approvals/inbox', { identity: fx.identities.reader }),
        ),
        workerNotice = workerInbox.notifications.find(
          (n) => n.kind === 'commercial-candidate-approval' && n.instanceId === costReq.id,
        );
      assert(workerNotice);
      assert.deepEqual(workerNotice.reasons, ['affected_worker']);
      assert(!JSON.stringify(workerNotice).includes('73.0007'));
      assert(!JSON.stringify(workerNotice).includes('Synthetic cost'));
      const costRecipients = (
        await pool.query(
          "select r.user_id,r.reasons from commercial_candidate_approval_recipients r join commercial_candidate_approval_events e on e.id=r.event_id where e.instance_id=$1 and e.event_key='approval.rejected_or_correction_required'",
          [costReq.id],
        )
      ).rows;
      assert.equal(costRecipients.length, 3);
      assert.deepEqual(costRecipients.find((x) => x.user_id === costOwnerId).reasons, [
        'commercial_change_owner',
      ]);
      assert.deepEqual(costRecipients.find((x) => x.user_id === admin.id).reasons, ['requester']);
      assert.deepEqual(costRecipients.find((x) => x.user_id === fx.identities.reader.id).reasons, [
        'affected_worker',
      ]); // A middle manager is a scope witness, not the target worker. Losing that
      // relationship concurrently must block a decision before any receipt exists.
      await pool.query(
        `insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values ('synthetic-approval-lead','SYN-APPROVAL-LEAD','Synthetic lead','lead-scope@example.test','Manager','Delivery','US','director-commercial','Active',$1,$2),('synthetic-approval-middle','SYN-APPROVAL-MIDDLE','Synthetic middle','middle-scope@example.test','Manager','Delivery','US','director-commercial','Active',$1,$2)`,
        [f.organizationId, f.legalEntityId],
      );
      await pool.query(
        "update employees set reporting_manager_id='synthetic-approval-lead' where id='synthetic-approval-middle'",
      );
      await pool.query("update employees set reporting_manager_id='synthetic-approval-middle' where id=$1", [
        f.ownerId,
      ]);
      await pool.query(
        "update users set employee_record_id='synthetic-approval-lead',employee_id='SYN-APPROVAL-LEAD' where id=$1",
        [reviewer.id],
      );
      reviewer.employeeRecordId = 'synthetic-approval-lead';
      reviewer.employeeId = 'SYN-APPROVAL-LEAD';
      for (const k of ['commercial.cost_candidates.view', 'commercial.cost_approvals.decide'])
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
          [k],
        );
      const scopedCost = ok(
          await request('/api/v1/rate-candidates/candidates', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              streamId: randomUUID(),
              expectedLatestId: null,
              kind: 'cost',
              bindingType: 'worker',
              bindingId: f.ownerId,
              effectiveFrom: fx.today,
              effectiveTo: fx.today,
              currency: 'USD',
              unit: 'HOUR',
              amount: '12.3400',
              priority: 1,
              reason: 'Synthetic scoped candidate',
            },
          }),
          201,
        ).candidate,
        scopedOwner = ok(
          await request('/api/v1/rate-candidates/owners', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              candidateId: scopedCost.id,
              expectedOwnerEventId: null,
              ownerUserId: admin.id,
              ownerRole: 'Admin',
              reason: 'Synthetic owner',
            },
          }),
          201,
        ).owner,
        scopedPolicy = ok(
          await request(root + '/policies', {
            method: 'POST',
            body: {
              ...polCmd,
              requestId: randomUUID(),
              definition: {
                ...definition,
                kind: 'cost',
                candidateId: scopedCost.id,
                stages: [{ userId: reviewer.id, role: 'TeamLead' }],
              },
            },
          }),
          201,
        ).policy,
        scopedRequest = ok(
          await request(root + '/requests', {
            method: 'POST',
            body: {
              ...reqCmd,
              requestId: randomUUID(),
              candidateId: scopedCost.id,
              expectedOwnerEventId: scopedOwner.id,
              expectedPolicyId: scopedPolicy.id,
            },
          }),
          201,
        ).approval,
        scopedView = ok(await request(root + '/instances/' + scopedRequest.id, { identity: reviewer }));
      const relationshipLock = await pool.connect();
      try {
        await relationshipLock.query('begin');
        await relationshipLock.query(
          "update employees set reporting_manager_id=null where id='synthetic-approval-middle'",
        );
        const pendingDecision = request(root + '/instances/' + scopedRequest.id + '/decisions', {
          method: 'POST',
          identity: reviewer,
          body: {
            ...dec,
            expectedOwnerKey: scopedView.ownerKey,
            requestId: randomUUID(),
            expectedCandidateId: scopedCost.id,
            expectedOwnerEventId: scopedOwner.id,
            expectedPolicyId: scopedPolicy.id,
          },
        });
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          if (
            (
              await pool.query(
                "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%insert into commercial_candidate_approval_transitions%'",
              )
            ).rowCount
          ) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert(blocked, 'decision waits for the existing hierarchy witness');
        await relationshipLock.query('commit');
        const lost = await pendingDecision;
        assert([403, 409].includes(lost.status), JSON.stringify(lost.body));
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
              [scopedRequest.id],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await relationshipLock.query('rollback').catch(() => {});
        relationshipLock.release();
      }
      // The same scoped witness lock must also protect the country-map and
      // managed-project relationships used by other existing roles.
      await pool.query(
        "insert into country_directors(id,name,region)values('director-synthetic-target','Synthetic target director','Synthetic region')",
      );
      await pool.query(
        "update employees set designation='Country Director' where id='synthetic-approval-lead'",
      );
      await pool.query(
        "update employees set primary_country_director_id='director-synthetic-target' where id=$1",
        [f.ownerId],
      );
      await pool.query(
        "insert into employee_country_director_map(employee_id,country_director_id)values($1,'director-commercial')",
        [f.ownerId],
      );
      const blockedWitness = async (role, mutation, queryFragment) => {
        const held = await pool.connect();
        try {
          await held.query('begin');
          await held.query(mutation);
          const pending = pool
            .query(
              'select lock_commercial_candidate_worker_witness(c,$2,$3) from commercial_rate_candidates c where c.id=$1',
              [scopedCost.id, reviewer.id, role],
            )
            .then(
              () => null,
              (e) => e,
            );
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            if (
              (
                await pool.query(
                  "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1",
                  ['%' + queryFragment + '%'],
                )
              ).rowCount
            ) {
              blocked = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          assert(blocked, role + ' scope witness must wait');
          await held.query('commit');
          const error = await pending;
          assert.equal(error?.code, 'CCA02', role + ' must reject the removed witness');
        } finally {
          await held.query('rollback').catch(() => {});
          held.release();
        }
      };
      await blockedWitness(
        'CountryDirector',
        "delete from employee_country_director_map where employee_id='" +
          f.ownerId +
          "' and country_director_id='director-commercial'",
        'lock_commercial_candidate_worker_witness',
      );
      await pool.query("update projects set manager_id='synthetic-approval-lead' where id=$1", [f.projectId]);
      await blockedWitness(
        'ProjectManager',
        "update projects set manager_id=null where id='" + f.projectId + "'",
        'lock_commercial_candidate_worker_witness',
      );
      const createReview = async (suffix, stages = definition.stages) => {
        const candidate = ok(
            await request('/api/v1/rate-candidates/candidates', {
              method: 'POST',
              body: {
                requestId: randomUUID(),
                streamId: randomUUID(),
                expectedLatestId: null,
                kind: 'billing',
                bindingType: 'contract',
                bindingId: contract.id,
                effectiveFrom: fx.today,
                effectiveTo: fx.today,
                currency: 'USD',
                unit: 'HOUR',
                amount: '17.0001',
                priority: 3,
                reason: 'Synthetic ' + suffix,
              },
            }),
            201,
          ).candidate,
          owner = ok(
            await request('/api/v1/rate-candidates/owners', {
              method: 'POST',
              body: {
                requestId: randomUUID(),
                candidateId: candidate.id,
                expectedOwnerEventId: null,
                ownerUserId: admin.id,
                ownerRole: 'Admin',
                reason: 'Synthetic owner',
              },
            }),
            201,
          ).owner,
          policy = ok(
            await request(root + '/policies', {
              method: 'POST',
              body: {
                ...polCmd,
                requestId: randomUUID(),
                definition: { ...definition, stages, candidateId: candidate.id },
              },
            }),
            201,
          ).policy,
          command = {
            ...reqCmd,
            requestId: randomUUID(),
            candidateId: candidate.id,
            expectedOwnerEventId: owner.id,
            expectedPolicyId: policy.id,
          };
        return { candidate, owner, policy, command };
      };
      const loss = await createReview('owner-loss'),
        lossReq = ok(await request(root + '/requests', { method: 'POST', body: loss.command }), 201).approval,
        lossView = ok(await request(root + '/instances/' + lossReq.id, { identity: reviewer }));
      await pool.query("update users set status='Inactive' where id=$1", [admin.id]);
      try {
        const denied = await request(root + '/instances/' + lossReq.id + '/decisions', {
          method: 'POST',
          identity: reviewer,
          body: {
            ...dec,
            expectedOwnerKey: lossView.ownerKey,
            requestId: randomUUID(),
            expectedCandidateId: loss.candidate.id,
            expectedOwnerEventId: loss.owner.id,
            expectedPolicyId: loss.policy.id,
          },
        });
        assert.equal(denied.status, 409, JSON.stringify(denied.body));
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
              [lossReq.id],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await pool.query("update users set status='Active' where id=$1", [admin.id]);
      }
      const version = await createReview('new-version'),
        versionReq = ok(
          await request(root + '/requests', { method: 'POST', body: version.command }),
          201,
        ).approval,
        versionView = ok(await request(root + '/instances/' + versionReq.id, { identity: reviewer }));
      ok(
        await request('/api/v1/rate-candidates/candidates', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            streamId: version.candidate.streamId,
            expectedLatestId: version.candidate.id,
            kind: 'billing',
            bindingType: 'contract',
            bindingId: contract.id,
            effectiveFrom: shift(fx.today, 1),
            effectiveTo: shift(fx.today, 1),
            currency: 'USD',
            unit: 'HOUR',
            amount: '19.0000',
            priority: 3,
            reason: 'Synthetic later version',
          },
        }),
        201,
      );
      assert.equal(
        (
          await request(root + '/instances/' + versionReq.id + '/decisions', {
            method: 'POST',
            identity: reviewer,
            body: {
              ...dec,
              expectedOwnerKey: versionView.ownerKey,
              requestId: randomUUID(),
              expectedCandidateId: version.candidate.id,
              expectedOwnerEventId: version.owner.id,
              expectedPolicyId: version.policy.id,
            },
          })
        ).status,
        409,
      );
      await pool.query(
        "insert into role_permissions(role_name,permission_key,enabled)values('Admin','commercial.rate_approvals.decide',true)on conflict(role_name,permission_key)do update set enabled=true",
      );
      const self = await createReview('self'),
        selfPolicy = ok(
          await request(root + '/policies', {
            method: 'POST',
            body: {
              ...polCmd,
              requestId: randomUUID(),
              expectedLatestId: self.policy.id,
              definition: {
                ...definition,
                candidateId: self.candidate.id,
                stages: [{ userId: admin.id, role: 'Admin' }],
              },
            },
          }),
          201,
        ).policy;
      assert.equal(
        (
          await request(root + '/requests', {
            method: 'POST',
            body: { ...self.command, requestId: randomUUID(), expectedPolicyId: selfPolicy.id },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_instances where candidate_id=$1',
            [self.candidate.id],
          )
        ).rows[0].n,
        0,
      );
      const race = await createReview('race', def2.stages);
      await pool.query(
        "create function synthetic_notice_refusal()returns trigger language plpgsql as $$begin raise exception 'Synthetic notification failure';end$$;create trigger synthetic_notice_refusal before insert on commercial_candidate_approval_recipients for each row execute function synthetic_notice_refusal()",
      );
      assert.equal((await request(root + '/requests', { method: 'POST', body: race.command })).status, 503);
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_instances where candidate_id=$1',
            [race.candidate.id],
          )
        ).rows[0].n,
        0,
      );
      await pool.query(
        'drop trigger synthetic_notice_refusal on commercial_candidate_approval_recipients;drop function synthetic_notice_refusal()',
      );
      const [ra, rb] = await Promise.all([
        request(root + '/requests', { method: 'POST', body: race.command }),
        request(root + '/requests', { method: 'POST', body: race.command }),
      ]);
      assert.deepEqual([ra.status, rb.status].sort(), [200, 201]);
      assert.equal(ra.body.approval.id, rb.body.approval.id);
      assert.equal(
        (
          await request(root + '/requests', {
            method: 'POST',
            body: { ...race.command, requestId: randomUUID() },
          })
        ).status,
        409,
      );
      const rview = ok(await request(root + '/instances/' + ra.body.approval.id, { identity: reviewer })),
        rd = {
          ...dec,
          expectedOwnerKey: rview.ownerKey,
          expectedCandidateId: race.candidate.id,
          expectedOwnerEventId: race.owner.id,
          expectedPolicyId: race.policy.id,
          decision: 'Approved',
        },
        [d1, d2] = await Promise.all([
          request(root + '/instances/' + ra.body.approval.id + '/decisions', {
            method: 'POST',
            body: { ...rd, requestId: randomUUID() },
            identity: reviewer,
          }),
          request(root + '/instances/' + ra.body.approval.id + '/decisions', {
            method: 'POST',
            body: { ...rd, requestId: randomUUID() },
            identity: reviewer,
          }),
        ]);
      assert.deepEqual([d1.status, d2.status].sort(), [201, 409]);
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
            [ra.body.approval.id],
          )
        ).rows[0].n,
        1,
      );
      const cancelPath = root + '/instances/' + ra.body.approval.id + '/cancellations';
      const cancelStage = (data) => request(cancelPath, { method: 'POST', body: data });
      const baseCancel = { requestId: randomUUID(), expectedOwnerKey: ownerResponse.ownerKey,
        reason: 'Synthetic inspected review cancellation' };
      for (const pin of [{}, { expectedSequence: 0 }]) {
        const refused = await cancelStage({ ...baseCancel, ...pin });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error.code, 'COMMERCIAL_APPROVAL_STAGE_CHANGED');
      }
      const command = { ...baseCancel, expectedSequence: 1 };
      const recorded = ok(await cancelStage(command), 201).approval;
      assert.equal(recorded.state.status, 'Cancelled');
      assert.equal(recorded.state.sequence, 1);
      assert.equal(ok(await cancelStage(command)).replayed, true);
      assert.equal((await cancelStage({ ...command, expectedSequence: 0 })).status, 409);
      const original = ok(await request(root + '/receipts/cancellation/' + command.requestId));
      assert.equal(original.approval.cancellation.id, recorded.cancellation.id);
      const stale = await createReview('stale'),
        oldRequest = ok(
          await request(root + '/requests', { method: 'POST', body: stale.command }),
          201,
        ).approval,
        oldActor = ok(await request(root + '/instances/' + oldRequest.id, { identity: reviewer })),
        changed = ok(
          await request('/api/v1/rate-candidates/owners', {
            method: 'POST',
            body: {
              requestId: randomUUID(),
              candidateId: stale.candidate.id,
              expectedOwnerEventId: stale.owner.id,
              ownerUserId: admin.id,
              ownerRole: 'Admin',
              reason: 'Synthetic reassignment',
            },
          }),
          201,
        ).owner,
        staleDecision = {
          ...dec,
          expectedOwnerKey: oldActor.ownerKey,
          requestId: randomUUID(),
          expectedCandidateId: stale.candidate.id,
          expectedOwnerEventId: stale.owner.id,
          expectedPolicyId: stale.policy.id,
        };
      assert.equal(
        (
          await request(root + '/instances/' + oldRequest.id + '/decisions', {
            method: 'POST',
            body: staleDecision,
            identity: reviewer,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
            [oldRequest.id],
          )
        ).rows[0].n,
        0,
      );
      const cancellation = {
          expectedOwnerKey: ownerResponse.ownerKey,
          requestId: randomUUID(),
          reason: 'Synthetic stale review cancellation',
        },
        cancelled = ok(
          await request(root + '/instances/' + oldRequest.id + '/cancellations', {
            method: 'POST',
            body: cancellation,
          }),
          201,
        ).approval;
      assert.equal(cancelled.state.status, 'Cancelled');
      assert.equal(
        ok(
          await request(root + '/instances/' + oldRequest.id + '/cancellations', {
            method: 'POST',
            body: cancellation,
          }),
        ).replayed,
        true,
      );
      const fresh = ok(
        await request(root + '/requests', {
          method: 'POST',
          body: { ...stale.command, requestId: randomUUID(), expectedOwnerEventId: changed.id },
        }),
        201,
      ).approval;
      assert.equal(fresh.state.status, 'Pending');
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_events where instance_id=$1',
            [oldRequest.id],
          )
        ).rows[0].n,
        1,
      );
      const optional = await createReview('optional'),
        optionalReq = ok(
          await request(root + '/requests', { method: 'POST', body: optional.command }),
          201,
        ).approval,
        optionalView = ok(await request(root + '/instances/' + optionalReq.id, { identity: reviewer }));
      await pool.query(
        "create function synthetic_info_refusal()returns trigger language plpgsql as $$begin if new.event_key='approval.completed' then raise exception 'Synthetic optional failure';end if;return new;end$$;create trigger synthetic_info_refusal before insert on commercial_candidate_approval_events for each row execute function synthetic_info_refusal()",
      );
      const optionalDecision = {
        ...dec,
        expectedOwnerKey: optionalView.ownerKey,
        requestId: randomUUID(),
        expectedCandidateId: optional.candidate.id,
        expectedOwnerEventId: optional.owner.id,
        expectedPolicyId: optional.policy.id,
        decision: 'Approved',
      };
      assert.equal(
        ok(
          await request(root + '/instances/' + optionalReq.id + '/decisions', {
            method: 'POST',
            body: optionalDecision,
            identity: reviewer,
          }),
          201,
        ).approval.state.status,
        'Approved',
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_notification_failures where instance_id=$1',
            [optionalReq.id],
          )
        ).rows[0].n,
        1,
      );
      await pool.query(
        'drop trigger synthetic_info_refusal on commercial_candidate_approval_events;drop function synthetic_info_refusal()',
      );
      const authority = await createReview('authority'),
        authorityReq = ok(
          await request(root + '/requests', { method: 'POST', body: authority.command }),
          201,
        ).approval,
        authorityView = ok(await request(root + '/instances/' + authorityReq.id, { identity: reviewer })),
        lock = await pool.connect();
      try {
        await lock.query('begin');
        await lock.query(
          "update role_permissions set enabled=false where role_name='TeamLead' and permission_key='commercial.rate_approvals.decide'",
        );
        const waiting = request(root + '/instances/' + authorityReq.id + '/decisions', {
          method: 'POST',
          identity: reviewer,
          body: {
            ...dec,
            expectedOwnerKey: authorityView.ownerKey,
            requestId: randomUUID(),
            expectedCandidateId: authority.candidate.id,
            expectedOwnerEventId: authority.owner.id,
            expectedPolicyId: authority.policy.id,
          },
        });
        let blocked = false;
        for (let i = 0; i < 60; i++) {
          if (
            (
              await pool.query(
                "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%permission_key from role_permissions%'",
              )
            ).rowCount
          ) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert(blocked);
        await lock.query('commit');
        const denied = await waiting;
        assert([403, 409].includes(denied.status), JSON.stringify(denied.body));
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
              [authorityReq.id],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await lock.query('rollback').catch(() => {});
        lock.release();
        await pool.query(
          "update role_permissions set enabled=true where role_name='TeamLead' and permission_key='commercial.rate_approvals.decide'",
        );
      }
      const redacted = (await pool.query("select * from audit_logs where module='Commercial Approval'")).rows;
      assert(!JSON.stringify(redacted).includes('42.0001'));
      assert(!JSON.stringify(redacted).includes('73.0007'));
      assert(!JSON.stringify(redacted).includes('Synthetic review'));
      console.log(
        'Synthetic API two-stage billing, cost inbox, mandatory and optional isolation, replay/race, permission loss and stale-owner rereview passed.',
      );
    },
  );
});
