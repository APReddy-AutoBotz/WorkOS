import {approvalKeys,approvalUuid,validWorkApprovalPolicy,approvalState,renderApprovalTemplate} from './work-approval.mjs';
import {compareCapabilityIds} from './workforce-capabilities.mjs';

// This explicit exact-candidate policy does not adopt a rate or select recipients.
export const validCommercialCandidatePolicy=d=>{
 if(!approvalKeys(d,['entityType','kind','candidateId','stages','locale','templates','completionInApp'])||d.entityType!=='CommercialCandidate'||!['billing','cost'].includes(d.kind)||!approvalUuid(d.candidateId))return false;
 const {entityType:_entity,kind:_kind,candidateId:_candidate,...shared}=d;
 if(!validWorkApprovalPolicy({...shared,entityType:'Timesheet',workerIds:[]}))return false;
 // Sensitive reason and worker fields are never substituted into this inbox.
 return d.templates.every(t=>[t.subject,t.body].every(s=>!s.includes('{{decisionReason}}')&&!s.includes('{{workerCode}}')));
};
export const commercialApprovalState=(policy,transitions)=>{if(!validCommercialCandidatePolicy(policy))throw TypeError('Invalid commercial approval policy.');return approvalState(policy.stages,transitions);};
export const commercialApprovalRecipients=rows=>{
 const allowed=['current_stage_approver','requester','commercial_change_owner','affected_worker'],map=new Map();
 for(const r of rows){if(!approvalKeys(r,['userId','reason'])||!approvalUuid(r.userId)||!allowed.includes(r.reason))throw TypeError('Invalid commercial recipient relationship.');const reasons=map.get(r.userId)??[];if(!reasons.includes(r.reason))reasons.push(r.reason);map.set(r.userId,reasons);}
 return [...map].sort(([a],[b])=>compareCapabilityIds(a,b)).map(([userId,reasons])=>({userId,reasons:reasons.sort()}));
};
export const renderCommercialApproval=(template,candidateId,stage)=>{
 if(!approvalUuid(candidateId)||!Number.isInteger(stage)||stage<1||stage>10||[template?.subject,template?.body].some(x=>typeof x!=='string'||x.includes('{{decisionReason}}')||x.includes('{{workerCode}}')))throw TypeError('Invalid commercial template or source.');
 return renderApprovalTemplate(template,{workerCode:'',sourceRef:'commercial-candidate/'+candidateId,stageNumber:String(stage),decisionReason:''});
};
