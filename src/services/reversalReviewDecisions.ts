import { z } from 'zod';
import type { WorkApprovalContext } from './workApprovals';

const uuid = z.string().uuid(), decision = z.enum(['Approved','Rejected']);
const record = z.object({
  id:uuid,sequence:z.number().int().min(1).max(10),decision,actorId:uuid,activeRole:z.string().min(1),
  reason:z.string().min(3).max(1000),confirmationId:uuid.nullable(),createdAt:z.string().datetime(),
}).strict();
const schema = z.object({
  id:uuid,policyId:uuid,requestId:uuid,batchId:uuid,lineId:uuid,itemId:uuid,sourceType:z.enum(['TM_SNAPSHOT','MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD']),
  currency:z.string().regex(/^[A-Z]{3}$/),amount:z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/),requestReason:z.string().min(3).max(1000),
  artifactId:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/),confirmationId:uuid.nullable(),externalReference:z.string().nullable(),
  decisions:z.array(record).max(10),status:z.enum(['Pending','Approved','Rejected']),canDecide:z.boolean(),stageCount:z.number().int().min(1).max(10),
}).strict();
export type ReversalInspection = z.infer<typeof schema>;
type Call = (method:'GET'|'POST',path:string,c:WorkApprovalContext|null,body?:Record<string,unknown>) => Promise<Record<string,unknown>>;

export function reversalDecisionClient(call:Call) {
  return async (id:string,batchId:string,c:WorkApprovalContext|null,write?:{source:ReversalInspection;decision:'Approved'|'Rejected';reason:string}) => {
    uuid.parse(id);
    const path='/reversal-reviews/'+id;
    const raw=write ? await call('POST',path+'/decisions',c,{
      expectedSequence:write.source.decisions.length,confirmationId:write.source.confirmationId,policyId:write.source.policyId,
      decision:write.decision,reason:write.reason,
    }) : await call('GET',path,c);
    const review=schema.parse(raw.review);
    const rejected=review.decisions.find(d=>d.decision==='Rejected');
    const expectedStatus=rejected?'Rejected':review.decisions.length===review.stageCount?'Approved':'Pending';
    if(review.id!==id || review.batchId!==batchId || (review.confirmationId===null)!==(review.externalReference===null) ||
      review.decisions.length>review.stageCount || review.decisions.some((d,i)=>d.sequence!==i+1) ||
      (rejected && rejected.sequence!==review.decisions.length) || review.status!==expectedStatus || (review.canDecide && review.status!=='Pending'))
      throw Error('Review evidence changed.');
    if(write){
      const saved=review.decisions[write.source.decisions.length];
      if(typeof raw.replayed!=='boolean'||!saved || saved.reason!==write.reason || saved.decision!==write.decision ||
        saved.actorId!==raw.actorUserId || saved.activeRole!==c?.activeRole || saved.confirmationId!==write.source.confirmationId ||
        review.policyId!==write.source.policyId || review.artifactId!==write.source.artifactId || review.sha256!==write.source.sha256)
        throw Error('Decision receipt unavailable.');
    }
    return review;
  };
}
