import {z} from 'zod';
import {compareHours} from '../../../shared/work-hours.mjs';
import {fail} from './contracts.mjs';
import {getRetainerConsumption} from './retainer-consumption.mjs';
import {assertCommercialAuthority} from './service.mjs';

export const retainerRiskQuery=z.object({after:z.string().min(1).max(200).optional()}).strict();

// A contract revision alone does not adopt new capacity. Check the governed pin
// and any interruption between period start and the UTC observation date.
async function periodCoverage(client,scope,v,today) {
  const {rows}=await client.query(`with periods as (
    select p."startsOn" start,p."endsOn" finish,least(p."endsOn",$5::date) observed
    from commercial_contract_versions t cross join lateral jsonb_to_recordset(t.retainer_periods) p("startsOn" date,"endsOn" date)
    where t.organization_id=$1 and t.legal_entity_id=$2 and t.id=$4 and p."startsOn">=t.effective_from and p."startsOn"<=$5::date
  ) select p.start::text,coalesce(a.contract_version_id,l.contract_version_id)=$4 as applicable,
    l.state='Active' and p.start>=coalesce(a.starts_on,$6::date) and p.finish<=coalesce(a.ends_on,$7::date)
    and not exists(select from commercial_lifecycle_events e where e.organization_id=$1 and e.legal_entity_id=$2
      and e.entity_type='Contract' and e.entity_id=$3 and e.effective_on>p.start and e.effective_on<=p.observed and e.state<>'Active')
    and not exists(select from commercial_amendments m where m.organization_id=$1 and m.legal_entity_id=$2
      and m.entity_type='Contract' and m.entity_id=$3 and m.effective_on>p.start and m.effective_on<=p.observed
      and (m.contract_version_id is distinct from $4 or m.starts_on>p.start or m.ends_on<p.finish)) as covered
    from periods p left join lateral(select state,contract_version_id from commercial_lifecycle_events where organization_id=$1
      and legal_entity_id=$2 and entity_type='Contract' and entity_id=$3 and effective_on<=p.start order by sequence desc limit 1) l on true
    left join lateral(select contract_version_id,starts_on,ends_on from commercial_amendments where organization_id=$1
      and legal_entity_id=$2 and entity_type='Contract' and entity_id=$3 and effective_on<=p.start order by sequence desc limit 1) a on true`,
    [...scope,v.contract_id,v.id,today,v.starts_on,v.ends_on]);
  return new Map(rows.map(row=>[row.start,row]));
}

export async function retainerRiskRegister(client,req,buildEmployeeScopeWhere,{after}) {
  await assertCommercialAuthority(client,req,'employees.view');
  await assertCommercialAuthority(client,req,'reports.view_utilization');
  const coverage={entityWide:false};
  buildEmployeeScopeWhere(req,[],'worker',coverage);
  if (!coverage.entityWide) fail(403,'RETAINER_SCOPE_REQUIRED','Contract-wide worker visibility is required to inspect pooled capacity.');
  const {organizationId,legalEntityId}=req.organizationScope;
  const {rows:[clock]}=await client.query("select (now() at time zone 'UTC')::date::text today");
  const {rows}=await client.query(`select v.id,v.contract_id,c.number,v.version,v.retainer_capacity_policy,v.starts_on::text,v.ends_on::text
    from commercial_contract_versions v join commercial_contracts c on c.id=v.contract_id
      and c.organization_id=v.organization_id and c.legal_entity_id=v.legal_entity_id
    where v.organization_id=$1 and v.legal_entity_id=$2 and v.model='retainer' and v.effective_from<=$3::date
      and ($4::text is null or v.id collate "C">$4 collate "C")
      and (exists(select from commercial_lifecycle_events e where e.organization_id=v.organization_id and e.legal_entity_id=v.legal_entity_id
        and e.entity_type='Contract' and e.entity_id=v.contract_id and e.contract_version_id=v.id and e.state='Active' and e.effective_on<=$3::date)
        or exists(select from commercial_amendments a where a.organization_id=v.organization_id and a.legal_entity_id=v.legal_entity_id
          and a.entity_type='Contract' and a.entity_id=v.contract_id and a.contract_version_id=v.id and a.effective_on<=$3::date))
    order by v.id collate "C" limit 11`,[organizationId,legalEntityId,clock.today,after??null]);
  const versions=rows.slice(0,10),findings=[];
  for (const v of versions) {
    const source={contractId:v.contract_id,number:v.number,versionId:v.id,version:v.version};
    if (!v.retainer_capacity_policy) {
      findings.push({...source,kind:'missing_policy'});
      continue;
    }
    const data=await getRetainerConsumption(client,req,buildEmployeeScopeWhere,false,null,{id:v.contract_id,versionId:v.id,throughToday:true});
    const coverage=await periodCoverage(client,[organizationId,legalEntityId],v,clock.today);
    let carryVerified=true;
    for (const p of data.periods) {
      if (!p.capacity) continue;
      const period=coverage.get(p.startsOn);
      if (!period?.applicable || !period.covered || !carryVerified) {
        if (period?.applicable) findings.push({...source,kind:'review_terms',startsOn:p.startsOn,endsOn:p.endsOn});
        if (v.retainer_capacity_policy.endsWith('_rollover')) carryVerified=false;
        continue;
      }
      for (const [kind,hours] of [['overconsumption',p.capacity.overage],['expiry',p.capacity.expired]]) {
        if (compareHours(hours,'0')>0) findings.push({...source,kind,startsOn:p.startsOn,endsOn:p.endsOn,hours});
      }
    }
  }
  return {asOf:clock.today,scannedVersions:versions.length,findings,nextAfter:rows.length>10?versions[9].id:null};
}
