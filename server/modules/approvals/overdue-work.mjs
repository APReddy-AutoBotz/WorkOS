import {randomUUID} from 'node:crypto';
import {OVERDUE_KEY, renderApprovalTemplate} from '../../../shared/work-approval.mjs';
import {workApprovalActor,workApprovalRecipientScope,workApprovalScope} from './work-approval-service.mjs';
import {processRiskTransaction} from '../commercial-drafting/fixed-fee-risk-worker.mjs';

// Version one of the built-in English in-app message for policies without a localized override.
const builtIn={id:'0525e4f1-2f48-48b7-bdc6-3774721b5c0c',locale:'en',
  key:OVERDUE_KEY,subject:'Work approval overdue',body:'Stage {{stageNumber}} for {{sourceRef}} exceeded its deadline.'};

// Catch up from immutable stage history, including decisions recorded between ticks.
export function collectOverdueWorkStages(pool) {
  return pool.query(`insert into work_approval_overdue_stages(instance_id,stage,due_at)
    select s.instance_id,s.stage,s.due_at from work_approval_timed_stages s
    where s.due_at < least(now(),coalesce(s.decided_at,now()))
      and not exists(select from work_approval_overdue_stages e where e.instance_id=s.instance_id and e.stage=s.stage)
    order by s.due_at,s.instance_id,s.stage limit 100 on conflict do nothing`);
}

