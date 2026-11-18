import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './support/compiled-fixture-server.mjs';
import { chromium } from 'playwright';

import { INVOICE_EXPORT_EVENT_KEYS } from '../shared/invoice-export-notification.mjs';
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
    'commercial.milestone_billing.view',
    'commercial.milestone_billing.manage',
    'commercial.milestone_billing.decide',
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
    'commercial.invoice_export.view',
    'commercial.invoice_export.create',
    'commercial.invoice_export.configure',
    'integrations.invoice_alert_routes.manage',
    'commercial.invoice_batch.confirm',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    {
      databaseUrl,
      identities: ids,
      onServerError: (s) => {
        for (const m of s.matchAll(/Diagnostic ([A-Z0-9]+) ([a-z_.]+) ([a-z0-9_]+)/gi))
          process.stderr.write('Sanitized diagnostic: ' + m[1] + ' ' + m[2] + ' ' + m[3] + '\n');
      },
    },
    async ({ request, baseUrl: apiUrl, tokenFor }) => {
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
        // Create a second governed source and a pending invoice review in the same database.
        const mroots = await createAmendmentHierarchy(request, 'SYN-MIXED-MILESTONE', {
          contract: {
            model: 'milestone',
            startsOn: fx.today,
            endsOn: end,
            effectiveFrom: fx.today,
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        });
        const m = ok(
          await request('/milestones', {
            method: 'POST',
            body: {
              engagementId: mroots.engagement.id,
              code: 'SYN-MIXED-1',
              name: 'Synthetic delivery',
              dueOn: fx.today,
              amount: '125.1500',
              currency: 'USD',
              reason: 'Synthetic milestone',
            },
          }),
          201,
        );
        const mr = '/api/v1/milestone-billing',
          mi = ok(await request(mr + '/policies?engagementId=' + mroots.engagement.id));
        const md = {
          entityType: 'MilestoneBillingEligibility',
          engagementId: mroots.engagement.id,
          evidenceKinds: ['INTERNAL_ASSERTION'],
          stages: [{ userId: ids.manager.id, role: 'Admin' }],
          locale: 'en-US',
          templates: keys.map((key) => ({
            key,
            subject: 'Review {{sourceRef}}',
            body: 'Stage {{stageNumber}}',
          })),
          completionInApp: false,
        };
        const mp = ok(
          await request(mr + '/policies', {
            method: 'POST',
            body: {
              expectedOwnerKey: mi.ownerKey,
              requestId: randomUUID(),
              engagementId: mroots.engagement.id,
              expectedLatestId: null,
              effectiveFrom: fx.today,
              definition: md,
              reason: 'Synthetic milestone policy',
            },
          }),
          201,
        ).policy;
        const mk = await readApprovalOwner(request, ids.requester),
          ma = ok(
            await request(mr + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: mk,
                requestId: randomUUID(),
                milestoneId: m.id,
                expectedPolicyId: mp.id,
                ownerUserId: ids.requester.id,
                ownerRole: 'Admin',
                evidence: [
                  {
                    kind: 'INTERNAL_ASSERTION',
                    reference: 'Synthetic accepted milestone',
                    url: 'https://example.test/acceptance',
                  },
                ],
                reason: 'Synthetic milestone review',
              },
            }),
            201,
          ).approval;
        const mv = ok(await request(mr + '/instances/' + ma.id, { identity: ids.manager })),
          mf = ok(
            await request(mr + '/instances/' + ma.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: {
                expectedOwnerKey: mv.ownerKey,
                requestId: randomUUID(),
                expectedSequence: 0,
                decision: 'Approved',
                reason: 'Synthetic milestone approval',
              },
            }),
            201,
          );
        const mcreate = {
          expectedOwnerKey: mi.ownerKey,
          requestId: randomUUID(),
          definition: {
            clientId: mroots.contract.clientId,
            contractId: mroots.contract.id,
            engagementId: mroots.engagement.id,
            currency: 'USD',
            periodStart: fx.today,
            periodEnd: fx.today,
            periodBasis: 'ELIGIBLE_DATE',
            ownerUserId: ids.manager.id,
            ownerRole: 'Admin',
          },
          reason: 'Synthetic milestone draft',
        };
        const mb = ok(await request(route + '/batches', { method: 'POST', body: mcreate }), 201);
        ok(
          await request(route + '/batches/' + mb.batch.id + '/lines', {
            method: 'POST',
            body: {
              expectedOwnerKey: mb.ownerKey,
              requestId: randomUUID(),
              itemId: mf.itemId,
              itemVersion: 1,
              expectedLineCount: 0,
              reason: 'Synthetic milestone reservation',
            },
          }),
          201,
        );
        const ip = { ...policyInput, engagementId: mroots.engagement.id },
          mpol = ok(
            await request(approvalRoute + '/policies', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: invoiceRequesterKey,
                requestId: randomUUID(),
                engagementId: mroots.engagement.id,
                expectedLatestId: null,
                effectiveFrom: fx.today,
                definition: ip,
                reason: 'Synthetic invoice policy',
              },
            }),
            201,
          ).policy;
        const ms = ok(
            await request(approvalRoute + '/sources/' + mb.batch.id, { identity: ids.requester }),
          ).batch,
          mreview = ok(
            await request(approvalRoute + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: invoiceRequesterKey,
                requestId: randomUUID(),
                batchId: mb.batch.id,
                expectedPolicyId: mpol.id,
                expectedLineCount: ms.lineCount,
                expectedLineageHash: ms.lineageHash,
                reason: 'Synthetic invoice review',
              },
            }),
            201,
          ).approval;
        const vite = await startFixtureServer({
          root: fileURLToPath(new URL('../', import.meta.url)),
          fixtures: ['milestone-invoice-bulk'],
          apiUrl,
        });
        let browser, ctx;
        try {
          const origin = vite.url;
          browser = await chromium.launch({ headless: true });
          ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, timezoneId: 'UTC' });
          const permissions = [
            'commercial.contracts.view',
            'commercial.tm_billing.view',
            'commercial.milestone_billing.view',
            'commercial.invoice_drafts.view',
            'commercial.invoice_approval.decide',
            'approvals.view',
            'employees.view',
            'notifications.view',
          ];
          await ctx.addInitScript(
            ({ user, scope, token }) => {
              sessionStorage.setItem('workos_session', JSON.stringify(user));
              sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
              sessionStorage.setItem('workos_api_token', token);
            },
            {
              user: {
                id: ids.manager.id,
                employeeId: ids.manager.id,
                userName: ids.manager.username,
                role: 'Admin',
                permissionRole: 'Admin',
                permissions,
              },
              scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId },
              token: tokenFor(ids.manager),
            },
          );
          const page = await ctx.newPage();
          page.setDefaultTimeout(20000);
          const query = new URLSearchParams();
          query.append('engagement', roots.engagement.id);
          query.append('engagement', mroots.engagement.id);
          await page.goto(origin + '/tests/fixtures/milestone-invoice-bulk.html?' + query);
          const ui = page.getByRole('region', { name: 'Reviewed invoice bulk decisions' });
          for (const [engagement, review] of [
            [roots.engagement.id, submitted],
            [mroots.engagement.id, mreview],
          ]) {
            await ui.getByLabel('Invoice bulk engagement').selectOption(engagement);
            await ui.getByLabel('Invoice bulk review reference').fill(review.id);
            await ui.getByRole('button', { name: 'Inspect invoice bulk source' }).click();
            await ui.getByRole('article', { name: 'Invoice bulk retained source' }).waitFor();
            await ui.getByLabel('Invoice bulk decision').selectOption('Approved');
            await ui.getByLabel('Invoice bulk reason').fill('Synthetic reviewed bulk decision');
            await ui.getByLabel('I inspected this retained source and stage').check();
            await ui.getByRole('button', { name: 'Add reviewed invoice' }).click();
          }
          // Change the milestone after inspection: the queued stale command must fail independently.
          const staleView = ok(
            await request(approvalRoute + '/instances/' + mreview.id, { identity: ids.manager }),
          );
          ok(
            await request(approvalRoute + '/instances/' + mreview.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: {
                expectedOwnerKey: staleView.ownerKey,
                requestId: randomUUID(),
                expectedSequence: 0,
                decision: 'Approved',
                reason: 'Synthetic independent stage decision',
              },
            }),
            201,
          );
          await ui.getByRole('button', { name: 'Execute reviewed invoice decisions' }).click();
          await ui
            .getByRole('article', { name: 'Reviewed invoice ' + submitted.id })
            .getByText(/Confirmed/)
            .waitFor();
          await ui
            .getByRole('article', { name: 'Reviewed invoice ' + mreview.id })
            .getByText(/Denied/)
            .waitFor();
          for (const id of [submitted.id, mreview.id]) {
            const a = ok(
              await request(approvalRoute + '/instances/' + id, { identity: ids.manager }),
            ).approval;
            assert.equal(a.state.sequence, 1);
            assert.equal(a.state.status, 'Pending');
          }
          assert.equal(
            (
              await pool.query(
                'select count(*)::int n from invoice_draft_occupancies where batch_id=any($1::uuid[])',
                [[draft.batch.id, mb.batch.id]],
              )
            ).rows[0].n,
            2,
          );
          console.log('Real React/API/PostgreSQL mixed T&M and stale milestone bulk outcomes verified.');
        } finally {
          await ctx?.close();
          await browser?.close();
          await vite.close();
        }
      }
    },
  );
});
