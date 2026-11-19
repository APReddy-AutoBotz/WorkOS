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
    'commercial.invoice_drafts.view',
    'commercial.invoice_drafts.prepare',
    'commercial.invoice_drafts.own',
    'commercial.invoice_drafts.cancel',
    'commercial.invoice_approval.manage',
    'commercial.invoice_approval.decide',
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

      {
        const route = '/api/v1/invoice-drafts',
          approvalRoute = '/api/v1/invoice-batch-approvals',
          item = ok(await request(b + '/register')).items[0];
        assert(item);
        const create = {
            expectedOwnerKey: initial.ownerKey,
            requestId: randomUUID(),
            definition: {
              clientId: roots.contract.clientId,
              contractId: roots.contract.id,
              engagementId: roots.engagement.id,
              currency: 'USD',
              periodStart: fx.today,
              periodEnd: fx.today,
              periodBasis: 'WORK_DATE',
              ownerUserId: ids.manager.id,
              ownerRole: 'Admin',
            },
            reason: 'Synthetic invoice draft',
          },
          draft = ok(await request(route + '/batches', { method: 'POST', body: create }), 201);
        ok(
          await request(route + '/batches/' + draft.batch.id + '/lines', {
            method: 'POST',
            body: {
              expectedOwnerKey: draft.ownerKey,
              requestId: randomUUID(),
              itemId: item.id,
              itemVersion: 1,
              expectedLineCount: 0,
              reason: 'Synthetic reserve',
            },
          }),
          201,
        );
        const policyInput = {
            entityType: 'InvoiceBatch',
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
          },
          invoiceRequesterKey = await readApprovalOwner(request, ids.requester),
          policy = ok(
            await request(approvalRoute + '/policies', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: invoiceRequesterKey,
                requestId: randomUUID(),
                engagementId: roots.engagement.id,
                expectedLatestId: null,
                effectiveFrom: fx.today,
                definition: policyInput,
                reason: 'Synthetic invoice policy',
              },
            }),
            201,
          ).policy,
          source = ok(
            await request(approvalRoute + '/sources/' + draft.batch.id, { identity: ids.requester }),
          ).batch,
          requestCommand = {
            expectedOwnerKey: invoiceRequesterKey,
            requestId: randomUUID(),
            batchId: draft.batch.id,
            expectedPolicyId: policy.id,
            expectedLineCount: source.lineCount,
            expectedLineageHash: source.lineageHash,
            reason: 'Synthetic invoice review',
          },
          submitted = ok(
            await request(approvalRoute + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: requestCommand,
            }),
            201,
          ).approval;
        assert.equal(submitted.state.status, 'Pending');
        assert.equal(ok(await request(route + '/batches/' + draft.batch.id)).batch.state, 'Under Review');
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft.batch.id,
            ])
          ).rows[0].n,
          1,
        );
        assert.equal(
          ok(
            await request(approvalRoute + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: requestCommand,
            }),
          ).replayed,
          true,
        );
        const inbox = ok(await request(work + '/inbox', { identity: ids.manager }));
        assert(
          inbox.notifications.some(
            (x) => x.kind === 'invoice-batch-approval' && x.instanceId === submitted.id,
          ),
        );
        const decision = async (who, sequence, kind = 'Approved') => {
          const v = ok(await request(approvalRoute + '/instances/' + submitted.id, { identity: who }));
          return request(approvalRoute + '/instances/' + submitted.id + '/decisions', {
            method: 'POST',
            identity: who,
            body: {
              expectedOwnerKey: v.ownerKey,
              requestId: randomUUID(),
              expectedSequence: sequence,
              decision: kind,
              reason: 'Synthetic invoice stage',
            },
          });
        };
        const inspectCancellation = async (id) =>
          ok(await request(route + '/batches/' + id + '?forCancellation=true')).cancellationToken;
        const staleCancellation = async (token) =>
          request(route + '/batches/' + draft.batch.id + '/cancellations', {
            method: 'POST',
            body: {
              expectedOwnerKey: draft.ownerKey,
              requestId: randomUUID(),
              expectedLineCount: 1,
              expectedCancellationToken: token,
              reason: 'Synthetic stale inspected cancellation',
            },
          });
        const firstStageToken = await inspectCancellation(draft.batch.id);
        assert.equal((await decision(ids.manager, 0)).status, 201);
        assert.equal((await staleCancellation(firstStageToken)).body.code, 'INVOICE_CANCELLATION_STALE');
        const lastStageToken = await inspectCancellation(draft.batch.id);
        assert.notEqual(lastStageToken, firstStageToken);

        assert.equal(ok(await request(route + '/batches/' + draft.batch.id)).batch.state, 'Under Review');
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft.batch.id,
            ])
          ).rows[0].n,
          1,
        );
        const final = ok(await decision(ids.second, 1), 201);
        assert.equal(final.approval.state.status, 'Approved');
        assert.equal((await staleCancellation(lastStageToken)).status, 409);
        assert.equal((await staleCancellation(undefined)).status, 409);
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft.batch.id,
            ])
          ).rows[0].n,
          1,
        );

        assert.equal(ok(await request(route + '/batches/' + draft.batch.id)).batch.state, 'Approved');
        await assert.rejects(
          pool.query(
            "update approval_records set source='Synthetic rewrite' where entity_type='InvoiceBatchApproval' and entity_id=$1",
            [submitted.id],
          ),
          (e) => e.code === 'IBA02',
        );
        assert.equal(
          (await request('/api/approvals')).body.some((x) => x.entity_type === 'InvoiceBatchApproval'),
          false,
        );
        const generic = (
          await pool.query(
            "select id from approval_records where entity_type='InvoiceBatchApproval' and entity_id=$1",
            [submitted.id],
          )
        ).rows[0];
        assert.equal(
          (
            await request('/api/approvals/' + generic.id + '/status', {
              method: 'PATCH',
              body: { status: 'Approved' },
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await request(approvalRoute + '/instances/' + submitted.id + '/withdrawals', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: invoiceRequesterKey,
                requestId: randomUUID(),
                reason: 'Synthetic forbidden reopen',
              },
            })
          ).status,
          409,
        );
        const cancelCommand = {
          expectedOwnerKey: draft.ownerKey,
          requestId: randomUUID(),
          expectedLineCount: 1,
          expectedCancellationToken: await inspectCancellation(draft.batch.id),
          reason: 'Synthetic approved cancellation',
        };
        const cancelApproved = (body) =>
          request(route + '/batches/' + draft.batch.id + '/cancellations', { method: 'POST', body });
        const cancelled = ok(await cancelApproved(cancelCommand), 201);
        const replay = ok(await cancelApproved(cancelCommand));
        assert.equal(replay.replayed, true);
        assert.equal(replay.cancellation.id, cancelled.cancellation.id);
        assert.equal(
          (await cancelApproved({ ...cancelCommand, expectedCancellationToken: firstStageToken })).status,
          409,
        );
        assert.equal(cancelled.batch.state, 'Cancelled');
        assert.equal(cancelled.lines.length, 1);
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft.batch.id,
            ])
          ).rows[0].n,
          0,
        );
        assert.equal(ok(await request(b + '/register')).items[0].id, item.id);

        const draft2 = ok(
          await request(route + '/batches', { method: 'POST', body: { ...create, requestId: randomUUID() } }),
          201,
        );
        ok(
          await request(route + '/batches/' + draft2.batch.id + '/lines', {
            method: 'POST',
            body: {
              expectedOwnerKey: draft2.ownerKey,
              requestId: randomUUID(),
              itemId: item.id,
              itemVersion: 1,
              expectedLineCount: 0,
              reason: 'Synthetic second reserve',
            },
          }),
          201,
        );
        const source2 = ok(
            await request(approvalRoute + '/sources/' + draft2.batch.id, { identity: ids.requester }),
          ).batch,
          command2 = {
            ...requestCommand,
            requestId: randomUUID(),
            batchId: draft2.batch.id,
            expectedLineCount: source2.lineCount,
            expectedLineageHash: source2.lineageHash,
          },
          review2 = ok(
            await request(approvalRoute + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: command2,
            }),
            201,
          ).approval,
          review2Manager = ok(
            await request(approvalRoute + '/instances/' + review2.id, { identity: ids.manager }),
          ),
          rejectCmd = {
            expectedOwnerKey: review2Manager.ownerKey,
            requestId: randomUUID(),
            expectedSequence: 0,
            decision: 'Rejected',
            reason: 'Synthetic reviewed rejection',
          };
        await pool.query("update users set status='Inactive' where id=$1", [ids.reader.id]);
        assert.equal(
          (
            await request(approvalRoute + '/instances/' + review2.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: rejectCmd,
            })
          ).status,
          409,
          'A missing affected-worker relationship fails closed',
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review2.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_notices where instance_id=$1 and transition_sequence=1',
              [review2.id],
            )
          ).rows[0].n,
          0,
        );
        await pool.query("update users set status='Active' where id=$1", [ids.reader.id]);
        await pool.query(
          "create function synthetic_invoice_recipient_refusal() returns trigger language plpgsql as $$begin raise exception 'Synthetic recipient refusal' using errcode='IBA03';end$$;create trigger synthetic_invoice_recipient_refusal before insert on invoice_batch_approval_recipients for each row execute function synthetic_invoice_recipient_refusal()",
        );
        assert.equal(
          (
            await request(approvalRoute + '/instances/' + review2.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: rejectCmd,
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review2.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_notices where instance_id=$1 and transition_sequence=1',
              [review2.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft2.batch.id,
            ])
          ).rows[0].n,
          1,
        );
        await pool.query(
          'drop trigger synthetic_invoice_recipient_refusal on invoice_batch_approval_recipients;drop function synthetic_invoice_recipient_refusal()',
        );
        const rejected = ok(
          await request(approvalRoute + '/instances/' + review2.id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: rejectCmd,
          }),
          201,
        );
        assert.equal(rejected.approval.state.status, 'Rejected');
        assert.equal(ok(await request(route + '/batches/' + draft2.batch.id)).batch.state, 'Draft');
        const reasons = (
          await pool.query(
            "select r.user_id,r.reasons from invoice_batch_approval_recipients r join invoice_batch_approval_notices n on n.id=r.event_id where n.instance_id=$1 and n.event_key='approval.rejected_or_correction_required' order by r.user_id",
            [review2.id],
          )
        ).rows;
        assert(reasons.some((x) => x.user_id === ids.requester.id && x.reasons.includes('requester')));
        assert(
          reasons.some(
            (x) =>
              x.user_id === ids.manager.id &&
              x.reasons.includes('invoice_batch_owner') &&
              x.reasons.includes('finance_preparer'),
          ),
        );
        assert(reasons.some((x) => x.user_id === ids.reader.id && x.reasons.includes('affected_worker')));
        assert.equal(
          ok(
            await request(approvalRoute + '/instances/' + review2.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: rejectCmd,
            }),
          ).replayed,
          true,
        );
        const current2 = ok(
            await request(approvalRoute + '/sources/' + draft2.batch.id, { identity: ids.requester }),
          ).batch,
          review3 = ok(
            await request(approvalRoute + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: {
                ...command2,
                requestId: randomUUID(),
                expectedLineCount: current2.lineCount,
                expectedLineageHash: current2.lineageHash,
              },
            }),
            201,
          ).approval;
        for (const k of [
          'commercial.invoice_drafts.view',
          'commercial.invoice_approval.decide',
          'approvals.view',
        ])
          await pool.query(
            "insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
            [k],
          );
        assert.equal(
          (await request(approvalRoute + '/instances/' + review3.id, { identity: ids.denied })).status,
          404,
          'A foreign worker review remains hidden despite held view permission',
        );
        const self = await request(approvalRoute + '/instances/' + review3.id + '/decisions', {
          method: 'POST',
          identity: ids.requester,
          body: {
            expectedOwnerKey: invoiceRequesterKey,
            requestId: randomUUID(),
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic self denial',
          },
        });
        assert.equal(self.status, 409);
        const view3 = ok(
            await request(approvalRoute + '/instances/' + review3.id, { identity: ids.manager }),
          ),
          sameDecision = {
            expectedOwnerKey: view3.ownerKey,
            requestId: randomUUID(),
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic concurrent stage',
          },
          sameResults = await Promise.all([
            request(approvalRoute + '/instances/' + review3.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: sameDecision,
            }),
            request(approvalRoute + '/instances/' + review3.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: sameDecision,
            }),
          ]);
        assert.deepEqual(sameResults.map((x) => x.status).sort(), [200, 201]);
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review3.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_notices where instance_id=$1 and transition_sequence=1',
              [review3.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await request(approvalRoute + '/instances/' + review3.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: { ...sameDecision, reason: 'Changed payload' },
            })
          ).status,
          409,
        );
        const pendingCancel = ok(
          await request(route + '/batches/' + draft2.batch.id + '/cancellations', {
            method: 'POST',
            body: {
              expectedOwnerKey: draft2.ownerKey,
              requestId: randomUUID(),
              expectedLineCount: 1,
              expectedCancellationToken: await inspectCancellation(draft2.batch.id),
              reason: 'Synthetic pending cancellation',
            },
          }),
          201,
        );
        assert.equal(pendingCancel.batch.state, 'Cancelled');
        assert.equal(
          (
            await pool.query('select status from approval_records where entity_type=$1 and entity_id=$2', [
              'InvoiceBatchApproval',
              review3.id,
            ])
          ).rows[0].status,
          'Cancelled',
        );
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft2.batch.id,
            ])
          ).rows[0].n,
          0,
        );
        assert.equal(pendingCancel.lines.length, 1);
        assert.equal(ok(await request(b + '/register')).items[0].id, item.id);

        const draft3 = ok(
          await request(route + '/batches', { method: 'POST', body: { ...create, requestId: randomUUID() } }),
          201,
        );
        ok(
          await request(route + '/batches/' + draft3.batch.id + '/lines', {
            method: 'POST',
            body: {
              expectedOwnerKey: draft3.ownerKey,
              requestId: randomUUID(),
              itemId: item.id,
              itemVersion: 1,
              expectedLineCount: 0,
              reason: 'Synthetic owner loss reserve',
            },
          }),
          201,
        );
        const source3 = ok(
            await request(approvalRoute + '/sources/' + draft3.batch.id, { identity: ids.requester }),
          ).batch,
          review4 = ok(
            await request(approvalRoute + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: {
                ...requestCommand,
                requestId: randomUUID(),
                batchId: draft3.batch.id,
                expectedLineCount: source3.lineCount,
                expectedLineageHash: source3.lineageHash,
              },
            }),
            201,
          ).approval;
        assert.equal(
          (
            await request(route + '/batches/' + draft3.batch.id + '/lines', {
              method: 'POST',
              body: {
                expectedOwnerKey: draft3.ownerKey,
                requestId: randomUUID(),
                itemId: item.id,
                itemVersion: 1,
                expectedLineCount: 1,
                reason: 'Synthetic forbidden reviewed edit',
              },
            })
          ).status,
          409,
        );
        await assert.rejects(
          pool.query(
            "update approval_records set status='Approved' where entity_type='InvoiceBatchApproval' and entity_id=$1",
            [review4.id],
          ),
          (e) => e.code === 'IBA02',
        );
        await pool.query("update users set status='Inactive' where id=$1", [ids.manager.id]);
        await pool.query("update users set status='Active' where id=$1", [ids.manager.id]);
        const stale4 = ok(
          await request(approvalRoute + '/instances/' + review4.id, { identity: ids.manager }),
        );
        assert.equal(
          stale4.approval.current,
          false,
          'An owner restored after committed eligibility loss cannot revive the old review',
        );
        assert.equal(
          (
            await request(approvalRoute + '/instances/' + review4.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: {
                expectedOwnerKey: stale4.ownerKey,
                requestId: randomUUID(),
                expectedSequence: 0,
                decision: 'Approved',
                reason: 'Synthetic stale denial',
              },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review4.id],
            )
          ).rows[0].n,
          0,
        );
        const staleCancelled = ok(
          await request(route + '/batches/' + draft3.batch.id + '/cancellations', {
            method: 'POST',
            body: {
              expectedOwnerKey: draft3.ownerKey,
              requestId: randomUUID(),
              expectedLineCount: 1,
              expectedCancellationToken: await inspectCancellation(draft3.batch.id),
              reason: 'Synthetic stale cancellation',
            },
          }),
          201,
        );
        assert.equal(staleCancelled.batch.state, 'Cancelled');
        assert.equal(ok(await request(b + '/register')).items[0].id, item.id);

        const draft4 = ok(
          await request(route + '/batches', {
            method: 'POST',
            body: {
              ...create,
              requestId: randomUUID(),
              definition: { ...create.definition, ownerUserId: ids.second.id },
            },
          }),
          201,
        );
        ok(
          await request(route + '/batches/' + draft4.batch.id + '/lines', {
            method: 'POST',
            body: {
              expectedOwnerKey: draft4.ownerKey,
              requestId: randomUUID(),
              itemId: item.id,
              itemVersion: 1,
              expectedLineCount: 0,
              reason: 'Synthetic race reserve',
            },
          }),
          201,
        );
        const source4 = ok(
            await request(approvalRoute + '/sources/' + draft4.batch.id, { identity: ids.requester }),
          ).batch,
          review5 = ok(
            await request(approvalRoute + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: {
                ...requestCommand,
                requestId: randomUUID(),
                batchId: draft4.batch.id,
                expectedLineCount: source4.lineCount,
                expectedLineageHash: source4.lineageHash,
              },
            }),
            201,
          ).approval,
          v5 = ok(await request(approvalRoute + '/instances/' + review5.id, { identity: ids.manager }));
        await pool.query(
          "create function synthetic_invoice_owner_loss_during_decision() returns trigger language plpgsql as $$begin update users set status='Inactive' where id=(select owner_user_id from invoice_batch_approval_instances where id=new.instance_id);return new;end$$;create trigger synthetic_invoice_owner_loss_during_decision after insert on invoice_batch_approval_transitions for each row execute function synthetic_invoice_owner_loss_during_decision()",
        );
        const lost = await request(approvalRoute + '/instances/' + review5.id + '/decisions', {
          method: 'POST',
          identity: ids.manager,
          body: {
            expectedOwnerKey: v5.ownerKey,
            requestId: randomUUID(),
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic owner loss race',
          },
        });
        assert([403, 409].includes(lost.status));
        assert.equal(
          (await pool.query('select status from users where id=$1', [ids.second.id])).rows[0].status,
          'Active',
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review5.id],
            )
          ).rows[0].n,
          0,
        );
        await pool.query(
          'drop trigger synthetic_invoice_owner_loss_during_decision on invoice_batch_approval_transitions;drop function synthetic_invoice_owner_loss_during_decision()',
        );
        const compete = {
            expectedOwnerKey: v5.ownerKey,
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic competing decision',
          },
          race5 = await Promise.all([
            request(approvalRoute + '/instances/' + review5.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: { ...compete, requestId: randomUUID() },
            }),
            request(approvalRoute + '/instances/' + review5.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: { ...compete, requestId: randomUUID() },
            }),
          ]);
        assert.deepEqual(race5.map((x) => x.status).sort(), [201, 409]);
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review5.id],
            )
          ).rows[0].n,
          1,
        );
        const finalView = ok(
            await request(approvalRoute + '/instances/' + review5.id, { identity: ids.second }),
          ),
          finalCompete = {
            expectedOwnerKey: finalView.ownerKey,
            expectedSequence: 1,
            decision: 'Approved',
            reason: 'Synthetic competing final',
          },
          finalRace = await Promise.all([
            request(approvalRoute + '/instances/' + review5.id + '/decisions', {
              method: 'POST',
              identity: ids.second,
              body: { ...finalCompete, requestId: randomUUID() },
            }),
            request(approvalRoute + '/instances/' + review5.id + '/decisions', {
              method: 'POST',
              identity: ids.second,
              body: { ...finalCompete, requestId: randomUUID() },
            }),
          ]);
        assert.deepEqual(finalRace.map((x) => x.status).sort(), [201, 409]);
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review5.id],
            )
          ).rows[0].n,
          2,
        );
        assert.equal(ok(await request(route + '/batches/' + draft4.batch.id)).batch.state, 'Approved');
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft4.batch.id,
            ])
          ).rows[0].n,
          1,
        );
        console.log('configured invoice review and cancellation via disposable real API/PostgreSQL passed.');
      }
    },
  );
});
