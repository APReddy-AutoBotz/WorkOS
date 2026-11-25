import {registerModuleReleaseRoutes} from './modules/module-releases.mjs';
import { registerFinancialPeriodRoutes } from './modules/financial-periods.mjs';
import {asyncHandler} from './api/async-handler.mjs';
import {lockCommercialLifecycle} from './modules/commercial-drafting/project-mutation.mjs';
import { Router } from 'express';
import { z } from 'zod';
import { disableLinkedWorkerIdentity, restoreLinkedWorkerIdentity } from './worker-lifecycle.mjs';
import { canTransitionReportingPeriod, REPORTING_PERIOD_FREQUENCIES, REPORTING_PERIOD_STATES } from './reporting-periods.mjs';
import { buildSetupReadiness } from './setup-readiness.mjs';
import { calendarScopeValues, validateWorkingCalendar, validateWorkingCalendarHoliday } from './working-calendars.mjs';

export const MAX_SETUP_ROWS = 200;
export const MAX_DEPENDENCIES = 100;
export const MAX_HISTORY_ROWS = 100;

const terminologyKeys = ['employee','manager','teamLead','businessUnit','region','regionalOwner','engagement','project','worklog'];
const terminologyValueSchema = z.object({
  singular:z.string().trim().min(1).max(100), plural:z.string().trim().min(1).max(100), helpText:z.string().trim().max(500),
}).strict();
const terminologyTermsSchema = z.object(Object.fromEntries(terminologyKeys.map(key => [key, terminologyValueSchema]))).strict();
const legacyPluralize = value => /[^aeiou]y$/i.test(value) ? `${value.slice(0,-1)}ies` : /(s|x|z|ch|sh)$/i.test(value) ? `${value}es` : `${value}s`;
const normalizeTerminologyTerms = terms => Object.fromEntries(Object.entries(terms || {}).map(([key,value]) => {
  if (typeof value !== 'string') return [key,value];
  const singular=value.trim(); return [key,{singular,plural:legacyPluralize(singular),helpText:''}];
}));
export const validateTerminology = input => z.object({terms:terminologyTermsSchema,effectiveFrom:z.string().date()}).strict().safeParse(input);
export const normalizePersistedTerminology = normalizeTerminologyTerms;

const catalogTypes = ['business_unit', 'department', 'cost_centre', 'practice', 'location', 'region', 'worker_type'];
const scopeHeaders = request => ({
  organizationId: String(request.headers['x-organization-id'] || '').trim(),
  legalEntityId: String(request.headers['x-legal-entity-id'] || '').trim(),
});

const currentOrganizationScopeSource = `
  from user_organization_scopes s
  join users u on u.id=s.user_id and u.status='Active'
  join organizations o on o.id=s.organization_id
  left join organization_profile_versions op on op.organization_id=o.id
    and current_date between op.effective_from and coalesce(op.effective_to,'infinity'::date)
  join legal_entities le on le.id=s.legal_entity_id and le.organization_id=s.organization_id
  join legal_entity_profile_versions lp on lp.legal_entity_id=le.id and lp.organization_id=le.organization_id
    and current_date between lp.effective_from and coalesce(lp.effective_to,'infinity'::date)
`;
const currentOrganizationScopePredicate = `
  s.user_id=$1 and s.active=true and o.status='Active' and lp.status='Active'
  and current_date between o.effective_from and coalesce(o.effective_to,'infinity'::date)
  and current_date between le.effective_from and coalesce(lp.authority_effective_to,'infinity'::date)
`;

export const listAuthorizedOrganizationScopes = async (database, userId) => {
  const result = await database.query(`
    select s.organization_id "organizationId",s.legal_entity_id "legalEntityId",
      coalesce(op.name,o.name) "organizationName",coalesce(lp.legal_name,le.name) "legalEntityName"
    ${currentOrganizationScopeSource}
    where ${currentOrganizationScopePredicate}
    order by coalesce(op.name,o.name),coalesce(lp.legal_name,le.name) limit 100
  `, [userId]);
  return result.rows;
};

export const resolveOrganizationScope = async (database, request) => {
  const requested = scopeHeaders(request);
  const result = await database.query(`
    select s.organization_id, s.legal_entity_id
    ${currentOrganizationScopeSource}
    where ${currentOrganizationScopePredicate}
      and ($2::text='' or s.organization_id=$2)
      and ($3::text='' or s.legal_entity_id=$3)
    order by s.organization_id, s.legal_entity_id limit 2`,
  [request.user.sub, requested.organizationId, requested.legalEntityId]);
  if (result.rows.length !== 1) {
    const error = new Error(result.rows.length ? 'Organization scope is ambiguous' : 'Organization scope is not authorized');
    error.statusCode = 403;
    error.code = 'ORG_SCOPE_DENIED';
    throw error;
  }
  return { organizationId: result.rows[0].organization_id, legalEntityId: result.rows[0].legal_entity_id };
};

const asOfPredicate = (alias, parameter) =>
  `${alias}.effective_from <= ${parameter} and (${alias}.effective_to is null or ${alias}.effective_to >= ${parameter})`;
const dateOnly = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

const isLocale = value => { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } };
const isTimeZone = value => { try { new Intl.DateTimeFormat('en', { timeZone:value }).format(); return true; } catch { return false; } };
const isFiscalStart = value => {
  if (!/^\d{2}-\d{2}$/.test(value)) return false;
  const [month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(2000, month - 1, day));
  return candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
};
const isSupportContact = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || (() => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
})();
const currency = z.string().trim().regex(/^[A-Z]{3}$/);
const assetPath = z.string().trim().max(512).regex(/^\/(?!\/)[a-zA-Z0-9_./-]+\.(?:svg|png|jpe?g|webp|gif|ico)$/i)
  .refine(value => !value.split('/').some(part => part === '.' || part === '..'));
// Both accent roles appear beside white text or backgrounds in the workspace.
const brandColor = z.string().regex(/^#[\da-fA-F]{6}$/).refine(hex => {
  const channels = [1,3,5].map(start => {
    const value = parseInt(hex.slice(start,start+2),16)/255;
    return value <= 0.04045 ? value/12.92 : ((value+0.055)/1.055)**2.4;
  });
  const luminance = 0.2126*channels[0]+0.7152*channels[1]+0.0722*channels[2];
  return 1.05/(luminance+0.05) >= 4.5;
},'Use an accent with at least 4.5:1 contrast against white.');
const brandingSchema = z.object({
  logoUrl:assetPath.optional(), compactMarkUrl:assetPath.optional(), faviconUrl:assetPath.optional(),
  primaryAccent:brandColor.optional(), secondaryAccent:brandColor.optional(),
  emailBrand:z.string().trim().min(1).max(150).optional(),
  reportBrand:z.string().trim().min(1).max(150).optional(),
}).strict();
const organizationProfileSchema = z.object({
  branding:brandingSchema.optional(),
  name:z.string().trim().min(1).max(150), legalName:z.string().trim().min(1).max(200),
  productDisplayName:z.string().trim().min(1).max(150), supportContact:z.string().trim().min(3).max(254).refine(isSupportContact),
  defaultLocale:z.string().trim().min(2).max(35).refine(isLocale), defaultTimeZone:z.string().trim().min(1).max(80).refine(isTimeZone),
  baseCurrency:currency, fiscalYearStart:z.string().refine(isFiscalStart), defaultWeekStart:z.number().int().min(0).max(6),
  effectiveFrom:z.string().date(), organizationId:z.string().optional(),
});
const addressSchema = z.object({ line1:z.string().trim().min(1).max(200), line2:z.string().trim().max(200).optional(),
  city:z.string().trim().min(1).max(100), region:z.string().trim().max(100).optional(), postalCode:z.string().trim().max(30).optional(),
  countryCode:z.string().trim().regex(/^[A-Z]{2}$/) }).strict();
