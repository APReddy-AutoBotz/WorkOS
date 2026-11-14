import {z} from 'zod';
import {normalizeWorkReference,workReferenceIsValid} from '../../../shared/work-reference.mjs';
export const workReferenceInput=z.union([z.string(),z.null()])
  .refine(workReferenceIsValid,'Use a single-line work reference of at most 200 characters without control characters.')
  .transform(normalizeWorkReference).optional();
