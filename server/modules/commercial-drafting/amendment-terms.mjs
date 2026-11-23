// Effective term resolution is deliberately separate from immutable activation
// pins and work/valuation evidence. It never writes or recalculates economics.
const scope=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
export const amendmentTerms=row=>({contractVersionId:row.contract_version_id,startsOn:row.starts_on,endsOn:row.ends_on,budget:row.budget,
 ...(row.effort_policy!=null?{effortPolicy:row.effort_policy}:{}),
 ...(row.elapsed_time_policy!=null?{elapsedTimePolicy:row.elapsed_time_policy}:{}),
 ...(row.budget_hours!=null?{budgetHours:row.budget_hours}:{}),
 ...(row.expense_budget!=null?{expenseBudget:row.expense_budget}:{}),
 ...(row.labor_cost_budget!=null?{laborCostBudget:row.labor_cost_budget}:{})});
export const resolveAmendedTerms=async(client,req,type,id,baseline,asOf)=>{
  // Internal/neutral records have no contract and are deliberately outside
  // amendment authority. Preserve their explicit null pin without a lookup.
  if(!baseline.contractVersionId)return baseline;
  const row=(await client.query(`select contract_version_id,starts_on::text,ends_on::text,budget::text,after_value->'terms'->>'effortPolicy' effort_policy,after_value->'terms'->>'elapsedTimePolicy' elapsed_time_policy,after_value->'terms'->>'laborCostBudget' labor_cost_budget,after_value->'terms'->>'budgetHours' budget_hours,after_value->'terms'->>'expenseBudget' expense_budget from commercial_amendments
    where organization_id=$1 and legal_entity_id=$2 and entity_type=$3 and entity_id=$4 and effective_on<=coalesce($5::date,(now() at time zone 'UTC')::date)
    order by sequence desc limit 1`,[...scope(req),type,id,asOf||null])).rows[0];
  return row?amendmentTerms(row):baseline;
};
export const applyAmendedSnapshot=async(client,req,type,id,root,asOf,includeExpenseBudget=false)=>{
  const terms=await resolveAmendedTerms(client,req,type,id,{contractVersionId:root.contract_version_id,startsOn:root.starts_on,endsOn:root.ends_on,budget:type==='Project'?root.budget_allocation:root.budget},asOf);
  return {...root,...(includeExpenseBudget && terms.expenseBudget!==undefined?{expense_budget:terms.expenseBudget}:{}),contract_version_id:terms.contractVersionId,starts_on:terms.startsOn,ends_on:terms.endsOn,
    ...(type==='Project'?{budget_allocation:terms.budget}:{budget:terms.budget})};
};
