import {validWorkApprovalPolicy,approvalKeys,approvalText,renderApprovalTemplate,approvalEventIdentity} from './work-approval.mjs';
export const LEAVE_APPROVAL_VERSION='leave-approval/1';
export const validLeaveApprovalPolicy=d=>{
 if(!approvalKeys(d,['entityType','workerIds','stages','locale','templates','completionInApp', ...(d && Object.hasOwn(d,'stageDueMinutes') ? ['stageDueMinutes'] : [])])||d.entityType!=='LeaveRequest'||!validWorkApprovalPolicy({...d,entityType:'Timesheet'}))return false;
 return d.templates.every(t=>{const r=renderApprovalTemplate(t,{workerCode:'w'.repeat(200),sourceRef:'s'.repeat(239),stageNumber:'10',decisionReason:'r'.repeat(1000)});return approvalText(r.title,1200)&&approvalText(r.body,12000);});
};
export const leaveApprovalIdentity=(...args)=>approvalEventIdentity(...args).replace(/^work-approval\//,'leave-approval/');
