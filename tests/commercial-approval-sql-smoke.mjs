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
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedCapacity(pool),
    admin = fx.identities.manager,
    approver = fx.identities.denied;
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
  await withCommercialApi({ databaseUrl, identities: fx.identities }, async ({ request }) => {
    const cont = await request('/contracts', {
      method: 'POST',
      body: {
        number: 'SYN-APPROVAL-ONE',
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
    });
    assert.equal(cont.status, 201, JSON.stringify(cont.body));
    const cand = await request('/api/v1/rate-candidates/candidates', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        streamId: randomUUID(),
        expectedLatestId: null,
        kind: 'billing',
        bindingType: 'contract',
        bindingId: cont.body.id,
        effectiveFrom: fx.today,
        effectiveTo: fx.today,
        currency: 'USD',
        unit: 'HOUR',
        amount: '42.0001',
        priority: 1,
        reason: 'Synthetic candidate',
      },
    });
    assert.equal(cand.status, 201, JSON.stringify(cand.body));
    const own = await request('/api/v1/rate-candidates/owners', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        candidateId: cand.body.candidate.id,
        expectedOwnerEventId: null,
        ownerUserId: admin.id,
        ownerRole: 'Admin',
        reason: 'Synthetic owner',
      },
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const cid = cand.body.candidate.id,
      oid = own.body.owner.id,
      pid = randomUUID(),
      iid = randomUUID(),
      keys = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
    const definition = {
      entityType: 'CommercialCandidate',
      kind: 'billing',
      candidateId: cid,
      stages: [{ userId: approver.id, role: 'TeamLead' }],
      locale: 'en-US',
      templates: keys.map((key) => ({
        key,
        subject: 'Review {{stageNumber}}',
        body: 'Source {{sourceRef}}',
      })),
      completionInApp: false,
    };
    const ctx = (actor, role, operation, instance = null) =>
      JSON.stringify({
        actorId: actor,
        activeRole: role,
        operationId: operation,
        organizationId: f.organizationId,
        legalEntityId: f.legalEntityId,
        instanceId: instance,
      });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(admin.id, 'Admin', 'policy'),
      ]);
      await c.query(
        `insert into commercial_candidate_approval_policies(id,organization_id,legal_entity_id,candidate_id,sequence,previous_id,effective_from,definition,actor_id,active_role,reason,request_id,request_fingerprint,operation_id)values($1,$2,$3,$4,1,null,$5,$6::jsonb,$7,$8,$9,gen_random_uuid(),repeat('a',64),'policy')`,
        [
          pid,
          f.organizationId,
          f.legalEntityId,
          cid,
          fx.today,
          JSON.stringify(definition),
          admin.id,
          'Admin',
          'Synthetic policy',
        ],
      );
      await c.query('commit');
      const incomplete = randomUUID();
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(admin.id, 'Admin', 'incomplete', incomplete),
      ]);
      await c.query(
        `insert into commercial_candidate_approval_instances(id,organization_id,legal_entity_id,candidate_id,owner_event_id,policy_id,requester_user_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Synthetic reason',$11)`,
        [
          incomplete,
          f.organizationId,
          f.legalEntityId,
          cid,
          oid,
          pid,
          admin.id,
          'Admin',
          randomUUID(),
          'c'.repeat(64),
          'incomplete',
        ],
      );
      await assert.rejects(c.query('commit'), { code: 'CCA04' });
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_instances where id=$1',
            [incomplete],
          )
        ).rows[0].n,
        0,
      );
      const rid = randomUUID(),
        ev = 'synthetic-approval-event',
        rec = randomUUID();
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(admin.id, 'Admin', 'request', iid),
      ]);
      await c.query(
        `insert into commercial_candidate_approval_instances(id,organization_id,legal_entity_id,candidate_id,owner_event_id,policy_id,requester_user_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Synthetic reason',$11)`,
        [
          iid,
          f.organizationId,
          f.legalEntityId,
          cid,
          oid,
          pid,
          admin.id,
          'Admin',
          randomUUID(),
          'a'.repeat(64),
          'request',
        ],
      );
      await c.query(
        "insert into approval_records(id,entity_type,entity_id,status,source)values($1,'CommercialCandidateApproval',$2,'Pending','Web')",
        ['synthetic-' + iid, iid],
      );
      await c.query(
        "insert into commercial_candidate_approval_events(id,instance_id,transition_sequence,stage,event_key,policy_class,policy_id,operation_id,locale,title,body)values($1,$2,0,0,'approval.action_required','ACTION_REQUIRED',$3,'request','en-US','Review 1',$4)",
        [ev, iid, pid, 'Source commercial-candidate/' + cid],
      );
      await c.query(
        "insert into commercial_candidate_approval_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,array['current_stage_approver'],true,'Required')",
        [rec, ev, approver.id],
      );
      await c.query(
        "insert into commercial_candidate_approval_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)",
        [rid, rec],
      );
      await c.query('commit');
      const failedId = randomUUID();
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(approver.id, 'TeamLead', 'incomplete-decision', iid),
      ]);
      await c.query(
        "insert into commercial_candidate_approval_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,1,0,'Rejected',$3,'TeamLead',$4,$5,'Synthetic reason','incomplete-decision')",
        [failedId, iid, approver.id, randomUUID(), 'd'.repeat(64)],
      );
      await c.query(
        "update approval_records set status='Rejected' where entity_type='CommercialCandidateApproval' and entity_id=$1",
        [iid],
      );
      await c.query(
        "insert into commercial_candidate_approval_events(id,instance_id,transition_sequence,stage,event_key,policy_class,policy_id,operation_id,locale,title,body)values('synthetic-incomplete',$1,1,0,'approval.rejected_or_correction_required','ACTION_REQUIRED',$2,'incomplete-decision','en-US','Review 1',$3)",
        [iid, pid, 'Source commercial-candidate/' + cid],
      );
      await assert.rejects(c.query('commit'), { code: 'CCA04' });
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
            [iid],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query('select status from approval_records where entity_id=$1', [iid])).rows[0].status,
        'Pending',
      );
      const op = 'decision',
        did = randomUUID(),
        resultEvent = 'synthetic-rejected',
        rr = randomUUID();
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(approver.id, 'TeamLead', op, iid),
      ]);
      await c.query(
        "insert into commercial_candidate_approval_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,1,0,'Rejected',$3,'TeamLead',$4,$5,'Synthetic reason',$6)",
        [did, iid, approver.id, randomUUID(), 'b'.repeat(64), op],
      );
      await c.query(
        "update approval_records set status='Rejected' where entity_type='CommercialCandidateApproval' and entity_id=$1",
        [iid],
      );
      await c.query(
        "insert into commercial_candidate_approval_events(id,instance_id,transition_sequence,stage,event_key,policy_class,policy_id,operation_id,locale,title,body)values($1,$2,1,0,'approval.rejected_or_correction_required','ACTION_REQUIRED',$3,$4,'en-US','Review 1',$5)",
        [resultEvent, iid, pid, op, 'Source commercial-candidate/' + cid],
      );
      await c.query(
        "insert into commercial_candidate_approval_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,array['commercial_change_owner','requester'],true,'Required')",
        [rr, resultEvent, admin.id],
      );
      await c.query(
        "insert into commercial_candidate_approval_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)",
        [randomUUID(), rr],
      );
      await c.query('commit');
      assert.equal(
        (await pool.query('select status from approval_records where entity_id=$1', [iid])).rows[0].status,
        'Rejected',
      );
      const stale = randomUUID(),
        staleEvent = 'synthetic-stale-event',
        staleRecipient = randomUUID();
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(admin.id, 'Admin', 'stale-request', stale),
      ]);
      await c.query(
        `insert into commercial_candidate_approval_instances(id,organization_id,legal_entity_id,candidate_id,owner_event_id,policy_id,requester_user_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Synthetic reason',$11)`,
        [
          stale,
          f.organizationId,
          f.legalEntityId,
          cid,
          oid,
          pid,
          admin.id,
          'Admin',
          randomUUID(),
          'e'.repeat(64),
          'stale-request',
        ],
      );
      await c.query(
        "insert into approval_records(id,entity_type,entity_id,status,source)values($1,'CommercialCandidateApproval',$2,'Pending','Web')",
        ['synthetic-' + stale, stale],
      );
      await c.query(
        "insert into commercial_candidate_approval_events(id,instance_id,transition_sequence,stage,event_key,policy_class,policy_id,operation_id,locale,title,body)values($1,$2,0,0,'approval.action_required','ACTION_REQUIRED',$3,'stale-request','en-US','Review 1',$4)",
        [staleEvent, stale, pid, 'Source commercial-candidate/' + cid],
      );
      await c.query(
        "insert into commercial_candidate_approval_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,array['current_stage_approver'],true,'Required')",
        [staleRecipient, staleEvent, approver.id],
      );
      await c.query(
        "insert into commercial_candidate_approval_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)",
        [randomUUID(), staleRecipient],
      );
      await c.query('commit');
      await pool.query("update users set status='Disabled' where id=$1", [admin.id]);
      assert.equal(
        (
          await pool.query(
            'select commercial_candidate_approval_is_current(i) current from commercial_candidate_approval_instances i where i.id=$1',
            [stale],
          )
        ).rows[0].current,
        false,
      );
      await pool.query("update users set status='Active' where id=$1", [admin.id]);
      const changed = await request('/api/v1/rate-candidates/owners', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          candidateId: cid,
          expectedOwnerEventId: oid,
          ownerUserId: admin.id,
          ownerRole: 'Admin',
          reason: 'Synthetic changed owner version',
        },
      });
      assert.equal(changed.status, 201, JSON.stringify(changed.body));
      assert.equal(
        (
          await pool.query(
            'select commercial_candidate_approval_is_current(i) current from commercial_candidate_approval_instances i where i.id=$1',
            [stale],
          )
        ).rows[0].current,
        false,
      );
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(approver.id, 'TeamLead', 'stale-decision', stale),
      ]);
      await assert.rejects(
        c.query(
          "insert into commercial_candidate_approval_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,1,0,'Approved',$3,'TeamLead',$4,$5,'Synthetic reason','stale-decision')",
          [randomUUID(), stale, approver.id, randomUUID(), 'f'.repeat(64)],
        ),
        { code: 'CCA02' },
      );
      await c.query('rollback');
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_transitions where instance_id=$1',
            [stale],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query('select status from approval_records where entity_id=$1', [stale])).rows[0].status,
        'Pending',
      );
      const badCancel = randomUUID();
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(admin.id, 'Admin', 'cancel-without-audit', stale),
      ]);
      await c.query(
        "insert into commercial_candidate_approval_invalidations(id,instance_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,'Admin',$4,repeat('f',64),'Synthetic cancellation','cancel-without-audit')",
        [badCancel, stale, admin.id, randomUUID()],
      );
      await c.query(
        "update approval_records set status='Cancelled' where entity_type='CommercialCandidateApproval' and entity_id=$1",
        [stale],
      );
      await assert.rejects(c.query('commit'), { code: 'CCA04' });
      assert.equal(
        (await pool.query('select status from approval_records where entity_id=$1', [stale])).rows[0].status,
        'Pending',
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_invalidations where instance_id=$1',
            [stale],
          )
        ).rows[0].n,
        0,
      );
      const cancellation = randomUUID(),
        cancelOp = 'synthetic-cancel';
      await c.query('begin');
      await c.query("select set_config('workos.commercial_approval_context',$1,true)", [
        ctx(admin.id, 'Admin', cancelOp, stale),
      ]);
      await c.query(
        "insert into commercial_candidate_approval_invalidations(id,instance_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,'Admin',$4,repeat('f',64),'Synthetic cancellation',$5)",
        [cancellation, stale, admin.id, randomUUID(), cancelOp],
      );
      await c.query(
        "update approval_records set status='Cancelled' where entity_type='CommercialCandidateApproval' and entity_id=$1",
        [stale],
      );
      await c.query(
        "insert into audit_logs(user_id,user_name,user_role,active_role,module,action,entity_type,entity_id,new_value,details,organization_id,legal_entity_id,operation_id)values($1,'Synthetic actor','Admin','Admin','Commercial Approval','Cancel Request','CommercialCandidateApproval',$2,$3::jsonb,'Synthetic redacted audit',$4,$5,$6)",
        [
          admin.id,
          cancellation,
          JSON.stringify({ cancellationId: cancellation, instanceId: stale }),
          f.organizationId,
          f.legalEntityId,
          cancelOp,
        ],
      );
      await c.query('commit');
      assert.equal(
        (await pool.query('select status from approval_records where entity_id=$1', [stale])).rows[0].status,
        'Cancelled',
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from commercial_candidate_approval_events where instance_id=$1',
            [stale],
          )
        ).rows[0].n,
        1,
      );
      console.log(
        'Synthetic SQL request, deduplicated rejection, recipient rollback, stale refusal and authorized audited cancellation passed.',
      );
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });
});