const legalEntitySchema = z.object({
  code:z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,49}$/), legalName:z.string().trim().min(1).max(200),
  registrationIdentifier:z.string().trim().min(1).max(100).nullable().optional(), taxIdentifier:z.string().trim().min(1).max(100).nullable().optional(),
  reportingCurrency:currency, address:addressSchema, status:z.enum(['Active','Inactive']),
  effectiveFrom:z.string().date(), effectiveTo:z.string().date().nullable().optional(), organizationId:z.string().optional(),
});
export const validateOrganizationProfile = input => organizationProfileSchema.safeParse(input);
export const validateLegalEntity = input => legalEntitySchema.safeParse(input);
const profileSelect = `select o.id organization_id,o.code organization_code,p.name organization_name,
  p.legal_name,p.product_display_name,p.branding,p.support_contact,p.default_locale,p.default_time_zone,p.base_currency,
  p.fiscal_year_start,p.default_week_start,p.effective_from::text profile_effective_from,p.effective_to::text profile_effective_to
  from organizations o join organization_profile_versions p on p.organization_id=o.id`;
const legalSelect = `select le.id,le.organization_id,le.code,p.legal_name name,p.country_code,p.status,le.effective_from,p.authority_effective_to effective_to,
  p.legal_name,p.registration_identifier,p.tax_identifier,p.reporting_currency,p.address,
  p.effective_from profile_effective_from,p.effective_to profile_effective_to
  from legal_entities le join legal_entity_profile_versions p on p.legal_entity_id=le.id and p.organization_id=le.organization_id`;

