// Shared lock order closes legacy CRUD/import versus explicit promotion races.
// A database trigger is the final guard, including writers added in future.
export const commercialLifecycleLockKey=scope=>`commercial-lifecycle:${scope.organizationId}:${scope.legalEntityId}`;
export const lockCommercialLifecycle = (client,scope) => client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
  [commercialLifecycleLockKey(scope)]);
export const assertLegacyProjectMutationAllowed = async (client,scope,projectIds) => {
  await lockCommercialLifecycle(client,scope);
  const result=await client.query(`select 1 from commercial_project_bindings where organization_id=$1 and legal_entity_id=$2 and project_id=any($3::text[]) limit 1`,
    [scope.organizationId,scope.legalEntityId,projectIds.filter(Boolean)]);
  if(result.rowCount){const error=new Error('Use the governed project lifecycle command.');error.code='WPG01';throw error;}
};
export const sendGovernedProjectConflict = (res,error) => {
  if(error?.code!=='WPG01')return false;
  res.status(409).json({error:{code:'GOVERNED_PROJECT_MUTATION_REQUIRED',message:'This project is governed by its engagement. Use the commercial lifecycle workspace; legacy CRUD, status and imports cannot change it.'}});return true;
};
