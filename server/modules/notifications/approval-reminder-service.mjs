import {randomUUID} from 'node:crypto';
import {validApprovalReminderDefinition,APPROVAL_REMINDER_KEY,approvalReminderRecipients,approvalReminderIdentity,renderApprovalReminder} from '../../../shared/approval-reminder.mjs';
import {validApprovalDueDefinition} from '../../../shared/approval-due.mjs';
import {capacityCanonical,capacityHash} from '../planning/worker-capacity-service.mjs';
import {workApprovalScope as scope,workApprovalFail as fail,setWorkApprovalContext,workApprovalActor} from '../approvals/work-approval-service.mjs';
import {assignmentApprovalActor} from '../approvals/assignment-approval-service.mjs';
import {leaveApprovalActor} from '../approvals/leave-approval-service.mjs';
import {canonicalStageRecipients} from '../approvals/canonical-delegation-service.mjs';
import {approvalDueSource} from './approval-due-service.mjs';

const iso=v=>v instanceof Date?v.toISOString():v;
export const assertReminderSourcePermission=(req,origin)=>{
 const needed=origin==='Work'?['timesheets.submit']:origin==='Leave'?['leave.self_service']:['allocations.view','projects.view'];
 if(!needed.every(k=>req.user.permissions.includes(k)))fail('APPROVAL_REMINDER_SOURCE_FORBIDDEN','Existing source-read permission is required.',403);
};
export const reminderPolicyView=p=>({id:p.id,sequence:p.sequence,previousPolicyId:p.previous_policy_id,duePolicyId:p.due_policy_id,effectiveFrom:p.effective_from,definition:p.definition,actorId:p.actor_id,activeRole:p.active_role,requestId:p.request_id,reason:p.reason,operationId:p.operation_id,createdAt:iso(p.created_at)});
export const reminderRunView=r=>({id:r.id,sequence:r.sequence,origin:r.origin,instanceId:r.instance_id,stage:r.stage,clockId:r.clock_id,policyId:r.policy_id,requestId:r.request_id,actorId:r.actor_id,activeRole:r.active_role,reason:r.reason,operationId:r.operation_id,correlationId:r.correlation_id,sourceToken:r.source_token,outcome:r.outcome,createdAt:iso(r.created_at)});
export const linkedReminderDue=async(c,req,id)=>{
 const p=(await c.query('select *,effective_from::text from approval_due_policies where id=$1 and organization_id=$2 and legal_entity_id=$3',[id,...scope(req)])).rows[0];
 if(!p||!validApprovalDueDefinition(p.definition))fail('APPROVAL_REMINDER_DUE_UNAVAILABLE','Select an existing valid due-policy version in this scope.',404);
 for(const kind of p.definition.sourceKinds)assertReminderSourcePermission(req,kind);
 return p;
};
export const adoptReminderPolicy=async(c,req,input,o)=>{
 const fingerprint=capacityHash({actorId:req.user.sub,activeRole:req.user.activeRole,...input}),old=(await c.query('select *,effective_from::text from approval_reminder_policies where organization_id=$1 and legal_entity_id=$2 and request_id=$3',[...scope(req),input.requestId])).rows[0];
 await linkedReminderDue(c,req,input.duePolicyId);
 if(old){if(old.request_fingerprint!==fingerprint)fail('APPROVAL_REMINDER_REQUEST_CONFLICT','This request identifies different retained policy content.');return{policy:reminderPolicyView(old),replayed:true};}
 const latest=(await c.query('select *,effective_from::text from approval_reminder_policies where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 1',scope(req))).rows[0];
 if((latest?.id??null)!==input.expectedLatestId)fail('APPROVAL_REMINDER_POLICY_STALE','Reminder configuration changed. Load its latest retained version.');
 const due=await linkedReminderDue(c,req,input.duePolicyId);
 if(input.definition!==null&&(!validApprovalReminderDefinition(input.definition)||input.definition.afterMinutes>=due.definition.dueAfterMinutes))fail('APPROVAL_REMINDER_INTERVAL_INVALID','Choose a positive reminder interval strictly before this due-policy interval.',422);
 for(const id of due.definition.workerIds){const p=[id],where=o.buildEmployeeScopeWhere(req,p,'e');if(!(await c.query(`select 1 from employees e where e.id=$1 and e.status='Active'and ${where}`,p)).rowCount)fail('APPROVAL_REMINDER_POLICY_SCOPE','Every linked worker must retain current active scoped authority.',403);}
 await setWorkApprovalContext(c,req);
 const saved=(await c.query('insert into approval_reminder_policies(id,organization_id,legal_entity_id,sequence,previous_policy_id,due_policy_id,effective_from,definition,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)returning *,effective_from::text',[randomUUID(),...scope(req),(latest?.sequence??0)+1,latest?.id??null,due.id,input.effectiveFrom,input.definition,req.user.sub,req.user.activeRole,input.requestId,fingerprint,input.reason,req.operationId])).rows[0];
 if(input.definition!==null){const d=input.definition;await c.query('insert into approval_reminder_templates values($1,$2,$3,$4,$5,$6)',[randomUUID(),saved.id,APPROVAL_REMINDER_KEY,d.locale,d.template.subject,d.template.body]);}
 await o.audit(c,req,{module:'Approvals',action:'Adopt Prospective Approval Reminder Policy',entityType:'ApprovalReminderPolicy',entityId:saved.id,oldValue:latest?reminderPolicyView(latest):null,newValue:reminderPolicyView(saved),reason:input.reason,details:'Explicit immutable due-policy linkage and new-instance UTC reminder or explicit prospective disable; no legacy adoption, default, authority grant, schedule or external delivery.'});
 return{policy:reminderPolicyView(saved),replayed:false};
};

