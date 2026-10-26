import {z} from 'zod';
import {APPROVAL_REMINDER_KEY,validApprovalReminderDefinition} from '../../../shared/approval-reminder.mjs';
import {APPROVAL_DUE_KINDS} from '../../../shared/approval-due.mjs';
import {workApprovalScope as scope} from '../approvals/work-approval-service.mjs';
import {approvalDueSource} from './approval-due-service.mjs';
import {assertReminderSourcePermission,adoptReminderPolicy,reminderPolicyView,reminderPreview,reminderPreviewView,evaluateReminder,reminderRunView} from './approval-reminder-service.mjs';

export const registerApprovalReminderRoutes=(router,o,{config,handle,parse,uuid,hash,date,reason})=>{
 const origin=z.enum(APPROVAL_DUE_KINDS),selection=z.object({origin,instanceId:uuid,stage:z.coerce.number().int().min(0).max(9)}).strict();
 router.get('/reminders/policies',...config,handle(false,async(c,req)=>{
  const q=parse(z.object({before:z.coerce.number().int().min(1).max(2147483647).optional()}).strict(),req.query),rows=(await c.query('select *,effective_from::text from approval_reminder_policies where organization_id=$1 and legal_entity_id=$2 and($3::integer is null or sequence<$3)order by sequence desc limit 11',[...scope(req),q.before??null])).rows;
  return{policies:rows.slice(0,10).map(reminderPolicyView),nextBefore:rows.length>10?rows[9].sequence:null,today:(await c.query("select to_char((clock_timestamp()at time zone'UTC')::date,'YYYY-MM-DD')d")).rows[0].d};
 }));
 router.post('/reminders/policies',...config,handle(true,async(c,req)=>{
  const d=parse(z.object({expectedOwnerKey:hash,expectedLatestId:uuid.nullable(),duePolicyId:uuid,effectiveFrom:date,definition:z.unknown().refine(v=>v===null||validApprovalReminderDefinition(v)),requestId:uuid,reason}).strict(),req.body),{expectedOwnerKey:_owner,...input}=d;
  const result=await adoptReminderPolicy(c,req,input,o);return{status:result.replayed?200:201,body:result};
 },{sourceLock:true}));
 router.get('/reminders/policy-requests/:requestId',...config,handle(false,async(c,req)=>{
  parse(z.object({}).strict(),req.query);const id=parse(uuid,req.params.requestId),row=(await c.query('select *,effective_from::text from approval_reminder_policies where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',[...scope(req),req.user.sub,id])).rows[0];return{policy:row?reminderPolicyView(row):null};
 }));
 router.get('/reminders/preview',...config,handle(false,async(c,req)=>{const q=parse(selection,req.query);return{preview:reminderPreviewView(await reminderPreview(c,req,q.origin,q.instanceId,q.stage,o))};}));
 router.post('/reminders/evaluate',...config,handle(true,async(c,req)=>{
  const d=parse(selection.extend({expectedOwnerKey:hash,expectedSourceToken:hash,expectedEventKey:z.literal(APPROVAL_REMINDER_KEY).nullable(),requestId:uuid,reason}).strict(),req.body),{expectedOwnerKey:_owner,...input}=d,result=await evaluateReminder(c,req,input,o);return{status:result.replayed?200:201,body:result};
 },{sourceLock:true}));
 router.get('/reminders/history',...config,handle(false,async(c,req)=>{
  const q=parse(z.object({origin,instanceId:uuid,before:z.coerce.number().int().min(1).max(2147483647).optional()}).strict(),req.query);assertReminderSourcePermission(req,q.origin);await approvalDueSource(c,req,q.origin,q.instanceId,o);
  const rows=(await c.query('select * from approval_reminder_runs where origin=$1 and instance_id=$2 and($3::integer is null or sequence<$3)order by sequence desc limit 11',[q.origin,q.instanceId,q.before??null])).rows;
  return{origin:q.origin,instanceId:q.instanceId,receipts:rows.slice(0,10).map(reminderRunView),nextBefore:rows.length>10?rows[9].sequence:null};
 }));
 router.get('/reminders/requests/:requestId',...config,handle(false,async(c,req)=>{
  parse(z.object({}).strict(),req.query);const id=parse(uuid,req.params.requestId),row=(await c.query('select * from approval_reminder_runs where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',[...scope(req),req.user.sub,id])).rows[0];
  if(row){assertReminderSourcePermission(req,row.origin);await approvalDueSource(c,req,row.origin,row.instance_id,o);}return{receipt:row?reminderRunView(row):null};
 }));
};
