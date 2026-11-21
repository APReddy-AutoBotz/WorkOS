import {z} from 'zod';

const id=z.string().trim().min(1).max(200), date=z.string().date(), reason=z.string().trim().min(3).max(1000);
const amount=z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
export const fixedFeeInvoiceEvidence=z.object({sourceVersion:z.literal(1),contractVersionId:id,installment:z.number().int().min(1).max(120),
    dueOn:date,currency:z.string().regex(/^[A-Z]{3}$/),amount,engagementId:id,contractLifecycleId:id,
    engagementLifecycleId:id,contractAmendmentId:id.nullable(),engagementAmendmentId:id.nullable(),approvalReason:reason}).strict();
