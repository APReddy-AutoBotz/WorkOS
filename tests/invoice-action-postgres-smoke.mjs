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
  readApprovalOwner,
  WORK_APPROVAL_BASE as work,
} from './support/work-approval-test.mjs';
import {
  grantAmendmentPermissions,
  createAmendmentHierarchy,
} from './support/commercial-amendments-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const ok = (v, n = 200) => {
  assert.equal(v.status, n, JSON.stringify(v.body));
  return v.body;
};
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedWorkApproval(pool),
    ids = fx.identities;
  await grantAmendmentPermissions(pool);
  for (const k of [
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'commercial.invoice_drafts.prepare',
    'commercial.invoice_drafts.own',
    'commercial.invoice_drafts.cancel',
    'commercial.invoice_approval.manage',
    'commercial.contracts.manage',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
    async ({ request }) => {
      const end = shift(fx.today, 30),
        roots = await createAmendmentHierarchy(request, 'SYN-ACTION', {
          contract: {
            model: 'time_and_materials',
            startsOn: fx.today,
            endsOn: end,
            effectiveFrom: fx.today,
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        }),
        requesterKey = await readApprovalOwner(request, ids.requester),
        route = '/api/v1/invoice-action-notices',
        drafts = '/api/v1/invoice-drafts';
      const draft = ok(
        await request(drafts + '/batches', {
          method: 'POST',
          identity: ids.requester,
          body: {
            expectedOwnerKey: requesterKey,
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
            reason: 'Synthetic empty draft',
          },
        }),
        201,
      ).batch;
      const definition = {
          entityType: 'InvoiceBatch',
          engagementId: roots.engagement.id,
          locale: 'en-US',
          key: 'invoice_batch.action_required',
          subject: 'Inspect {{sourceRef}}',
          body: 'Review {{sourceRef}}',
        },
        templateCommand = {
          expectedOwnerKey: requesterKey,
          requestId: randomUUID(),
          expectedLatestId: null,
          effectiveFrom: fx.today,
          definition,
          reason: 'Synthetic template',
        };
      assert.equal(
        (
          await request(route + '/templates', {
            method: 'POST',
            identity: ids.requester,
            body: { ...templateCommand, requestId: randomUUID(), effectiveFrom: shift(fx.today, -1) },
          })
        ).status,
        400,
      );
      const fixed = await createAmendmentHierarchy(request, 'SYN-FIXED-ACTION', {
        contract: {
          model: 'fixed_fee',
          startsOn: fx.today,
          endsOn: end,
          effectiveFrom: fx.today,
          currency: 'USD',
        },
        engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
        project: { startsOn: fx.today, endsOn: end },
      });
      assert.equal(
        (await request(route + '/templates?engagementId=' + fixed.engagement.id, { identity: ids.requester }))
          .status,
        404,
      );
      assert.equal(
        (
          await request(route + '/templates', {
            method: 'POST',
            identity: ids.requester,
            body: { ...templateCommand, definition: { ...definition, engagementId: fixed.engagement.id } },
          })
        ).status,
        404,
      );
      const template = ok(
        await request(route + '/templates', {
          method: 'POST',
          identity: ids.requester,
          body: templateCommand,
        }),
        201,
      ).template;
      assert.equal(
        ok(
          await request(route + '/templates', {
            method: 'POST',
            identity: ids.requester,
            body: templateCommand,
          }),
        ).replayed,
        true,
      );
      const source = ok(await request(route + '/sources/' + draft.id, { identity: ids.requester })).source;
      assert.equal(source.state, 'Draft');
      assert.equal(source.lineCount, 0);
      assert.equal(source.ownerCurrent, true);
      const command = {
        expectedOwnerKey: requesterKey,
        requestId: randomUUID(),
        batchId: draft.id,
        templateId: template.id,
        lineageHash: source.lineageHash,
        reason: 'Synthetic readiness check',
      };
      await assert.rejects(
        pool.query(
          "insert into invoice_action_events(id,organization_id,legal_entity_id,batch_id,template_id,event_key,policy_class,trigger_kind,lineage_hash,line_count,locale,title,body,actor_id,active_role,request_id,request_fingerprint,reason,operation_id) values($1,$2,$3,$4,$5,'invoice_batch.action_required','ACTION_REQUIRED','EMPTY_DRAFT_ASSESSMENT',$6,0,'en-US','Synthetic','Synthetic',$7,'Admin',$8,$9,'Synthetic bypass','synthetic-operation')",
          [
            randomUUID(),
            f.organizationId,
            f.legalEntityId,
            draft.id,
            template.id,
            source.lineageHash,
            ids.requester.id,
            randomUUID(),
            'a'.repeat(64),
          ],
        ),
        (e) => e.code === 'IAN01',
      );
      assert.equal(
        (
          await request(route + '/assessments', {
            method: 'POST',
            identity: ids.requester,
            body: { ...command, requestId: randomUUID(), lineageHash: 'f'.repeat(64) },
          })
        ).status,
        409,
      );
      assert.equal((await request(route + '/sources/' + draft.id, { identity: ids.reader })).status, 403);
      assert.equal(
        (
          await request(route + '/sources/' + draft.id, {
            identity: ids.requester,
            scope: { organizationId: f.organizationId, legalEntityId: f.foreignLegalEntityId },
          })
        ).status,
        403,
      );
      await pool.query(
        "create function synthetic_invoice_action_refusal() returns trigger language plpgsql as $$begin if exists(select 1 from invoice_action_recipients where event_id=new.event_id) then raise exception 'synthetic second recipient refusal' using errcode='IAN03';end if;return new;end$$;create trigger synthetic_invoice_action_refusal before insert on invoice_action_recipients for each row execute function synthetic_invoice_action_refusal()",
      );
      assert.equal(
        (await request(route + '/assessments', { method: 'POST', identity: ids.requester, body: command }))
          .status,
        409,
      );
      for (const t of ['invoice_action_events', 'invoice_action_recipients', 'invoice_action_deliveries'])
        assert.equal((await pool.query('select count(*)::int n from ' + t)).rows[0].n, 0);
      await pool.query(
        'drop trigger synthetic_invoice_action_refusal on invoice_action_recipients;drop function synthetic_invoice_action_refusal()',
      );
      await pool.query(
        "create function synthetic_invoice_action_owner_loss() returns trigger language plpgsql as $$begin update users set status='Inactive' where id=(select owner_user_id from invoice_draft_batches where id=new.batch_id);return new;end$$;create trigger synthetic_invoice_action_owner_loss after insert on invoice_action_events for each row execute function synthetic_invoice_action_owner_loss()",
      );
      assert.equal(
        (await request(route + '/assessments', { method: 'POST', identity: ids.requester, body: command }))
          .status,
        403,
      );
      assert.equal((await pool.query('select count(*)::int n from invoice_action_events')).rows[0].n, 0);
      assert.equal(
        (await pool.query('select status from users where id=$1', [ids.manager.id])).rows[0].status,
        'Active',
      );
      await pool.query(
        'drop trigger synthetic_invoice_action_owner_loss on invoice_action_events;drop function synthetic_invoice_action_owner_loss()',
      );
      const both = await Promise.all([
        request(route + '/assessments', { method: 'POST', identity: ids.requester, body: command }),
        request(route + '/assessments', { method: 'POST', identity: ids.requester, body: command }),
      ]);
      assert.deepEqual(both.map((x) => x.status).sort(), [200, 201]);
      const event = both.find((x) => x.status === 201).body.event;
      assert.equal(event.eventKey, 'invoice_batch.action_required');
      assert.equal(
        (
          await request(route + '/assessments', {
            method: 'POST',
            identity: ids.requester,
            body: { ...command, reason: 'Changed request' },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(route + '/assessments', {
            method: 'POST',
            identity: ids.requester,
            body: { ...command, requestId: randomUUID() },
          })
        ).status,
        409,
      );
      assert.equal(
        ok(await request(route + '/receipts/' + command.requestId, { identity: ids.requester })).event.id,
        event.id,
      );
      const recipients = (
        await pool.query(
          'select user_id,reasons,in_app,channel_decision from invoice_action_recipients where event_id=$1 order by user_id',
          [event.id],
        )
      ).rows;
      assert.equal(recipients.length, 2);
      assert(recipients.every((x) => x.in_app && x.channel_decision === 'Required'));
      assert.deepEqual(
        new Set(recipients.flatMap((x) => x.reasons)),
        new Set(['invoice_batch_owner', 'finance_preparer']),
      );
      const inbox = ok(await request(work + '/inbox', { identity: ids.manager })),
        notice = inbox.notifications.find((x) => x.kind === 'invoice-action' && x.eventId === event.id);
      assert(notice);
      const read = ok(
        await request(work + '/inbox/' + notice.id + '/read', {
          method: 'POST',
          identity: ids.manager,
          body: { expectedOwnerKey: inbox.ownerKey },
        }),
      );
      assert(read.notification.readAt);
      assert.equal(
        (
          await request(work + '/inbox/' + notice.id + '/read', {
            method: 'POST',
            identity: ids.requester,
            body: { expectedOwnerKey: requesterKey },
          })
        ).status,
        404,
      );
      assert.equal((await pool.query('select count(*)::int n from invoice_action_events')).rows[0].n, 1);
      const sameDraft = ok(
        await request(drafts + '/batches', {
          method: 'POST',
          identity: ids.requester,
          body: {
            expectedOwnerKey: requesterKey,
            requestId: randomUUID(),
            definition: {
              clientId: roots.contract.clientId,
              contractId: roots.contract.id,
              engagementId: roots.engagement.id,
              currency: 'USD',
              periodStart: fx.today,
              periodEnd: fx.today,
              periodBasis: 'WORK_DATE',
              ownerUserId: ids.requester.id,
              ownerRole: 'Admin',
            },
            reason: 'Synthetic deduplicated draft',
          },
        }),
        201,
      ).batch;
      const sameSource = ok(
          await request(route + '/sources/' + sameDraft.id, { identity: ids.requester }),
        ).source,
        same = ok(
          await request(route + '/assessments', {
            method: 'POST',
            identity: ids.requester,
            body: {
              ...command,
              requestId: randomUUID(),
              batchId: sameDraft.id,
              lineageHash: sameSource.lineageHash,
            },
          }),
          201,
        ).event,
        sameRecipients = (
          await pool.query('select reasons from invoice_action_recipients where event_id=$1', [same.id])
        ).rows;
      assert.equal(sameRecipients.length, 1);
      assert.deepEqual(sameRecipients[0].reasons, ['finance_preparer', 'invoice_batch_owner']);
      const raceDraft = ok(
          await request(drafts + '/batches', {
            method: 'POST',
            identity: ids.requester,
            body: {
              expectedOwnerKey: requesterKey,
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
              reason: 'Synthetic race draft',
            },
          }),
          201,
        ).batch,
        raceSource = ok(
          await request(route + '/sources/' + raceDraft.id, { identity: ids.requester }),
        ).source,
        race = await Promise.all([
          request(route + '/assessments', {
            method: 'POST',
            identity: ids.requester,
            body: {
              ...command,
              requestId: randomUUID(),
              batchId: raceDraft.id,
              lineageHash: raceSource.lineageHash,
            },
          }),
          request(drafts + '/batches/' + raceDraft.id + '/cancellations', {
            method: 'POST',
            identity: ids.requester,
            body: {
              expectedOwnerKey: requesterKey,
              requestId: randomUUID(),
              expectedLineCount: 0,
              reason: 'Synthetic race cancellation',
            },
          }),
        ]);
      assert.equal(race[1].status, 201, JSON.stringify(race[1].body));
      assert([201, 409].includes(race[0].status));
      assert.equal(
        (
          await pool.query('select count(*)::int n from invoice_action_events where batch_id=$1', [
            raceDraft.id,
          ])
        ).rows[0].n,
        race[0].status === 201 ? 1 : 0,
      );
      assert.equal(
        (
          await request(route + '/assessments', {
            method: 'POST',
            identity: ids.requester,
            body: {
              ...command,
              requestId: randomUUID(),
              batchId: raceDraft.id,
              lineageHash: raceSource.lineageHash,
            },
          })
        ).status,
        409,
      );
      console.log(
        'Synthetic empty Draft action, second-recipient and owner-loss rollback, stale and unauthorized denial, distinct/deduplicated recipients, SQL bypass, cancellation race, concurrency, exact replay and owned inbox passed.',
      );
      await pool.query(
        "update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.invoice_drafts.view'",
      );
      const restricted = ok(await request(work + '/inbox', { identity: ids.manager }));
      assert(!restricted.notifications.some((x) => x.id === notice.id));
      assert.equal(
        (
          await request(work + '/inbox/' + notice.id + '/read', {
            method: 'POST',
            identity: ids.manager,
            body: { expectedOwnerKey: inbox.ownerKey },
          })
        ).status,
        404,
      );
    },
  );
});
