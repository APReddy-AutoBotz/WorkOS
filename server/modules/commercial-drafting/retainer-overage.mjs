// Preview exact extensions only. An approved billing event must separately select monetary rounding.
export async function priceRetainerOverage(client,scope,contractId,currency,policy,rows) {
  const started=rows.filter(p=>p.capacity).map(p=>({startsOn:p.startsOn,endsOn:p.endsOn,hours:p.capacity.overage}));
  if (policy==='no_charge') return started.map(p=>({...p,status:'no_charge',amount:'0'}));
  const result=await client.query(`
    select p.*,case when p.hours::numeric=0 then 'no_excess' when rate.id is null then 'missing'
      when rate.ties>1 then 'conflict' else 'priced' end status,
      case when p.hours::numeric=0 then '0' when rate.ties=1 then trim_scale(p.hours::numeric*rate.amount)::text end amount,
      case when rate.ties=1 then jsonb_build_object('adoptionId',rate.id,'candidateId',rate.candidate_id,'approvalId',rate.approval_id,
        'effectiveFrom',rate.effective_from,'effectiveTo',rate.effective_to,'hourlyRate',rate.amount::text) end source
    from jsonb_to_recordset($4::jsonb) p("startsOn" text,"endsOn" text,hours text)
    left join lateral (
      select a.id,a.approval_id,c.id candidate_id,c.amount,c.effective_from,c.effective_to,count(*) over(partition by c.priority) ties
      from commercial_rate_candidates c join commercial_rate_adoptions a on a.candidate_id=c.id
        and a.organization_id=c.organization_id and a.legal_entity_id=c.legal_entity_id
      where c.organization_id=$1 and c.legal_entity_id=$2 and c.kind='billing' and c.binding_type='contract'
        and c.binding_id=$3 and c.currency=$5 and c.unit='HOUR' and p."endsOn"::date between c.effective_from and c.effective_to
        and p.hours::numeric>0 order by c.priority desc,c.id limit 1
    ) rate on true order by p."startsOn"`,[scope.organizationId,scope.legalEntityId,contractId,JSON.stringify(started),currency]);
  return result.rows;
}
