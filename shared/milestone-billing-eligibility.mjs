import {approvalKeys,approvalText,approvalUuid,approvalState,validWorkApprovalPolicy,renderApprovalTemplate} from './work-approval.mjs';

// These are explicit assertions by the submitting user. In particular, the
// client-evidence class does not claim that WorkOS contacted or verified a client.
export const milestoneEvidenceKinds = ['INTERNAL_ASSERTION','CLIENT_EVIDENCE_ASSERTION'];
export const validMilestoneEvidence = (e,required) => {
  if (!Array.isArray(required) || !required.length || !Array.isArray(e) || e.length!==required.length ||
      new Set(required).size!==required.length || required.some(k=>!milestoneEvidenceKinds.includes(k))) return false;
  return e.every(x=>{
    if (!approvalKeys(x,['kind','reference','url']) || !required.includes(x.kind) || !approvalText(x.reference) ||
        x.reference.length>200 || /[\u0000-\u001f\u007f]/u.test(x.reference) || typeof x.url!=='string' || x.url.length>2048 ||
        x.url!==x.url.trim() || !x.url.startsWith('https://') || /[\s\u0000-\u001f\u007f]/u.test(x.url)) return false;
    try {const url=new URL(x.url);return url.protocol==='https:'&&!url.username&&!url.password;} catch{return false;}
  }) && new Set(e.map(x=>x.kind)).size===required.length;
};

export const validMilestoneBillingPolicy = d => {
  if (!approvalKeys(d,['entityType','engagementId','evidenceKinds','stages','locale','templates','completionInApp']) ||
      d.entityType!=='MilestoneBillingEligibility' || !approvalText(d.engagementId) ||
      !Array.isArray(d.evidenceKinds) || !d.evidenceKinds.length || d.evidenceKinds.length>2 ||
      new Set(d.evidenceKinds).size!==d.evidenceKinds.length || d.evidenceKinds.some(k=>!milestoneEvidenceKinds.includes(k))) return false;
  const {entityType:_entity,engagementId:_engagement,evidenceKinds:_kinds,...shared}=d;
  return validWorkApprovalPolicy({...shared,entityType:'Timesheet',workerIds:[]}) &&
    d.templates.every(t=>[t.subject,t.body].every(s=>!s.includes('{{workerCode}}')&&!s.includes('{{decisionReason}}')));
};

export const milestoneBillingState = (policy,transitions) => {
  if(!validMilestoneBillingPolicy(policy))throw new TypeError('Invalid milestone billing policy.');
  return approvalState(policy.stages,transitions);
};

export const milestoneBillingActorAllowed = (policy,transitions,sourceCurrent,actor,requesterId) => {
  if(!validMilestoneBillingPolicy(policy)||sourceCurrent!==true||!approvalUuid(requesterId)||
     !approvalKeys(actor,['userId','role','active','heldRole','scopedSourceAccess','decisionPermission','inboxPermission'])||
     !approvalUuid(actor.userId)||actor.userId===requesterId||typeof actor.role!=='string'||
     !['active','heldRole','scopedSourceAccess','decisionPermission','inboxPermission'].every(k=>actor[k]===true))return false;
  try{const state=milestoneBillingState(policy,transitions),stage=state.status==='Pending'&&policy.stages[state.currentStage];return Boolean(stage&&stage.userId===actor.userId&&stage.role===actor.role);}catch{return false;}
};

export const renderMilestoneBillingNotice = (template,milestoneId,stage) => {
  if(!approvalText(milestoneId)||!Number.isInteger(stage)||stage<1||stage>10||
     [template?.subject,template?.body].some(s=>typeof s!=='string'||s.includes('{{workerCode}}')||s.includes('{{decisionReason}}')))throw new TypeError('Invalid milestone notice.');
  return renderApprovalTemplate(template,{workerCode:'',sourceRef:`milestone/${milestoneId}`,stageNumber:String(stage),decisionReason:''});
};
