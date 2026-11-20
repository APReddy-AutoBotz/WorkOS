import {WORKFORCE_DIRECTORY_VERSION,WORKFORCE_DIRECTORY_PAGE_SIZE,directoryLiteral} from '../../../shared/workforce-directory.mjs';
import {capacityHash,capacityFailure} from '../planning/worker-capacity-service.mjs';
import {workApprovalOwner} from '../approvals/work-approval-service.mjs';

// Only the already-authorized minimal roster enters the relationship joins,
// digest, counts and search. No out-of-scope manager identifier is serialized.
export const readWorkforceDirectory=async(c,req,q,buildEmployeeScopeWhere)=>{
 const args=[],where=buildEmployeeScopeWhere(req,args,'e');
 const add=v=>{args.push(v);return '$'+args.length;};
 const parent=add(q.parentId??null),term=add(directoryLiteral(q.search)),after=add(q.after??null);
 const org=add(req.organizationScope.organizationId),legal=add(req.organizationScope.legalEntityId);
 const today="(statement_timestamp() at time zone 'UTC')::date";
 const includeType=q.contractVersion===WORKFORCE_DIRECTORY_VERSION;
 const version=includeType?WORKFORCE_DIRECTORY_VERSION:'workforce-directory/1';
 const row=(alias)=>`jsonb_build_object('id',${alias}.id,'code',${alias}.code,'name',${alias}.name,'status',${alias}.status,'designation',${alias}.designation,'department',${alias}.department,${includeType?`'workerType',${alias}.worker_type,`:''}'country',${alias}.country,'region',${alias}.region,'businessUnit',${alias}.business_unit,'manager',case when ${alias}.manager_id is null then null else jsonb_build_object('id',${alias}.manager_id,'code',${alias}.manager_code,'name',${alias}.manager_name)end,'visibleDirectReports',${alias}.visible_direct_reports)`;
 const data=(await c.query(`with visible as materialized(
   select e.id,e.employee_id code,e.name,e.status,e.designation,e.department,e.country,e.region,e.business_unit,e.reporting_manager_id,kind.name worker_type
   from employees e
   left join worker_profiles profile on profile.employee_id=e.id and profile.organization_id=${org}
     and profile.legal_entity_id=${legal} and ${today} between profile.effective_from and coalesce(profile.effective_to,'infinity'::date)
   left join organization_catalog_items kind on kind.id=profile.worker_type_id and kind.catalog_type='worker_type'
     and kind.organization_id=profile.organization_id and (kind.legal_entity_id is null or kind.legal_entity_id=profile.legal_entity_id)
     and kind.active and ${today} between kind.effective_from and coalesce(kind.effective_to,'infinity'::date)
   where ${where}
  ),counts as(select reporting_manager_id,count(*)::integer n from visible group by reporting_manager_id),
  roster as materialized(
   select v.*,m.id manager_id,m.code manager_code,m.name manager_name,coalesce(n.n,0)visible_direct_reports
   from visible v left join visible m on m.id=v.reporting_manager_id left join counts n on n.reporting_manager_id=v.id
  ),matching as materialized(
   select * from roster v where(${parent}::text is null or v.reporting_manager_id=${parent}::text)
   and(v.name ilike ${term} or v.code ilike ${term} ${includeType?`or v.worker_type ilike ${term}`:''} or v.designation ilike ${term} or v.department ilike ${term} or v.country ilike ${term} or v.region ilike ${term} or v.business_unit ilike ${term})
  ),page as(select * from matching v where(${after}::text is null or v.id collate "C">${after}::text collate "C")order by v.id collate "C" limit ${WORKFORCE_DIRECTORY_PAGE_SIZE+1})
  select(select encode(digest(coalesce(string_agg(${row('v')}::text,'|'order by v.id collate "C"),''),'sha256'),'hex')from roster v)stamp,
  (select ${row('v')} from roster v where v.id=${parent}::text)parent,
  (select count(*)::integer from matching)total,
  coalesce((select jsonb_agg(${row('v')} order by v.id collate "C")from page v),'[]'::jsonb)workers`,args)).rows[0];
 if(q.parentId&&!data.parent)capacityFailure('DIRECTORY_WORKER_UNAVAILABLE','The selected worker is unavailable in this current directory scope.',404);
 const ownerKey=workApprovalOwner(req),rosterToken=capacityHash({version,ownerKey,permissions:[...req.user.permissions].sort(),stamp:data.stamp});
 if(q.expectedRosterToken&&q.expectedRosterToken!==rosterToken)capacityFailure('DIRECTORY_ROSTER_CHANGED','Directory relationships, profile or access changed. Reload from the first page.',409);
 const workers=data.workers.slice(0,WORKFORCE_DIRECTORY_PAGE_SIZE),observed=(await c.query('select clock_timestamp()observed')).rows[0].observed;
 return{contractVersion:version,organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,ownerKey,activeRole:req.user.activeRole,selection:{search:q.search,parentId:q.parentId??null},parent:data.parent??null,workers,totalMatching:data.total,nextAfter:data.workers.length>WORKFORCE_DIRECTORY_PAGE_SIZE?workers.at(-1).id:null,rosterToken,observedAt:observed.toISOString()};
};
