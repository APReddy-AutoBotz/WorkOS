import {approvalKeys,approvalUuid,approvalText,approvalRecipients} from './work-approval.mjs';

export const APPROVAL_REMINDER_KEY='approval.action_required';
export const APPROVAL_REMINDER_STATES=Object.freeze(['Unconfigured','Waiting','Ready','Notified','Overdue','Terminal','Stale']);
const variables=Object.freeze({workerCode:200,sourceRef:239,stageNumber:2,pendingAt:24,reminderAt:24,dueAt:24});
const expand=(s,v)=>s.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g,(_m,k)=>{if(!(k in variables))throw TypeError('Unsupported reminder variable');return v[k];});
export const validApprovalReminderDefinition=d=>{
 try{
  if(!approvalKeys(d,['afterMinutes','locale','template'])||!Number.isInteger(d.afterMinutes)||d.afterMinutes<1||d.afterMinutes>527039||!approvalText(d.locale,100)||Intl.getCanonicalLocales(d.locale)[0]!==d.locale)return false;
  const t=d.template;
  if(!approvalKeys(t,['key','subject','body'])||t.key!==APPROVAL_REMINDER_KEY||!approvalText(t.subject,200)||!approvalText(t.body,8000))return false;
  for(const[k,max]of[['subject',1200],['body',12000]]){
   const rendered=expand(t[k],Object.fromEntries(Object.entries(variables).map(([n,size])=>[n,'x'.repeat(size)])));
   if(/[{}]/.test(rendered)||rendered.length>max)return false;
  }
  return true;
 }catch{return false;}
};
export const approvalReminderRecipients=actors=>{
 if(!Array.isArray(actors)||actors.length<1||actors.length>2||actors.some(a=>!approvalKeys(a,['userId','reason'])||!approvalUuid(a.userId)||a.reason!=='current_stage_approver'))throw TypeError('Existing current-stage identities required');
 return approvalRecipients(actors);
};
export const approvalReminderIdentity=(clockId,operationId)=>{
 if(!approvalUuid(clockId)||!approvalText(operationId))throw TypeError('Retained clock and triggering operation required');
 return `approval-reminder/${clockId}/${APPROVAL_REMINDER_KEY}/${encodeURIComponent(operationId)}`;
};
export const renderApprovalReminder=(definition,values)=>{
 if(!validApprovalReminderDefinition(definition))throw TypeError('Retained reminder definition required');
 for(const[k,max]of Object.entries(variables))if(!approvalText(values[k],max))throw TypeError('Exact retained operating value required');
 const result={title:expand(definition.template.subject,values),body:expand(definition.template.body,values)};
 if(!approvalText(result.title,1200)||!approvalText(result.body,12000))throw RangeError('Reminder exceeds inbox contract');
 return result;
};
