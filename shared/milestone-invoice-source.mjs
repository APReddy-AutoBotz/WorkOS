import {approvalKeys,approvalText,approvalUuid} from './work-approval.mjs';
import {validCapabilityDate} from './workforce-capabilities.mjs';
import {validInvoiceDraft,invoiceDraftTotal} from './invoice-batch-draft.mjs';
import {validMilestoneEvidence} from './milestone-billing-eligibility.mjs';

// This validates a retained projection; it does not establish database
// authority, create occupancy or authorize a batch decision.
export const milestoneInvoiceItemMatches=(draft,item)=>{
 if(!validInvoiceDraft(draft)||draft.periodBasis!=='ELIGIBLE_DATE'||
    !approvalKeys(item,['sourceType','itemId','itemVersion','eventId','clientId','contractId','engagementId','currency','eligibleOn','amount','current','evidence'])||
    item.sourceType!=='MILESTONE_ACCEPTANCE'||!approvalUuid(item.itemId)||item.itemVersion!==1||!approvalUuid(item.eventId)||
    item.current!==true||!validCapabilityDate(item.eligibleOn)||typeof item.amount!=='string')return false;
 try{invoiceDraftTotal([item.amount]);}catch{return false;}
 const e=item.evidence;
 if(!approvalKeys(e,['milestoneId','sourceVersion','engagementId','contractVersionId','engagementLifecycleId','contractLifecycleId','dueOn','evidence','ownerUserId','ownerRole','policyId','decisionId','currency','amount'])||
    !approvalText(e.milestoneId)||e.sourceVersion!==1||!approvalText(e.contractVersionId)||!approvalText(e.engagementLifecycleId)||!approvalText(e.contractLifecycleId)||
    !validCapabilityDate(e.dueOn)||!approvalUuid(e.ownerUserId)||!approvalText(e.ownerRole)||!approvalUuid(e.policyId)||!approvalUuid(e.decisionId)||
    !Array.isArray(e.evidence)||!validMilestoneEvidence(e.evidence,e.evidence.map(x=>x?.kind))||e.engagementId!==item.engagementId||e.currency!==item.currency||typeof e.amount!=='string')return false;
 try{if(invoiceDraftTotal([e.amount]).amount!==invoiceDraftTotal([item.amount]).amount)return false;}catch{return false;}
 return ['clientId','contractId','engagementId','currency'].every(k=>draft[k]===item[k])&&draft.periodStart<=item.eligibleOn&&item.eligibleOn<=draft.periodEnd;
};
