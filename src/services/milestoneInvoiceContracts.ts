import {z} from 'zod';
import {validMilestoneEvidence} from '../../shared/milestone-billing-eligibility.mjs';
import {canonicalHours} from '../../shared/work-hours.mjs';

const uuid=z.string().uuid(),id=z.string().trim().min(1).max(200),date=z.string().date(),amount=z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
const assertion=z.object({kind:z.enum(['INTERNAL_ASSERTION','CLIENT_EVIDENCE_ASSERTION']),reference:id,url:z.string()}).strict();
export const milestoneInvoiceEvidence=z.object({milestoneId:id,sourceVersion:z.literal(1),engagementId:id,contractVersionId:id,engagementLifecycleId:id,contractLifecycleId:id,dueOn:date,evidence:z.array(assertion).min(1).max(2),ownerUserId:uuid,ownerRole:id,policyId:uuid,decisionId:uuid,currency:z.string().regex(/^[A-Z]{3}$/),amount}).strict().refine(v=>/[1-9]/.test(v.amount)&&validMilestoneEvidence(v.evidence,v.evidence.map(x=>x.kind)));
export const milestoneEvidenceMatches=(e:z.infer<typeof milestoneInvoiceEvidence>,engagementId:string,currency:string,value:string)=>{
 try{return e.engagementId===engagementId&&e.currency===currency&&canonicalHours(e.amount)===canonicalHours(value);}catch{return false;}
};
