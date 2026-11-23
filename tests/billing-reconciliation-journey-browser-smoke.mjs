import {runMigrations} from '../server/migrate.mjs';
import {verifyPurchaseOrderNotices} from './support/purchase-order-risk-delivery.mjs';
import { canonicalHours } from '../shared/work-hours.mjs';
import { INVOICE_EXPORT_EVENT_KEYS } from '../shared/invoice-export-notification.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './support/compiled-fixture-server.mjs';
import { chromium } from 'playwright';
import { workPermissions } from './support/work-assignment-test.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialFixture as f,
  withCommercialDatabase,
  withCommercialMigrationsThrough,
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
  adoptTmHierarchyAmendment,
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
  const historicalOrder=process.argv.includes('--reject-reversal');
  if (historicalOrder) await withCommercialMigrationsThrough(109,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
  else await migrateCommercialDatabase(pool);
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
    'commercial.purchase_orders.release',
    'commercial.invoice_drafts.own',
    'commercial.invoice_drafts.cancel',
    'commercial.invoice_approval.manage',
    'commercial.invoice_approval.decide',
    'commercial.invoice_export.view',
    'commercial.invoice_export.create',
    'commercial.invoice_export.configure',
    'integrations.invoice_alert_routes.manage',
    'commercial.invoice_export.recover_notices',
    'commercial.invoice_batch.confirm',
    'reports.export',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
    async ({ request, tokenFor, baseUrl: apiUrl }) => {
      const end = shift(fx.today, 30),
        roots = await createAmendmentHierarchy(request, 'SYN-TM-VAL', {
          contract: {
            model: 'time_and_materials',
            startsOn: shift(fx.today,-1),
            endsOn: end,
            effectiveFrom: shift(fx.today,-1),
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        });
      const amendment=await adoptTmHierarchyAmendment(pool, request, ids.manager, roots, fx.today, end);
      for (const [number,value] of [['SYN-PO-100','100'],['SYN-PO-79','79']]) {
        const po=ok(await request('/purchase-orders',{method:'POST',body:{number,value,contractId:roots.contract.id,
          contractVersionId:amendment.version.id,currency:'USD',startsOn:fx.today,endsOn:end,warningThresholdPercent:'80',
          reason:'Synthetic purchase order'}}),201);
        ok(await request('/purchase-orders/'+po.id+'/release',{method:'POST',identity:ids.requester,body:{
          contractVersionId:amendment.version.id,approvalReference:'SYN-authorized',reason:'Approved synthetic allocation limit'}}),201);
      }
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
          version: 'governed-tm/2',
          currency: 'USD',
          precision: 2,
          rounding: 'HALF_UP',
          aggregation: 'PER_ENTRY',
          capTreatment: 'PER_ENTRY_VALUE',
          capAmount: '80.00',
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
          item = ok(await request(b + '/register')).items[0],
          draft = ok(
            await request(route + '/batches', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: await readApprovalOwner(request, ids.requester),
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
            }),
            201,
          );
        ok(
          await request(route + '/batches/' + draft.batch.id + '/lines', {
            method: 'POST',
            identity: ids.requester,
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
        const invoiceRequesterKey = await readApprovalOwner(request, ids.requester),
          policyInput = {
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
          };
        const config = '/api/v1/invoice-export-notice-config',
          configOwner = await readApprovalOwner(request, ids.manager),
          routeConfig = ok(
            await request(config + '/routes', {
              identity: ids.manager,
              method: 'POST',
              body: {
                expectedOwnerKey: configOwner,
                requestId: randomUUID(),
                routeKey: randomUUID(),
                expectedLatestId: null,
                label: 'Synthetic internal alert',
                active: true,
                reason: 'Synthetic route configuration',
              },
            }),
            201,
          ).route,
          noticeDefinition = {
            entityType: 'InvoiceExport',
            engagementId: roots.engagement.id,
            financeOwner: { userId: ids.manager.id, role: 'Admin' },
            integrationAdmin: { userId: ids.second.id, role: 'Admin' },
            alertRouteId: routeConfig.id,
            locale: 'en-US',
            templates: INVOICE_EXPORT_EVENT_KEYS.map((key) => ({
              key,
              subject: 'Invoice {{sourceRef}}',
              body: 'Synthetic status {{sourceRef}}',
            })),
            completionInApp: true,
          };
        ok(
          await request(config + '/policies', {
            identity: ids.manager,
            method: 'POST',
            body: {
              expectedOwnerKey: configOwner,
              requestId: randomUUID(),
              expectedLatestId: null,
              effectiveFrom: fx.today,
              definition: noticeDefinition,
              reason: 'Synthetic notice policy',
            },
          }),
          201,
        );
        const fixture = await startFixtureServer({
          root: fileURLToPath(new URL('../', import.meta.url)),
          fixtures: ['invoice-csv'],
          apiUrl,
        });
        let browser;
        const contexts = [];
        try {
          const origin = fixture.url;
          browser = await chromium.launch({ headless: true });
          const open = async (identity,sessionId=identity.id) => {
            const ctx = await browser.newContext({
              viewport: { width: 1800, height: 1400 },
              timezoneId: 'UTC',
            });
            contexts.push(ctx);
            await ctx.addInitScript(
              ({ user, scope, token }) => {
                sessionStorage.setItem('workos_session', JSON.stringify(user));
                sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
                sessionStorage.setItem('workos_api_token', token);
              },
              {
                user: {
                  id: sessionId,
                  employeeId: sessionId,
                  userName: identity.username,
                  name: 'Synthetic invoice actor',
                  role: 'Admin',
                  permissionRole: 'Admin',
                  permissions: [
                    ...workPermissions,
                    'notifications.view',
                    'commercial.contracts.view',
                    'commercial.contracts.manage',
                    'commercial.purchase_orders.release',
                    'commercial.tm_billing.view',
                    'commercial.invoice_drafts.view',
                    'commercial.invoice_drafts.prepare',
                    'commercial.reversal_eligibility.create',
                    'commercial.invoice_drafts.cancel',
                    'commercial.invoice_drafts.own',
                    'commercial.invoice_approval.manage',
                    'commercial.invoice_approval.decide',
                    'commercial.invoice_export.view',
                    'commercial.rate_candidates.view',
                    'commercial.invoice_export.create',
                    'commercial.invoice_export.configure',
                    'integrations.invoice_alert_routes.manage',
                    'commercial.invoice_export.recover_notices',
                    'commercial.invoice_batch.confirm',
                    'reports.export',
                  ],
                },
                scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId },
                token: tokenFor(identity),
              },
            );
            const p = await ctx.newPage(),
              errors = [],
              external = [];
            p.setDefaultTimeout(25000);
            p.on('pageerror', (e) => errors.push(e.stack ?? e.message));
            p.on('request', (q) => {
              if (/^https?:/.test(q.url()) && new URL(q.url()).origin !== origin) external.push(q.url());
            });
            await p.goto(
              origin +
                '/tests/fixtures/invoice-csv.html?' +
                new URLSearchParams({ engagement: roots.engagement.id }),
            );
            const ui = p.getByRole('region', { name: 'Invoice batch approvals' });
            await ui.getByLabel('Invoice approval engagement').selectOption(roots.engagement.id);
            return { p, ui, errors, external };
          };
          const wait = (p, path, method = 'GET') =>
              p.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === method),
            body = async (w, status = 200) => {
              const r = await w;
              assert.equal(r.status(), status, await r.text());
              return r.json();
            };
          const load = async ({ p, ui }) => {
            const pol = wait(p, approvalRoute + '/policies'),
              ins = wait(p, approvalRoute + '/instances'),
              drafts = wait(p, route + '/batches');
            await ui.getByRole('button', { name: 'Load invoice batches and reviews' }).click();
            await Promise.all([body(pol), body(ins), body(drafts)]);
          };
          const requester = await open(ids.requester);
          await load(requester);
          let { p, ui } = requester;
          await ui.getByLabel('Invoice approval policy effective from').fill(fx.today);
          await ui.getByLabel('Invoice approval policy locale').fill('en-US');
          await ui.getByLabel('Invoice approval completion in-app').selectOption('yes');
          await ui.getByLabel('Use these named review stages for full-line reversal requests').check();
          await ui.getByLabel('Invoice approval stage 1 user ID').fill(ids.manager.id);
          await ui.getByLabel('Invoice approval stage 1 role').fill('Admin');
          await ui.getByRole('button', { name: 'Add invoice approval stage' }).click();
          await ui.getByLabel('Invoice approval stage 2 user ID').fill(ids.second.id);
          await ui.getByLabel('Invoice approval stage 2 role').fill('Admin');
          for (const k of keys) {
            await ui.getByLabel(k + ' invoice approval subject').fill('Review {{sourceRef}}');
            await ui.getByLabel(k + ' invoice approval body').fill('Stage {{stageNumber}}');
          }
          await ui.getByLabel('Invoice approval policy reason').fill('Synthetic policy');
          let policyWait = wait(p, approvalRoute + '/policies', 'POST');
          await ui.getByRole('button', { name: 'Record invoice approval policy' }).click();
          const policy = (await body(policyWait, 201)).policy;
          assert.equal(policy.definition.fullLineReversals, true);
          await ui
            .getByText('Operation recorded. Reload the current batch and reviews before another action.')
            .waitFor();
          await load(requester);
          await ui.getByLabel('Invoice approval Draft').selectOption(draft.batch.id);
          let w = wait(p, approvalRoute + '/sources/' + draft.batch.id);
          await ui.getByRole('button', { name: 'Inspect invoice Draft source' }).click();
          const source = await body(w);
          assert.equal(source.batch.lineCount, 1);
          await ui.getByLabel('I inspected the retained lineage and control total').check();
          await ui.getByLabel('Invoice batch review policy').selectOption(policy.id);
          await ui.getByLabel('Invoice approval request reason').fill('Synthetic review');
          let accepted, notify;
          const done = new Promise((resolve) => {
            notify = resolve;
          });
          await p.route(
            '**/api/v1/invoice-batch-approvals/requests',
            async (intercepted) => {
              const response = await intercepted.fetch();
              assert.equal(response.status(), 201, await response.text());
              accepted = await response.json();
              notify();
              await intercepted.abort('failed');
            },
            { times: 1 },
          );
          await ui.getByRole('button', { name: 'Submit invoice Draft for review' }).click();
          await done;
          const review = accepted.approval;
          await ui.getByText(/may still be in flight/).waitFor();
          w = wait(p, approvalRoute + '/receipts/request/' + review.requestId);
          await ui.getByRole('button', { name: 'Read original invoice approval receipt' }).click();
          assert.equal((await body(w)).approval.id, review.id);
          await ui.getByText('The original request was confirmed by a read-only receipt. Reload.').waitFor();
          assert.equal(
            (
              await pool.query(
                'select count(*)::int n from invoice_batch_approval_instances where batch_id=$1',
                [draft.batch.id],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(ok(await request(route + '/batches/' + draft.batch.id)).batch.state, 'Under Review');
          for (const [identity, sequence] of [
            [ids.manager, 0],
            [ids.second, 1],
          ]) {
            const actor = await open(identity);
            await load(actor);
            const a = actor.ui,
              page = actor.p;
            if (sequence === 0) {
              const inbox = page.getByRole('region', { name: 'Canonical work approval notifications' }),
                inboxWait = wait(page, work + '/inbox');
              await inbox.getByRole('button', { name: 'Load my governed notifications' }).click();
              const inboxData = await body(inboxWait),
                notice = inboxData.notifications.find(
                  (x) => x.kind === 'invoice-batch-approval' && x.instanceId === review.id,
                );
              assert(notice, 'Named approver receives canonical in-app event');
              const card = inbox.getByRole('article', { name: 'Governed notification ' + notice.id });
              await card.getByText(/Invoice batch/).waitFor();
              const readWait = wait(page, work + '/inbox/' + notice.id + '/read', 'POST');
              await card
                .getByRole('button', { name: 'Mark governed notification read ' + notice.id })
                .click();
              assert((await body(readWait)).notification.readAt);
            }
            await a.getByLabel('Invoice batch review', { exact: true }).selectOption(review.id);
            w = wait(page, approvalRoute + '/instances/' + review.id);
            await a.getByRole('button', { name: 'Inspect invoice review' }).click();
            const inspected = await body(w);
            assert.equal(inspected.batch.lineCount, 1);
            await a.getByLabel('Invoice approval decision', { exact: true }).selectOption('Approved');
            await a.getByLabel('Invoice approval decision reason').fill('Synthetic stage');
            w = wait(page, approvalRoute + '/instances/' + review.id + '/decisions', 'POST');
            await a.getByRole('button', { name: 'Record invoice approval decision' }).click();
            const decided = await body(w, 201);
            assert.equal(decided.approval.state.sequence, sequence + 1);
            assert.equal(
              (
                await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
                  draft.batch.id,
                ])
              ).rows[0].n,
              1,
            );
            assert.deepEqual(actor.errors, []);
            assert.deepEqual(actor.external, []);
          }
          assert.equal(ok(await request(route + '/batches/' + draft.batch.id)).batch.state, 'Approved');
          const configUi = requester.p.getByRole('region', { name: 'Invoice notification configuration' });
          await configUi.getByLabel('Invoice alert route label').fill('Synthetic UI route');
          await configUi.getByLabel('Invoice alert route active').selectOption('yes');
          await configUi.getByLabel('Invoice alert route reason').fill('Synthetic UI route reason');
          let configWait = wait(requester.p, config + '/routes', 'POST');
          await configUi.getByRole('button', { name: 'Record invoice alert route' }).click();
          const uiRoute = (await body(configWait, 201)).route;
          await configUi
            .getByText('Internal alert route configuration recorded. No external delivery is enabled.')
            .waitFor();
          await configUi.getByLabel('Invoice notice engagement').selectOption(roots.engagement.id);
          configWait = wait(requester.p, config + '/policies');
          await configUi.getByRole('button', { name: 'Load invoice notification policies' }).click();
          await body(configWait);
          assert.equal(await configUi.getByLabel('Invoice notice route ID').inputValue(), uiRoute.id);
          await configUi.getByLabel('Invoice finance owner user ID').fill(ids.manager.id);
          await configUi.getByLabel('Invoice finance owner role').fill('Admin');
          await configUi.getByLabel('Invoice integration administrator user ID').fill(ids.second.id);
          await configUi.getByLabel('Invoice integration administrator role').fill('Admin');
          await configUi.getByLabel('Invoice notice effective from').fill(fx.today);
          await configUi.getByLabel('Invoice notice locale').fill('en-US');
          await configUi.getByLabel('Invoice export notice subject').fill('Export {{sourceRef}}');
          await configUi.getByLabel('Invoice export notice body').fill('Synthetic exported {{sourceRef}}');
          await configUi.getByLabel('Invoice failure notice subject').fill('Failure {{sourceRef}}');
          await configUi.getByLabel('Invoice failure notice body').fill('Synthetic failure {{sourceRef}}');
          await configUi.getByLabel('Invoice informational in-app').selectOption('yes');
          await configUi.getByLabel('Invoice notice policy reason').fill('Synthetic UI policy reason');
          let acceptedPolicy, signalPolicy;
          const policyDone = new Promise((resolve) => {
            signalPolicy = resolve;
          });
          await requester.p.route(
            '**/api/v1/invoice-export-notice-config/policies',
            async (intercepted) => {
              const response = await intercepted.fetch();
              assert.equal(response.status(), 201, await response.text());
              acceptedPolicy = await response.json();
              signalPolicy();
              await intercepted.abort('failed');
            },
            { times: 1 },
          );
          await configUi.getByRole('button', { name: 'Record invoice notification policy' }).click();
          await policyDone;
          await configUi.getByText(/may still be in flight/).waitFor();
          configWait = wait(requester.p, config + '/policy-receipts/' + acceptedPolicy.policy.requestId);
          await configUi
            .getByRole('button', { name: 'Read original notification configuration receipt' })
            .click();
          assert.equal((await body(configWait)).policy.id, acceptedPolicy.policy.id);
          await configUi
            .getByText('Prospective invoice notification policy recorded. Reload before another change.')
            .waitFor();
          const exportUi = requester.p.getByRole('region', { name: 'Invoice CSV export' });
          await exportUi.getByLabel('Invoice export engagement').selectOption(roots.engagement.id);
          let ew = wait(requester.p, route + '/batches');
          await exportUi.getByRole('button', { name: 'Load invoice export batches' }).click();
          await body(ew);
          await exportUi.getByLabel('Invoice export batch').selectOption(draft.batch.id);
          ew = wait(requester.p, '/api/v1/invoice-csv/batches/' + draft.batch.id);
          await exportUi.getByRole('button', { name: 'Inspect invoice export source' }).click();
          const inspectedBatch=(await body(ew)).batch;
          assert.equal(inspectedBatch.state,'Approved');
          const line=inspectedBatch.lines[0];
          const pricingPath='/api/v1/invoice-csv/batches/'+draft.batch.id+'/lines/'+line.lineId+'/pricing';
          const poPath=pricingPath.replace('/pricing','/purchase-order');
          const assignPo=(number,fields={})=>request(poPath,{method:'POST',identity:ids.requester,
            body:{expectedOwnerKey:requesterKey,number,reason:'Allocate approved line',...fields}});
          assert.equal((await assignPo('SYN-PO-79')).status,409);
          assert.equal((await assignPo('SYN-PO-100',{amount:'1'})).status,400);
          assert.equal((await assignPo('SYN-ABSENT')).status,404);
          await pool.query("create function synthetic_po_audit_refusal() returns trigger language plpgsql as $$begin raise exception 'Synthetic refusal';end$$");
          await pool.query("create trigger synthetic_po_audit_refusal before insert on audit_logs for each row when (new.action='Commit purchase order') execute function synthetic_po_audit_refusal()");
          assert.equal((await assignPo('SYN-PO-100')).status,503);
          assert.equal(ok(await request(poPath,{identity:ids.requester})).commitment,null);
          await pool.query("drop trigger synthetic_po_audit_refusal on audit_logs");
          await exportUi.getByRole('button',{name:'Inspect order allocation'}).first().click();
          await exportUi.getByLabel('Released order number').fill('SYN-PO-100');
          await exportUi.getByLabel('Allocation reason').fill('Allocate approved line');
          await exportUi.getByRole('button',{name:'Commit invoice line'}).click();
          await exportUi.getByText(/Order committed 80.*Gross consumed 0.*Available 20.*Warning threshold reached/).waitFor();
          const riskRegister=ok(await request('/purchase-order-risks?expiresBy='+fx.today,{identity:ids.requester}));
          assert.deepEqual(riskRegister.orders.map(row=>[row.number,row.warning,row.exhausted,row.expiresInWindow,Number(row.remaining)]),
            [['SYN-PO-100',true,false,false,20]]);
          if (historicalOrder) await migrateCommercialDatabase(pool);
          const history=ok(await request('/purchase-orders/'+riskRegister.orders[0].id+'/risk-history',{identity:ids.requester}));
          assert.deepEqual(history.movements.map(m=>[Number(m.availableBefore),Number(m.availableAfter),m.warning,m.exhausted]),historicalOrder?[]:[[100,20,true,false]]);
          assert.equal(history.priorCommitments,historicalOrder?1:0);
          const initial=ok(await assignPo('SYN-PO-100'));
          assert.equal(initial.replayed,true);
          assert.equal((await assignPo('SYN-PO-79')).status,409);
          assert.equal((await request(poPath,{identity:ids.denied})).status,403);
          const pricingWait=wait(requester.p,pricingPath);
          await exportUi.getByRole('button',{name:'Inspect line pricing'}).first().click();
          const {pricing}=await body(pricingWait);
          assert.equal(pricing.snapshotId,line.snapshotId);
          assert.equal(pricing.ceiling,'80.00');
          assert.equal(pricing.amount,'80.00');
          assert.equal(pricing.rateCandidateId,billing.candidateId);
          assert.ok(!/cost|margin/i.test(Object.keys(pricing).join(' ')));
          await exportUi.getByRole('region',{name:'Retained invoice line pricing'}).getByText(/Per-entry ceiling USD 80.00/).waitFor();
          assert.equal((await request(pricingPath.replace(line.lineId,randomUUID()),{identity:ids.requester})).status,404);
          await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.rate_candidates.view'");
          assert.equal((await request(pricingPath,{identity:ids.requester})).status,403);
          await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.rate_candidates.view'");
          await exportUi.getByLabel('Invoice CSV schema').selectOption('workos.invoice-tm-csv/1');
          await exportUi
            .getByLabel('I inspected the final approval, retained lineage and control total')
            .check();
          await exportUi.getByLabel('Invoice CSV reason').fill('Synthetic export');
          await pool.query(
            "create function synthetic_ui_event_refusal()returns trigger language plpgsql as $$begin raise exception 'Synthetic event refusal' using errcode='INC02';end$$;create trigger synthetic_ui_event_refusal before insert on invoice_export_notice_events for each row execute function synthetic_ui_event_refusal()",
          );
          let artifact, signal;
          const exported = new Promise((resolve) => {
            signal = resolve;
          });
          await requester.p.route(
            '**/api/v1/invoice-csv/exports',
            async (intercepted) => {
              const response = await intercepted.fetch();
              assert.equal(response.status(), 201, await response.text());
              artifact = (await response.json()).artifact;
              signal();
              await intercepted.abort('failed');
            },
            { times: 1 },
          );
          await exportUi.getByRole('button', { name: 'Accept invoice CSV artifact' }).click();
          await exported;
          await exportUi.getByText(/may still be in flight/).waitFor();
          ew = wait(requester.p, '/api/v1/invoice-csv/receipts/' + artifact.requestId);
          await exportUi.getByRole('button', { name: 'Read original invoice export receipt' }).click();
          assert.equal((await body(ew)).artifact.id, artifact.id);
          await exportUi.getByText('The original artifact receipt and bytes were confirmed.').waitFor();
          ew = wait(requester.p, '/api/v1/invoice-csv/notification-status/' + artifact.requestId);
          await exportUi.getByRole('button', { name: 'Check invoice notification status' }).click();
          assert.equal((await body(ew)).status.state, 'EventUnavailable');
          await exportUi.getByText('Notification event needs recovery.').waitFor();
          const fallback = (
            await pool.query('select * from invoice_export_notice_producer_failures where artifact_id=$1', [
              artifact.id,
            ])
          ).rows[0];
          assert(fallback);
          await pool.query(
            'drop trigger synthetic_ui_event_refusal on invoice_export_notice_events;drop function synthetic_ui_event_refusal()',
          );
          const recoverActor = await open(ids.second),
            recoveryUi = recoverActor.p.getByRole('region', { name: 'Invoice notification recovery' });
          await recoveryUi.getByLabel('Invoice recovery engagement').selectOption(roots.engagement.id);
          let recoveryWait = wait(recoverActor.p, route + '/batches');
          await recoveryUi.getByRole('button', { name: 'Load invoice recovery batches' }).click();
          await body(recoveryWait);
          await recoveryUi.getByLabel('Invoice recovery batch').selectOption(draft.batch.id);
          recoveryWait = wait(
            recoverActor.p,
            '/api/v1/invoice-csv/notice-recovery-sources/' + draft.batch.id,
          );
          await recoveryUi.getByRole('button', { name: 'Load invoice recovery targets' }).click();
          assert((await body(recoveryWait)).targets.some((x) => x.id === fallback.id));
          await recoveryUi.getByLabel('Invoice recovery target').selectOption(fallback.id);
          await recoveryUi.getByLabel('Invoice recovery reason').fill('Synthetic UI recovery reason');
          let recovered, signalRecovery;
          const recoveryDone = new Promise((resolve) => {
            signalRecovery = resolve;
          });
          await recoverActor.p.route(
            '**/api/v1/invoice-csv/notice-recoveries',
            async (intercepted) => {
              const response = await intercepted.fetch();
              assert.equal(response.status(), 201, await response.text());
              recovered = await response.json();
              signalRecovery();
              await intercepted.abort('failed');
            },
            { times: 1 },
          );
          await recoveryUi.getByRole('button', { name: 'Attempt invoice notice recovery' }).click();
          await recoveryDone;
          await recoveryUi.getByText(/may still be in flight/).waitFor();
          recoveryWait = wait(
            recoverActor.p,
            '/api/v1/invoice-csv/notice-recovery-receipts/' + recovered.recovery.requestId,
          );
          await recoveryUi.getByRole('button', { name: 'Read original invoice recovery receipt' }).click();
          assert.equal((await body(recoveryWait)).recovery.id, recovered.recovery.id);
          await recoveryUi
            .getByText(
              'Recovery attempt recorded. Reload targets to check remaining work; no external alert was sent.',
            )
            .waitFor();
          assert.equal(recovered.recovery.actorId, ids.second.id);
          assert.notEqual(recovered.recovery.actorId, artifact.actorId);
          assert.deepEqual(recoverActor.errors, []);
          assert.deepEqual(recoverActor.external, []);
          ew = wait(requester.p, '/api/v1/invoice-csv/notification-status/' + artifact.requestId);
          await exportUi.getByRole('button', { name: 'Check invoice notification status' }).click();
          assert.equal((await body(ew)).status.state, 'Recorded');
          await exportUi.getByText('Notification event recorded.').waitFor();
          const downloading = requester.p.waitForEvent('download');
          await exportUi.getByRole('button', { name: 'Download verified invoice CSV' }).click();
          const downloaded = await downloading;
          assert.deepEqual(
            await readFile(await downloaded.path()),
            Buffer.from(artifact.payloadBase64, 'base64'),
          );
          ew = wait(requester.p, route + '/batches');
          await exportUi.getByRole('button', { name: 'Load invoice export batches' }).click();
          await body(ew);
          await exportUi.getByLabel('Invoice export batch').selectOption(draft.batch.id);
          ew = wait(requester.p, '/api/v1/invoice-csv/batches/' + draft.batch.id);
          await exportUi.getByRole('button', { name: 'Inspect invoice export source' }).click();
          assert.equal((await body(ew)).batch.state, 'Exported');
          ew = wait(requester.p, '/api/v1/invoice-csv/artifacts/' + artifact.id);
          await exportUi.getByRole('button', { name: 'Retrieve retained invoice CSV' }).click();
          assert.equal((await body(ew)).artifact.sha256, artifact.sha256);
          await exportUi.getByText('The retained artifact bytes and checksum were verified.').waitFor();
          const lineSelect = exportUi.getByLabel('Exported line to review');
          await lineSelect.selectOption({ index: 1 });
          await exportUi.getByRole('button', { name: 'Check reversal request' }).click();
          await exportUi.getByLabel('Full reversal reason').fill('Synthetic exported line needs full reversal');
          await exportUi.getByRole('button', { name: 'Request full line reversal' }).click();
          await exportUi.getByText(/Reversal requested.*Synthetic exported line needs full reversal/).waitFor();
          await exportUi.getByRole('button', { name: 'Check reversal request' }).click();
          await exportUi.getByText(/Reversal requested.*Synthetic exported line needs full reversal/).waitFor();
          const checkRoute = exportUi.getByRole('button', { name: 'Check reversal reviewers' });
          await checkRoute.click();
          await exportUi.getByText('Review policy ' + policy.id, { exact: false }).waitFor();
          await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.invoice_approval.decide'");
          await checkRoute.click();
          await exportUi.getByText('The named reviewers do not meet current access or independence requirements.').waitFor();
          assert.equal(await exportUi.getByText('Review policy ' + policy.id, { exact: false }).count(), 0);
          await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.invoice_approval.decide'");
          const reversalBase = '/api/v1/invoice-csv/batches/' + draft.batch.id + '/lines/' + await lineSelect.inputValue() + '/reversal-request';
          const submittedPath = reversalBase + '/review';
          const originalRequest = ok(await request(reversalBase, { identity: ids.requester })).request;
          const submission = { requestId: originalRequest.id, expectedOwnerKey: requesterKey, policyId: policy.id, inspectedState: 'Exported' };
          const submitReview = (changes = {}, identity = ids.requester) => request(submittedPath, {
            method: 'POST', identity, body: { ...submission, ...changes },
          });
          assert.equal((await submitReview({ expectedOwnerKey: await readApprovalOwner(request, ids.manager) }, ids.manager)).status, 403);
          assert.equal((await submitReview({ inspectedState: 'Billed/Confirmed' })).status, 409);
          assert.equal((await submitReview({ policyId: randomUUID() })).status, 409);
          await pool.query("create function synthetic_refuse_review_submit() returns trigger language plpgsql as $$begin if new.action='Submit Full Line Reversal' then raise exception 'synthetic audit refusal'; end if; return new;end$$; create trigger synthetic_refuse_review_submit before insert on audit_logs for each row execute function synthetic_refuse_review_submit()");
          assert.equal((await submitReview()).status, 503);
          assert.equal(ok(await request(submittedPath, { identity: ids.requester })).review, null);
          await pool.query("drop trigger synthetic_refuse_review_submit on audit_logs");
          await checkRoute.click();
          await exportUi.getByRole('button', { name: 'Submit reversal for independent review' }).waitFor();
          const sentReview = wait(requester.p, submittedPath, 'POST');
          await exportUi.getByRole('button', { name: 'Submit reversal for independent review' }).click();
          const submittedReview = (await body(sentReview, 201)).review;
          assert.equal(submittedReview.reviewerId, ids.manager.id);
          await exportUi.getByText('Submitted reversal review ' + submittedReview.id, { exact: false }).waitFor();
          assert.equal(ok(await submitReview()).review.id, submittedReview.id);
          assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_id=$1 and action='Submit Full Line Reversal'", [submittedReview.id])).rows[0].n, 1);
          await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.invoice_approval.decide'");
          assert.equal((await request(work + '/inbox/' + submittedReview.id + '/read', {
            method: 'POST', identity: ids.manager, body: { expectedOwnerKey: await readApprovalOwner(request, ids.manager) },
          })).status, 404);
          await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.invoice_approval.decide'");

          assert.equal((await submitReview({ policyId: randomUUID() })).status, 409);
          assert.equal((await request(work + '/inbox/' + submittedReview.id + '/read', {
            method: 'POST', identity: ids.second, body: { expectedOwnerKey: await readApprovalOwner(request, ids.second) },
          })).status, 404);
          const redownload = requester.p.waitForEvent('download');
          await exportUi.getByRole('button', { name: 'Download verified invoice CSV' }).click();
          assert.deepEqual(
            await readFile(await (await redownload).path()),
            Buffer.from(artifact.payloadBase64, 'base64'),
          );
          const confirmUi = requester.p.getByRole('region', { name: 'Invoice billing confirmation' });
          await confirmUi.getByLabel('Invoice confirmation engagement').selectOption(roots.engagement.id);
          let confirmWait = wait(requester.p, route + '/batches');
          await confirmUi.getByRole('button', { name: 'Load invoice confirmation batches' }).click();
          await body(confirmWait);
          await confirmUi.getByLabel('Invoice confirmation batch').selectOption(draft.batch.id);
          confirmWait = wait(requester.p, '/api/v1/invoice-csv/confirmation-sources/' + draft.batch.id);
          await confirmUi.getByRole('button', { name: 'Inspect exported invoice artifact' }).click();
          assert.equal((await body(confirmWait)).source.artifactSha256, artifact.sha256);
          await confirmUi.getByLabel('Invoice confirmation reference').fill('SYNTHETIC-UI-INVOICE-REFERENCE');
          await confirmUi.getByLabel('Invoice confirmation reason').fill('Synthetic UI attestation');
          await confirmUi
            .getByLabel(
              'I attest the referenced downstream confirmation matches this exact artifact and total',
            )
            .check();
          let confirmation, signalConfirmation;
          const confirmationDone = new Promise((resolve) => {
            signalConfirmation = resolve;
          });
          await requester.p.route(
            '**/api/v1/invoice-csv/confirmations',
            async (intercepted) => {
              const response = await intercepted.fetch();
              assert.equal(response.status(), 201, await response.text());
              confirmation = await response.json();
              signalConfirmation();
              await intercepted.abort('failed');
            },
            { times: 1 },
          );
          await confirmUi.getByRole('button', { name: 'Record manual billing attestation' }).click();
          await confirmationDone;
          await confirmUi.getByText(/may still be in flight/).waitFor();
          confirmWait = wait(
            requester.p,
            '/api/v1/invoice-csv/confirmation-receipts/' + confirmation.confirmation.requestId,
          );
          await confirmUi.getByRole('button', { name: 'Read original billing attestation receipt' }).click();
          assert.equal((await body(confirmWait)).confirmation.id, confirmation.confirmation.id);
          await confirmUi
            .getByText(
              'Manual downstream attestation recorded. No provider verification or payment is implied.',
            )
            .waitFor();
          confirmWait = wait(
            requester.p,
            '/api/v1/invoice-csv/confirmation-notification-status/' + confirmation.confirmation.requestId,
          );
          await confirmUi
            .getByRole('button', { name: 'Check billing confirmation notification status' })
            .click();
          assert.equal((await body(confirmWait)).status.state, 'Recorded');
          await confirmUi.getByText('Confirmation notification event recorded.').waitFor();
          assert.equal(confirmation.confirmation.method, 'MANUAL_ATTESTATION');
          assert.equal(confirmation.confirmation.artifactSha256, artifact.sha256);
          ew = wait(requester.p, route + '/batches');
          await exportUi.getByRole('button', { name: 'Load invoice export batches' }).click();
          await body(ew);
          await exportUi.getByLabel('Invoice export batch').selectOption(draft.batch.id);
          ew = wait(requester.p, '/api/v1/invoice-csv/batches/' + draft.batch.id);
          await exportUi.getByRole('button', { name: 'Inspect invoice export source' }).click();
          assert.equal((await body(ew)).batch.state, 'Billed/Confirmed');
          ew = wait(requester.p, '/api/v1/invoice-csv/artifacts/' + artifact.id);
          await exportUi.getByRole('button', { name: 'Retrieve retained invoice CSV' }).click();
          await body(ew);
          await exportUi.getByText('The retained artifact bytes and checksum were verified.').waitFor();
          const afterConfirmationDownload = requester.p.waitForEvent('download');
          await exportUi.getByRole('button', { name: 'Download verified invoice CSV' }).click();
          assert.deepEqual(
            await readFile(await (await afterConfirmationDownload).path()),
            Buffer.from(artifact.payloadBase64, 'base64'),
          );
          const reconUi = requester.p.getByRole('region', { name: 'Billing reconciliation' });
          await reconUi.getByLabel('Reconciliation engagement').selectOption(roots.engagement.id);
          const reconWait = wait(requester.p, route + '/reconciliation');
          await reconUi.getByRole('button', { name: 'Load billing reconciliation' }).click();
          const reconciliation = await body(reconWait);
          assert.equal(reconciliation.exceptionCount, 0);
          assert.equal(reconciliation.items.length, 1);
          assert.equal(reconciliation.items[0].batchState, 'Billed/Confirmed');
          assert.equal(reconciliation.items[0].artifactHash, artifact.sha256);
          assert.equal(reconciliation.items[0].confirmationId, confirmation.confirmation.id);
          await reconUi.getByText('Control exceptions: 0.', { exact: false }).waitFor();
          await reconUi.getByText(artifact.sha256, { exact: false }).waitFor();
          assert.equal(
            canonicalHours(reconciliation.controls.find((x) => x.boundary === 'EXPORTED_LINE').amount),
            canonicalHours(reconciliation.items[0].amount),
          );
          assert.equal(
            canonicalHours(
              reconciliation.controls.find((x) => x.boundary === 'MANUALLY_CONFIRMED_LINE').amount,
            ),
            canonicalHours(reconciliation.items[0].amount),
          );
          const eligible = reconciliation.items[0].eligibleOn;
          await reconUi.getByLabel('Eligible from', { exact: true }).fill(eligible);
          await reconUi.getByLabel('Eligible through', { exact: true }).fill(eligible);
          const portfolioWait = wait(requester.p, route + '/reconciliation/portfolio');
          await reconUi.getByRole('button', { name: 'Load portfolio reconciliation' }).click();
          const portfolio = await body(portfolioWait);
          assert.deepEqual(portfolio.controls, reconciliation.controls);
          assert.deepEqual(portfolio.totals, reconciliation.totals);
          await reconUi.getByRole('rowheader', { name: 'manually confirmed line' }).waitFor();
          const portfolioPath =
            route +
            '/reconciliation/portfolio?' +
            new URLSearchParams({ start: eligible, end: eligible, source: 'time_and_materials' });
          assert.equal((await request(portfolioPath, { identity: ids.reader })).status, 403);
          assert.equal(
            (await request(portfolioPath.replace('time_and_materials', 'both'), { identity: ids.requester }))
              .status,
            403,
          );
          const portfolioExports = route + '/reconciliation/portfolio/exports';
          const command = {
            expectedOwnerKey: portfolio.ownerKey,
            start: portfolio.start,
            end: portfolio.end,
            source: portfolio.source,
            expectedReportToken: portfolio.reportToken,
            requestId: randomUUID(),
            reason: 'Synthetic portfolio export',
          };
          assert.equal(
            (
              await request(portfolioExports, {
                method: 'POST',
                identity: ids.requester,
                body: { ...command, source: 'both' },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(portfolioExports, {
                method: 'POST',
                identity: ids.requester,
                body: { ...command, start: '2000-01-01' },
              })
            ).status,
            409,
          );
          await reconUi.getByLabel('Portfolio export reason').fill(command.reason);
          const portfolioDownload = requester.p.waitForEvent('download'),
            exportResponse = wait(requester.p, portfolioExports, 'POST');
          await reconUi.getByRole('button', { name: 'Download audited portfolio CSV' }).click();
          const receipt = await body(exportResponse, 201),
            download = await portfolioDownload;
          assert.match(download.suggestedFilename(), /^portfolio-billing-reconciliation-/);
          assert.deepEqual(await readFile(await download.path()), Buffer.from(receipt.csv));
          assert.equal(receipt.reportToken, portfolio.reportToken);
          assert(receipt.csv.includes('"MANUALLY_CONFIRMED_LINE"'));
          assert(receipt.csv.includes('"REGISTER_STATE"'));
          assert(receipt.csv.includes('"' + eligible + '","' + eligible + '","time_and_materials"'));
          const recorded = (
            await pool.query(
              "select new_value,reason from audit_logs where action='Export Portfolio Billing Reconciliation' and entity_id=$1",
              [receipt.requestId],
            )
          ).rows;
          assert.equal(recorded.length, 1);
          assert.equal(recorded[0].new_value.artifactSha256, receipt.sha256);
          assert.equal(recorded[0].new_value.source, command.source);
          assert.equal(recorded[0].reason, command.reason);
          assert.equal(
            (
              await request(portfolioExports, {
                method: 'POST',
                identity: ids.requester,
                body: { ...command, requestId: receipt.requestId },
              })
            ).status,
            409,
          );
          await reconUi.getByLabel('Report export reason').fill('Synthetic reconciled report');
          const reportDownload = requester.p.waitForEvent('download'),
            reportExportWait = wait(requester.p, route + '/reconciliation/exports', 'POST');
          await reconUi.getByRole('button', { name: 'Download audited reconciliation CSV' }).click();
          const reportExport = await body(reportExportWait, 201),
            reportBytes = await readFile(await (await reportDownload).path());
          assert.deepEqual(reportBytes, Buffer.from(reportExport.csv));
          assert(reportExport.csv.includes('MANUALLY_CONFIRMED_LINE'));
          assert.equal(
            (
              await pool.query(
                "select count(*)::int n from audit_logs where module='Reports' and action='Export T&M Billing Reconciliation' and entity_id=$1",
                [reportExport.requestId],
              )
            ).rows[0].n,
            1,
          );
          const ownerUi = await open(ids.manager),
            inboxUi = ownerUi.p.getByRole('region', { name: 'Canonical work approval notifications' }),
            inboxWait = wait(ownerUi.p, work + '/inbox');
          await inboxUi.getByRole('button', { name: 'Load my governed notifications' }).click();
          const inboxData = await body(inboxWait),
            exportNotice = inboxData.notifications.find(
              (x) => x.kind === 'invoice-export' && x.batchId === draft.batch.id,
            );
          assert(exportNotice);
          const reversalNotice = inboxData.notifications.find(n => n.id === submittedReview.id);
          assert.equal(reversalNotice.kind, 'invoice-reversal-review');
          assert.equal(reversalNotice.eventKey, 'approval.action_required');
          const reversalCard = inboxUi.getByRole('article', { name: 'Governed notification ' + reversalNotice.id });
          await reversalCard.getByText(/Full-line reversal review/).waitFor();
          const reversalRead = wait(ownerUi.p, work + '/inbox/' + reversalNotice.id + '/read', 'POST');
          await reversalCard.getByRole('button', { name: /read/i }).click();
          assert.ok((await body(reversalRead)).notification.readAt);

          const reviewPath = work + '/reversal-reviews/' + submittedReview.id;
          await reversalCard.getByRole('button', { name: 'Inspect reversal evidence' }).click();
          await reversalCard.getByText(/Requested full reversal of USD/).waitFor();
          const evidence = ok(await request(reviewPath, { identity: ids.manager })).review;
          assert.equal(evidence.sha256, artifact.sha256);
          assert.equal(evidence.canDecide, true);
          assert.equal((await request(reviewPath, {identity:ids.second})).status, 404);
          const firstCommand = { expectedOwnerKey: await readApprovalOwner(request, ids.manager), expectedSequence: 0,
            confirmationId: evidence.confirmationId,policyId: policy.id,decision:'Approved',reason:'Synthetic reviewed export' };
          const decideReversal = (identity, data) => request(reviewPath + '/decisions', {method:'POST',identity,body:data});
          assert.equal((await decideReversal(ids.manager, {...firstCommand, confirmationId: null})).status,409);
          await pool.query("create function synthetic_refuse_stage() returns trigger language plpgsql as $$begin if new.action='Decide Full Line Reversal' then raise exception 'audit refused'; end if;return new;end$$;create trigger synthetic_refuse_stage before insert on audit_logs for each row execute function synthetic_refuse_stage()");
          assert.equal((await decideReversal(ids.manager,firstCommand)).status,503);
          assert.equal((await pool.query('select count(*)::int n from invoice_reversal_decision_notices')).rows[0].n,0);
          await pool.query('drop trigger synthetic_refuse_stage on audit_logs');
          await reversalCard.getByLabel('Reversal decision', {exact:true}).selectOption('Approved');
          await reversalCard.getByLabel('Reversal decision reason').fill(firstCommand.reason);
          await reversalCard.getByRole('button', {name:'Record reversal decision'}).click();
          await reversalCard.getByText(/1 of 2 decisions recorded/).waitFor();
          assert.equal(ok(await decideReversal(ids.manager,firstCommand)).replayed,true);
          assert.equal((await decideReversal(ids.manager,{...firstCommand,decision:'Rejected'})).status,409);
          const secondInbox = ok(await request(work+'/inbox',{identity:ids.second})).notifications;
          const assigned = secondInbox.find(n=>n.kind==='invoice-reversal-decision' && n.instanceId===submittedReview.id);
          assert.equal(assigned.eventKey,'approval.action_required');
          assert.equal(ok(await request(work+'/inbox/'+assigned.id+'/read',{method:'POST',identity:ids.second,
            body:{expectedOwnerKey:await readApprovalOwner(request,ids.second)}})).notification.id,assigned.id);
          const lastDecision = process.argv.includes('--reject-reversal') ? 'Rejected' : 'Approved';
          const lastCommand = {...firstCommand, decision:lastDecision, expectedSequence:1, expectedOwnerKey:await readApprovalOwner(request,ids.second), reason:'Synthetic final review'};
          assert.equal(ok(await decideReversal(ids.second,lastCommand),201).review.status,lastDecision);
          assert.equal(ok(await decideReversal(ids.second,lastCommand)).replayed,true);
          assert.equal(ok(await request(submittedPath, {identity:ids.requester})).review.state,lastDecision);
          const eventKey = lastDecision === 'Approved' ? 'approval.completed' : 'approval.rejected_or_correction_required';
          const recipients = (await pool.query(
            "select recipient_id,reasons,channel from invoice_reversal_decision_notices where event_key=$1", [eventKey],
          )).rows;
          assert.ok(recipients.some(n => n.reasons.includes('requester')));
          assert.ok(recipients.some(n => n.reasons.includes('affected_worker')));
          assert.equal(recipients.length,new Set(recipients.map(n => n.recipient_id)).size);
          if (lastDecision === 'Rejected') {
            const workerInbox = ok(await request(work+'/inbox',{identity:ids.reader})).notifications;
            const workerNotice = workerInbox.find(n=>n.kind==='invoice-reversal-decision' && n.instanceId===submittedReview.id);
            assert.ok(workerNotice.reasons.includes('affected_worker'));
            assert.equal((await request(reviewPath,{identity:ids.reader})).status,404);

            assert.ok(recipients.some(n => n.reasons.includes('invoice_batch_owner')));
            assert.ok(recipients.some(n => n.reasons.includes('finance_preparer')));
            assert.ok(recipients.every(n => n.channel === 'Required'));
          }
          const creditPath = reversalBase + '/eligibility';
          const creditView = () => request(creditPath,{identity:ids.requester});
          const inspectedCredit = ok(await creditView());
          const creditCommand = {
            expectedOwnerKey:requesterKey, reviewId:submittedReview.id,
            decisionId:inspectedCredit.source?.decisionId ?? submittedReview.id,
            confirmationId:lastCommand.confirmationId, eligibleOn:inspectedCredit.serverDate,
            reason:'Synthetic approved line credit',
          };
          const issueCredit = (changes={}) => request(creditPath,{identity:ids.requester,method:'POST',body:{...creditCommand,...changes}});
          assert.equal((await issueCredit()).status,403);
          await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Admin','commercial.reversal_eligibility.create',true) on conflict(role_name,permission_key) do update set enabled=true");
          if(lastDecision==='Approved'){
            assert.equal(inspectedCredit.source.amount,'-'+evidence.amount);
            assert.equal((await issueCredit({amount:'-1'})).status,400);
            assert.equal((await issueCredit({eligibleOn:'2000-01-01'})).status,409);
            assert.equal((await issueCredit({confirmationId:submittedReview.id})).status,409);
            assert.equal(ok(await creditView()).receipt,null);
            await pool.query("insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency) values('synthetic-credit-close',$1,$2,'CREDIT-CLOSE','Synthetic finance close',$3,$3,'Financially Locked','Monthly')",[f.organizationId,f.legalEntityId,inspectedCredit.serverDate]);
            const closed = await issueCredit();
            assert.equal(closed.status,409);
            assert.ok(JSON.stringify(closed.body).includes('BILLING_ELIGIBILITY_PERIOD_CLOSED'));
            await pool.query("delete from reporting_periods where id='synthetic-credit-close'");
            await pool.query(`create function synthetic_refuse_credit_audit() returns trigger language plpgsql as $$
              begin raise exception 'Synthetic credit audit failure'; end $$;
              create trigger synthetic_refuse_credit before insert on audit_logs for each row
              when(new.action='Issue Full Line Reversal') execute function synthetic_refuse_credit_audit()`);
            assert.equal((await issueCredit()).status,503);
            assert.equal(ok(await creditView()).receipt,null);
            assert.equal((await pool.query('select count(*)::int n from billing_eligibility_events where reversal_decision_id=$1',[creditCommand.decisionId])).rows[0].n,0);
            await pool.query('drop trigger synthetic_refuse_credit on audit_logs');
            await lineSelect.selectOption(evidence.lineId);
            await exportUi.getByRole('button',{name:'Check reversal request'}).click();
            await checkRoute.click();
            await exportUi.getByRole('button',{name:'Inspect corrective billing eligibility'}).click();
            await exportUi.getByLabel('Credit issuance reason').fill(creditCommand.reason);
            await exportUi.getByRole('button',{name:'Issue approved-unbilled credit'}).click();
            await exportUi.getByText(/Approved-unbilled credit .*eligibility date/).waitFor();
            const receipt = ok(await creditView()).receipt;
            assert.equal(receipt.amount,inspectedCredit.source.amount);
            const register = '/api/v1/invoice-csv/issued-credits?engagementId=' + encodeURIComponent(roots.engagement.id);
            const list = ok(await request(register,{identity:ids.requester}));
            assert.deepEqual(list.credits.map(c=>[c.itemId,c.eventId,c.originalEventId,c.amount]),[[receipt.itemId,receipt.eventId,receipt.originalEventId,receipt.amount]]);
            assert.equal(list.nextAfter,null);
            assert.deepEqual(ok(await request(register+'&after='+receipt.itemId,{identity:ids.requester})).credits,[]);
            assert.equal((await request(register+'&after=invalid',{identity:ids.requester})).status,400);
            await exportUi.getByRole('button',{name:'View issued credits'}).click();
            const table = exportUi.getByRole('table',{name:'Issued credits for this engagement'});
            await table.getByText(receipt.itemId,{exact:true}).waitFor();
            await table.getByText(receipt.currency+' '+receipt.amount).waitFor();
            await table.getByText('Credit evidence').click();
            await table.getByText(receipt.decisionId).waitFor();
            await table.getByRole('checkbox',{name:'Select credit '+receipt.itemId}).check();
            await exportUi.getByLabel('Correction batch reason').fill('Synthetic reserve credit');
            await exportUi.getByRole('button',{name:'Reserve selected credits'}).click();
            await table.getByRole('button',{name:'Cancel correction batch'}).waitFor();
            const occupied = ok(await request(register,{identity:ids.requester})).credits[0];
            assert.ok(occupied.correctionBatchId);
            await table.getByRole('button',{name:'Inspect correction draft'}).click();
            const proofPanel=exportUi.getByRole('region',{name:'Correction draft evidence'});
            await proofPanel.getByText('Correction draft '+occupied.correctionBatchId).waitFor();
            await proofPanel.getByText(/Current owner/).waitFor();
            await proofPanel.getByText(new RegExp(receipt.decisionId)).waitFor();
            const proofPath='/api/v1/invoice-csv/batches/'+draft.batch.id+'/correction-drafts/'+occupied.correctionBatchId;
            const proof=ok(await request(proofPath,{identity:ids.requester}));
            assert.equal(proof.lines[0].amount,receipt.amount);
            assert.equal(proof.header.ownerCurrent,true);

            assert.notEqual(occupied.correctionBatchId,draft.batch.id);
            assert.equal((await request('/api/v1/invoice-csv/batches/'+occupied.correctionBatchId,{identity:ids.requester})).status,404);
            await load(requester);
            await ui.getByRole('button',{name:'Find correction drafts'}).click();
            await ui.getByLabel('Invoice approval Draft').selectOption(occupied.correctionBatchId);
            await ui.getByRole('button',{name:'Inspect invoice Draft source'}).click();
            await ui.getByText(new RegExp('correction for line '+evidence.lineId)).waitFor();
            await ui.getByLabel('I inspected the retained lineage and control total').check();
            await ui.getByLabel('Invoice batch review policy').selectOption(policy.id);
            await ui.getByLabel('Invoice approval request reason').fill('Synthetic correction review');
            const reviewResponse=wait(p,approvalRoute+'/requests','POST');
            await ui.getByRole('button',{name:'Submit invoice Draft for review'}).click();
            const creditReview=(await body(reviewResponse,201)).approval;
            const correctionDecision=approvalRoute+'/instances/'+creditReview.id+'/decisions';
            const firstCredit={expectedOwnerKey:await readApprovalOwner(request,ids.manager),requestId:randomUUID(),
              expectedSequence:0,decision:'Approved',reason:'Synthetic first correction decision'};
            assert.equal(ok(await request(correctionDecision,{method:'POST',identity:ids.manager,body:firstCredit}),201).approval.state.status,'Pending');
            const rejectCredit={expectedOwnerKey:await readApprovalOwner(request,ids.second),requestId:randomUUID(),
              expectedSequence:1,decision:'Rejected',reason:'Synthetic correction draft review'};
            assert.equal(ok(await request(correctionDecision,{method:'POST',identity:ids.second,body:rejectCredit}),201).approval.state.status,'Rejected');
            assert.equal(ok(await request(correctionDecision,{method:'POST',identity:ids.second,body:rejectCredit})).replayed,true);
            const creditInbox=ok(await request('/api/v1/work-approvals/inbox',{identity:ids.reader})).notifications;
            assert.ok(creditInbox.some(n=>n.instanceId===creditReview.id && n.reasons.includes('affected_worker')));
            await exportUi.getByLabel('Correction batch reason').fill('Synthetic release credit');
            await table.getByRole('button',{name:'Cancel correction batch'}).click();
            await table.getByRole('checkbox',{name:'Select credit '+receipt.itemId}).waitFor();
            assert.equal(ok(await request(register,{identity:ids.requester})).credits[0].correctionBatchId,null);
            assert.equal((await pool.query('select count(*)::int n from invoice_draft_lines where batch_id=$1',[occupied.correctionBatchId])).rows[0].n,1);
            for(const permission of ['commercial.invoice_drafts.view','commercial.invoice_export.view','commercial.invoice_drafts.prepare','commercial.rate_candidates.view']){
              await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[permission]);
            }
            assert.deepEqual(ok(await request(register,{identity:ids.denied})).credits,[]);
            assert.equal((await request(pricingPath,{identity:ids.denied})).status,404);
            const hiddenReviews=ok(await request(approvalRoute+'/instances?engagementId='+encodeURIComponent(roots.engagement.id),{identity:ids.denied})).approvals;
            assert.ok(!hiddenReviews.some(x=>x.id===creditReview.id));
            assert.equal((await request(approvalRoute+'/instances/'+creditReview.id,{identity:ids.denied})).status,404);
            assert.equal((await request(proofPath,{identity:ids.denied})).status,404);

            const finalDraft=ok(await request('/api/v1/invoice-csv/batches/'+draft.batch.id+'/correction-drafts',{identity:ids.requester,method:'POST',
              body:{expectedOwnerKey:requesterKey,requestId:randomUUID(),reason:'Synthetic final correction',itemIds:[receipt.itemId]}}),201).receipt;
            const finalSource=ok(await request(approvalRoute+'/sources/'+finalDraft.batchId,{identity:ids.requester})).batch;
            const finalReview=ok(await request(approvalRoute+'/requests',{identity:ids.requester,method:'POST',body:{
              expectedOwnerKey:requesterKey,requestId:randomUUID(),batchId:finalDraft.batchId,expectedPolicyId:policy.id,
              expectedLineCount:1,expectedLineageHash:finalSource.lineageHash,reason:'Synthetic credit export approval'}}),201).approval;
            const finalDecision=approvalRoute+'/instances/'+finalReview.id+'/decisions';
            ok(await request(finalDecision,{identity:ids.manager,method:'POST',body:{...firstCredit,requestId:randomUUID()}}),201);
            ok(await request(finalDecision,{identity:ids.second,method:'POST',body:{...rejectCredit,decision:'Approved',requestId:randomUUID()}}),201);
            await exportUi.getByRole('button',{name:'Load invoice export batches'}).click();
            await exportUi.getByRole('button',{name:'Find credit exports'}).click();
            await exportUi.getByLabel('Invoice export batch').selectOption(finalDraft.batchId);
            await exportUi.getByRole('button',{name:'Inspect invoice export source'}).click();
            await exportUi.getByLabel('Invoice CSV schema').selectOption('workos.invoice-credit-csv/1');
            await exportUi.getByLabel('I inspected the final approval, retained lineage and control total').check();
            await exportUi.getByLabel('Invoice CSV reason').fill('Synthetic signed credit export');
            const creditResponse=wait(requester.p,'/api/v1/invoice-csv/exports','POST');
            await exportUi.getByRole('button',{name:'Accept invoice CSV artifact'}).click();
            const exportedCredit=(await body(creditResponse,201)).artifact;
            assert.equal(exportedCredit.total,receipt.amount);
            const downloadingCredit=requester.p.waitForEvent('download');
            await exportUi.getByRole('button',{name:'Download verified invoice CSV'}).click();
            assert.deepEqual(await readFile(await (await downloadingCredit).path()),Buffer.from(exportedCredit.payloadBase64,'base64'));
            await exportUi.getByRole('button',{name:'Load invoice export batches'}).click();
            await exportUi.getByLabel('Invoice export batch').selectOption(draft.batch.id);
            await exportUi.getByRole('button',{name:'Inspect invoice export source'}).click();
            await exportUi.getByRole('button',{name:'Check exported credits'}).click();
            const creditLink=exportUi.getByRole('listitem').filter({hasText:'credit artifact '+exportedCredit.id});
            await creditLink.filter({hasText:'Awaiting downstream attestation'}).waitFor();
            assert.equal((await request('/api/v1/invoice-csv/artifacts/'+exportedCredit.id,{identity:ids.denied})).status,404);
            await confirmUi.getByLabel('Invoice confirmation engagement').selectOption(roots.engagement.id);
            await confirmUi.getByRole('button',{name:'Find exported credits'}).click();
            await confirmUi.getByLabel('Invoice confirmation batch').selectOption(finalDraft.batchId);
            await confirmUi.getByRole('button',{name:'Inspect exported invoice artifact'}).click();
            await confirmUi.getByLabel('Inspected confirmation source').getByText(new RegExp(exportedCredit.sha256)).waitFor();
            await confirmUi.getByLabel('Invoice confirmation reference').fill('SYNTHETIC-CREDIT-APPLIED');
            await confirmUi.getByLabel('Invoice confirmation reason').fill('Synthetic downstream credit application');
            await confirmUi.getByLabel('I attest the referenced downstream confirmation matches this exact artifact and total').check();
            const confirmedCredit=requester.p.waitForResponse(r=>r.url().endsWith('/invoice-csv/confirmations') && r.request().method()==='POST');
            await confirmUi.getByRole('button',{name:'Record manual billing attestation'}).click();
            assert.equal((await body(await confirmedCredit,201)).confirmation.total,receipt.amount);
            await exportUi.getByRole('button',{name:'Check exported credits'}).click();
            await creditLink.filter({hasText:'Downstream application attested'}).waitFor();
            assert.deepEqual(ok(await request(pricingPath,{identity:ids.requester})).pricing,pricing);
            const consumed=ok(await request(poPath,{identity:ids.requester})).commitment;
            assert.deepEqual([consumed.committed,consumed.consumed,consumed.remaining,consumed.warning],['0','80.0000','20.0000',true]);
            assert.equal((await request('/api/v1/invoice-csv/batches/'+draft.batch.id+'/exported-credits',{identity:ids.denied})).status,404);
            assert.equal(receipt.originalEventId,inspectedCredit.source.originalEventId);
            assert.equal(ok(await issueCredit()).replayed,true);
            assert.equal((await issueCredit({reason:'Changed reason'})).status,409);
          } else {
            assert.equal(inspectedCredit.source,null);
            assert.equal((await issueCredit()).status,409);
          }
          assert.equal((await pool.query('select count(*)::int n from invoice_draft_occupancies where line_id=$1',[evidence.lineId])).rows[0].n,1);
          const exportCard = inboxUi.getByRole('article', {
            name: 'Governed notification ' + exportNotice.id,
          });
          await exportCard
            .getByText('invoice_batch.exported_or_billed_confirmed', { exact: false })
            .waitFor();
          const exportReadWait = wait(ownerUi.p, work + '/inbox/' + exportNotice.id + '/read', 'POST');
          await exportCard
            .getByRole('button', { name: 'Mark governed notification read ' + exportNotice.id })
            .click();
          assert((await body(exportReadWait)).notification.readAt);
          assert.deepEqual(ownerUi.errors, []);
          assert.deepEqual(ownerUi.external, []);
          assert.equal(
            ok(await request(route + '/batches/' + draft.batch.id)).batch.state,
            'Billed/Confirmed',
          );
          assert.equal(
            (
              await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
                draft.batch.id,
              ])
            ).rows[0].n,
            1,
          );
          await requester.p.evaluate(() =>
            window.dispatchEvent(new Event('workos:organization-scope-switch-requested')),
          );
          await requester.ui
            .getByText('Account, role or scope changed. Unsent invoice approval inputs were cleared.')
            .waitFor();
          await reconUi.getByText('Account, role or scope changed. Reload the report.').waitFor();
          assert.equal(await reconUi.getByText(artifact.sha256, { exact: false }).count(), 0);
          assert.equal(
            await reconUi.getByRole('region', { name: 'Portfolio reconciliation results' }).count(),
            0,
          );
          await confirmUi
            .getByText('Account, role or scope changed. Unsent confirmation inputs were cleared.')
            .waitFor();
          await exportUi
            .getByText(
              'Account, role or scope changed. Unsent export inputs and locally held bytes were cleared.',
            )
            .waitFor();
          assert.equal(await exportUi.getByRole('region', { name: 'Verified invoice CSV' }).count(), 0);
          assert.deepEqual(requester.errors, []);
          assert.deepEqual(requester.external, []);
          await verifyPurchaseOrderNotices({pool,request,ids,roots,orderId:riskRegister.orders[0].id,scope:f,today:fx.today,work,open,historicalOrder});
          console.log('real React/API/PostgreSQL approved invoice CSV download passed.');
        } finally {
          for (const ctx of contexts) await ctx.close();
          if (browser) await browser.close();
          await fixture.close();
        }
      }
    },
  );
});
