import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialFixture as f,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import {
  seedWorkApproval,
  adoptStagedPolicy,
  submitStagedWork,
  readApprovalOwner,
  WORK_APPROVAL_BASE as work,
} from './support/work-approval-test.mjs';
import { actualCatalog } from './support/actual-work-test.mjs';
import {
  grantAmendmentPermissions,
  createAmendmentHierarchy,
} from './support/commercial-amendments-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const base = '/api/v1/governed-tm-valuations',
  candidates = '/api/v1/rate-candidates',
  approvals = '/api/v1/commercial-candidate-approvals',
  adoptions = '/api/v1/approved-rate-sources',
  ok = (v, n = 200) => {
    assert.equal(v.status, n, JSON.stringify(v.body));
    return v.body;
  };
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from role_permissions where permission_key like 'commercial.tm_billing.%'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from user_permission_grants where permission_key like 'commercial.tm_billing.%'",
      )
    ).rows[0].n,
    0,
  );
  const fx = await seedWorkApproval(pool),
    ids = fx.identities;
  await grantAmendmentPermissions(pool);
  for (const k of [
    'commercial.rate_candidates.view',
    'commercial.rate_candidates.manage',
    'commercial.cost_candidates.view',
    'commercial.cost_candidates.manage',
    'commercial.rate_approvals.decide',
    'commercial.cost_approvals.decide',
    'commercial.tm_valuation.view',
    'commercial.tm_valuation.create',
    'commercial.tm_billing.view',
    'commercial.tm_billing.manage',
    'commercial.tm_billing.decide',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
    async ({ request }) => {
      const end = shift(fx.today, 30),
        roots = await createAmendmentHierarchy(request, 'SYN-TM-VAL', {
          contract: {
            model: 'time_and_materials',
            startsOn: fx.today,
            endsOn: end,
            effectiveFrom: fx.today,
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        });
      ok(
        await request('/api/v1/work-categories/catalogs', {
          method: 'POST',
          body: {
            expectedLatestId: null,
            effectiveFrom: fx.today,
            definition: actualCatalog,
            reason: 'Synthetic category',
          },
        }),
        201,
      );
      await adoptStagedPolicy(request, ids, fx.today);
      ok(
        await request('/api/allocations', {
          method: 'POST',
          body: {
            employee_id: f.ownerId,
            project_id: roots.project.id,
            percentage: 20,
            start_date: fx.today,
            end_date: fx.today,
            billable: true,
            status: 'Active',
          },
        }),
      );
      const keys = [
          'approval.action_required',
          'approval.rejected_or_correction_required',
          'approval.completed',
        ],
        makeRate = async (kind, amount, priority = 1, adoptNow = true, currency = 'USD') => {
          const bindingType = kind === 'billing' ? 'contract' : 'worker',
            bindingId = kind === 'billing' ? roots.contract.id : f.ownerId,
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
                  effectiveFrom: fx.today,
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
                  effectiveFrom: fx.today,
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
          const adoptionCommand = {
            expectedOwnerKey: inspected.ownerKey,
            requestId: randomUUID(),
            candidateId: candidate.id,
            expectedOwnerEventId: r.ownerEventId,
            approvalId: r.approvalId,
            expectedPolicyId: r.policyId,
            expectedFinalTransitionId: r.finalTransitionId,
            reason: 'Synthetic source adoption',
          };
          return adoptNow
            ? ok(await request(adoptions + '/adoptions', { method: 'POST', body: adoptionCommand }), 201)
                .adoption
            : adoptionCommand;
        };
      const billing = await makeRate('billing', '100.1234'),
        cost = await makeRate('cost', '40.0020'),
        policies = ok(await request(base + '/policies?engagementId=' + roots.engagement.id)),
        definition = {
          version: 'governed-tm/1',
          currency: 'USD',
          precision: 2,
          rounding: 'HALF_UP',
          aggregation: 'PER_ENTRY',
          capTreatment: 'NONE',
          exclusions: 'NONE',
          unit: 'HOUR',
          approvalTreatment: 'NONE',
        },
        policyCmd = {
          expectedOwnerKey: policies.ownerKey,
          requestId: randomUUID(),
          engagementId: roots.engagement.id,
          expectedLatestId: null,
          effectiveFrom: fx.today,
          definition,
          reason: 'Synthetic selected T&M policy',
        },
        policy = ok(await request(base + '/policies', { method: 'POST', body: policyCmd }), 201).policy;
      assert.equal(ok(await request(base + '/policies', { method: 'POST', body: policyCmd })).replayed, true);
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: { ...policyCmd, reason: 'Synthetic changed reason' },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: { ...policyCmd, requestId: randomUUID() },
          })
        ).status,
        409,
      );
      const invalidPolicy = { ...definition };
      delete invalidPolicy.approvalTreatment;
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: {
              ...policyCmd,
              requestId: randomUUID(),
              expectedLatestId: policy.id,
              definition: invalidPolicy,
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: {
              ...policyCmd,
              requestId: randomUUID(),
              expectedLatestId: policy.id,
              definition: { ...definition, approvalTreatment: 'REQUIRED' },
            },
          })
        ).status,
        400,
      );
      const submitted = await submitStagedWork(request, ids.reader, fx.today, {
          entries: [
            {
              project_id: roots.project.id,
              work_type: 'Project Work',
              category_code: 'BILL',
              work_date: fx.today,
              hours: '1.25',
              billable: true,
              remark: 'Synthetic approved work',
            },
            {
              project_id: roots.project.id,
              work_type: 'Project Work',
              category_code: 'BILL',
              work_date: fx.today,
              hours: '2.5',
              billable: true,
              remark: 'Synthetic other work',
            },
            {
              project_id: roots.project.id,
              work_type: 'Project Work',
              category_code: 'BILL',
              work_date: fx.today,
              hours: '3.75',
              billable: true,
              remark: 'Synthetic concurrent work',
            },
          ],
        }),
        evidence = (
          await pool.query('select * from work_submission_evidence where id=$1', [
            submitted.instance.submissionId,
          ])
        ).rows[0],
        entry = evidence.entries[0];
      const decideWork = async (identity) => {
        const current = ok(await request(work + '/instances/' + submitted.instance.id)).instance;
        return ok(
          await request(work + '/instances/' + submitted.instance.id + '/decisions', {
            method: 'POST',
            identity,
            body: {
              expectedOwnerKey: await readApprovalOwner(request, identity),
              expectedSourceToken: current.sourceToken,
              expectedSequence: current.state.sequence,
              requestId: randomUUID(),
              decision: 'Approved',
              reason: 'Synthetic approved work stage',
            },
          }),
          201,
        ).receipt;
      };
      await decideWork(ids.manager);
      await decideWork(ids.second);
      const calc = ok(
        await request(base + '/valuations', {
          method: 'POST',
          body: {
            expectedOwnerKey: policies.ownerKey,
            requestId: randomUUID(),
            engagementId: roots.engagement.id,
            policyId: policy.id,
            submissionId: evidence.id,
            entryId: entry.entryId,
            billingAdoptionId: billing.id,
            costAdoptionId: cost.id,
            reason: 'Synthetic calculation',
          },
        }),
        201,
      ).valuation;
      const calc2 = ok(
        await request(base + '/valuations', {
          method: 'POST',
          body: {
            expectedOwnerKey: policies.ownerKey,
            requestId: randomUUID(),
            engagementId: roots.engagement.id,
            policyId: policy.id,
            submissionId: evidence.id,
            entryId: evidence.entries.find((x) => x.hours === '2.5').entryId,
            billingAdoptionId: billing.id,
            costAdoptionId: cost.id,
            reason: 'Synthetic other calculation',
          },
        }),
        201,
      ).valuation;
      const calc3 = ok(
        await request(base + '/valuations', {
          method: 'POST',
          body: {
            expectedOwnerKey: policies.ownerKey,
            requestId: randomUUID(),
            engagementId: roots.engagement.id,
            policyId: policy.id,
            submissionId: evidence.id,
            entryId: evidence.entries.find((x) => x.hours === '3.75').entryId,
            billingAdoptionId: billing.id,
            costAdoptionId: cost.id,
            reason: 'Synthetic concurrent calculation',
          },
        }),
        201,
      ).valuation;
      const b = '/api/v1/tm-billing-eligibility',
        initial = ok(await request(b + '/policies?engagementId=' + roots.engagement.id)),
        approvalDefinition = {
          entityType: 'TmBillingEligibility',
          engagementId: roots.engagement.id,
          stages: [
            { userId: ids.manager.id, role: 'Admin' },
            { userId: ids.second.id, role: 'Admin' },
          ],
          locale: 'en-US',
          templates: keys.map((key) => ({
            key,
            subject: 'Review {{sourceRef}}',
            body: 'Stage {{stageNumber}}',
          })),
          completionInApp: true,
        };
      const policyResult = ok(
        await request(b + '/policies', {
          method: 'POST',
          body: {
            expectedOwnerKey: initial.ownerKey,
            requestId: randomUUID(),
            engagementId: roots.engagement.id,
            expectedLatestId: null,
            effectiveFrom: fx.today,
            definition: approvalDefinition,
            reason: 'Synthetic billing policy',
          },
        }),
        201,
      ).policy;
      const requesterKey = await readApprovalOwner(request, ids.requester),
        requestBody = {
          expectedOwnerKey: requesterKey,
          requestId: randomUUID(),
          snapshotId: calc.id,
          expectedPolicyId: policyResult.id,
          ownerUserId: ids.manager.id,
          ownerRole: 'Admin',
          reason: 'Synthetic billing review',
        };
      let created = ok(
        await request(b + '/requests', { method: 'POST', identity: ids.requester, body: requestBody }),
        201,
      ).approval;
      assert.equal(created.state.status, 'Pending');
      assert.equal((await pool.query('select count(*)::int n from billing_eligibility_events')).rows[0].n, 0);
      assert.equal(
        ok(await request(b + '/requests', { method: 'POST', identity: ids.requester, body: requestBody }))
          .replayed,
        true,
      );
      assert.equal(
        (
          await request(b + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: { ...requestBody, reason: 'Changed synthetic reason' },
          })
        ).status,
        409,
      );
      await assert.rejects(
        pool.query(
          'insert into tm_billing_eligibility_policies(id,organization_id,legal_entity_id,engagement_id,sequence,previous_id,effective_from,definition,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,2,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)',
          [
            randomUUID(),
            f.organizationId,
            f.legalEntityId,
            roots.engagement.id,
            policyResult.id,
            fx.today,
            JSON.stringify(approvalDefinition),
            ids.manager.id,
            'Admin',
            randomUUID(),
            'a'.repeat(64),
            'Synthetic direct denial',
            'synthetic-direct',
          ],
        ),
        (e) => e.code === 'TBE01',
      );
      for (const k of [
        'commercial.contracts.view',
        'commercial.tm_billing.view',
        'employees.view',
        'notifications.view',
      ])
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled)values('Employee',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
          [k],
        );
      const limited = ok(await request(b + '/sources/' + calc.id, { identity: ids.reader }));
      assert(!JSON.stringify(limited).includes('costAdoptionId'));
      assert(!JSON.stringify(limited).includes('costValue'));
      assert(!JSON.stringify(limited).includes('marginValue'));
      assert.equal((await request(base + '/valuations/' + calc.id, { identity: ids.reader })).status, 403);
      for (const k of [
        'commercial.contracts.view',
        'commercial.tm_billing.view',
        'employees.view',
        'notifications.view',
      ])
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
          [k],
        );
      assert.equal(
        (await request(b + '/sources/' + calc.id, { identity: ids.denied })).status,
        404,
        'A billing viewer cannot inspect a foreign worker',
      );
      assert.equal(ok(await request(b + '/register', { identity: ids.denied })).items.length, 0);
      assert.equal(
        (
          await request(b + '/requests', {
            method: 'POST',
            identity: ids.reader,
            body: { ...requestBody, expectedOwnerKey: await readApprovalOwner(request, ids.reader) },
          })
        ).status,
        403,
        'View access does not grant review management',
      );

      const decision = async (identity, expectedSequence) => {
        const reply = ok(await request(b + '/instances/' + created.id, { identity }));
        return request(b + '/instances/' + created.id + '/decisions', {
          method: 'POST',
          identity,
          body: {
            expectedOwnerKey: reply.ownerKey,
            requestId: randomUUID(),
            expectedSequence,
            decision: 'Approved',
            reason: 'Synthetic billing decision',
          },
        });
      };
      await pool.query("update users set status='Inactive' where id=$1", [ids.manager.id]);
      await pool.query("update users set status='Active' where id=$1", [ids.manager.id]);
      const revived = await decision(ids.manager, 0);
      assert.equal(
        revived.status,
        409,
        'An owner eligibility loss must require a fresh review even after access is restored',
      );
      assert.equal((await pool.query('select count(*)::int n from billing_eligibility_events')).rows[0].n, 0);
      const cancelled = await request(b + '/instances/' + created.id + '/cancellations', {
        method: 'POST',
        identity: ids.requester,
        body: {
          expectedOwnerKey: requesterKey,
          requestId: randomUUID(),
          reason: 'Synthetic stale review cancellation',
        },
      });
      assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
      created = ok(
        await request(b + '/requests', {
          method: 'POST',
          identity: ids.requester,
          body: { ...requestBody, requestId: randomUUID() },
        }),
        201,
      ).approval;
      const inbox = ok(await request(work + '/inbox', { identity: ids.manager })),
        notice = inbox.notifications.find(
          (x) => x.kind === 'tm-billing-eligibility' && x.instanceId === created.id,
        );
      assert(notice);
      assert(!JSON.stringify(notice).includes('costValue'));
      assert(
        ok(
          await request(work + '/inbox/' + notice.id + '/read', {
            method: 'POST',
            identity: ids.manager,
            body: { expectedOwnerKey: inbox.ownerKey },
          }),
        ).notification.readAt,
      );
      const legacy = ok(await request('/api/approvals'));
      assert(!legacy.some((x) => x.entity_type === 'TmBillingEligibilityApproval'));
      const compatibility = (
        await pool.query(
          "select id from approval_records where entity_type='TmBillingEligibilityApproval' and entity_id=$1",
          [created.id],
        )
      ).rows[0];
      assert.equal(
        (
          await request('/api/approvals/' + compatibility.id + '/status', {
            method: 'PATCH',
            body: { status: 'Approved' },
          })
        ).status,
        404,
      );
      const stage0 = ok(await request(b + '/instances/' + created.id, { identity: ids.manager })),
        stage0Body = {
          expectedOwnerKey: stage0.ownerKey,
          requestId: randomUUID(),
          expectedSequence: 0,
          decision: 'Approved',
          reason: 'Synthetic stage decision',
        };
      await pool.query(
        "create function synthetic_tm_billing_notice_refusal() returns trigger language plpgsql as $$begin raise exception 'synthetic recipient refusal' using errcode='TBE04';end$$",
      );
      await pool.query(
        'create trigger synthetic_tm_billing_notice_refusal before insert on tm_billing_eligibility_recipients for each row execute function synthetic_tm_billing_notice_refusal()',
      );
      const refused = await request(b + '/instances/' + created.id + '/decisions', {
        method: 'POST',
        identity: ids.manager,
        body: stage0Body,
      });
      assert.equal(refused.status, 409);
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from tm_billing_eligibility_transitions where instance_id=$1',
            [created.id],
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await pool.query('select count(*)::int n from billing_eligibility_events')).rows[0].n, 0);
      await pool.query(
        'drop trigger synthetic_tm_billing_notice_refusal on tm_billing_eligibility_recipients;drop function synthetic_tm_billing_notice_refusal()',
      );
      assert.equal(
        (
          await request(b + '/instances/' + created.id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: stage0Body,
          })
        ).status,
        201,
      );
      assert.equal((await pool.query('select count(*)::int n from billing_eligibility_events')).rows[0].n, 0);
      await pool.query(
        "insert into notification_preferences(employee_id,event_type,in_app)values($1,'approval.completed',false),($1,'approval.rejected_or_correction_required',false) on conflict(employee_id,event_type)do update set in_app=excluded.in_app",
        [f.ownerId],
      );
      const stage1 = ok(await request(b + '/instances/' + created.id, { identity: ids.second })),
        stage1Body = {
          expectedOwnerKey: stage1.ownerKey,
          requestId: randomUUID(),
          expectedSequence: 1,
          decision: 'Approved',
          reason: 'Synthetic final decision',
        };
      await pool.query(
        "create function synthetic_tm_billing_audit_failure()returns trigger language plpgsql as $$begin if new.module='T&M Billing Eligibility' and new.action='Decide Review' then raise exception 'synthetic audit refusal' using errcode='TBE04';end if;return new;end$$;create trigger synthetic_tm_billing_audit_failure before insert on audit_logs for each row execute function synthetic_tm_billing_audit_failure()",
      );
      const auditFailure = await request(b + '/instances/' + created.id + '/decisions', {
        method: 'POST',
        identity: ids.second,
        body: stage1Body,
      });
      assert.equal(auditFailure.status, 409);
      assert.equal(
        (
          await pool.query('select count(*)::int n from billing_eligibility_events where instance_id=$1', [
            created.id,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from tm_billing_eligibility_transitions where instance_id=$1',
            [created.id],
          )
        ).rows[0].n,
        1,
      );
      await pool.query(
        'drop trigger synthetic_tm_billing_audit_failure on audit_logs;drop function synthetic_tm_billing_audit_failure()',
      );
      await pool.query(
        "create function synthetic_tm_decider_loss()returns trigger language plpgsql as $$begin if new.sequence=2 then update users set status='Inactive' where id=new.actor_id;end if;return new;end$$;create trigger synthetic_tm_decider_loss after insert on tm_billing_eligibility_transitions for each row execute function synthetic_tm_decider_loss()",
      );
      const decisionLoss = await request(b + '/instances/' + created.id + '/decisions', {
        method: 'POST',
        identity: ids.second,
        body: stage1Body,
      });
      assert.equal(
        decisionLoss.status,
        403,
        'Decider loss in the same transaction must refuse final approval',
      );
      assert.equal(
        (
          await pool.query('select count(*)::int n from billing_eligibility_events where instance_id=$1', [
            created.id,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query('select status from users where id=$1', [ids.second.id])).rows[0].status,
        'Active',
      );
      await pool.query(
        'drop trigger synthetic_tm_decider_loss on tm_billing_eligibility_transitions;drop function synthetic_tm_decider_loss()',
      );
      const both = await Promise.all([
        request(b + '/instances/' + created.id + '/decisions', {
          method: 'POST',
          identity: ids.second,
          body: stage1Body,
        }),
        request(b + '/instances/' + created.id + '/decisions', {
          method: 'POST',
          identity: ids.second,
          body: stage1Body,
        }),
      ]);
      assert.deepEqual(both.map((x) => x.status).sort(), [200, 201]);
      const final = ok(
        both.find((x) => x.status === 201),
        201,
      );
      assert.equal(final.approval.state.status, 'Approved');
      const reg = ok(await request(b + '/register'));
      assert.equal(reg.items.length, 1);
      assert.equal(reg.items[0].evidence.amount, '125.15');
      assert.doesNotMatch(JSON.stringify(reg), /costValue|marginValue|costRateExact|costAdoptionId/);
      assert.equal((await pool.query('select count(*)::int n from approved_unbilled_items')).rows[0].n, 1);
      const completionRecipients = (
        await pool.query(
          "select r.user_id,r.in_app,r.channel_decision from tm_billing_eligibility_recipients r join tm_billing_eligibility_notices n on n.id=r.event_id where n.instance_id=$1 and n.event_key='approval.completed'",
          [created.id],
        )
      ).rows;
      assert.deepEqual(
        completionRecipients.find((x) => x.user_id === ids.reader.id),
        { user_id: ids.reader.id, in_app: false, channel_decision: 'SuppressedPreference' },
      );
      await assert.rejects(
        pool.query('update billing_eligibility_events set amount=0 where id=$1', [final.eventId]),
        (e) => e.code === '55000',
      );
      await assert.rejects(
        pool.query('delete from approved_unbilled_items where id=$1', [final.itemId]),
        (e) => e.code === '55000',
      );
      await assert.rejects(
        pool.query(
          "update approval_records set status='Rejected' where entity_type='TmBillingEligibilityApproval' and entity_id=$1",
          [created.id],
        ),
        (e) => e.code === 'TBE03',
      );
      const employeeReg = ok(await request(b + '/register', { identity: ids.reader }));
      assert.equal(employeeReg.items.length, 1);
      assert.doesNotMatch(JSON.stringify(employeeReg), /costValue|marginValue|costRateExact|costAdoptionId/);
      assert.equal(
        (
          await request(b + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: { ...requestBody, requestId: randomUUID() },
          })
        ).status,
        409,
        'A different request cannot duplicate an eligible snapshot',
      );
      assert.equal(
        (
          await request(b + '/instances/' + created.id + '/decisions', {
            method: 'POST',
            identity: ids.second,
            body: { ...stage1Body, requestId: randomUUID() },
          })
        ).status,
        409,
        'A different final decision cannot duplicate the event',
      );
      const rejectReq = ok(
          await request(b + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: { ...requestBody, snapshotId: calc2.id, requestId: randomUUID() },
          }),
          201,
        ).approval,
        rejectView = ok(await request(b + '/instances/' + rejectReq.id, { identity: ids.manager }));
      assert.equal(
        (
          await request(b + '/instances/' + rejectReq.id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: {
              expectedOwnerKey: rejectView.ownerKey,
              requestId: randomUUID(),
              expectedSequence: 0,
              decision: 'Rejected',
              reason: 'Synthetic correction required',
            },
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await pool.query('select count(*)::int n from billing_eligibility_events where snapshot_id=$1', [
            calc2.id,
          ])
        ).rows[0].n,
        0,
      );
      const rejection = (
        await pool.query(
          "select rec.user_id,rec.reasons from tm_billing_eligibility_recipients rec join tm_billing_eligibility_notices ev on ev.id=rec.event_id where ev.instance_id=$1 and ev.event_key='approval.rejected_or_correction_required'",
          [rejectReq.id],
        )
      ).rows;
      assert.equal(rejection.length, 3);
      assert.deepEqual(rejection.find((x) => x.user_id === ids.requester.id).reasons, ['requester']);
      assert.deepEqual(rejection.find((x) => x.user_id === ids.manager.id).reasons, [
        'commercial_change_owner',
      ]);
      assert.deepEqual(rejection.find((x) => x.user_id === ids.reader.id).reasons, ['affected_worker']);
      const workerReject = (
        await pool.query(
          "select r.in_app,r.channel_decision from tm_billing_eligibility_recipients r join tm_billing_eligibility_notices n on n.id=r.event_id where n.instance_id=$1 and n.event_key='approval.rejected_or_correction_required' and r.user_id=$2",
          [rejectReq.id, ids.reader.id],
        )
      ).rows[0];
      assert.deepEqual(workerReject, { in_app: true, channel_decision: 'Required' });
      await pool.query(
        "insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)values('synthetic-billing-lead','SYN-BILLING-LEAD','Synthetic billing lead','synthetic-billing-lead@example.test','Manager','Delivery','US','director-commercial','Active',$1,$2)",
        [f.organizationId, f.legalEntityId],
      );
      await pool.query(
        "update users set employee_record_id='synthetic-billing-lead',employee_id='SYN-BILLING-LEAD' where id=$1",
        [ids.denied.id],
      );
      await pool.query("update employees set reporting_manager_id='synthetic-billing-lead' where id=$1", [
        f.ownerId,
      ]);
      for (const k of ['commercial.contracts.manage', 'commercial.tm_billing.manage'])
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
          [k],
        );
      const scopedReq = ok(
          await request(b + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: {
              ...requestBody,
              snapshotId: calc2.id,
              ownerUserId: ids.denied.id,
              ownerRole: 'TeamLead',
              requestId: randomUUID(),
            },
          }),
          201,
        ).approval,
        scopedView = ok(await request(b + '/instances/' + scopedReq.id, { identity: ids.manager }));
      await pool.query('update employees set reporting_manager_id=null where id=$1', [f.ownerId]);
      await pool.query("update employees set reporting_manager_id='synthetic-billing-lead' where id=$1", [
        f.ownerId,
      ]);
      assert.equal(
        (
          await pool.query('select count(*)::int n from tm_billing_owner_losses where instance_id=$1', [
            scopedReq.id,
          ])
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await request(b + '/instances/' + scopedReq.id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: {
              expectedOwnerKey: scopedView.ownerKey,
              requestId: randomUUID(),
              expectedSequence: 0,
              decision: 'Approved',
              reason: 'Synthetic stale owner scope',
            },
          })
        ).status,
        409,
        'Restoring a lost worker-scope witness must not revive the review',
      );
      const raceReq = ok(
          await request(b + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: { ...requestBody, snapshotId: calc3.id, requestId: randomUUID() },
          }),
          201,
        ).approval,
        raceFirst = ok(await request(b + '/instances/' + raceReq.id, { identity: ids.manager }));
      ok(
        await request(b + '/instances/' + raceReq.id + '/decisions', {
          method: 'POST',
          identity: ids.manager,
          body: {
            expectedOwnerKey: raceFirst.ownerKey,
            requestId: randomUUID(),
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic first stage',
          },
        }),
        201,
      );
      for (const pin of [{}, { expectedSequence: 0 }]) {
        const staleCancel = await request(b + '/instances/' + raceReq.id + '/cancellations', {
          method: 'POST', identity: ids.requester,
          body: { ...pin, expectedOwnerKey: requesterKey, requestId: randomUUID(), reason: 'Synthetic superseded stage' },
        });
        assert.equal(staleCancel.status, 409);
        assert.equal(staleCancel.body.error.code, 'TM_BILLING_STAGE_CHANGED');
      }
      const raceLast = ok(await request(b + '/instances/' + raceReq.id, { identity: ids.second })),
        raceBody = {
          expectedOwnerKey: raceLast.ownerKey,
          expectedSequence: 1,
          decision: 'Approved',
          reason: 'Synthetic competing final',
        },
        raced = await Promise.all([
          request(b + '/instances/' + raceReq.id + '/decisions', {
            method: 'POST',
            identity: ids.second,
            body: { ...raceBody, requestId: randomUUID() },
          }),
          request(b + '/instances/' + raceReq.id + '/decisions', {
            method: 'POST',
            identity: ids.second,
            body: { ...raceBody, requestId: randomUUID() },
          }),
        ]);
      assert.deepEqual(raced.map((x) => x.status).sort(), [201, 409]);
      assert.equal(
        (
          await pool.query('select count(*)::int n from billing_eligibility_events where snapshot_id=$1', [
            calc3.id,
          ])
        ).rows[0].n,
        1,
      );
      ok(
        await request(b + '/instances/' + scopedReq.id + '/cancellations', {
          method: 'POST',
          identity: ids.requester,
          body: {
            expectedOwnerKey: requesterKey,
            requestId: randomUUID(),
            reason: 'Synthetic stale scope cancellation',
          },
        }),
        201,
      );
      const stale = ok(
          await request(b + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: { ...requestBody, snapshotId: calc2.id, requestId: randomUUID() },
          }),
          201,
        ).approval,
        staleView = ok(await request(b + '/instances/' + stale.id, { identity: ids.manager }));
      const nextPolicy = ok(
        await request(b + '/policies', {
          method: 'POST',
          body: {
            expectedOwnerKey: initial.ownerKey,
            requestId: randomUUID(),
            engagementId: roots.engagement.id,
            expectedLatestId: policyResult.id,
            effectiveFrom: fx.today,
            definition: approvalDefinition,
            reason: 'Synthetic replacement policy',
          },
        }),
        201,
      ).policy;
      assert.equal(
        (
          await request(b + '/instances/' + stale.id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: {
              expectedOwnerKey: staleView.ownerKey,
              requestId: randomUUID(),
              expectedSequence: 0,
              decision: 'Approved',
              reason: 'Synthetic stale policy',
            },
          })
        ).status,
        409,
        'Policy supersession must invalidate old pending review',
      );
      ok(
        await request(b + '/instances/' + stale.id + '/cancellations', {
          method: 'POST',
          identity: ids.requester,
          body: {
            expectedOwnerKey: requesterKey,
            requestId: randomUUID(),
            reason: 'Synthetic policy cancellation',
          },
        }),
        201,
      );
      const fresh = ok(
        await request(b + '/requests', {
          method: 'POST',
          identity: ids.requester,
          body: {
            ...requestBody,
            snapshotId: calc2.id,
            expectedPolicyId: nextPolicy.id,
            requestId: randomUUID(),
          },
        }),
        201,
      ).approval;
      assert.equal(fresh.state.status, 'Pending');
      const advanced = ok(await request(b + '/instances/' + fresh.id + '/decisions', {
        method: 'POST', identity: ids.manager,
        body: { expectedOwnerKey: staleView.ownerKey, requestId: randomUUID(), expectedSequence: 0,
          decision: 'Approved', reason: 'Synthetic first billing decision' },
      }), 201).approval;
      const cancelBody = { expectedOwnerKey: requesterKey, requestId: randomUUID(),
        expectedSequence: advanced.state.sequence, reason: 'Synthetic inspected second stage' };
      const cancelPath = b + '/instances/' + fresh.id + '/cancellations';
      const writeCancel = (data) => request(cancelPath, { method: 'POST', identity: ids.requester, body: data });
      const recorded = ok(await writeCancel(cancelBody), 201).approval;
      assert.equal(recorded.state.sequence, 1);
      assert.equal(recorded.state.status, 'Cancelled');
      assert.equal(ok(await writeCancel(cancelBody)).replayed, true);
      assert.equal((await writeCancel({ ...cancelBody, expectedSequence: 0 })).status, 409);
      const recovered = ok(await request(b + '/receipts/cancellation/' + cancelBody.requestId, { identity: ids.requester }));
      assert.equal(recovered.approval.cancellation.id, recorded.cancellation.id);
      assert.equal(recovered.eventId, null);

      console.log('explicit staged review and billing event path passed in disposable PostgreSQL.');
    },
  );
});