export const registerOrganizationSetupRoutes = ({
  app,
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  buildEmployeeScopeWhere,
  audit,
  mountPaths = ['/api/organization-setup'],
}) => {
  const router = Router();
  router.get('/login-brand', asyncHandler(async (_req,res) => {
    res.set('Cache-Control','no-store');
    const organizationId=process.env.PUBLIC_BRANDING_ORGANIZATION_ID;
    if (!organizationId) return res.json({});
    const {rows}=await pool.query(`select product_display_name as "productName",
      branding->>'logoUrl' as "logoUrl",branding->>'faviconUrl' as "faviconUrl",
      branding->>'primaryAccent' as "primaryAccent",branding->>'secondaryAccent' as "secondaryAccent"
      from organization_profile_versions where organization_id=$1 and (created_by is not null or branding is not null) and (now() at time zone 'UTC')::date
      between effective_from and coalesce(effective_to,'infinity'::date) order by effective_from desc limit 1`,
      [organizationId]);
    return res.json(rows[0] ?? {});
  }));
  router.use(requireDatabase, requireAuth, asyncHandler(async (req, res, next) => {
    try {
      const asOf=z.string().date().safeParse(req.query.asOf === undefined ? new Date().toISOString().slice(0,10) : req.query.asOf);
      if(!asOf.success)return res.status(400).json({error:'asOf must be one valid ISO date (YYYY-MM-DD).',code:'INVALID_AS_OF_DATE'});
      req.setupAsOf=asOf.data;
      req.organizationScope = await resolveOrganizationScope(pool, req);
      next();
    } catch (error) {
      if(error.code==='ORG_SCOPE_DENIED')return res.status(403).json({error:'Organization scope is not authorized',code:'ORG_SCOPE_DENIED'});
      next(error);
    }
  }));

  registerModuleReleaseRoutes(router, {pool, requirePermission, audit});

  router.get('/context', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
    const { organizationId, legalEntityId } = req.organizationScope;
    const result = await pool.query(`select o.id organization_id,o.code organization_code,op.name organization_name,
      op.legal_name organization_legal_name,op.product_display_name,op.support_contact,op.default_locale,
      op.default_time_zone,op.base_currency,op.fiscal_year_start,op.default_week_start,
      le.id legal_entity_id,le.code legal_entity_code,lp.legal_name legal_entity_name,lp.status legal_entity_status,
      le.effective_from legal_entity_effective_from,lp.authority_effective_to legal_entity_effective_to,
      lp.legal_name legal_entity_legal_name,lp.country_code legal_entity_country_code,
      lp.registration_identifier,lp.tax_identifier,lp.reporting_currency,lp.address
      from organizations o join legal_entities le on le.organization_id=o.id
      join lateral (select * from organization_profile_versions where organization_id=o.id and $3::date between effective_from and coalesce(effective_to,'infinity'::date) order by effective_from desc limit 1) op on true
      join lateral (select * from legal_entity_profile_versions where organization_id=o.id and legal_entity_id=le.id and $3::date between effective_from and coalesce(effective_to,'infinity'::date) order by effective_from desc limit 1) lp on true
      where o.id=$1 and le.id=$2`, [organizationId, legalEntityId, req.setupAsOf]);
    res.json(result.rows[0]);
  }));

  router.get('/profile', requirePermission('settings.manage'), asyncHandler(async(req,res)=>{
    const asOf=req.setupAsOf;
    const result=await pool.query(`${profileSelect} where o.id=$1 and ${asOfPredicate('p','$2')}
      order by p.effective_from desc limit 1`,[req.organizationScope.organizationId,asOf]);
    if(!result.rowCount)return res.status(404).json({error:'Organization profile not found',code:'ORGANIZATION_PROFILE_NOT_FOUND'});
    res.json(result.rows[0]);
  }));

  router.put('/profile',requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
    const parsed=validateOrganizationProfile(req.body);
    if(!parsed.success)return res.status(400).json({error:'Invalid organization profile',code:'ORGANIZATION_PROFILE_VALIDATION_FAILED',issues:parsed.error.flatten()});
    if(parsed.data.organizationId&&parsed.data.organizationId!==req.organizationScope.organizationId)
      return res.status(403).json({error:'Organization scope is not authorized',code:'ORG_SCOPE_DENIED'});
    const client=await pool.connect();try{
      await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtext($1))',[`organization-profile:${req.organizationScope.organizationId}`]);
      const organization=(await client.query('select * from organizations where id=$1 for update',[req.organizationScope.organizationId])).rows[0];
      const latest=(await client.query('select *,effective_from::text effective_from,effective_to::text effective_to from organization_profile_versions where organization_id=$1 order by organization_profile_versions.effective_from desc limit 1 for update',[req.organizationScope.organizationId])).rows[0];
      if(latest&&parsed.data.effectiveFrom<dateOnly(latest.effective_from)){await client.query('rollback');return res.status(409).json({error:'Organization profile version is stale',code:'ORGANIZATION_PROFILE_VERSION_CONFLICT'});}
      if(latest&&parsed.data.effectiveFrom>dateOnly(latest.effective_from)&&latest.effective_to==null)
        await client.query('update organization_profile_versions set effective_to=$2::date-1 where id=$1',[latest.id,parsed.data.effectiveFrom]);
      const values=[req.organizationScope.organizationId,parsed.data.name,parsed.data.legalName,parsed.data.productDisplayName,parsed.data.supportContact,
        parsed.data.defaultLocale,parsed.data.defaultTimeZone,parsed.data.baseCurrency,parsed.data.fiscalYearStart,parsed.data.defaultWeekStart,parsed.data.effectiveFrom,req.user.sub,
        parsed.data.branding ?? latest?.branding ?? null];
      const result=await client.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,
        default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from,created_by,branding)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(organization_id,effective_from) do update set
        branding=excluded.branding,
        name=excluded.name,legal_name=excluded.legal_name,product_display_name=excluded.product_display_name,support_contact=excluded.support_contact,
        default_locale=excluded.default_locale,default_time_zone=excluded.default_time_zone,base_currency=excluded.base_currency,
        fiscal_year_start=excluded.fiscal_year_start,default_week_start=excluded.default_week_start returning *`,values);
      await client.query(`update organizations set name=$2,updated_at=now()
        where id=$1 and $3::date <= current_date`,[req.organizationScope.organizationId,parsed.data.name,parsed.data.effectiveFrom]);
      await audit(client,req,{module:'Organization Setup',action:'Update Organization Profile',entityType:'Organization',entityId:req.organizationScope.organizationId,
        oldValue:{...latest,name:organization.name},newValue:{...result.rows[0],name:parsed.data.name},details:'Versioned organization profile using authoritative request scope',
        organizationScope:{organizationId:req.organizationScope.organizationId,legalEntityId:null}});
      const response=await client.query(`${profileSelect} where o.id=$1 and p.id=$2`,[req.organizationScope.organizationId,result.rows[0].id]);
      await client.query('commit');res.json(response.rows[0]);
    }catch(error){await client.query('rollback');if(['23P01','23505'].includes(error.code))return res.status(409).json({error:'Organization profile version conflicts with existing history',code:'ORGANIZATION_PROFILE_VERSION_CONFLICT'});console.error(error);res.status(500).json({error:'Organization profile mutation failed',code:'ORGANIZATION_PROFILE_MUTATION_FAILED'});}finally{client.release();}
  }));

  router.get('/legal-entities', requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
    const asOf=req.setupAsOf;
    const result=await pool.query(`${legalSelect} join user_organization_scopes s on s.legal_entity_id=le.id and s.organization_id=le.organization_id
      where le.organization_id=$1 and s.user_id=$2 and s.active=true and ${asOfPredicate('p','$3')}
      order by le.code,p.effective_from desc limit $4`,[req.organizationScope.organizationId,req.user.sub,asOf,MAX_SETUP_ROWS]);res.json(result.rows);
  }));
  router.get('/legal-entities/:id', requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
    if(req.params.id!==req.organizationScope.legalEntityId)return res.status(404).json({error:'Legal entity not found'});
    const asOf=req.setupAsOf;
    const result=await pool.query(`${legalSelect} where le.organization_id=$1 and le.id=$2 and ${asOfPredicate('p','$3')}
      order by p.effective_from desc limit 1`,[req.organizationScope.organizationId,req.params.id,asOf]);
    if(!result.rowCount)return res.status(404).json({error:'Legal entity not found'});res.json(result.rows[0]);
  }));

  const mutateLegalEntity=asyncHandler(async(req,res)=>{
    const parsed=validateLegalEntity(req.body);
    if(!parsed.success||parsed.success&&parsed.data.effectiveTo&&parsed.data.effectiveTo<parsed.data.effectiveFrom)
      return res.status(400).json({error:'Invalid legal entity',code:'LEGAL_ENTITY_VALIDATION_FAILED',issues:parsed.success?undefined:parsed.error.flatten()});
    if(parsed.data.organizationId&&parsed.data.organizationId!==req.organizationScope.organizationId)
      return res.status(403).json({error:'Organization scope is not authorized',code:'ORG_SCOPE_DENIED'});
    const targetId=req.params.id||null;
    if(targetId&&targetId!==req.organizationScope.legalEntityId)return res.status(404).json({error:'Legal entity not found'});
    const client=await pool.connect();try{
      await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtext($1))',[`legal-entity:${req.organizationScope.organizationId}:${targetId||parsed.data.code}`]);
      const previous=targetId?(await client.query('select * from legal_entities where id=$1 and organization_id=$2 for update',[targetId,req.organizationScope.organizationId])).rows[0]:null;
      if(targetId&&!previous){await client.query('rollback');return res.status(404).json({error:'Legal entity not found'});}
      if(previous&&parsed.data.code!==previous.code){await client.query('rollback');return res.status(409).json({error:'Legal entity code is immutable',code:'LEGAL_ENTITY_CODE_IMMUTABLE'});}
      const exactVersion=(await client.query('select * from legal_entity_profile_versions where legal_entity_id=$1 and effective_from=$2 for update',[previous?.id||'',parsed.data.effectiveFrom])).rows[0];
      const latest=(await client.query('select * from legal_entity_profile_versions where legal_entity_id=$1 order by effective_from desc limit 1 for update',[previous?.id||''])).rows[0];
      const currentDate=new Date().toISOString().slice(0,10);
      const exactVersionIsHistorical=exactVersion&&exactVersion.effective_to&&dateOnly(exactVersion.effective_to)<currentDate;
      if(exactVersionIsHistorical||!exactVersion&&latest&&parsed.data.effectiveFrom<dateOnly(latest.effective_from)){await client.query('rollback');return res.status(409).json({error:'Legal entity profile version is stale',code:'LEGAL_ENTITY_VERSION_CONFLICT'});}
      if(previous&&(parsed.data.status==='Inactive'||parsed.data.effectiveTo)){
        const deps=await client.query(`select id from employees where organization_id=$1 and legal_entity_id=$2 and status<>'Exited'
          union all select id from projects where organization_id=$1 and legal_entity_id=$2 and status in ('Proposed','Active','On Hold')
          union all select id from clients where organization_id=$1 and legal_entity_id=$2 and status='Active' limit $3`,[req.organizationScope.organizationId,targetId,MAX_DEPENDENCIES+1]);
        const alternative=await client.query(`select 1 from user_organization_scopes s join legal_entities le on le.id=s.legal_entity_id and le.organization_id=s.organization_id
          join legal_entity_profile_versions lp on lp.legal_entity_id=le.id and lp.organization_id=le.organization_id
            and current_date between lp.effective_from and coalesce(lp.effective_to,'infinity'::date)
          where s.user_id=$1 and s.organization_id=$2 and s.legal_entity_id<>$3 and s.active=true and lp.status='Active'
          and current_date between le.effective_from and coalesce(lp.authority_effective_to,'infinity'::date) limit 1`,[req.user.sub,req.organizationScope.organizationId,targetId]);
        if(deps.rowCount||!alternative.rowCount){await client.query('rollback');return res.status(409).json({error:'Legal entity has active authority or dependencies',code:'LEGAL_ENTITY_IN_USE'});}
      }
      const id=previous?.id||`legal-${crypto.randomUUID()}`;
      const entity=previous?await client.query(`with changed as (update legal_entities set
          name=$2,country_code=$3,status=$4,effective_to=$5,updated_at=now()
          where id=$1 and $6::date<=current_date returning *)
          select * from changed union all select * from legal_entities where id=$1 and not exists(select 1 from changed)`,
        [id,parsed.data.legalName,parsed.data.address.countryCode,parsed.data.status,parsed.data.effectiveTo||null,parsed.data.effectiveFrom]):
        await client.query(`insert into legal_entities(id,organization_id,code,name,country_code,status,effective_from,effective_to) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
          [id,req.organizationScope.organizationId,parsed.data.code,parsed.data.legalName,parsed.data.address.countryCode,parsed.data.status,parsed.data.effectiveFrom,parsed.data.effectiveTo||null]);
      if(!exactVersion&&latest&&parsed.data.effectiveFrom>dateOnly(latest.effective_from)&&latest.effective_to==null)
        await client.query('update legal_entity_profile_versions set effective_to=$2::date-1 where id=$1',[latest.id,parsed.data.effectiveFrom]);
      const profile=await client.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,country_code,status,authority_effective_to,
        registration_identifier,tax_identifier,reporting_currency,address,effective_from,created_by)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(legal_entity_id,effective_from) do update set legal_name=excluded.legal_name,
        country_code=excluded.country_code,status=excluded.status,authority_effective_to=excluded.authority_effective_to,
        registration_identifier=excluded.registration_identifier,tax_identifier=excluded.tax_identifier,reporting_currency=excluded.reporting_currency,address=excluded.address returning *`,
      [id,req.organizationScope.organizationId,parsed.data.legalName,parsed.data.address.countryCode,parsed.data.status,parsed.data.effectiveTo||null,
        parsed.data.registrationIdentifier||null,parsed.data.taxIdentifier||null,parsed.data.reportingCurrency,JSON.stringify(parsed.data.address),parsed.data.effectiveFrom,req.user.sub]);
      if(!previous)await client.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true)
        on conflict(user_id,organization_id,legal_entity_id) do update set active=true`,[req.user.sub,req.organizationScope.organizationId,id]);
      await audit(client,req,{module:'Organization Setup',action:previous?'Update Legal Entity':'Create Legal Entity',entityType:'Legal Entity',entityId:id,
        oldValue:previous?{entity:previous,profile:exactVersion||latest}:null,newValue:{entity:entity.rows[0],profile:profile.rows[0]},details:`${previous?'Updated':'Created'} legal entity in authoritative organization scope`,
        organizationScope:previous?req.organizationScope:{organizationId:req.organizationScope.organizationId,legalEntityId:null}});
      const response=await client.query(`${legalSelect} where le.id=$1 and p.id=$2`,[id,profile.rows[0].id]);
      await client.query('commit');res.status(previous?200:201).json(response.rows[0]);
    }catch(error){await client.query('rollback');if(error.code==='23505')return res.status(409).json({error:'Legal entity code or identity already exists',code:'LEGAL_ENTITY_UNIQUENESS_CONFLICT'});if(error.code==='23P01'&&error.constraint==='legal_entity_registration_identifier_no_overlap')return res.status(409).json({error:'Registration identifier is already assigned during an overlapping effective period',code:'LEGAL_ENTITY_IDENTIFIER_CONFLICT',field:'registrationIdentifier'});if(error.code==='23P01'&&error.constraint==='legal_entity_tax_identifier_no_overlap')return res.status(409).json({error:'Tax identifier is already assigned during an overlapping effective period',code:'LEGAL_ENTITY_IDENTIFIER_CONFLICT',field:'taxIdentifier'});if(error.code==='23P01')return res.status(409).json({error:'Legal entity profile version conflicts with existing history',code:'LEGAL_ENTITY_VERSION_CONFLICT'});console.error(error);res.status(500).json({error:'Legal entity mutation failed',code:'LEGAL_ENTITY_MUTATION_FAILED'});}finally{client.release();}
  });
  router.post('/legal-entities',requirePermission('settings.manage'),mutateLegalEntity);
  router.put('/legal-entities/:id',requirePermission('settings.manage'),mutateLegalEntity);

  router.get('/catalogs/:type', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
    if (!catalogTypes.includes(req.params.type)) return res.status(404).json({ error: 'Unknown organization catalog' });
    const asOf = req.setupAsOf;
    const result = await pool.query(`select * from organization_catalog_items i where i.organization_id=$1
      and i.catalog_type=$2 and (i.legal_entity_id is null or i.legal_entity_id=$3)
      and ${asOfPredicate('i', '$4')} order by i.name, i.code, i.effective_from desc limit $5`,
    [req.organizationScope.organizationId, req.params.type, req.organizationScope.legalEntityId, asOf, MAX_SETUP_ROWS]);
    res.json(result.rows);
  }));

  router.post('/catalogs/:type', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
    if (!catalogTypes.includes(req.params.type)) return res.status(404).json({ error: 'Unknown organization catalog' });
    const parsed = z.object({ code:z.string().trim().min(1).max(50), name:z.string().trim().min(1).max(150),
      parentId:z.string().nullable().optional(), effectiveFrom:z.string().date(), legalEntityId:z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const legalEntityId = parsed.data.legalEntityId || req.organizationScope.legalEntityId;
    if (legalEntityId !== req.organizationScope.legalEntityId) return res.status(403).json({ error:'Legal entity scope is not authorized', code:'LEGAL_SCOPE_DENIED' });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))',
        [`${req.organizationScope.organizationId}:${legalEntityId}:${req.params.type}:${parsed.data.code}`]);
      if (parsed.data.parentId) {
        const parent = await client.query(`select 1 from organization_catalog_items where id=$1 and organization_id=$2
          and catalog_type=$3 and active=true and (legal_entity_id is null or legal_entity_id=$4) for share`,
        [parsed.data.parentId, req.organizationScope.organizationId, req.params.type, req.organizationScope.legalEntityId]);
        if (!parent.rowCount) { await client.query('rollback'); return res.status(409).json({ error:'Parent is unavailable in this scope', code:'INVALID_CATALOG_PARENT' }); }
      }
      const latest = (await client.query(`select effective_from,effective_to from organization_catalog_items
        where organization_id=$1 and catalog_type=$2 and code=$3 and legal_entity_id=$4
        order by effective_from desc limit 1 for update`,
      [req.organizationScope.organizationId, req.params.type, parsed.data.code, legalEntityId])).rows[0];
      if (latest && parsed.data.effectiveFrom <= dateOnly(latest.effective_from)) {
        await client.query('rollback');
        return res.status(409).json({ error:'Catalog versions must be added after the latest version', code:'CATALOG_VERSION_CONFLICT' });
      }
      if (latest?.effective_to && parsed.data.effectiveFrom <= dateOnly(latest.effective_to)) {
        await client.query('rollback');
        return res.status(409).json({ error:'Catalog version overlaps existing history', code:'CATALOG_VERSION_CONFLICT' });
      }
      if (latest?.effective_to == null && latest) {
        await client.query(`update organization_catalog_items set effective_to=$4::date-1,updated_at=now()
          where organization_id=$1 and catalog_type=$2 and code=$3 and legal_entity_id=$5 and effective_to is null`,
        [req.organizationScope.organizationId, req.params.type, parsed.data.code, parsed.data.effectiveFrom, legalEntityId]);
      }
      const result = await client.query(`insert into organization_catalog_items
        (organization_id,legal_entity_id,catalog_type,code,name,parent_id,effective_from)
        values($1,$2,$3,$4,$5,$6,$7) returning *`, [req.organizationScope.organizationId, legalEntityId,
        req.params.type, parsed.data.code, parsed.data.name, parsed.data.parentId || null, parsed.data.effectiveFrom]);
      await audit(client, req, { module:'Organization Setup', action:'Create Catalog Item', entityType:req.params.type,
        entityId:result.rows[0].id, newValue:result.rows[0], details:'Created organization-scoped catalog item' });
      await client.query('commit'); res.status(201).json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      if (['WKT01','23P01','23505','23514'].includes(error.code)) return res.status(409).json({ error:'Catalog version conflicts with existing history', code:'CATALOG_VERSION_CONFLICT' });
      console.error(error); res.status(500).json({ error:'Catalog item creation failed' });
    } finally { client.release(); }
  }));

  router.post('/catalogs/:type/:id/retire', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
    if (!catalogTypes.includes(req.params.type)) return res.status(404).json({ error:'Unknown organization catalog' });
    const client = await pool.connect();
    try {
      await client.query('begin');
      const item = (await client.query(`select * from organization_catalog_items where id=$1 and organization_id=$2
        and catalog_type=$3 and legal_entity_id=$4 for update`,
      [req.params.id, req.organizationScope.organizationId, req.params.type, req.organizationScope.legalEntityId])).rows[0];
      if (!item) { await client.query('rollback'); return res.status(404).json({ error:'Catalog item not found' }); }
      const scheduledTypes=item.catalog_type==='worker_type' && (await client.query("select to_regclass('worker_type_assignments') is not null available")).rows[0].available;
      const currentLegacy=scheduledTypes?`and not exists(select 1 from worker_type_assignments a where a.employee_id=worker_profiles.employee_id
        and a.organization_id=$2 and a.legal_entity_id=$3 and a.effective_from<=(statement_timestamp() at time zone 'UTC')::date)`:'';
      const dependencies = await client.query(`select 'child' dependency,id from organization_catalog_items
        where parent_id=$1 and active=true and organization_id=$2 and (legal_entity_id is null or legal_entity_id=$3)
        union all select 'worker',employee_id from worker_profiles where worker_type_id=$1 and organization_id=$2
          and legal_entity_id=$3 and lifecycle_status in ('Active','On Leave') ${currentLegacy} limit $4`,
      [item.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId, MAX_DEPENDENCIES + 1]);
      if (dependencies.rows.length) { await client.query('rollback'); return res.status(409).json({ error:'Active dependencies prevent retirement', code:'CATALOG_IN_USE', dependencies:dependencies.rows.slice(0,MAX_DEPENDENCIES), truncated:dependencies.rows.length>MAX_DEPENDENCIES }); }
      const result = await client.query('update organization_catalog_items set active=false,effective_to=coalesce(effective_to,current_date),updated_at=now() where id=$1 returning *',[item.id]);
      await audit(client,req,{module:'Organization Setup',action:'Retire Catalog Item',entityType:req.params.type,entityId:item.id,oldValue:item,newValue:result.rows[0],details:'Retired catalog item after dependency analysis'});
      await client.query('commit'); res.json(result.rows[0]);
    } catch(error) { await client.query('rollback'); if(error.code==='WKT01')return res.status(409).json({error:'Current or scheduled worker assignments prevent retirement',code:'CATALOG_IN_USE'}); console.error(error); res.status(500).json({error:'Catalog retirement failed'}); } finally { client.release(); }
  }));

  router.get('/calendars', requirePermission('settings.manage'), asyncHandler(async (req,res) => {
    const asOf=req.setupAsOf;
    const result=await pool.query(`select c.*,c.effective_from::text effective_from,c.effective_to::text effective_to from working_calendars c
      left join organization_catalog_items wg on wg.id=c.worker_group_id and wg.organization_id=c.organization_id
      join legal_entities scope_le on scope_le.id=$2 and scope_le.organization_id=c.organization_id
      where c.organization_id=$1 and (
        (c.applicability_type='legal_entity' and c.legal_entity_id=$2)
        or (c.applicability_type='country' and c.country_code=scope_le.country_code)
        or (c.applicability_type='worker_group' and (wg.legal_entity_id is null or wg.legal_entity_id=$2))
      ) and ${asOfPredicate('c','$3')} order by c.code,c.effective_from desc limit $4`,
    [req.organizationScope.organizationId,req.organizationScope.legalEntityId,asOf,MAX_SETUP_ROWS]);
    res.json(result.rows);
  }));
  router.post('/calendars', requirePermission('settings.manage'), asyncHandler(async (req,res) => {
    const parsed=validateWorkingCalendar(req.body);
    if(!parsed.success)return res.status(400).json({error:'Invalid working calendar',code:'CALENDAR_VALIDATION_FAILED',issues:parsed.error.flatten()});
    const scope=calendarScopeValues(parsed.data.applicability,req.organizationScope.legalEntityId);
    const client=await pool.connect(); try { await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))',[`calendar:${req.organizationScope.organizationId}:${scope.applicabilityType}:${scope.legalEntityId||scope.countryCode||scope.workerGroupId}:${parsed.data.code}`]);
      if(scope.countryCode){const authority=await client.query(`select 1 from legal_entities where organization_id=$1 and id=$2 and country_code=$3
          and status='Active' and current_date between effective_from and coalesce(effective_to,'infinity'::date)`,[req.organizationScope.organizationId,req.organizationScope.legalEntityId,scope.countryCode]);
        if(!authority.rowCount){await client.query('rollback');return res.status(404).json({error:'Country authority not found',code:'CALENDAR_COUNTRY_NOT_FOUND'});}}
      if(scope.workerGroupId){const group=await client.query(`select 1 from organization_catalog_items where id=$1 and organization_id=$2
          and catalog_type='business_unit' and active=true and (legal_entity_id is null or legal_entity_id=$3)
          and $4::date between effective_from and coalesce(effective_to,'infinity'::date)`,[scope.workerGroupId,req.organizationScope.organizationId,req.organizationScope.legalEntityId,parsed.data.effectiveFrom]);
        if(!group.rowCount){await client.query('rollback');return res.status(404).json({error:'Worker group not found',code:'CALENDAR_WORKER_GROUP_NOT_FOUND'});}}
      const values=[req.organizationScope.organizationId,scope.applicabilityType,scope.legalEntityId,scope.countryCode,scope.countryAuthorityLegalEntityId,scope.workerGroupId,parsed.data.code];
      const latest=(await client.query(`select * from working_calendars where organization_id=$1 and applicability_type=$2
        and legal_entity_id is not distinct from $3 and country_code is not distinct from $4
        and country_authority_legal_entity_id is not distinct from $5 and worker_group_id is not distinct from $6
        and code=$7 order by effective_from desc limit 1 for update`,values)).rows[0];
      if(latest&&parsed.data.effectiveFrom<=dateOnly(latest.effective_from)){await client.query('rollback');return res.status(409).json({error:'Calendar version conflict',code:'CALENDAR_VERSION_CONFLICT'});}
      if(latest&&latest.effective_to==null)await client.query('update working_calendars set effective_to=$2::date-1 where id=$1',[latest.id,parsed.data.effectiveFrom]);
      const result=await client.query(`insert into working_calendars(organization_id,applicability_type,legal_entity_id,country_code,
        country_authority_legal_entity_id,worker_group_id,code,name,timezone,working_days,hours_per_day,effective_from)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,[...values,parsed.data.name,parsed.data.timezone,parsed.data.workingDays,parsed.data.hoursPerDay,parsed.data.effectiveFrom]);
      await audit(client,req,{module:'Organization Setup',action:'Version Calendar',entityType:'Working Calendar',entityId:result.rows[0].id,newValue:result.rows[0],details:'Created an effective-dated working calendar version'}); await client.query('commit');res.status(201).json(result.rows[0]);
    }catch(error){await client.query('rollback');if(['23P01','23505'].includes(error.code))return res.status(409).json({error:'Calendar version conflict',code:'CALENDAR_VERSION_CONFLICT'});res.status(500).json({error:'Calendar creation failed'});}finally{client.release();}
  }));
  router.post('/calendars/:id/retire',requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
    const client=await pool.connect();try{await client.query('begin');
      const calendar=(await client.query(`select * from working_calendars where id=$1 and organization_id=$2 and (
        (applicability_type='legal_entity' and legal_entity_id=$3) or
        (applicability_type='country' and country_authority_legal_entity_id=$3) or
        (applicability_type='worker_group' and exists(select 1 from organization_catalog_items where id=worker_group_id and organization_id=$2 and (legal_entity_id is null or legal_entity_id=$3)))) for update`,[req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if(!calendar){await client.query('rollback');return res.status(404).json({error:'Working calendar not found'});}
      const dependencies=await client.query(`select employee_id id,'worker' dependency from worker_profiles where working_calendar_id=$1
        and organization_id=$2 and lifecycle_status in ('Active','On Leave')
        union all select holiday_id,'holiday' from working_calendar_holidays where calendar_id=$1 and organization_id=$2 and active=true
        and current_date between effective_from and coalesce(effective_to,'infinity'::date) limit $3`,[calendar.id,req.organizationScope.organizationId,MAX_DEPENDENCIES+1]);
      if(dependencies.rowCount){await client.query('rollback');return res.status(409).json({error:'Active dependencies prevent calendar retirement',code:'CALENDAR_IN_USE',dependencies:dependencies.rows.slice(0,MAX_DEPENDENCIES)});}
      const result=await client.query(`update working_calendars set active=false,effective_to=least(coalesce(effective_to,current_date),current_date) where id=$1 returning *`,[calendar.id]);
      await audit(client,req,{module:'Organization Setup',action:'Retire Calendar',entityType:'Working Calendar',entityId:calendar.id,oldValue:calendar,newValue:result.rows[0],details:'Retired working calendar after dependency analysis'});
      await client.query('commit');res.json(result.rows[0]);
    }catch(error){await client.query('rollback');res.status(500).json({error:'Calendar retirement failed'});}finally{client.release();}
  }));
  router.get('/calendars/:id/holidays', requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
    const asOf=req.setupAsOf;
    const authorized=await pool.query(`select 1 from working_calendars c left join organization_catalog_items wg
      on wg.id=c.worker_group_id and wg.organization_id=c.organization_id
      join legal_entities scope_le on scope_le.id=$3 and scope_le.organization_id=c.organization_id where c.id=$1 and c.organization_id=$2 and (
        (c.applicability_type='legal_entity' and c.legal_entity_id=$3) or (c.applicability_type='country' and c.country_code=scope_le.country_code)
        or (c.applicability_type='worker_group' and (wg.legal_entity_id is null or wg.legal_entity_id=$3)))`,
    [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId]);
    if(!authorized.rowCount)return res.status(404).json({error:'Working calendar not found'});
    const result=await pool.query(`select h.*,h.holiday_date::text holiday_date,h.effective_from::text effective_from,h.effective_to::text effective_to from working_calendar_holidays h
      where h.organization_id=$1 and h.calendar_id=$2 and (h.active=true or h.effective_to is not null)
      and $3::date between h.effective_from and coalesce(h.effective_to,'infinity'::date)
      order by h.holiday_date,h.label limit $4`,[req.organizationScope.organizationId,req.params.id,asOf,MAX_SETUP_ROWS]);
    res.json(result.rows);
  }));
  const mutateHoliday=asyncHandler(async(req,res)=>{
    const parsed=validateWorkingCalendarHoliday(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid calendar holiday',code:'CALENDAR_HOLIDAY_VALIDATION_FAILED',issues:parsed.error.flatten()});
    const client=await pool.connect();try{await client.query('begin');
      const calendar=(await client.query(`select * from working_calendars where id=$1 and organization_id=$2 and active=true and (
        (applicability_type='legal_entity' and legal_entity_id=$3) or (applicability_type='country' and country_authority_legal_entity_id=$3)
        or (applicability_type='worker_group' and exists(select 1 from organization_catalog_items where id=worker_group_id and organization_id=$2 and (legal_entity_id is null or legal_entity_id=$3)))) for update`,[req.params.calendarId,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if(!calendar){await client.query('rollback');return res.status(404).json({error:'Working calendar not found'});}
      const holidayId=req.params.holidayId||null;await client.query('select pg_advisory_xact_lock(hashtext($1))',[`calendar-holiday:${calendar.id}:${holidayId||parsed.data.holidayDate}`]);
      const previous=holidayId?(await client.query(`select * from working_calendar_holidays where holiday_id=$1 and calendar_id=$2 and organization_id=$3 and active=true order by effective_from desc limit 1 for update`,[holidayId,calendar.id,req.organizationScope.organizationId])).rows[0]:null;
      if(holidayId&&!previous){await client.query('rollback');return res.status(404).json({error:'Calendar holiday not found'});}
      if(previous&&parsed.data.effectiveFrom<=dateOnly(previous.effective_from)){await client.query('rollback');return res.status(409).json({error:'Holiday version conflict',code:'CALENDAR_HOLIDAY_VERSION_CONFLICT'});}
      if(previous)await client.query('update working_calendar_holidays set effective_to=$2::date-1 where id=$1',[previous.id,parsed.data.effectiveFrom]);
      const result=await client.query(`insert into working_calendar_holidays(holiday_id,organization_id,calendar_id,holiday_date,label,holiday_type,effective_from,created_by)
        values(coalesce($1,'calendar-holiday-'||gen_random_uuid()::text),$2,$3,$4,$5,$6,$7,$8) returning *`,[holidayId,req.organizationScope.organizationId,calendar.id,parsed.data.holidayDate,parsed.data.label,parsed.data.holidayType,parsed.data.effectiveFrom,req.user.sub]);
      await audit(client,req,{module:'Organization Setup',action:previous?'Update Calendar Holiday':'Create Calendar Holiday',entityType:'Calendar Holiday',entityId:result.rows[0].holiday_id,oldValue:previous,newValue:result.rows[0],details:`${parsed.data.holidayType} holiday authority for ${parsed.data.holidayDate}`});
      await client.query('commit');res.status(previous?200:201).json(result.rows[0]);
    }catch(error){await client.query('rollback');if(['23P01','23505'].includes(error.code))return res.status(409).json({error:'Holiday date conflicts with existing authority',code:'CALENDAR_HOLIDAY_CONFLICT'});res.status(500).json({error:'Calendar holiday mutation failed'});}finally{client.release();}
  });
  router.post('/calendars/:calendarId/holidays',requirePermission('settings.manage'),mutateHoliday);
  router.put('/calendars/:calendarId/holidays/:holidayId',requirePermission('settings.manage'),mutateHoliday);
  router.post('/calendars/:calendarId/holidays/:holidayId/retire',requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
    const client=await pool.connect();try{await client.query('begin');
      const previous=(await client.query(`select h.* from working_calendar_holidays h join working_calendars c on c.id=h.calendar_id and c.organization_id=h.organization_id
        left join organization_catalog_items wg on wg.id=c.worker_group_id and wg.organization_id=c.organization_id
        where h.holiday_id=$1 and h.calendar_id=$2 and h.organization_id=$3 and h.active=true
        and ((c.applicability_type='legal_entity' and c.legal_entity_id=$4) or (c.applicability_type='country' and c.country_authority_legal_entity_id=$4)
          or (c.applicability_type='worker_group' and (wg.legal_entity_id is null or wg.legal_entity_id=$4))) order by h.effective_from desc limit 1 for update of h`,[req.params.holidayId,req.params.calendarId,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if(!previous){await client.query('rollback');return res.status(404).json({error:'Calendar holiday not found'});}
      const result=await client.query(`update working_calendar_holidays set active=false,effective_to=case when effective_from<current_date then least(coalesce(effective_to,current_date-1),current_date-1) else effective_to end where id=$1 returning *`,[previous.id]);
      await audit(client,req,{module:'Organization Setup',action:'Retire Calendar Holiday',entityType:'Calendar Holiday',entityId:previous.holiday_id,oldValue:previous,newValue:result.rows[0],details:'Retired calendar holiday authority'});
      await client.query('commit');res.json(result.rows[0]);
    }catch(error){await client.query('rollback');res.status(500).json({error:'Calendar holiday retirement failed'});}finally{client.release();}
  }));
  registerFinancialPeriodRoutes(router,{pool,requirePermission,audit});
  router.get('/reporting-periods', requirePermission('settings.manage'), asyncHandler(async (req,res) => {
    const result=await pool.query(`select * from reporting_periods where organization_id=$1
      and (legal_entity_id is null or legal_entity_id=$2) order by starts_on desc limit $3`,
    [req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_SETUP_ROWS]); res.json(result.rows);
  }));
  router.post('/reporting-periods', requirePermission('settings.manage'), asyncHandler(async(req,res)=>{
    const parsed=z.object({code:z.string().trim().min(1).max(50),name:z.string().trim().min(1).max(150),frequency:z.enum(REPORTING_PERIOD_FREQUENCIES),startsOn:z.string().date(),endsOn:z.string().date(),status:z.enum(REPORTING_PERIOD_STATES).default('Open')}).safeParse(req.body);
    if(!parsed.success||parsed.success&&parsed.data.endsOn<parsed.data.startsOn)return res.status(400).json({error:'Invalid reporting period'});
    const client=await pool.connect();
    try {
      await client.query('begin');
      await lockCommercialLifecycle(client,req.organizationScope);
      await client.query('select pg_advisory_xact_lock(hashtext($1))',[`reporting-period:${req.organizationScope.organizationId}:${req.organizationScope.legalEntityId}:${parsed.data.frequency}`]);
      const previous=(await client.query(`select * from reporting_periods where organization_id=$1 and legal_entity_id=$2 and frequency=$3 and code=$4 for update`,
        [req.organizationScope.organizationId,req.organizationScope.legalEntityId,parsed.data.frequency,parsed.data.code])).rows[0];
      if(['Financially Locked','Closed'].includes(parsed.data.status) && previous?.status!==parsed.data.status){
        await client.query('rollback');return res.status(409).json({error:'Inspect the period and use its financial transition action',code:'REPORTING_PERIOD_REVIEW_REQUIRED'});
      }
      if(previous&&!canTransitionReportingPeriod(previous.status,parsed.data.status)){
        await client.query('rollback');return res.status(409).json({error:'Reporting period state transition is not allowed',code:'REPORTING_PERIOD_TRANSITION_CONFLICT'});
      }
      if(previous&&['Submission Closed','Approval Closed','Financially Locked','Closed'].includes(previous.status)
        && (parsed.data.name!==previous.name||parsed.data.startsOn!==dateOnly(previous.starts_on)||parsed.data.endsOn!==dateOnly(previous.ends_on))){
        await client.query('rollback');return res.status(409).json({error:'Closed reporting-period boundaries and identity are immutable',code:'REPORTING_PERIOD_IMMUTABLE'});
      }
      const overlap=(await client.query(`select id from reporting_periods where organization_id=$1 and legal_entity_id=$2 and frequency=$3
        and id<>coalesce($4,'') and daterange(starts_on,ends_on+1,'[)') && daterange($5::date,$6::date+1,'[)') limit 1`,
      [req.organizationScope.organizationId,req.organizationScope.legalEntityId,parsed.data.frequency,previous?.id||null,parsed.data.startsOn,parsed.data.endsOn])).rows[0];
      if(overlap){await client.query('rollback');return res.status(409).json({error:'Reporting period overlaps existing authority',code:'REPORTING_PERIOD_OVERLAP'});}
      let result;
      if(previous) result=await client.query(`update reporting_periods set name=$2,starts_on=$3,ends_on=$4,status=$5 where id=$1 returning *`,
        [previous.id,parsed.data.name,parsed.data.startsOn,parsed.data.endsOn,parsed.data.status]);
      else result=await client.query(`insert into reporting_periods(organization_id,legal_entity_id,code,name,frequency,starts_on,ends_on,status)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[req.organizationScope.organizationId,req.organizationScope.legalEntityId,parsed.data.code,parsed.data.name,parsed.data.frequency,parsed.data.startsOn,parsed.data.endsOn,parsed.data.status]);
      await audit(client,req,{module:'Organization Setup',action:previous?'Update Reporting Period':'Create Reporting Period',entityType:'Reporting Period',entityId:result.rows[0].id,
        oldValue:previous,newValue:result.rows[0],details:`${previous?'Updated':'Created'} ${parsed.data.frequency} reporting period ${parsed.data.code} in state ${parsed.data.status}`});
      await client.query('commit');res.status(previous?200:201).json(result.rows[0]);
    } catch(error) {
      await client.query('rollback');
      if(['23P01','23505','23514'].includes(error.code))return res.status(409).json({error:'Reporting period conflicts with existing authority',code:'REPORTING_PERIOD_CONFLICT'});
      console.error(error);res.status(500).json({error:'Reporting period mutation failed'});
    } finally { client.release(); }
  }));
  router.get('/terminology', asyncHandler(async (req,res) => {
    const asOf=req.setupAsOf;
    const result=await pool.query(`select terms,effective_from::text effective_from,effective_to::text effective_to from terminology_versions t where t.organization_id=$1 and ${asOfPredicate('t','$2')} order by t.effective_from desc limit 1`,[req.organizationScope.organizationId,asOf]);
    const row=result.rows[0];
    const termsResponse=row?{...row,terms:normalizeTerminologyTerms(row.terms)}:{terms:{}};
    if(req.query.includeBrand !== '1') return res.json(termsResponse);
    const brand=await pool.query(`select name as "organizationName",product_display_name as "productName",branding
      from organization_profile_versions p where organization_id=$1 and (p.created_by is not null or p.branding is not null) and ${asOfPredicate('p','$2')}
      order by effective_from desc limit 1`,[req.organizationScope.organizationId,asOf]);
    const profile=brand.rows[0];
    res.json({...termsResponse,...(profile ? {brand:{...brandingSchema.parse(profile.branding ?? {}),
      productName:profile.productName,organizationName:profile.organizationName}} : {})});
  }));
  router.post('/terminology',requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
    const parsed=validateTerminology(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.flatten(),code:'TERMINOLOGY_INVALID'});
    const client=await pool.connect();try{
      await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtext($1))',[`terminology:${req.organizationScope.organizationId}`]);
      const versions=(await client.query('select *,effective_from::text effective_from,effective_to::text effective_to from terminology_versions where organization_id=$1 order by terminology_versions.effective_from desc for update',[req.organizationScope.organizationId])).rows;
      const exact=versions.find(row=>dateOnly(row.effective_from)===parsed.data.effectiveFrom);const latest=versions[0];
      if(!exact&&latest&&parsed.data.effectiveFrom<dateOnly(latest.effective_from)){await client.query('rollback');return res.status(409).json({error:'Terminology version is stale',code:'TERMINOLOGY_VERSION_CONFLICT'});}
      let result;if(exact) result=await client.query('update terminology_versions set terms=$3,created_by=$4 where organization_id=$1 and effective_from=$2 returning *,effective_from::text effective_from,effective_to::text effective_to',[req.organizationScope.organizationId,parsed.data.effectiveFrom,JSON.stringify(parsed.data.terms),req.user.sub]);
      else {if(latest)await client.query("update terminology_versions set effective_to=($2::date-interval '1 day')::date where organization_id=$1 and effective_to is null",[req.organizationScope.organizationId,parsed.data.effectiveFrom]);result=await client.query('insert into terminology_versions(organization_id,terms,effective_from,created_by) values($1,$2,$3,$4) returning *,effective_from::text effective_from,effective_to::text effective_to',[req.organizationScope.organizationId,JSON.stringify(parsed.data.terms),parsed.data.effectiveFrom,req.user.sub]);}
      await audit(client,req,{module:'Organization Setup',action:exact?'Update Terminology':'Version Terminology',entityType:'Terminology',entityId:`${req.organizationScope.organizationId}:${parsed.data.effectiveFrom}`,oldValue:exact||null,newValue:result.rows[0],details:'Updated effective-dated terminology labels and help text',
        organizationScope:{organizationId:req.organizationScope.organizationId,legalEntityId:null}});
      await client.query('commit');res.status(exact?200:201).json(result.rows[0]);
    }catch(error){await client.query('rollback');if(['23P01','23505'].includes(error.code))return res.status(409).json({error:'Terminology version conflicts with existing history',code:'TERMINOLOGY_VERSION_CONFLICT'});console.error(error);res.status(500).json({error:'Terminology mutation failed'});}finally{client.release();}
  }));

  router.get('/readiness', requirePermission('settings.manage'), asyncHandler(async (req,res) => {
    const org=req.organizationScope.organizationId;
    const facts=await pool.query(`select
      exists(select 1 from organizations where id=$1 and status='Active'
        and current_date between effective_from and coalesce(effective_to,'infinity'::date)) organization,
      exists(select 1 from legal_entities le join legal_entity_profile_versions lp
        on lp.legal_entity_id=le.id and lp.organization_id=le.organization_id
        and current_date between lp.effective_from and coalesce(lp.effective_to,'infinity'::date)
        where le.id=$2 and le.organization_id=$1 and lp.status='Active'
        and current_date between le.effective_from and coalesce(lp.authority_effective_to,'infinity'::date)) legal_entity,
      exists(select 1 from organization_catalog_items where organization_id=$1 and catalog_type='worker_type' and active
        and current_date between effective_from and coalesce(effective_to,'infinity'::date) and (legal_entity_id is null or legal_entity_id=$2)) worker_type,
      exists(select 1 from working_calendars c left join organization_catalog_items wg on wg.id=c.worker_group_id and wg.organization_id=c.organization_id
        join legal_entities scope_le on scope_le.id=$2 and scope_le.organization_id=c.organization_id
        where c.organization_id=$1 and c.active and current_date between c.effective_from and coalesce(c.effective_to,'infinity'::date)
        and ((c.applicability_type='legal_entity' and c.legal_entity_id=$2)
          or (c.applicability_type='country' and c.country_code=scope_le.country_code)
          or (c.applicability_type='worker_group' and (wg.legal_entity_id is null or wg.legal_entity_id=$2)))) calendars,
      (select count(distinct frequency)=3 from reporting_periods where organization_id=$1 and status='Open'
        and frequency in ('Weekly','Monthly','Fiscal') and current_date between starts_on and ends_on and legal_entity_id=$2) reporting_period,
      exists(select 1 from user_organization_scopes s join users u on u.id=s.user_id and u.status='Active'
        join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
        join role_permissions rp on rp.role_name=r.name and rp.enabled=true
        where s.organization_id=$1 and s.legal_entity_id=$2 and s.active=true) roles,
      exists(select 1 from user_organization_scopes s join users u on u.id=s.user_id and u.status='Active'
        join employees e on e.id=u.employee_record_id and e.organization_id=s.organization_id and e.legal_entity_id=s.legal_entity_id
        where s.organization_id=$1 and s.legal_entity_id=$2 and s.active=true) initial_users,
      exists(select 1 from user_organization_scopes s join users u on u.id=s.user_id and u.status='Active'
        join employees e on e.id=u.employee_record_id and e.organization_id=s.organization_id and e.legal_entity_id=s.legal_entity_id
        join identity_provider_links i on i.employee_id=e.id and i.provider='entra' and i.status='Linked'
        where s.organization_id=$1 and s.legal_entity_id=$2 and s.active=true) identity,
      exists(select 1 from audit_logs a
        where a.module='Import' and a.action like 'Import %'
          and ((a.organization_id=$1 and a.legal_entity_id=$2)
            or (a.organization_id is null and a.legal_entity_id is null
              and a.new_value->>'organization_id'=$1 and a.new_value->>'legal_entity_id'=$2))) imports,
      (select count(*)=3 from system_settings where (key='currency' and jsonb_typeof(value)='string' and length(value#>>'{}')>0)
        or (key='expectedWeeklyHours' and jsonb_typeof(value)='number' and (value#>>'{}')::numeric>0)
        or (key='timesheetPolicyMaxHours' and jsonb_typeof(value)='number' and (value#>>'{}')::numeric>0)) commercial_defaults,
      exists(select 1 from notification_preferences np join employees e on e.id=np.employee_id
        where e.organization_id=$1 and e.legal_entity_id=$2)
        and exists(select 1 from notification_templates where active=true and channel='InApp') notifications`,[org,req.organizationScope.legalEntityId]);
    const readiness=buildSetupReadiness(facts.rows[0]||{});
    res.json({ organizationId:org, legalEntityId:req.organizationScope.legalEntityId, ...readiness,
      authority:'persisted-server-state' });
  }));

  router.get('/workers/:id/dependencies', requirePermission('employees.manage'), asyncHandler(async (req,res) => {
    const params=[req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_DEPENDENCIES+1];
    const visible=buildEmployeeScopeWhere(req,params,'e');
    const result=await pool.query(`select (select coalesce(jsonb_agg(d),'[]'::jsonb) from (select kind,id from (
      select 'active_assignment' kind,a.id from project_allocations a join projects p on p.id=a.project_id and p.organization_id=a.organization_id
        where a.employee_id=$1 and a.status='Active' and p.organization_id=$2 and p.legal_entity_id=$3
      union all select 'pending_approval',id::text from approval_records where subject_employee_id=$1 and status='Pending'
      union all select 'open_work',id::text from timesheets where employee_id=$1 and organization_id=$2 and status in ('Draft','Submitted')
      union all select 'project_owner',id from projects where manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status in ('Proposed','Active','On Hold')
      union all select 'direct_report',id from employees where reporting_manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status<>'Exited'
    ) dependencies limit $4) d) dependencies from employees e where e.id=$1 and (${visible})`,params);
    if(!result.rowCount)return res.status(404).json({error:'Worker not found',code:'WORKER_NOT_FOUND'});
    const dependencies=result.rows[0].dependencies;
    res.json({dependencies:dependencies.slice(0,MAX_DEPENDENCIES),truncated:dependencies.length>MAX_DEPENDENCIES});
  }));

  router.post('/workers/:id/transition', requirePermission('employees.manage'), asyncHandler(async (req,res) => {
    const parsed=z.object({status:z.enum(['Active','On Leave','Disabled','Exited']),effectiveFrom:z.string().date(),reason:z.string().trim().min(1).max(500),idempotencyKey:z.string().trim().min(8).max(100)}).safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:parsed.error.flatten()});
    if(parsed.data.effectiveFrom>new Date().toISOString().slice(0,10)) return res.status(409).json({error:'Future worker transitions are not supported',code:'FUTURE_TRANSITION_UNSUPPORTED'});
    const client=await pool.connect();
    try {
      await client.query('begin');
      const employeeKey=(await client.query(`select employee_id from employees
        where id=$1 and organization_id=$2 and legal_entity_id=$3`,
      [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if(!employeeKey){await client.query('rollback');return res.status(404).json({error:'Worker not found'});}
      await client.query('select pg_advisory_xact_lock(hashtext($1))',[
        `employee:${req.organizationScope.organizationId}:${employeeKey.employee_id}`,
      ]);
      const worker=(await client.query(`select e.*,wp.lifecycle_status from employees e join worker_profiles wp on wp.employee_id=e.id
        where e.id=$1 and e.organization_id=$2 and e.legal_entity_id=$3 and wp.organization_id=$2 and wp.legal_entity_id=$3 for update`,
      [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if(!worker){await client.query('rollback');return res.status(404).json({error:'Worker not found'});}
      const replay=await client.query("select snapshot from worker_history where employee_id=$1 and snapshot->>'idempotencyKey'=$2",[worker.id,parsed.data.idempotencyKey]);
      if(replay.rowCount){await client.query('rollback');return res.json({worker:replay.rows[0].snapshot,replayed:true});}
      const latestHistory=(await client.query(`select effective_from from worker_history where employee_id=$1
        and organization_id=$2 order by effective_from desc limit 1 for update`,[worker.id,req.organizationScope.organizationId])).rows[0];
      if(latestHistory && parsed.data.effectiveFrom <= dateOnly(latestHistory.effective_from)) {
        await client.query('rollback');
        return res.status(409).json({error:'Worker transition conflicts with existing history',code:'WORKER_VERSION_CONFLICT'});
      }
      if(['Disabled','Exited'].includes(parsed.data.status)) {
        const deps=await client.query(`select kind,id from (select 'active_assignment' kind,a.id from project_allocations a
          join projects p on p.id=a.project_id and p.organization_id=a.organization_id
          where a.employee_id=$1 and a.status='Active' and p.organization_id=$2 and p.legal_entity_id=$3
          union all select 'pending_approval',id::text from approval_records where subject_employee_id=$1 and status='Pending'
          union all select 'open_work',id::text from timesheets where employee_id=$1 and organization_id=$2 and status in ('Draft','Submitted')
          union all select 'project_owner',id from projects where manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status in ('Proposed','Active','On Hold')
          union all select 'direct_report',id from employees where reporting_manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status<>'Exited') d limit $4`,
        [worker.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_DEPENDENCIES+1]);
        if(deps.rowCount){await client.query('rollback');return res.status(409).json({error:'Worker has active dependencies',code:'WORKER_DEPENDENCY_CONFLICT',dependencies:deps.rows.slice(0,MAX_DEPENDENCIES),truncated:deps.rows.length>MAX_DEPENDENCIES});}
      }
      await client.query('update worker_history set effective_to=$2::date-1 where employee_id=$1 and effective_to is null',[worker.id,parsed.data.effectiveFrom]);
      const snapshot={status:parsed.data.status,reason:parsed.data.reason,idempotencyKey:parsed.data.idempotencyKey};
      await client.query('insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot,actor_id) values($1,$2,$3,$4,$5,$6,$7)',[worker.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,parsed.data.effectiveFrom,parsed.data.status,JSON.stringify(snapshot),req.user.sub]);
      await client.query('update worker_profiles set lifecycle_status=$2,effective_from=$3,updated_at=now() where employee_id=$1',[worker.id,parsed.data.status,parsed.data.effectiveFrom]);
      await client.query('update employees set status=$2,exit_date=case when $2=\'Exited\' then $3 else exit_date end,updated_at=now() where id=$1',[worker.id,parsed.data.status==='Disabled'?'Exited':parsed.data.status,parsed.data.effectiveFrom]);
      if(['Disabled','Exited'].includes(parsed.data.status)) {
        await disableLinkedWorkerIdentity(client, {
          employeeId: worker.id,
          organizationId: req.organizationScope.organizationId,
          legalEntityId: req.organizationScope.legalEntityId,
        });
      } else if (['Disabled','Exited'].includes(worker.lifecycle_status) && ['Active','On Leave'].includes(parsed.data.status)) {
        await restoreLinkedWorkerIdentity(client, {
          employeeId: worker.id,
          organizationId: req.organizationScope.organizationId,
          legalEntityId: req.organizationScope.legalEntityId,
        });
      }
      await audit(client,req,{module:'Workforce',action:'Worker Lifecycle Transition',entityType:'Employee',entityId:worker.id,oldValue:{status:worker.lifecycle_status},newValue:snapshot,reason:parsed.data.reason,details:'Applied dependency-safe worker transition'});
      await client.query('commit');res.json({worker:snapshot,replayed:false});
    } catch(error){await client.query('rollback');if(error.code==='WORKER_IDENTITY_SYNC_CONFLICT')return res.status(409).json({error:'Linked worker identity scope synchronization failed',code:'WORKER_IDENTITY_SYNC_CONFLICT'});if(['23P01','23505','23514'].includes(error.code))return res.status(409).json({error:'Worker transition conflicts with existing history',code:'WORKER_VERSION_CONFLICT'});console.error(error);res.status(500).json({error:'Worker transition failed'});}finally{client.release();}
  }));

  router.get('/workers/:id/history', requirePermission('employees.view'), asyncHandler(async(req,res)=>{
    const params=[req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_HISTORY_ROWS];
    const visible=buildEmployeeScopeWhere(req,params,'e');
    const result=await pool.query(`select h.id,h.employee_id,h.organization_id,h.legal_entity_id,
      h.effective_from,h.effective_to,h.status,h.created_at,
      jsonb_build_object('status',h.status) snapshot from worker_history h
      join employees e on e.id=h.employee_id
      where h.employee_id=$1 and h.organization_id=$2 and h.legal_entity_id=$3 and (${visible})
      order by h.effective_from desc limit $4`,params);
    if(!result.rowCount)return res.status(404).json({error:'Worker history not found'});
    res.json(result.rows);
  }));
  router.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    console.error('Organization setup request failed');
    res.status(500).json({error:'Organization setup request failed',code:'ORGANIZATION_SETUP_FAILED'});
  });
  for (const mountPath of mountPaths) app.use(mountPath, router);
  return router;
};