export const reminderPreview=async(c,req,origin,instanceId,stage,o)=>{
 assertReminderSourcePermission(req,origin);
 const source=await approvalDueSource(c,req,origin,instanceId,o),now=(await c.query('select clock_timestamp() now')).rows[0].now.toISOString();
 const row=(await c.query('select cl.*,p.id reminder_policy_id,p.sequence reminder_policy_sequence,p.due_policy_id,p.definition,d.definition->>\'dueAfterMinutes\' due_minutes from approval_due_clocks cl join approval_reminder_bindings b on b.origin=cl.origin and b.instance_id=cl.instance_id join approval_reminder_policies p on p.id=b.policy_id join approval_due_policies d on d.id=p.due_policy_id where cl.origin=$1 and cl.instance_id=$2 and cl.stage=$3 and cl.activated_at>=p.created_at',[origin,instanceId,stage])).rows[0];
 const clock=row?{id:row.id,policyId:row.reminder_policy_id,policySequence:row.reminder_policy_sequence,duePolicyId:row.due_policy_id,stage:row.stage,pendingAt:iso(row.activated_at),reminderAt:new Date(row.activated_at.getTime()+row.definition.afterMinutes*60000).toISOString(),dueAt:iso(row.due_at),afterMinutes:row.definition.afterMinutes,dueAfterMinutes:Number(row.due_minutes),approver:{userId:row.approver_user_id,role:row.approver_role},locale:row.definition.locale}:null;
 const current=(await c.query('select approval_due_current($1,$2,$3)current',[origin,instanceId,stage])).rows[0].current;
 const existing=row?(await c.query('select id from approval_reminder_events where clock_id=$1',[row.id])).rows[0]?.id??null:null;
 const state=source.state.status!=='Pending'?'Terminal':source.state.currentStage!==stage||!current?'Stale':!clock?'Unconfigured':existing?'Notified':Date.parse(now)<Date.parse(clock.reminderAt)?'Waiting':Date.parse(now)>=Date.parse(clock.dueAt)?'Overdue':'Ready';
 let recipients=[],delegatedApprover;
 if(state==='Ready'){
  const v=source.v,stages=origin==='Work'?v.policy.definition.stages:v.p.definition.stages,validate=origin==='Work'?workApprovalActor:origin==='Leave'?leaveApprovalActor:assignmentApprovalActor;
  const record=origin==='Work'?(await c.query('select * from timesheets where id=$1',[v.i.timesheet_id])).rows[0]:v.a;
  recipients=approvalReminderRecipients(await canonicalStageRecipients(c,req,v,stages,stage,record,validate,o));
  const binding=(v.delegations??[]).find(b=>b.stage===stage&&b.eligible);if(binding)delegatedApprover={bindingId:binding.id,delegationId:binding.delegationId,userId:binding.delegateUserId,role:binding.role};
 }
 const view={...(delegatedApprover?{delegatedApprover}:{}),origin,instanceId,stage,worker:source.worker,sourceVersion:source.sourceToken,sourceState:source.state,clock,state,eventKey:state==='Ready'?APPROVAL_REMINDER_KEY:null,existingEvent:existing,recipientReasons:recipients},canonical=capacityCanonical(view);
 return{...view,sourceToken:capacityHash(canonical),checkedAt:now,sourceCanonical:canonical};
};
export const reminderPreviewView=({sourceCanonical:_canonical,...v})=>v;
export const evaluateReminder=async(c,req,input,o)=>{
 assertReminderSourcePermission(req,input.origin);
 const fingerprint=capacityHash({actorId:req.user.sub,activeRole:req.user.activeRole,...input}),old=(await c.query('select * from approval_reminder_runs where organization_id=$1 and legal_entity_id=$2 and request_id=$3',[...scope(req),input.requestId])).rows[0];
 if(old){await approvalDueSource(c,req,old.origin,old.instance_id,o);if(old.request_fingerprint!==fingerprint)fail('APPROVAL_REMINDER_REQUEST_CONFLICT','This request identifies different inspected reminder content.');return{receipt:reminderRunView(old),replayed:true};}
 const v=await reminderPreview(c,req,input.origin,input.instanceId,input.stage,o);
 if(v.sourceToken!==input.expectedSourceToken||v.eventKey!==input.expectedEventKey)fail('APPROVAL_REMINDER_STALE','Source, current stage, reminder phase or recipient authority changed. Inspect again.');
 const id=randomUUID(),sequence=(await c.query('select coalesce(max(sequence),0)+1 n from approval_reminder_runs where origin=$1 and instance_id=$2',[input.origin,input.instanceId])).rows[0].n;
 const eventId=v.eventKey?approvalReminderIdentity(v.clock.id,req.operationId):v.existingEvent;
 const outcome={state:v.state,disposition:v.eventKey?'Emitted':v.existingEvent?'Existing':'NoEvent',eventKey:v.eventKey,eventId,checkedAt:v.checkedAt,sourceToken:v.sourceToken};
 await setWorkApprovalContext(c,req);
 const saved=(await c.query('insert into approval_reminder_runs(id,organization_id,legal_entity_id,origin,instance_id,stage,clock_id,policy_id,sequence,request_id,request_fingerprint,actor_id,active_role,reason,operation_id,correlation_id,source_token,source_canonical,outcome)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)returning *',[id,...scope(req),v.origin,v.instanceId,v.stage,v.clock?.id??null,v.clock?.policyId??null,sequence,input.requestId,fingerprint,req.user.sub,req.user.activeRole,input.reason,req.operationId,req.correlationId,v.sourceToken,v.sourceCanonical,outcome])).rows[0];
 if(v.eventKey){
  const p=(await c.query('select p.definition,t.* from approval_reminder_policies p join approval_reminder_templates t on t.policy_id=p.id where p.id=$1',[v.clock.policyId])).rows[0];
  if(!p)fail('APPROVAL_REMINDER_TEMPLATE_UNAVAILABLE','The retained reminder template is unavailable.');
  const rendered=renderApprovalReminder(p.definition,{workerCode:v.worker.code,sourceRef:`${v.origin.toLowerCase()}/${v.instanceId}`,stageNumber:String(v.stage+1),pendingAt:v.clock.pendingAt,reminderAt:v.clock.reminderAt,dueAt:v.clock.dueAt});
  await c.query("insert into approval_reminder_events(id,clock_id,run_id,policy_id,event_key,policy_class,template_id,operation_id,correlation_id,locale,title,body)values($1,$2,$3,$4,$5,'ACTION_REQUIRED',$6,$7,$8,$9,$10,$11)",[eventId,v.clock.id,id,v.clock.policyId,APPROVAL_REMINDER_KEY,p.id,req.operationId,req.correlationId,p.locale,rendered.title,rendered.body]);
  for(const recipient of v.recipientReasons){const rid=randomUUID();await c.query("insert into approval_reminder_recipients values($1,$2,$3,$4,true,'Required')",[rid,eventId,recipient.userId,recipient.reasons]);await c.query("insert into approval_reminder_deliveries(id,recipient_id,channel,status,operation_id,correlation_id,attempt)values($1,$2,'InApp','Delivered',$3,$4,1)",[randomUUID(),rid,req.operationId,req.correlationId]);}
 }
 await o.audit(c,req,{module:'Approvals',action:'Evaluate Retained Approval Reminder',entityType:'ApprovalReminderEvaluation',entityId:id,newValue:reminderRunView(saved),reason:input.reason,details:'Authenticated on-demand current-stage action-required reminder; one event per retained clock, complete atomic mandatory in-app set; no decision, clock reset, escalation target, scheduler or external delivery.'});
 return{receipt:reminderRunView(saved),replayed:false};
};

