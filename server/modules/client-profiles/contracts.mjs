import {z} from 'zod';
const identifier=z.string().trim().min(1).max(200);
const name=z.string().trim().min(1).max(200).nullable();
const code=z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,79}$/);
const contacts=z.array(z.object({name:z.string().trim().min(1).max(200),email:z.string().trim().max(254).email()}).strict()).max(10);
const fields={effectiveFrom:z.string().date(),legalName:name,displayName:name,defaultCurrency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 billingContacts:contacts,reason:z.string().trim().min(3).max(1000)};
export const profileQuerySchema=z.object({asOf:z.string().date().optional()}).strict();
export const clientProfileSchema=z.object({...fields,code,expectedVersion:z.number().int().min(0).max(199),parentClientId:identifier.nullable()}).strict();
export const billingUnitSchema=z.object({...fields,code,kind:z.enum(['billing_entity','business_unit'])}).strict();
export const billingUnitVersionSchema=z.object({...fields,expectedVersion:z.number().int().min(1).max(199)}).strict();
