import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {compareCapabilityIds} from '../../shared/workforce-capabilities.mjs';
import {adoptStagedPolicy, stagedDefinition, WORK_APPROVAL_BASE} from './work-approval-test.mjs';

export async function measureStagedApprovals({pool, request, accounts, sessions, identities, samples, thresholds, readOwnWork, readReport}) {
  const stageWorkers = accounts.slice(90,180);
  const approvers = {manager: sessions[0], second: sessions[1]};
  const definition = stagedDefinition(approvers);
  definition.workerIds = stageWorkers.map(account => account.worker).sort(compareCapabilityIds);
  const today = (await pool.query("select to_char(now() at time zone 'UTC','YYYY-MM-DD') as day")).rows[0].day;
  const policy = await adoptStagedPolicy(request, identities, today, definition);
  const stagedHeaders = new Map();
  const stagedWeek = '2024-03-03';
  for (const [phase, reviewer, stage] of [
    ['staged submission', null, null],
    ['first stage', approvers.manager, 0],
    ['final stage', approvers.second, 1],
  ]) {
    const readKey = 'read during ' + phase;
    const reportKey = 'report during ' + phase;
    for (const [key, target] of [[phase,3000],[readKey,2000],[reportKey,5000]]) {
      samples[key] = [];
      thresholds[key] = target;
    }
    for (let offset = 0; offset < stageWorkers.length; offset += 15) {
      const group = stageWorkers.slice(offset,offset+15);
      // Each named reviewer loads the pending source and sequence before the timed decision wave.
      const views = reviewer ? await Promise.all(group.map(async worker => {
        const header = stagedHeaders.get(worker.id);
        const list = await request(WORK_APPROVAL_BASE + '/instances?timesheetId=' + header, {identity:reviewer});
        assert.equal(list.status,200,JSON.stringify(list.body));
        assert.equal(list.body.instances.length,1);
        const detail = await request(WORK_APPROVAL_BASE + '/instances/' + list.body.instances[0].id, {identity:reviewer});
        assert.equal(detail.status,200,JSON.stringify(detail.body));
        const instance = detail.body.instance;
        assert.equal(instance.policy.id,policy.id);
        assert.equal(instance.timesheetId,header);
        assert.equal(instance.state.currentStage,stage);
        return {instance, ownerKey:detail.body.ownerKey};
      })) : [];
      await Promise.all([
        ...group.map(async (worker,index) => {
          const started = performance.now();
          if (reviewer) {
            const {instance, ownerKey} = views[index];
            const result = await request(WORK_APPROVAL_BASE + '/instances/' + instance.id + '/decisions', {
              method:'POST', identity:reviewer, body:{expectedOwnerKey:ownerKey, expectedSourceToken:instance.sourceToken,
                expectedSequence:instance.state.sequence, requestId:randomUUID(), decision:'Approved', reason:'Synthetic Standard-profile review'},
            });
            samples[phase].push(performance.now()-started);
            assert.equal(result.status,201,JSON.stringify(result.body));
            assert.equal(result.body.receipt.outcome.status,stage === 0 ? 'Pending' : 'Approved');
          } else {
            const result = await request('/api/timesheets', {method:'POST', identity:worker, body:{employee_id:worker.worker,
              week_ending:stagedWeek, status:'Submitted', expected_write_token:null, entries:[{work_date:stagedWeek,
                work_type:'Client Misc Task', client_name:'Synthetic client', hours:'1', remark:'Synthetic staged work', billable:false}]}});
            samples[phase].push(performance.now()-started);
            assert.equal(result.status,200,JSON.stringify(result.body));
            stagedHeaders.set(worker.id,result.body.id);
          }
        }),
        ...sessions.slice(20,75).map(employee => readOwnWork(employee, readKey)),
        ...sessions.slice(0,5).map(admin => readReport(admin, reportKey)),
      ]);
    }
    assert.equal(samples[phase].length, 90);
    assert.equal(samples[readKey].length, 330);
    assert.equal(samples[reportKey].length, 30);
    const headers = [...stagedHeaders.values()];
    const state = await pool.query('select status,count(*)::int n from timesheets where id=any($1::uuid[]) group by status',[headers]);
    assert.deepEqual(state.rows,[{status:stage === 1 ? 'Approved' : 'Submitted',n:90}]);
    const decisions = await pool.query(`select count(*)::int n from work_submission_decisions d
      join work_approval_instances i on i.submission_id=d.submission_id where i.policy_id=$1`,[policy.id]);
    assert.equal(decisions.rows[0].n,stage === 1 ? 90 : 0);
  }
  const transitions = await pool.query(`select t.stage,t.actor_id,count(distinct i.id)::int n from work_approval_instances i
    join work_approval_transitions t on t.instance_id=i.id where i.policy_id=$1 and t.actor_id<>i.requester_user_id
    and t.decision='Approved' group by t.stage,t.actor_id order by t.stage`,[policy.id]);
  assert.deepEqual(transitions.rows,[{stage:0,actor_id:approvers.manager.id,n:90},{stage:1,actor_id:approvers.second.id,n:90}]);
  const notifications = await pool.query(`select e.transition_sequence, count(*)::int recipients,
    count(distinct i.id) filter (where r.in_app and r.user_id=case e.transition_sequence
      when 0 then $2::uuid when 1 then $3::uuid else i.requester_user_id end)::int matching_instances
    from work_approval_instances i join work_approval_events e on e.instance_id=i.id
    join work_approval_recipients r on r.event_id=e.id where i.policy_id=$1
    group by e.transition_sequence order by e.transition_sequence`,[policy.id,approvers.manager.id,approvers.second.id]);
  assert.deepEqual(notifications.rows,[0,1,2].map(transition_sequence => ({transition_sequence,recipients:90,matching_instances:90})));
}