export const reminderInboxRows=async(c,req,o,{after=null,id=null}={})=>{
 if(!(await c.query("select to_regclass('public.approval_reminder_recipients')t")).rows[0]?.t)return[];
 const params=[req.user.sub,...scope(req),after,id],ew=o.buildEmployeeScopeWhere(req,params,'w'),pw=o.buildProjectScopeWhere(req,params,'p');
 return(await c.query(`select 'approval-reminder'kind,n.id,e.id "eventId",r.id "runId",r.origin,r.instance_id "instanceId",r.stage,e.clock_id "clockId",e.policy_id "policyId",cl.activated_at "pendingAt",cl.activated_at+(pol.definition->>'afterMinutes')::integer*interval '1 minute' "reminderAt",cl.due_at "dueAt",e.event_key "eventKey",e.policy_class "policyClass",e.template_id "templateId",e.operation_id "operationId",e.correlation_id "correlationId",e.locale,e.title,e.body,n.reasons,n.channel_decision "channelDecision",d.id "deliveryId",d.status "deliveryStatus",e.created_at "createdAt",rd.read_at "readAt" from approval_reminder_recipients n join approval_reminder_events e on e.id=n.event_id join approval_reminder_runs r on r.id=e.run_id join approval_due_clocks cl on cl.id=e.clock_id join approval_reminder_policies pol on pol.id=e.policy_id join approval_due_source_events se on se.origin=cl.origin and se.source_event_id=cl.source_event_id join employees w on w.id=se.employee_id and w.organization_id=r.organization_id and w.legal_entity_id=r.legal_entity_id left join projects p on p.id=se.project_id join approval_reminder_deliveries d on d.recipient_id=n.id left join approval_reminder_reads rd on rd.recipient_id=n.id and rd.user_id=n.user_id where n.user_id=$1 and r.organization_id=$2 and r.legal_entity_id=$3 and($4::uuid is null or n.id>$4)and($5::uuid is null or n.id=$5)and ${ew} and(r.origin='Work'and ${req.user.permissions.includes('timesheets.submit')?'true':'false'} or r.origin='Leave'and ${req.user.permissions.includes('leave.self_service')?'true':'false'} or r.origin not in('Work','Leave')and ${['allocations.view','projects.view'].every(k=>req.user.permissions.includes(k))?'true':'false'} and ${pw})order by n.id limit 21`,params)).rows;
};
