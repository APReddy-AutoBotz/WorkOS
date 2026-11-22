import {z} from 'zod';
import {decimalAmount} from './contracts.mjs';
const fields={expectedSequence:z.number().int().min(0).max(199),expectedLifecycleSequence:z.number().int().min(1).max(200),
  expectedContractVersion:z.number().int().min(1).max(200),contractVersionId:z.string().trim().min(1).max(200),
  effectiveOn:z.string().date(),startsOn:z.string().date(),endsOn:z.string().date(),budget:decimalAmount,laborCostBudget:decimalAmount.optional(),
  reason:z.string().trim().min(3).max(1000),approvalReference:z.string().trim().min(1).max(200)};
const dates=x=>x.startsOn<=x.effectiveOn && x.effectiveOn<=x.endsOn;
export const amendmentPreviewSchema=z.object(fields).strict().refine(dates);
export const amendmentCommandSchema=z.object({...fields,previewToken:z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(dates);