async function dispatchNext(c,o) {
  const {rows:[v]}=await c.query(`select d.instance_id,d.stage,i.organization_id,i.legal_entity_id,i.timesheet_id,
    i.employee_id,e.employee_id as worker_code,p.id as policy_id,p.definition,coalesce(last.attempt,0)+1 as attempt
    from work_approval_overdue_stages d join work_approval_instances i on i.id=d.instance_id
    join work_approval_policy_versions p on p.id=i.policy_id join employees e on e.id=i.employee_id
    left join lateral(select a.attempt,a.failure,a.created_at from work_approval_overdue_attempts a
      where a.instance_id=d.instance_id and a.stage=d.stage order by a.attempt desc limit 1) last on true
    where last.attempt is null or (last.failure is not null and last.created_at
      + interval '1 minute'*power(2,least(last.attempt-1,6))<=now())
    order by d.due_at,d.instance_id,d.stage limit 1 for update of d skip locked`);
  if (!v) return false;
  const req={organizationScope:{organizationId:v.organization_id,legalEntityId:v.legal_entity_id}};
  const stage=v.definition.stages[v.stage], escalation=v.definition.escalationUserId;
  await c.query('savepoint deliver_overdue');
  try {
    await workApprovalActor(c,req,stage,{id:v.timesheet_id,employee_id:v.employee_id},o);
    if (escalation) await workApprovalRecipientScope(c,req,escalation,[v.employee_id],o);
    const custom=v.definition.overdueTemplate;
    const {title,body}=renderApprovalTemplate(custom??{key:builtIn.key,subject:builtIn.subject,body:builtIn.body},
      {workerCode:v.worker_code,sourceRef:'timesheet/'+v.timesheet_id,stageNumber:String(v.stage+1),decisionReason:''});
    await c.query(`insert into work_approval_overdue_attempts(instance_id,stage,attempt,approver_receipt,escalation_receipt,template_id,locale,title,body)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[v.instance_id,v.stage,v.attempt,randomUUID(),
      escalation && escalation!==stage.userId ? randomUUID() : null,custom?v.policy_id:builtIn.id,custom?v.definition.locale:builtIn.locale,title,body]);
  } catch(error) {
    if (!['WGA05','WORK_APPROVAL_ACTOR_UNAVAILABLE','WORK_APPROVAL_RELATIONSHIP_UNAVAILABLE','WORK_APPROVAL_SELF_DECISION'].includes(error.code)) throw error;
    await c.query('rollback to savepoint deliver_overdue');
    await c.query("insert into work_approval_overdue_attempts(instance_id,stage,attempt,failure)values($1,$2,$3,'RECIPIENT_UNAVAILABLE')",[v.instance_id,v.stage,v.attempt]);
  }
  return true;
}

export function collectWorkStageReminders(pool) {
  return pool.query(`insert into work_approval_stage_reminders(recipient_id)
    select c.recipient_id from work_approval_reminder_candidates c
    where c.remind_at<=now() and c.due_at>now()
      and not exists(select from work_approval_stage_reminders d where d.recipient_id=c.recipient_id)
    order by c.due_at,c.recipient_id limit 100 on conflict do nothing`);
}

export async function processOverdueWork(pool,o) {
  await collectOverdueWorkStages(pool);
  for (let n=0;n<10;n++) if (!await processRiskTransaction(pool,c=>dispatchNext(c,o))) break;
  if ((await pool.query("select to_regclass('work_approval_stage_reminders') is not null as ready")).rows[0].ready)
    await collectWorkStageReminders(pool);
}

export async function timedWorkInboxRows(c,req,o,{after=null,id=null}={}) {
  const {rows:[schema]}=await c.query(`select to_regclass('public.work_approval_overdue_inbox') is not null as overdue,
    to_regclass('public.work_approval_reminder_inbox') is not null as reminders`);
  if (!schema.overdue) return [];
  const params=[req.user.sub,...workApprovalScope(req),after,id],where=o.buildEmployeeScopeWhere(req,params,'e');
  const overdue=(await c.query(`select r.id,'work-approval/'||r.instance_id||'/'||r.stage||'/approval.overdue_or_escalated/deadline' as "eventId",
    r.instance_id as "instanceId", r.timesheet_id as "timesheetId",r.submission_id as "submissionId",r.stage as "transitionSequence",
    'approval.overdue_or_escalated' as "eventKey",'CONTROL_MANDATORY' as "policyClass",r.template_id as "templateId",
    'deadline' as "operationId",r.locale,r.title,r.body,r.reasons,'Required' as "channelDecision",r.created_at as "createdAt",rd.read_at as "readAt"
    from work_approval_overdue_inbox r join employees e on e.id=r.employee_id and e.organization_id=r.organization_id and e.legal_entity_id=r.legal_entity_id
    left join work_approval_overdue_reads rd on rd.recipient_id=r.id and rd.user_id=r.user_id
    where r.user_id=$1 and r.organization_id=$2 and r.legal_entity_id=$3 and ($4::uuid is null or r.id>$4)
    and ($5::uuid is null or r.id=$5) and ${where} order by r.id limit 21`,params)).rows;
  if (!schema.reminders) return overdue;
  const reminders=(await c.query(`select r.id,r.event_id as "eventId",r.instance_id as "instanceId",r.timesheet_id as "timesheetId",
    r.submission_id as "submissionId",r.transition_sequence as "transitionSequence",r.event_key as "eventKey",
    r.policy_class as "policyClass",r.template_id as "templateId",r.operation_id as "operationId",r.locale,r.title,r.body,r.reasons,
    r.channel_decision as "channelDecision",r.created_at as "createdAt",rd.read_at as "readAt",true as reminder
    from work_approval_reminder_inbox r join employees e on e.id=r.employee_id and e.organization_id=r.organization_id and e.legal_entity_id=r.legal_entity_id
    left join work_approval_overdue_reads rd on rd.recipient_id=r.id and rd.user_id=r.user_id
    where r.user_id=$1 and r.organization_id=$2 and r.legal_entity_id=$3 and ($4::uuid is null or r.id>$4)
    and ($5::uuid is null or r.id=$5) and ${where} order by r.id limit 21`,params)).rows;
  return [...overdue,...reminders];
}

export function startOverdueWorkWorker(pool,server,o) {
  let running=false;
  async function tick() {
    if (running) return;
    running=true;
    try {await processOverdueWork(pool,o);}
    catch {console.error('Overdue work approval processing unavailable.');}
    finally {running=false;}
  }
  const timer=setInterval(tick,30_000);
  timer.unref();
  server.once('close',()=>clearInterval(timer));
}
