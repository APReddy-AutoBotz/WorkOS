import {z} from 'zod';

export const COMMERCIAL_MODELS = ['time_and_materials','fixed_fee','milestone','retainer','managed_service'];
export const ENGAGEMENT_MODELS = [...COMMERCIAL_MODELS,'internal','pre_sales'];
export const COMMERCIAL_PAGE_SIZE = 200;
const identifier = z.string().trim().min(1).max(200);
const code = z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,79}$/);
const date = z.string().date();
export const decimalAmount = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const reason = z.string().trim().min(3).max(1000);
const document = z.object({name:z.string().trim().min(1).max(200),url:z.string().max(2048).refine(value => {
  try {const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password;} catch {return false;}
})}).strict();
const terms = {
  name:z.string().trim().min(1).max(200),model:z.enum(COMMERCIAL_MODELS),
  startsOn:date,endsOn:date,effectiveFrom:date,currency,value:decimalAmount,
  retainerRounding:z.object({precision:z.number().int().min(0).max(4),mode:z.enum(['HALF_UP','HALF_EVEN','DOWN'])}).strict().nullable().optional(),
  retainerOveragePolicy:z.enum(['no_charge','contract_hourly_at_period_end']).nullable().optional(),
  retainerCapacityPolicy:z.enum(['billable_expire','all_expire','billable_rollover','all_rollover']).nullable().optional(),
  serviceDimensions:z.array(z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),label:z.string().trim().min(1).max(80),precision:z.number().int().min(0).max(4)}).strict()).max(50).optional(),
  retainerPeriods:z.array(z.object({startsOn:date,endsOn:date,includedHours:decimalAmount,baseFee:decimalAmount}).strict()).max(120).optional(),
  installments:z.array(z.object({dueOn:date,amount:decimalAmount}).strict()).max(120).optional(),
  billingTerms:z.string().trim().min(1).max(4000),documents:z.array(document).max(10),reason,
};
const validTerms = data => data.startsOn<=data.endsOn && data.effectiveFrom>=data.startsOn && data.effectiveFrom<=data.endsOn;
export const createContractSchema = z.object({number:code,clientId:identifier,...terms}).strict().refine(validTerms,{message:'Contract dates must contain the effective date.'});
export const appendContractSchema = z.object({expectedVersion:z.number().int().min(1).max(199),...terms}).strict().refine(validTerms,{message:'Contract dates must contain the effective date.'});
export const createEngagementSchema = z.object({
  code,name:z.string().trim().min(1).max(200),model:z.enum(ENGAGEMENT_MODELS),ownerId:identifier,
  startsOn:date,endsOn:date,currency,budget:decimalAmount,
  clientId:identifier.nullable(),contractId:identifier.nullable(),contractVersionId:identifier.nullable(),attributionId:identifier.nullable(),reason,
}).strict().refine(data=>data.startsOn<=data.endsOn,{message:'Engagement dates are reversed.'});
export const createPurchaseOrderSchema = z.object({
  contractId:identifier,contractVersionId:identifier,number:code,value:decimalAmount,currency,startsOn:date,endsOn:date,
  warningThresholdPercent:z.string().regex(/^(?:0|[1-9]\d?|100)(?:\.\d{1,2})?$/).refine(value=>Number(value)<=100),reason,
}).strict().refine(data=>data.startsOn<=data.endsOn,{message:'Purchase-order dates are reversed.'});
export const createMilestoneSchema = z.object({
  engagementId:identifier,code,name:z.string().trim().min(1).max(200),dueOn:date,amount:decimalAmount,currency,reason,
}).strict();
export const workspaceQuerySchema = z.object({asOf:date.optional()}).strict();
export class CommercialDraftError extends Error {
  constructor(statusCode,code,message) {super(message);this.statusCode=statusCode;this.code=code;}
}
export const fail = (status,code,message) => {throw new CommercialDraftError(status,code,message);};
