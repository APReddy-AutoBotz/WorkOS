import {z} from 'zod';
import {decimalAmount} from './contracts.mjs';
const id=z.string().trim().min(1).max(200);
const reason=z.string().trim().min(3).max(1000);
export const lifecycleTransitionSchema=z.object({expectedSequence:z.number().int().min(0).max(199),state:z.enum(['Active','On Hold']),
  contractVersionId:id.nullable(),reason,approvalReference:z.string().trim().min(1).max(200).nullable()}).strict();
export const projectBindingSchema=z.object({engagementId:id,projectId:id.nullable(),code:z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,79}$/),
  name:z.string().trim().min(1).max(200),managerId:id,startsOn:z.string().date(),endsOn:z.string().date(),
  billable:z.boolean(),budgetAllocation:decimalAmount,reason}).strict().refine(x=>x.startsOn<=x.endsOn);
export const lifecycleQuerySchema=z.object({}).strict();
export const lifecycleTypes=new Set(['Contract','Engagement','Project']);
