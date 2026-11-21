import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../server/migrate.mjs';
const preMilestone = async (pool) => {
  const dir = await mkdtemp(join(tmpdir(), 'workos-synthetic-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile('server/schema.sql', join(dir, 'schema.sql'));
    for (const f of (await readdir('server/migrations')).sort())
      if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(f) && f < '065n_wos06_milestone_invoice_lineage.sql')
        await copyFile(join('server/migrations', f), join(dir, 'migrations', f));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
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
  await preMilestone(pool);
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
        const beforeExport = ok(await request('/api/v1/invoice-csv/batches/' + draft.batch.id));
        assert.equal(beforeExport.batch.state, 'Under Review');
        const rejectedEarly = await request('/api/v1/invoice-csv/exports', {
          method: 'POST',
          body: {
            expectedOwnerKey: beforeExport.ownerKey,
            requestId: randomUUID(),
            batchId: draft.batch.id,
            approvalId: randomUUID(),
            finalTransitionId: randomUUID(),
            lineageHash: 'a'.repeat(64),
            schemaVersion: 'workos.invoice-tm-csv/1',
            expectedLineCount: 1,
            expectedTotal: '1',
            reason: 'Synthetic pending refusal',
          },
        });
        assert.equal(rejectedEarly.status, 409);
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
        assert.equal((await decision(ids.manager, 0)).status, 201);
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
        assert.equal(ok(await request(route + '/batches/' + draft.batch.id)).batch.state, 'Approved');
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
        const csv = '/api/v1/invoice-csv';
        for (const k of [
          'commercial.invoice_drafts.view',
          'commercial.invoice_export.view',
          'commercial.invoice_export.create',
          'commercial.invoice_batch.confirm',
        ])
          await pool.query(
            "insert into role_permissions(role_name,permission_key,enabled)values('TeamLead',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
            [k],
          );
        assert.equal(
          (await request(csv + '/batches/' + draft.batch.id, { identity: ids.denied })).status,
          404,
          'Foreign worker scope cannot inspect the retained invoice',
        );
        assert.equal(
          (await request(csv + '/batches/' + draft.batch.id, { identity: ids.reader })).status,
          403,
          'Worker view does not confer invoice export permission',
        );
        await assert.rejects(
          pool.query(
            "insert into invoice_csv_failures(id,batch_id,organization_id,legal_entity_id,actor_id,active_role,request_id,request_fingerprint,reason,code,operation_id)values($1,$2,$3,$4,$5,'Admin',$6,$7,'Synthetic direct refusal','ARTIFACT_GENERATION_FAILED','synthetic-direct')",
            [
              randomUUID(),
              draft.batch.id,
              f.organizationId,
              f.legalEntityId,
              ids.manager.id,
              randomUUID(),
              'a'.repeat(64),
            ],
          ),
          (e) => e.code === 'ICV01',
        );
        const inspected = ok(await request(csv + '/batches/' + draft.batch.id)),
          sourceCsv = inspected.batch;
        assert.equal(sourceCsv.state, 'Approved');
        assert.equal(sourceCsv.sourceCurrent, true);
        assert.equal(sourceCsv.control.lineCount, 1);
        const cmd = {
          expectedOwnerKey: inspected.ownerKey,
          requestId: randomUUID(),
          batchId: draft.batch.id,
          approvalId: sourceCsv.approvalId,
          finalTransitionId: sourceCsv.finalTransitionId,
          lineageHash: sourceCsv.lineageHash,
          schemaVersion: 'workos.invoice-tm-csv/1',
          expectedLineCount: sourceCsv.control.lineCount,
          expectedTotal: sourceCsv.control.total,
          reason: 'Synthetic invoice export',
        };
        await assert.rejects(
          pool.query(
            "insert into invoice_csv_request_keys(organization_id,legal_entity_id,actor_id,request_id,result_kind,result_id)values($1,$2,$3,$4,'artifact',$5)",
            [f.organizationId, f.legalEntityId, ids.manager.id, randomUUID(), randomUUID()],
          ),
          (e) => e.code === 'ICV03',
        );
        await pool.query(
          "create function synthetic_csv_audit_refusal()returns trigger language plpgsql as $$begin if new.module='Invoice CSV' then raise exception 'synthetic audit refusal' using errcode='ICV03';end if;return new;end$$;create trigger synthetic_csv_audit_refusal before insert on audit_logs for each row execute function synthetic_csv_audit_refusal()",
        );
        assert.equal((await request(csv + '/exports', { method: 'POST', body: cmd })).status, 409);
        assert.equal((await pool.query('select count(*)::int n from invoice_csv_request_keys')).rows[0].n, 0);
        assert.equal(ok(await request(csv + '/batches/' + draft.batch.id)).batch.state, 'Approved');
        await pool.query(
          'drop trigger synthetic_csv_audit_refusal on audit_logs;drop function synthetic_csv_audit_refusal()',
        );
        const raced = await Promise.all([
          request(csv + '/exports', { method: 'POST', body: cmd }),
          request(csv + '/exports', { method: 'POST', body: cmd }),
        ]);
        assert.deepEqual(raced.map((x) => x.status).sort(), [200, 201]);
        const result = ok(
          raced.find((x) => x.status === 201),
          201,
        );
        assert(result.artifact);
        assert.equal(result.failure, null);
        const saved = (
          await pool.query(
            "select payload,encode(digest(payload,'sha256'),'hex') hash from invoice_csv_artifacts where id=$1",
            [result.artifact.id],
          )
        ).rows[0];
        assert.deepEqual(Buffer.from(result.artifact.payloadBase64, 'base64'), saved.payload);
        assert.equal(saved.hash, result.artifact.sha256);
        const confirmationPath = csv + '/confirmations',
          inspection = ok(await request(csv + '/confirmation-sources/' + draft.batch.id)),
          confirmationSource = inspection.source;
        assert.equal(confirmationSource.state, 'Exported');
        assert.equal(confirmationSource.artifactSha256, result.artifact.sha256);
        assert.equal(
          (await request(csv + '/confirmation-sources/' + draft.batch.id, { identity: ids.reader })).status,
          403,
        );
        assert.equal(
          (await request(csv + '/confirmation-sources/' + draft.batch.id, { identity: ids.denied })).status,
          404,
        );
        const confirmationCmd = {
          expectedOwnerKey: inspection.ownerKey,
          requestId: randomUUID(),
          batchId: draft.batch.id,
          artifactId: result.artifact.id,
          artifactVersion: result.artifact.version,
          artifactSha256: result.artifact.sha256,
          currency: result.artifact.currency,
          total: result.artifact.total,
          reference: 'SYNTHETIC-INVOICE-REFERENCE',
          reason: 'Synthetic manual attestation',
        };
        assert.equal(
          (
            await request(confirmationPath, {
              method: 'POST',
              body: { ...confirmationCmd, artifactSha256: 'b'.repeat(64) },
            })
          ).status,
          409,
        );
        await assert.rejects(
          pool.query(
            "insert into invoice_batch_confirmations(id,organization_id,legal_entity_id,batch_id,artifact_id,artifact_version,artifact_sha256,currency,total,confirmation_kind,external_reference,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,1,$6,$7,$8,'MANUAL_ATTESTATION','SYNTHETIC-DIRECT',$9,'Admin',$10,$11,'Synthetic direct refusal','synthetic-direct')",
            [
              randomUUID(),
              f.organizationId,
              f.legalEntityId,
              draft.batch.id,
              result.artifact.id,
              result.artifact.sha256,
              result.artifact.currency,
              result.artifact.total,
              ids.manager.id,
              randomUUID(),
              'a'.repeat(64),
            ],
          ),
          (e) => e.code === 'IBC01',
        );
        const confirmations = await Promise.all([
          request(confirmationPath, { method: 'POST', body: confirmationCmd }),
          request(confirmationPath, { method: 'POST', body: confirmationCmd }),
        ]);
        assert.deepEqual(confirmations.map((x) => x.status).sort(), [200, 201]);
        const confirmed = ok(
          confirmations.find((x) => x.status === 201),
          201,
        ).confirmation;
        assert.equal(confirmed.method, 'MANUAL_ATTESTATION');
        assert.equal(confirmed.reference, confirmationCmd.reference);
        assert.equal(confirmed.artifactSha256, result.artifact.sha256);
        await assert.rejects(
          pool.query('update invoice_batch_confirmations set external_reference=$1 where id=$2', [
            'Synthetic rewrite',
            confirmed.id,
          ]),
          (e) => e.code === '55000',
        );
        await assert.rejects(
          pool.query('delete from invoice_batch_confirmations where id=$1', [confirmed.id]),
          (e) => e.code === '55000',
        );
        assert.equal(
          (
            await request(confirmationPath, {
              method: 'POST',
              body: { ...confirmationCmd, reference: 'CHANGED-SYNTHETIC-REFERENCE' },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await request(confirmationPath, {
              identity: ids.second,
              method: 'POST',
              body: {
                ...confirmationCmd,
                expectedOwnerKey: await readApprovalOwner(request, ids.second),
                requestId: randomUUID(),
              },
            })
          ).status,
          409,
        );
        const confirmationAudit = (
          await pool.query(
            "select new_value from audit_logs where module='Invoice Billing Confirmation' and entity_id=$1",
            [confirmed.id],
          )
        ).rows[0];
        assert(confirmationAudit);
        assert(!JSON.stringify(confirmationAudit).includes(confirmationCmd.reference));
        assert(!JSON.stringify(confirmationAudit).includes(confirmationCmd.total));
        assert.equal(
          ok(await request(csv + '/confirmation-sources/' + draft.batch.id)).source.state,
          'Billed/Confirmed',
        );
        assert.equal(
          ok(await request(csv + '/confirmation-receipts/' + confirmationCmd.requestId)).confirmation.id,
          confirmed.id,
        );
        assert.equal(
          (
            await request(confirmationPath, {
              method: 'POST',
              body: { ...confirmationCmd, requestId: randomUUID() },
            })
          ).status,
          409,
        );
        const confirmationNotice = (
          await pool.query('select * from invoice_export_notice_events where confirmation_id=$1', [
            confirmed.id,
          ])
        ).rows[0];
        assert.equal(confirmationNotice.event_key, 'invoice_batch.exported_or_billed_confirmed');
        assert.equal(confirmationNotice.operation_id, confirmed.operationId);
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_export_notice_events where confirmation_id=$1',
              [confirmed.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft.batch.id,
            ])
          ).rows[0].n,
          1,
        );
        assert.deepEqual(
          (await pool.query('select payload from invoice_csv_artifacts where id=$1', [result.artifact.id]))
            .rows[0].payload,
          saved.payload,
        );
        const status = ok(await request(csv + '/notification-status/' + cmd.requestId)).status;
        assert.equal(status.state, 'Recorded');
        assert.equal(status.eventKey, 'invoice_batch.exported_or_billed_confirmed');
        assert.equal(status.alertOutbox, null);
        const notice = (
          await pool.query('select * from invoice_export_notice_events where artifact_id=$1', [
            result.artifact.id,
          ])
        ).rows[0];
        assert.equal(notice.event_key, 'invoice_batch.exported_or_billed_confirmed');
        assert.equal(notice.policy_class, 'INFORMATIONAL');
        const recipients = (
          await pool.query('select * from invoice_export_notice_recipients where event_id=$1', [notice.id])
        ).rows;
        assert.equal(recipients.length, 1);
        assert.deepEqual(recipients[0].reasons, ['finance_billing_owner', 'invoice_batch_owner']);
        assert.equal(recipients[0].channel_decision, 'Enabled');
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_export_notice_deliveries where recipient_id=$1',
              [recipients[0].id],
            )
          ).rows[0].n,
          1,
        );
        const exportInbox = ok(await request(work + '/inbox', { identity: ids.manager })),
          exportNotice = exportInbox.notifications.find(
            (x) => x.kind === 'invoice-export' && x.eventId === notice.id,
          );
        assert(exportNotice);
        assert.equal(exportNotice.batchId, draft.batch.id);
        assert(
          ok(
            await request(work + '/inbox/' + exportNotice.id + '/read', {
              identity: ids.manager,
              method: 'POST',
              body: { expectedOwnerKey: exportInbox.ownerKey },
            }),
          ).notification.readAt,
        );
        assert.equal(
          (
            await request(work + '/inbox/' + exportNotice.id + '/read', {
              identity: ids.second,
              method: 'POST',
              body: { expectedOwnerKey: await readApprovalOwner(request, ids.second) },
            })
          ).status,
          404,
        );
        await assert.rejects(
          pool.query('update invoice_csv_artifacts set reason=$1 where id=$2', [
            'Synthetic rewrite',
            result.artifact.id,
          ]),
          (e) => e.code === '55000',
        );
        await assert.rejects(
          pool.query('delete from invoice_csv_artifacts where id=$1', [result.artifact.id]),
          (e) => e.code === '55000',
        );
        assert.equal(
          (
            await request(
              '/api/approvals/' +
                (
                  await pool.query(
                    "select id from approval_records where entity_type='InvoiceBatchApproval' and entity_id=$1",
                    [submitted.id],
                  )
                ).rows[0].id +
                '/status',
              { method: 'PATCH', body: { status: 'Approved' } },
            )
          ).status,
          404,
        );
        assert.equal(ok(await request(csv + '/batches/' + draft.batch.id)).batch.state, 'Billed/Confirmed');
        assert.equal(ok(await request(csv + '/exports', { method: 'POST', body: cmd })).replayed, true);
        assert.equal(
          (
            await request(csv + '/exports', {
              method: 'POST',
              body: { ...cmd, reason: 'Changed synthetic request' },
            })
          ).status,
          409,
        );
        assert.deepEqual(ok(await request(csv + '/receipts/' + cmd.requestId)).artifact, result.artifact);
        assert.deepEqual(
          ok(await request(csv + '/artifacts/' + result.artifact.id)).artifact,
          result.artifact,
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_export_notice_events where artifact_id=$1',
              [result.artifact.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await request(route + '/batches/' + draft.batch.id + '/cancellations', {
              method: 'POST',
              body: {
                expectedOwnerKey: draft.ownerKey,
                requestId: randomUUID(),
                expectedLineCount: 1,
                reason: 'Synthetic prohibited cancel',
              },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1', [
              draft.batch.id,
            ])
          ).rows[0].n,
          1,
        );
        assert.equal((await pool.query('select count(*)::int n from invoice_csv_request_keys')).rows[0].n, 1);
        const beforeUpgrade = (
            await pool.query('select payload,sha256,version from invoice_csv_artifacts where id=$1', [
              result.artifact.id,
            ])
          ).rows[0],
          beforeOccupancy = (
            await pool.query(
              'select item_id,item_version,batch_id,line_id from invoice_draft_occupancies where batch_id=$1',
              [draft.batch.id],
            )
          ).rows;
        const upgrade = await migrateCommercialDatabase(pool);
        assert.deepEqual(upgrade.applied, [
          '065n_wos06_milestone_invoice_lineage',
          '065o_wos06_milestone_invoice_approval',
          '065p_wos06_milestone_invoice_export',
          '065q_wos06_milestone_invoice_cancel_notice',
          '065r_wos06_milestone_invoice_confirmation',
          '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts', '082l_wos06_retainer_invoice_approval', '082m_wos06_retainer_invoice_csv', '082n_wos06_retainer_billing_confirmation', '082o_wos06_retainer_reversal_review', '082p_wos06_retainer_credit', '082q_wos08_archive_constraint_resolution', '082r_wos06_managed_service_dimensions', '082s_wos06_service_unit_evidence',
        ]);
        assert.deepEqual((await pool.query('select id from commercial_tm_period_versions')).rows, []);
        const afterUpgrade = (
            await pool.query('select payload,sha256,version from invoice_csv_artifacts where id=$1', [
              result.artifact.id,
            ])
          ).rows[0],
          afterOccupancy = (
            await pool.query(
              'select item_id,item_version,batch_id,line_id from invoice_draft_occupancies where batch_id=$1',
              [draft.batch.id],
            )
          ).rows;
        assert.equal((await pool.query(
          "select count(*)::int n from pg_trigger where tgrelid='billing_eligibility_events'::regclass and tgname='verify_billing_eligibility_period' and tgenabled='O'",
        )).rows[0].n, 1);
        assert.deepEqual(afterUpgrade, beforeUpgrade);
        assert.deepEqual(afterOccupancy, beforeOccupancy);
        assert.equal(
          (await pool.query('select source_type from invoice_draft_batches where id=$1', [draft.batch.id]))
            .rows[0].source_type,
          'TM_SNAPSHOT',
        );
        assert.equal(
          (
            await pool.query('select source_type from invoice_batch_confirmations where id=$1', [
              confirmed.id,
            ])
          ).rows[0].source_type,
          'TM_SNAPSHOT',
        );
        const afterApi = ok(await request(csv + '/artifacts/' + result.artifact.id)).artifact;
        assert.deepEqual(afterApi, result.artifact);
        const replayUpgrade = await migrateCommercialDatabase(pool);
        assert.equal(replayUpgrade.applied.length, 0);
        console.log(
          'Populated T&M artifact, confirmation and occupancy survive 065n–065r upgrade and replay.',
        );
        console.log('Invoice CSV diagnostic real API/PostgreSQL passed.');
      }
    },
  );
});
